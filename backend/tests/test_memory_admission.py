# SPDX-License-Identifier: AGPL-3.0-only
"""Admission fixtures do not establish real model memory requirements."""
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import threading
import time
from unittest.mock import patch

import pytest
from karaoke_backend.workers import memory_admission as guard


def policy():
    return {"schema": 1, "executionProfile": "bounded-v1", "evidenceReference": "synthetic-test-only", "models": {
        "heart-transcriptor": {"maxDurationSeconds": 60, "maxSampleRate": 48000,
                              "maxChannels": 2, "devices": {
                                  "cuda": {"ramBytes": 100, "vramBytes": 200},
                                  "cpu": {"ramBytes": 300}}}}}


@pytest.fixture
def configured(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy()))
    monkeypatch.setattr(guard, "available_ram", lambda: 400)
    monkeypatch.setattr(guard, "cuda_free", lambda: 250)
    monkeypatch.setitem(sys.modules, "soundfile", SimpleNamespace(info=lambda _: SimpleNamespace(
        duration=30, samplerate=44100, channels=2)))


@pytest.mark.parametrize("ram,vram,expected", [(400, 250, "cuda"), (400, 100, "cpu"), (400, None, "cpu"), (150, 250, "cuda")])
def test_selected_device_and_independent_cpu_budget(ram, vram, expected):
    assert guard.choose_device("cuda", policy()["models"]["heart-transcriptor"], ram, vram) == expected


@pytest.mark.parametrize("ram,vram", [(150, 100), (None, 250), (99, 999), (True, 999)])
def test_neither_route_fits_fails_closed(ram, vram):
    with pytest.raises(guard.MemoryAdmissionError):
        guard.choose_device("cuda", policy()["models"]["heart-transcriptor"], ram, vram)


def test_missing_cpu_evidence_cannot_fallback():
    limits = policy()["models"]["heart-transcriptor"]
    del limits["devices"]["cpu"]
    with pytest.raises(guard.MemoryAdmissionError):
        guard.choose_device("cuda", limits, 999, None)


def test_missing_policy_blocks_cuda_before_checkpoint(monkeypatch):
    monkeypatch.delenv("KARAOKE_PROCESSING_MEMORY_JSON", raising=False)
    with pytest.raises(guard.MemoryAdmissionError, match="No measured"):
        with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]):
            pytest.fail("checkpoint load must not be reached")


def test_fresh_observation_and_no_retry_after_work_starts(configured):
    with patch.object(guard, "available_ram", side_effect=[400, 90]):
        with pytest.raises(guard.MemoryAdmissionError):
            with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]):
                pytest.fail("fresh RAM check must refuse")
    calls = []
    with pytest.raises(RuntimeError, match="inference failed"):
        with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]) as device:
            calls.append(device)
            raise RuntimeError("inference failed")
    assert calls == ["cuda"]
    with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]) as device:
        assert device == "cuda"  # failure released the admission lock


def test_concurrent_worker_refused_after_bounded_wait(configured, monkeypatch):
    monkeypatch.setattr(guard, "LOCK_WAIT_SECONDS", 0.2)
    monkeypatch.setattr(guard, "LOCK_POLL_SECONDS", 0.02)
    started = time.monotonic()
    with guard.serialized():
        with pytest.raises(guard.MemoryAdmissionError, match="Another local"):
            with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]):
                pytest.fail("concurrent load")
    assert time.monotonic() - started >= 0.2


def test_admission_waits_for_a_running_worker(configured, monkeypatch):
    monkeypatch.setattr(guard, "LOCK_POLL_SECONDS", 0.02)
    held, release = threading.Event(), threading.Event()

    def other_worker():
        with guard.serialized():
            held.set()
            release.wait(5)

    thread = threading.Thread(target=other_worker)
    thread.start()
    assert held.wait(5)
    threading.Timer(0.2, release.set).start()
    with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]) as device:
        assert device == "cuda"
    thread.join(5)


def test_lock_file_does_not_grow(configured):
    for _ in range(3):
        with guard.serialized():
            pass
    lock = Path(os.environ["XDG_CACHE_HOME"]) / "processing-memory.lock"
    assert lock.stat().st_size <= 1


@pytest.mark.parametrize("duration,rate,channels", [(61, 44100, 2), (float('nan'), 44100, 2), (30, 96000, 2), (30, 44100, 6)])
def test_unmeasured_audio_refused(configured, duration, rate, channels):
    sys.modules["soundfile"].info = lambda _: SimpleNamespace(duration=duration, samplerate=rate, channels=channels)
    with pytest.raises(guard.MemoryAdmissionError, match="workload envelope"):
        with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]):
            pytest.fail("out-of-envelope load")


def test_missing_model_and_malformed_limits_refused(configured, monkeypatch):
    for value in ({}, {**policy(), "models": {"heart-transcriptor": {}}}):
        monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(value))
        with pytest.raises(guard.MemoryAdmissionError):
            guard.policy_for("heart-transcriptor")


def device_records(capsys):
    return [guard.parse_device_line(line) for line in capsys.readouterr().err.splitlines()
            if guard.parse_device_line(line)]


@pytest.mark.parametrize("vram,ram,device,reason", [
    (250, 400, "cuda", "requested"), (100, 400, "cpu", "insufficient-vram"),
])
def test_device_line_reports_selection(configured, monkeypatch, capsys, vram, ram, device, reason):
    monkeypatch.setattr(guard, "cuda_free", lambda: vram)
    monkeypatch.setattr(guard, "available_ram", lambda: ram)
    with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]) as selected:
        assert selected == device
    [record] = device_records(capsys)
    assert (record["model"], record["requested"], record["device"], record["reason"]) == (
        "heart-transcriptor", "cuda", device, reason)


def test_insufficient_ram_for_gpu_route_is_named(configured, monkeypatch, capsys):
    limits = policy()
    limits["models"]["heart-transcriptor"]["devices"]["cuda"]["ramBytes"] = 500
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(limits))
    with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]) as selected:
        assert selected == "cpu"
    assert device_records(capsys)[0]["reason"] == "insufficient-ram"


def test_broken_cuda_is_reported_not_swallowed(configured, monkeypatch, capsys):
    def broken():
        raise guard.CudaUnusable("cuda-unavailable", "CUDA driver version is insufficient for CUDA runtime version")
    monkeypatch.setattr(guard, "cuda_free", broken)
    with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]) as selected:
        assert selected == "cpu"
    [record] = device_records(capsys)
    assert record["reason"] == "cuda-unavailable"
    text = guard.describe_device_selection(record, "Transcribing vocals")
    assert text == ("Transcribing vocals on the CPU because the GPU could not be used "
                    "(CUDA driver version is insufficient for CUDA runtime version); this is slower")


def test_broken_cuda_without_cpu_memory_names_both_causes(configured, monkeypatch):
    def broken():
        raise guard.CudaUnusable("unsupported-gpu", "GPU compute capability 6.1 is not supported")
    monkeypatch.setattr(guard, "cuda_free", broken)
    monkeypatch.setattr(guard, "available_ram", lambda: 150)
    with pytest.raises(guard.MemoryAdmissionError, match="6.1 is not supported, and the CPU route"):
        with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]):
            pytest.fail("no route fits")


def test_unmeasured_path_uses_cpu_without_touching_cuda(configured, monkeypatch, capsys):
    monkeypatch.setattr(guard, "cuda_free", lambda: pytest.fail("CUDA must not be queried"))
    with guard.admit("heart-transcriptor", "cuda", ["audio.wav"], unmeasured_cuda="temperature fallback") as selected:
        assert selected == "cpu"
    [record] = device_records(capsys)
    assert (record["reason"], record["detail"]) == ("unmeasured-path", "temperature fallback")
    assert "has not been qualified on the GPU" in guard.describe_device_selection(record, "Transcribing")


def test_unguarded_runtime_reports_nothing(monkeypatch, capsys):
    for name in ("KARAOKE_PROCESSING_MEMORY_JSON", "KARAOKE_PROCESSING_ACCELERATOR"):
        monkeypatch.delenv(name, raising=False)
    with guard.admit("heart-transcriptor", "cpu", ["audio.wav"]) as selected:
        assert selected == "cpu"
    assert capsys.readouterr().err == ""
    assert not guard.guarded("mps")


@pytest.mark.parametrize("line", [
    "plain progress output", guard.DEVICE_LINE_PREFIX + "{not json",
    guard.DEVICE_LINE_PREFIX + json.dumps({"schema": 1, "device": "tpu", "requested": "cuda", "reason": "requested"}),
])
def test_other_stderr_is_not_a_device_line(line):
    assert guard.parse_device_line(line) is None


REAL_CUDA_FREE = guard.cuda_free
ARCH_LIST = ["sm_70", "sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]


@pytest.mark.parametrize("capability,supported", [
    ((6, 1), False), ((7, 0), True), ((7, 5), True), ((8, 9), True), ((8, 6), True),
    ((12, 0), True), ((11, 0), False), ((5, 2), False),
])
def test_compute_capability_against_compiled_architectures(capability, supported):
    assert guard.capability_supported(capability, ARCH_LIST) is supported
    assert guard.minimum_capability(ARCH_LIST) == (7, 0)


def test_ptx_allows_newer_devices():
    assert guard.capability_supported((9, 0), ["sm_80", "compute_80"])
    assert not guard.capability_supported((7, 5), ["sm_80", "compute_80"])
    assert not guard.capability_supported((9, 1), ["sm_90a"])


class FakeCuda:
    def __init__(self, capability=(8, 6), error=None, arch_list=ARCH_LIST):
        self.capability, self.error, self.queried = capability, error, False
        self.arch_list = arch_list

    def init(self):
        if self.error:
            raise RuntimeError(self.error)

    def current_device(self):
        return 0

    def get_device_capability(self, _):
        return self.capability

    def get_arch_list(self):
        return list(self.arch_list)

    def mem_get_info(self, _):
        self.queried = True
        return (123, 456)


def test_cuda_free_names_unsupported_capability_before_querying_memory(monkeypatch):
    cuda = FakeCuda(capability=(6, 1))
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=cuda))
    with pytest.raises(guard.CudaUnusable) as raised:
        guard.cuda_free()
    assert raised.value.reason == "unsupported-gpu"
    assert "compute capability 6.1" in raised.value.detail and "7.0 or newer" in raised.value.detail
    assert not cuda.queried


@pytest.mark.parametrize("capability", [(6, 1), (8, 6)])
def test_cuda_free_refuses_a_runtime_without_compiled_architectures(monkeypatch, capability):
    cuda = FakeCuda(capability=capability, arch_list=[])
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=cuda))
    with pytest.raises(guard.CudaUnusable) as raised:
        guard.cuda_free()
    assert (raised.value.reason, raised.value.detail) == ("unsupported-gpu", guard.NO_ARCH_LIST)
    assert not cuda.queried


def test_missing_architecture_list_falls_back_to_cpu(configured, monkeypatch, capsys):
    monkeypatch.setattr(guard, "cuda_free", REAL_CUDA_FREE)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=FakeCuda(arch_list=[])))
    with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]) as selected:
        assert selected == "cpu"
    [record] = device_records(capsys)
    assert record["reason"] == "unsupported-gpu"
    assert guard.describe_device_selection(record, "Transcribing vocals") == (
        "Transcribing vocals on the CPU because the installed CUDA runtime lists no compiled GPU "
        "architectures; this is slower")


def test_cuda_free_reports_driver_error(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=FakeCuda(
        error="The NVIDIA driver on your system is too old (found version 11040).\nDetails follow")))
    with pytest.raises(guard.CudaUnusable) as raised:
        guard.cuda_free()
    assert raised.value.reason == "cuda-unavailable"
    assert raised.value.detail == "The NVIDIA driver on your system is too old (found version 11040)."


def test_cuda_free_returns_free_bytes(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=FakeCuda()))
    assert guard.cuda_free() == 123


def test_policy_coverage(configured, monkeypatch):
    assert guard.policy_covers(["heart-transcriptor"])
    assert not guard.policy_covers(["heart-transcriptor", "demucs-mdx-extra"])
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", "")
    assert not guard.policy_covers(["heart-transcriptor"])
