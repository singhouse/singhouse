#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Linux single-stage processing measurements; outputs raw, unqualified evidence.

Run once per model/device/input with an explicit candidate admission policy.
The candidate is an experiment input, NOT measured release policy. CUDA runs
retain only the CUDA entry so admission cannot silently measure CPU fallback.
RAM and per-process GPU values are sampled lower bounds, not allocation limits.
The reserve watchdog is best effort, not a guarantee against host exhaustion.
Outputs and logs can contain private audio/transcription data; keep them local.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time

MODELS = ("demucs-mdx-extra", "karaoke-roformer", "heart-transcriptor")
ROFORMER = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
MIB = 1024 ** 2


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(root):
    root = Path(root).resolve(strict=True)
    records = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Model inventory must not contain symlinks")
        if path.is_file():
            records.append({"path": path.relative_to(root).as_posix(), "size": path.stat().st_size,
                            "sha256": sha256(path)})
    if not records:
        raise ValueError("Model inventory is empty")
    return records


def verify_runtime(root, manifest_path, interpreter):
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("platform") != "linux" or manifest.get("accelerator") != "cuda":
        raise ValueError("An explicit Linux CUDA runtime manifest is required")
    if (root / manifest["python"]).resolve() != interpreter.resolve():
        raise ValueError("Interpreter differs from runtime manifest")
    files = manifest["files"]
    if not files or manifest["python"] not in {entry["path"] for entry in files}:
        raise ValueError("Runtime inventory is incomplete")
    for entry in files:
        path = (root / entry["path"]).resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("Runtime inventory escapes root or is not a file")
        if path.stat().st_size != entry["size"] or sha256(path) != entry["sha256"]:
            raise ValueError("Runtime inventory hash or size mismatch")
    return {"manifestSha256": sha256(manifest_path), "lockSha256": manifest["provenance"]["lockSha256"],
            "pythonSha256": sha256(interpreter), "verifiedFileCount": len(files)}


def candidate_policy(value, model, device):
    if (not isinstance(value, dict)
            or set(value) != {"schema", "evidenceReference", "executionProfile", "models"}
            or type(value.get("schema")) is not int or value["schema"] != 1
            or value["executionProfile"] != "bounded-v1"
            or not isinstance(value.get("evidenceReference"), str) or not value["evidenceReference"].strip()):
        raise ValueError("Explicit candidate policy with an experiment reference is required")
    if not isinstance(value["models"], dict) or not set(value["models"]) <= set(MODELS):
        raise ValueError("Unknown candidate model schema")
    limits = value["models"][model]
    if not isinstance(limits, dict) or set(limits) != {"maxDurationSeconds", "maxSampleRate", "maxChannels", "devices"}:
        raise ValueError("Unknown candidate workload schema")
    for key in ("maxDurationSeconds", "maxSampleRate", "maxChannels"):
        if type(limits[key]) is not int or limits[key] <= 0:
            raise ValueError("Invalid candidate workload envelope")
    requirement = limits["devices"][device]
    if not isinstance(requirement, dict) or set(requirement) != ({"ramBytes", "vramBytes"} if device == "cuda" else {"ramBytes"}):
        raise ValueError("Unknown candidate device budget schema")
    for key in (("ramBytes", "vramBytes") if device == "cuda" else ("ramBytes",)):
        if type(requirement[key]) is not int or requirement[key] <= 0:
            raise ValueError("Invalid candidate memory budget")
    return {"schema": 1, "executionProfile": value["executionProfile"], "evidenceReference": value["evidenceReference"],
            "models": {model: {**limits, "devices": {device: requirement}}}}


def available_ram():
    values = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    return int(values["MemAvailable"].split()[0]) * 1024


def group_memory(pgid):
    """Sum current RSS and retain individual kernel high-water observations."""
    rss, hwm, pids = 0, 0, set()
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            # comm can contain spaces or parentheses; subsequent fields begin at state.
            fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
            if int(fields[2]) != pgid:
                continue
            values = dict(line.split(":", 1) for line in (directory / "status").read_text().splitlines())
            pids.add(int(directory.name))
            rss += int(values.get("VmRSS", "0 kB").split()[0]) * 1024
            hwm = max(hwm, int(values.get("VmHWM", "0 kB").split()[0]) * 1024)
        except (FileNotFoundError, ProcessLookupError):
            pass  # Process exited between enumeration and observation.
    return rss, hwm, pids


def smi(query, kind="gpu"):
    result = subprocess.run(["nvidia-smi", f"--query-{kind}={query}", "--format=csv,noheader,nounits"],
                            check=True, capture_output=True, text=True, timeout=2)
    return [[field.strip() for field in line.split(",")] for line in result.stdout.splitlines() if line.strip()]


def gpu_inventory(uuid):
    rows = smi("uuid,name,driver_version,memory.total")
    row = next((row for row in rows if row[0] == uuid), None)
    if row is None:
        raise ValueError("Requested GPU UUID was not reported by the driver")
    return {"uuid": row[0], "name": row[1], "driverVersion": row[2], "totalBytes": int(row[3]) * MIB}


def gpu_memory(uuid, pids):
    owned, other = 0, 0
    for gpu, pid, used in smi("gpu_uuid,pid,used_gpu_memory", "compute-apps"):
        if gpu == uuid:
            amount = int(used) * MIB  # Unknown accounting fails closed; never turn N/A into zero.
            if int(pid) in pids:
                owned += amount
            else:
                other += amount
    return owned, other


def kill_group(child):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def monitor(command, env, directory, reserve, timeout, interval, gpu_uuid=None):
    record = {"sampledPeakRssBytes": 0, "observedProcessHighWaterRssBytes": 0,
              "sampledPeakVramBytes": 0 if gpu_uuid else None, "sampledOtherPeakVramBytes": 0 if gpu_uuid else None,
              "minimumHostAvailableRamBytes": available_ram(), "samples": 0, "stopReason": None}
    if record["minimumHostAvailableRamBytes"] <= reserve:
        raise ValueError("Host reserve is already threatened; worker was not started")
    started = time.monotonic()
    with (directory / "stdout.log").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
        child = subprocess.Popen(command, env=env, cwd=directory, stdin=subprocess.DEVNULL,
                                 stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            while child.poll() is None:
                ram = available_ram()
                record["minimumHostAvailableRamBytes"] = min(ram, record["minimumHostAvailableRamBytes"])
                if ram <= reserve:
                    record["stopReason"] = "host-reserve-threatened"
                    break
                if time.monotonic() - started > timeout:
                    record["stopReason"] = "timeout"
                    break
                rss, hwm, pids = group_memory(child.pid)
                record["sampledPeakRssBytes"] = max(rss, record["sampledPeakRssBytes"])
                record["observedProcessHighWaterRssBytes"] = max(hwm, record["observedProcessHighWaterRssBytes"])
                if gpu_uuid:
                    owned, other = gpu_memory(gpu_uuid, pids)
                    record["sampledPeakVramBytes"] = max(owned, record["sampledPeakVramBytes"])
                    record["sampledOtherPeakVramBytes"] = max(other, record["sampledOtherPeakVramBytes"])
                record["samples"] += 1
                time.sleep(interval)
        except Exception as error:
            record["stopReason"] = f"monitor-failed:{type(error).__name__}"
        finally:
            # Also remove surviving descendants after a worker exits or monitor interruption.
            kill_group(child)
    record.update(exitCode=child.returncode, elapsedSeconds=time.monotonic() - started,
                  success=child.returncode == 0 and record["stopReason"] is None)
    if gpu_uuid and record["sampledPeakVramBytes"] == 0:
        record.update(success=False, stopReason=record["stopReason"] or "no-worker-gpu-allocation-observed")
    return record


def worker_command(args, artifacts):
    base = [str(args.interpreter), "-I", "-B", "-m"]
    if args.model == "demucs-mdx-extra":
        return base + ["karaoke_backend.workers.managed_demucs", "-n", "mdx_extra", "--device", args.device,
                       "--float32", "-o", str(artifacts), str(args.audio)]
    if args.model == "karaoke-roformer":
        return base + ["karaoke_backend.workers.managed_audio_separator", str(args.audio), "--model_filename", ROFORMER,
                       "--model_file_dir", str(args.model_dir), "--output_dir", str(artifacts),
                       "--output_format", "WAV", "--device", args.device]
    return base + ["karaoke_backend.workers.heart_transcriptor", str(args.audio), "--model-path", str(args.model_dir),
                   "--device", args.device, "--language", args.language, "--managed-vad-config", "{}"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("interpreter", "runtime-root", "runtime-manifest", "model-dir", "audio", "candidate-policy", "output", "native-bin"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    parser.add_argument("--gpu-uuid", help="Required for CUDA; passed through CUDA_VISIBLE_DEVICES")
    parser.add_argument("--reserve-ram-bytes", type=int, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=3600)
    parser.add_argument("--sample-seconds", type=float, default=0.1)
    parser.add_argument("--language", default="en")
    args = parser.parse_args(argv)
    if sys.platform != "linux" or args.reserve_ram_bytes <= 0 or not 0.01 <= args.sample_seconds <= 1 or not 0 < args.timeout_seconds < float("inf"):
        parser.error("Linux, a positive RAM reserve/timeout, and a sample interval between 0.01 and 1 second are required")
    if (args.device == "cuda") != bool(args.gpu_uuid):
        parser.error("Specify --gpu-uuid exactly for CUDA measurements")
    for name in ("interpreter", "runtime_root", "runtime_manifest", "model_dir", "audio", "candidate_policy", "native_bin"):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    runtime = verify_runtime(args.runtime_root, args.runtime_manifest, args.interpreter)
    models = inventory(args.model_dir)
    policy = candidate_policy(json.loads(args.candidate_policy.read_text()), args.model, args.device)
    cache = args.output / "cache"
    cache.mkdir()
    artifacts = args.output / "artifacts"
    artifacts.mkdir()
    for name in ("ffmpeg", "ffprobe"):
        if not (args.native_bin / name).is_file():
            raise ValueError("Explicit native-bin must provide ffmpeg and ffprobe")
    env = {"PATH": str(args.native_bin), "XDG_CACHE_HOME": str(cache),
           "HF_HOME": str(cache / "huggingface"), "NUMBA_CACHE_DIR": str(cache / "numba"),
           "TORCHINDUCTOR_CACHE_DIR": str(cache / "torchinductor"),
           "TORCH_HOME": str(args.model_dir) if args.model == "demucs-mdx-extra" else str(cache / "torch"),
           "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTORCH_ENABLE_MPS_FALLBACK": "0",
           "CUDA_VISIBLE_DEVICES": args.gpu_uuid or "", "KARAOKE_PROCESSING_ACCELERATOR": "cuda",
           "KARAOKE_PROCESSING_MEMORY_JSON": json.dumps(policy)}
    # Metadata-only subprocess: no model imports, no input decoding.
    inspect = "import soundfile,json,sys; i=soundfile.info(sys.argv[1]); print(json.dumps(dict(durationSeconds=i.duration,sampleRate=i.samplerate,channels=i.channels,frames=i.frames)))"
    audio = json.loads(subprocess.check_output([str(args.interpreter), "-I", "-B", "-c", inspect, str(args.audio)],
                                             env=env, cwd=args.output, text=True, timeout=30))
    command = worker_command(args, artifacts)
    module_names = [command[4], "karaoke_backend.workers.memory_admission"]
    locate = "import importlib.util,json,sys; print(json.dumps({n:importlib.util.find_spec(n).origin for n in sys.argv[1:]}))"
    origins = json.loads(subprocess.check_output([str(args.interpreter), "-I", "-B", "-c", locate, *module_names],
                                               env=env, cwd=args.output, text=True, timeout=30))
    listed = {entry["path"] for entry in json.loads(args.runtime_manifest.read_text())["files"]}
    runtime["workerSources"] = {}
    for module, origin in origins.items():
        path = Path(origin).resolve(strict=True)
        if not path.is_relative_to(args.runtime_root) or path.relative_to(args.runtime_root).as_posix() not in listed:
            raise ValueError("Managed worker source is outside the verified runtime inventory")
        runtime["workerSources"][module] = sha256(path)
    report = {"schema": 1, "kind": "raw-processing-memory-measurement", "qualified": False,
              "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "model": args.model, "device": args.device, "runtime": runtime, "modelInventory": models,
              "managedVadConfig": {} if args.model == "heart-transcriptor" else None,
              "input": {**audio, "sha256": sha256(args.audio)}, "candidatePolicy": policy,
              "candidatePolicyFileSha256": sha256(args.candidate_policy),
              "profilerSha256": sha256(__file__),
              "nativeTools": {name: sha256(args.native_bin / name) for name in ("ffmpeg", "ffprobe")},
              "host": {"kernel": platform.release(), "architecture": platform.machine()},
              "gpu": gpu_inventory(args.gpu_uuid) if args.gpu_uuid else None,
              "reserveRamBytes": args.reserve_ram_bytes, "sampleIntervalSeconds": args.sample_seconds,
              "limitations": ["Sampled peaks are lower bounds; short allocation spikes may be missed.",
                              "Reserve watchdog cannot guarantee protection from rapid allocation or unrelated workloads.",
                              "Successful exit is execution evidence, not audio quality or release qualification."]}
    report["measurement"] = monitor(command, env, args.output,
                                    args.reserve_ram_bytes, args.timeout_seconds, args.sample_seconds, args.gpu_uuid)
    (args.output / "measurement.json").write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["measurement"]["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
