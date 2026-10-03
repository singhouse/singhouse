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


def cuda_free():
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.mem_get_info(torch.cuda.current_device())[0]
    except Exception:
        pass
    return None


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


@contextmanager
def serialized():
    cache = os.environ.get("XDG_CACHE_HOME")
    if not cache or not Path(cache).is_dir():
        raise MemoryAdmissionError("The processing admission cache is unavailable.")
    with (Path(cache) / "processing-memory.lock").open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                lock.write(b"\0")
                lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise MemoryAdmissionError("Another local processing worker is running. Retry when it finishes.") from None
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


@contextmanager
def admit(model, requested, audio_paths):
    # Existing non-CUDA runtimes retain their contract until they carry policy.
    # Every CUDA managed entry point is guarded, including CPU requests inside
    # an attested CUDA runtime. Standalone Heart use is not a managed runtime.
    required = requested == "cuda" or os.getenv("KARAOKE_PROCESSING_ACCELERATOR") == "cuda"
    if not required and not os.getenv("KARAOKE_PROCESSING_MEMORY_JSON"):
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
        free_vram = cuda_free() if requested == "cuda" else None
        device = choose_device(requested, limits, available_ram(), free_vram)
        if device != requested:
            print("CUDA memory/device unavailable; using the measured CPU fallback (slower).", file=sys.stderr)
        yield device
