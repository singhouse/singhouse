# SPDX-License-Identifier: AGPL-3.0-only
"""Fail-closed admission for explicitly measured managed processing workloads.

A policy is a test/release input, never a claim that arbitrary audio fits. The
worker serializes admissions and checks fresh observations before loading any
checkpoint. This cannot reserve memory against unrelated applications.
"""
from contextlib import contextmanager
import ctypes
import json
import math
import os
from pathlib import Path
import sys
import time


EXECUTION_PROFILE = "bounded-v1"
DEMUCS_SEGMENT_SECONDS = 6
ROFORMER_PARAMETERS = {"segment_size": 256, "override_model_segment_size": True,
                       "batch_size": 1, "overlap": 8, "pitch_shift": 0}


class MemoryAdmissionError(RuntimeError):
    pass


def available_ram():
    try:
        if sys.platform == "linux":
            values = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
            return int(values["MemAvailable"].split()[0]) * 1024
        if sys.platform == "win32":
            class Status(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                    (name, ctypes.c_ulonglong) for name in
                    ("total", "available", "page_total", "page_available", "virtual_total", "virtual_available", "extended")]
            status = Status()
            status.length = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return status.available
    except (OSError, ValueError, KeyError, AttributeError):
        pass
    return None


class CudaUnusable(RuntimeError):
    """CUDA cannot run this stage; ``reason`` is a stable device-line code."""

    def __init__(self, reason, detail):
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


def _brief(error):
    lines = str(error).strip().splitlines()
    text = lines[0].strip() if lines else ""
    return (text or type(error).__name__)[:160]


def capability_supported(capability, arch_list):
    """Whether a compute capability can run kernels compiled for ``arch_list``.

    SASS (``sm_XY``) runs on the same major architecture with an equal or newer
    minor version; PTX (``compute_XY``) can be JIT compiled for newer devices.
    """
    major, minor = capability
    for arch in arch_list:
        kind, _, version = arch.partition("_")
        digits = version.rstrip("abf")
        if not digits.isdigit() or len(digits) < 2:
            continue
        built = (int(digits[:-1]), int(digits[-1]))
        if kind == "sm" and not version[len(digits):] and built[0] == major and built[1] <= minor:
            return True
        if kind == "compute" and built <= (major, minor):
            return True
    return False


def minimum_capability(arch_list):
    versions = []
    for arch in arch_list:
        kind, _, version = arch.partition("_")
        if kind in {"sm", "compute"} and version.isdigit() and len(version) >= 2:
            versions.append((int(version[:-1]), int(version[-1])))
    return min(versions) if versions else None


NO_ARCH_LIST = "the installed CUDA runtime lists no compiled GPU architectures"


def cuda_free():
    """Free bytes on the current CUDA device, or raise ``CudaUnusable``.

    Driver and runtime failures are reported, never treated as a memory
    shortage. The capability check runs before free memory is queried, so an
    unsupported GPU is refused without allocating memory on it.
    """
    try:
        import torch
    except Exception as error:  # noqa: BLE001 - any import failure makes CUDA unusable
        raise CudaUnusable("cuda-unavailable", _brief(error)) from None
    try:
        torch.cuda.init()
        index = torch.cuda.current_device()
        capability = tuple(torch.cuda.get_device_capability(index))
        arch_list = list(torch.cuda.get_arch_list())
    except Exception as error:  # noqa: BLE001 - driver errors are reported to the user
        raise CudaUnusable("cuda-unavailable", _brief(error)) from None
    if not arch_list:
        # Without the compiled architectures, support cannot be established.
        raise CudaUnusable("unsupported-gpu", NO_ARCH_LIST)
    if not capability_supported(capability, arch_list):
        minimum = minimum_capability(arch_list)
        supported = f"; this runtime requires {minimum[0]}.{minimum[1]} or newer" if minimum else ""
        raise CudaUnusable("unsupported-gpu",
                           f"GPU compute capability {capability[0]}.{capability[1]} is not supported{supported}")
    try:
        return torch.cuda.mem_get_info(index)[0]
    except Exception as error:  # noqa: BLE001
        raise CudaUnusable("cuda-unavailable", _brief(error)) from None


DEVICE_LINE_PREFIX = "KARAOKE_PROCESSING_DEVICE "
DEVICE_REASONS = {"requested", "insufficient-vram", "insufficient-ram", "cuda-unavailable",
                  "unsupported-gpu", "unmeasured-path"}


def device_line(model, requested, device, reason, detail=None):
    """One machine-readable stderr line describing the selected device."""
    return DEVICE_LINE_PREFIX + json.dumps({"schema": 1, "model": model, "requested": requested,
                                            "device": device, "reason": reason, "detail": detail},
                                           sort_keys=True)


def parse_device_line(line):
    """Return a validated device-selection record, or None for other output."""
    line = line.strip()
    if not line.startswith(DEVICE_LINE_PREFIX.strip()):
        return None
    try:
        record = json.loads(line[len(DEVICE_LINE_PREFIX.strip()):])
    except ValueError:
        return None
    if (not isinstance(record, dict) or record.get("schema") != 1
            or record.get("device") not in {"cpu", "cuda", "mps"}
            or record.get("requested") not in {"cpu", "cuda", "mps"}
            or record.get("reason") not in DEVICE_REASONS
            or not (record.get("detail") is None or isinstance(record.get("detail"), str))):
        return None
    return record


def fallback_cause(reason, detail=None):
    """Plain-language reason a CUDA request runs on the CPU, or None."""
    detail = (detail or "").strip()
    return {
        "insufficient-vram": "there is not enough free GPU memory",
        "insufficient-ram": "there is not enough free system memory for the GPU route",
        "cuda-unavailable": "the GPU could not be used" + (f" ({detail})" if detail else ""),
        "unsupported-gpu": detail or "this GPU is not supported by the installed runtime",
        "unmeasured-path": (detail or "this processing mode") + " has not been qualified on the GPU",
    }.get(reason)


def describe_device_selection(record, activity):
    """User-facing progress text for a device-selection record."""
    if record["device"] == "cuda":
        return f"{activity} on the GPU"
    if record["device"] == "mps":
        return f"{activity} on the GPU (Metal)"
    why = fallback_cause(record["reason"], record.get("detail"))
    if record["requested"] != "cuda" or why is None:
        return f"{activity} on the CPU"
    return f"{activity} on the CPU because {why}; this is slower"


def policy_for(model):
    try:
        policy = json.loads(os.environ.get("KARAOKE_PROCESSING_MEMORY_JSON", ""))
        if (type(policy["schema"]) is not int or policy["schema"] != 1 or not isinstance(policy["evidenceReference"], str)
                or not policy["evidenceReference"].strip()
                or policy.get("executionProfile") != EXECUTION_PROFILE):
            raise ValueError()
        limits = policy["models"][model]
        for key in ("maxDurationSeconds", "maxSampleRate", "maxChannels"):
            if type(limits[key]) is not int or limits[key] <= 0:
                raise ValueError()
        for device, requirement in limits["devices"].items():
            if device not in {"cpu", "cuda"}:
                raise ValueError()
            for key in (("ramBytes", "vramBytes") if device == "cuda" else ("ramBytes",)):
                if type(requirement[key]) is not int or requirement[key] <= 0:
                    raise ValueError()
        if not limits["devices"]:
            raise ValueError()
        return limits
    except (ValueError, KeyError, TypeError, AttributeError):
        raise MemoryAdmissionError("No measured memory policy is available for this model; processing was refused.") from None


def policy_covers(models):
    """Whether the configured policy validly covers every model named."""
    try:
        for model in models:
            policy_for(model)
    except MemoryAdmissionError:
        return False
    return True


def choose_device(requested, limits, ram, vram):
    def fits(device):
        requirement = limits["devices"].get(device)
        return (requirement is not None and type(ram) is int and ram >= requirement["ramBytes"]
                and (device != "cuda" or type(vram) is int and vram >= requirement["vramBytes"]))
    if fits(requested):
        return requested
    if requested == "cuda" and fits("cpu"):
        return "cpu"
    raise MemoryAdmissionError("Available memory could not meet the measured workload requirements. Close other applications and retry; CPU fallback also requires sufficient RAM.")


def guarded(requested):
    """Whether this worker runs under measured admission and the bounded profile.

    Every CUDA managed entry point is guarded, including CPU requests inside an
    attested CUDA runtime. Other runtimes are guarded only when they carry a
    policy, so existing CPU and Metal packs keep their settings.
    """
    return (requested == "cuda" or os.getenv("KARAOKE_PROCESSING_ACCELERATOR") == "cuda"
            or bool(os.getenv("KARAOKE_PROCESSING_MEMORY_JSON")))


LOCK_WAIT_SECONDS = 900
LOCK_POLL_SECONDS = 1.0


@contextmanager
def serialized(wait_seconds=None):
    """Hold the host-wide admission lock, waiting a bounded time for it."""
    cache = os.environ.get("XDG_CACHE_HOME")
    if not cache or not Path(cache).is_dir():
        raise MemoryAdmissionError("The processing admission cache is unavailable.")
    wait_seconds = LOCK_WAIT_SECONDS if wait_seconds is None else wait_seconds
    # Read/write without append: append mode ignores seeks on Windows, so the
    # lock byte would be appended again on every admission.
    descriptor = os.open(Path(cache) / "processing-memory.lock", os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "r+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0, os.SEEK_END)
            if lock.tell() == 0:
                lock.write(b"\0")
                lock.flush()
        else:
            import fcntl
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                if os.name == "nt":
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise MemoryAdmissionError("Another local processing worker is still running. Retry when it finishes.") from None
                time.sleep(LOCK_POLL_SECONDS)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def _report(model, requested, device, reason, detail=None):
    print(device_line(model, requested, device, reason, detail), file=sys.stderr, flush=True)


@contextmanager
def admit(model, requested, audio_paths, *, unmeasured_cuda=None):
    """Admit one managed stage and yield the device it must use.

    ``unmeasured_cuda`` names a processing mode whose GPU memory was not
    measured; it is routed to the CPU budget as though VRAM were insufficient.
    Standalone Heart use is not a managed runtime and is not guarded.
    """
    if not guarded(requested):
        yield requested
        return
    limits = policy_for(model)
    with serialized():
        # Check RAM before importing even the audio inspection dependency.
        ram = available_ram()
        if not any(type(ram) is int and ram >= item["ramBytes"] for item in limits["devices"].values()):
            raise MemoryAdmissionError("Available RAM is insufficient or unknown; processing was refused.")
        import soundfile
        try:
            for audio in audio_paths:
                info = soundfile.info(audio)
                if (not math.isfinite(info.duration) or info.duration <= 0
                        or info.duration > limits["maxDurationSeconds"]
                        or info.samplerate <= 0 or info.samplerate > limits["maxSampleRate"]
                        or info.channels <= 0 or info.channels > limits["maxChannels"]):
                    raise ValueError()
        except (ValueError, OSError, RuntimeError):
            raise MemoryAdmissionError("Audio is outside the measured workload envelope or could not be inspected; processing was refused.") from None
        free_vram, reason, detail = None, "requested", None
        if requested == "cuda" and unmeasured_cuda:
            reason, detail = "unmeasured-path", unmeasured_cuda
        elif requested == "cuda":
            try:
                free_vram = cuda_free()
            except CudaUnusable as error:
                reason, detail = error.reason, error.detail
            if free_vram is None and reason == "requested":
                reason = "cuda-unavailable"
        ram = available_ram()
        try:
            device = choose_device(requested, limits, ram, free_vram)
        except MemoryAdmissionError:
            cause = fallback_cause(reason, detail) if reason != "requested" else None
            if cause is not None:
                raise MemoryAdmissionError(f"{cause[0].upper()}{cause[1:]}, and the CPU route needs more "
                                           "available memory. Close other applications and retry.") from None
            raise
        if device != requested and reason == "requested":
            requirement = limits["devices"].get("cuda", {})
            reason = ("insufficient-vram" if type(ram) is int and ram >= requirement.get("ramBytes", 0)
                      else "insufficient-ram")
        _report(model, requested, device, reason, detail)
        yield device
