# SPDX-License-Identifier: AGPL-3.0-only
"""Admission fixtures do not establish real model memory requirements."""
import json
from types import SimpleNamespace
import sys
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


def test_concurrent_worker_refused(configured):
    with guard.serialized():
        with pytest.raises(guard.MemoryAdmissionError, match="Another local"):
            with guard.admit("heart-transcriptor", "cuda", ["audio.wav"]):
                pytest.fail("concurrent load")


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
