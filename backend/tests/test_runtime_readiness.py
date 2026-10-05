# SPDX-License-Identifier: AGPL-3.0-only
import asyncio
import json
import hashlib
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock
import pytest

from karaoke_backend.api import features
from karaoke_backend.api.songs import _song_stems_dir
from karaoke_backend.models.song import Song
from karaoke_backend.workers import modal_worker
from karaoke_backend.workers import word_sync_worker

def _attestation(python, **changes):
    value = {"runtimeManifestId": "pack-1", "pythonPath": str(python),
        "pythonSha256": hashlib.sha256(python.read_bytes()).hexdigest(),
        "probePassed": True, "accelerator": "cpu",
        "components": {"torch": "2.8.0", "demucs": "4.0.1"},
        "verifiedCapabilities": ["transcription", "separation"],
        "capabilitiesReady": True}
    value.update(changes)
    return json.dumps(value)


def _model_sets(**changes):
    value = {"schema": 1, "runtimeManifestId": "pack-1", "modelManifestId": "b" * 64,
             "requiredModels": {"transcription": ["heart-transcriptor"], "separation": ["demucs-mdx-extra", "karaoke-roformer"]},
             "verifiedModelIds": ["heart-transcriptor", "demucs-mdx-extra", "karaoke-roformer"]}
    value.update(changes)
    return json.dumps(value)


@pytest.fixture(autouse=True)
def verified_model_inventory(monkeypatch):
    monkeypatch.setenv("KARAOKE_DESKTOP_MODEL_SETS_JSON", _model_sets())


def test_processing_manifest_is_reported_only_when_verified(monkeypatch, tmp_path):
    python = tmp_path / "bin" / "python"
    python.parent.mkdir()
    python.write_bytes(b"")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cpu")
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(python))
    result = features._processing_readiness()
    assert result["runtime"] == {"id": "pack-1", "accelerator": "cpu", "capabilities": ["separation", "transcription"]}
    assert result["transcription"]["ready"] is True
    assert result["separation"]["ready"] is True


@pytest.mark.parametrize("accelerator,device", [("cpu", "cpu"), ("metal", "mps"),
                                                 ("mps", "mps"), ("cuda", "cuda")])
def test_workers_use_only_the_explicit_attested_accelerator(
    monkeypatch, tmp_path, accelerator, device
):
    python = tmp_path / "python"
    python.write_bytes(b"runtime")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON",
                       _attestation(python, accelerator=accelerator))
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", accelerator)
    monkeypatch.setenv("KARAOKE_AUDIO_SEPARATOR_DEVICE", device)
    assert modal_worker.configured_accelerator() == device
    assert modal_worker.configured_pass2_device() == device
    assert word_sync_worker._attested_accelerator() == device
    with pytest.raises(RuntimeError, match="model set"):
        word_sync_worker._attested_accelerator("tiny")


def test_worker_accelerator_mismatch_fails_closed(monkeypatch, tmp_path):
    python = tmp_path / "python"
    python.write_bytes(b"runtime")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON",
                       _attestation(python, accelerator="cuda"))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cpu")
    with pytest.raises(modal_worker.StemSeparationError, match="does not match"):
        modal_worker.configured_accelerator()
    with pytest.raises(RuntimeError, match="does not match"):
        word_sync_worker._attested_accelerator()


def test_legacy_core_mode_keeps_local_defaults(monkeypatch):
    monkeypatch.delenv("KARAOKE_DESKTOP_PROCESSING_JSON", raising=False)
    monkeypatch.delenv("KARAOKE_PROCESSING_ACCELERATOR", raising=False)
    assert modal_worker.configured_accelerator() == "cuda"
    assert modal_worker.configured_pass2_device() is None
    assert word_sync_worker._attested_accelerator() is None


def test_forged_attestation_is_rejected_by_execution(monkeypatch, tmp_path):
    python = tmp_path / "python"
    python.write_bytes(b"real")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON",
                       _attestation(python, pythonSha256="0" * 64, accelerator="cuda"))
    with pytest.raises(RuntimeError, match="hash"):
        word_sync_worker._attested_accelerator()


def test_unverified_capability_is_not_ready(monkeypatch, tmp_path):
    python = tmp_path / "processing.exe"
    python.write_bytes(b"")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cpu")
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON",
                       _attestation(python, verifiedCapabilities=[]))
    result = features._processing_readiness()
    assert result["separation"]["ready"] is False
    assert result["transcription"]["ready"] is False


def test_validated_runtime_can_be_installed_before_capabilities_are_ready(monkeypatch, tmp_path):
    python = tmp_path / "python"
    python.write_bytes(b"runtime")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(
        python, capabilitiesReady=False, verifiedCapabilities=[]
    ))
    result = features._processing_readiness()
    assert result["runtime"] == {"id": "pack-1", "accelerator": "cpu", "capabilities": []}
    assert result["transcription"]["ready"] is False
    assert result["separation"]["ready"] is False
    with pytest.raises(RuntimeError, match="not ready"):
        word_sync_worker._attested_accelerator()

def test_heart_only_attestation_does_not_claim_separation(monkeypatch, tmp_path):
    python = tmp_path / "python"; python.write_bytes(b""); python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cpu")
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON",
                       _attestation(python, verifiedCapabilities=["transcription"]))
    monkeypatch.setenv("KARAOKE_DESKTOP_MODEL_SETS_JSON", _model_sets(
        requiredModels={"transcription": ["heart-transcriptor"], "separation": []},
        verifiedModelIds=["heart-transcriptor"]))
    result = features._processing_readiness()
    assert result["transcription"]["ready"] is True
    assert result["separation"]["ready"] is False


def test_invalid_processing_manifest_fails_closed(monkeypatch):
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", "not-json")
    assert features._processing_readiness()["runtime"] is None


def test_absent_desktop_components_must_not_claim_capabilities(monkeypatch):
    absent = {"runtimeManifestId": "pack-1", "pythonPath": "/missing",
              "pythonSha256": "0" * 64, "probePassed": True, "accelerator": "cpu",
              "components": [], "verifiedCapabilities": ["separation"],
              "capabilitiesReady": False}
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", json.dumps(absent))
    assert features._desktop_processing_manifest()["valid"] is False

def test_processing_attestation_rejects_hash_path_probe_and_extra_fields(monkeypatch, tmp_path):
    python = tmp_path / "python"; python.write_bytes(b"runtime"); python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    for change in ({"pythonSha256": "0" * 64}, {"pythonPath": str(tmp_path / "other")},
                   {"probePassed": False}, {"unexpected": True}):
        monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(python, **change))
        assert features._processing_readiness()["runtime"] is None


def test_active_generation_resolver_preserves_legacy_and_rejects_traversal(tmp_path):
    song = Song(id=7, artist="a", title="t", filename="f", stems_path=str(tmp_path))
    assert _song_stems_dir(song) == tmp_path
    song.active_stem_generation = "resplit-abc123"
    assert _song_stems_dir(song) == tmp_path / ".generations" / "resplit-abc123"
    song.active_stem_generation = "../escape"
    assert _song_stems_dir(song) == tmp_path / ".invalid-generation"


@pytest.mark.asyncio
async def test_owned_child_is_reaped_before_timeout_returns():
    with pytest.raises(asyncio.TimeoutError):
        await modal_worker._run_subprocess(["/bin/sh", "-c", "sleep 30"], timeout=0.01)

@pytest.mark.asyncio
async def test_posix_timeout_reaps_the_whole_process_tree(tmp_path):
    if os.name != "posix":
        pytest.skip("POSIX process-group contract")
    pid_file = tmp_path / "grandchild.pid"
    command = f"sleep 30 & echo $! > {pid_file}; wait"
    with pytest.raises(asyncio.TimeoutError):
        await modal_worker._run_subprocess(["/bin/sh", "-c", command], timeout=.2)
    pid = int(pid_file.read_text())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    status = Path(f"/proc/{pid}/status")
    if sys.platform == "linux":
        try:
            state = status.read_text()
        except (FileNotFoundError, ProcessLookupError):
            # The child can finish being reaped after kill(pid, 0) succeeds.
            return
        if "State:\tZ" in state:
            return
    raise AssertionError(f"grandchild {pid} survived timeout")

@pytest.mark.asyncio
async def test_signal_race_preserves_timeout_and_still_waits(monkeypatch):
    class Child:
        pid = 42; returncode = None; waited = False; killed = False
        async def communicate(self): raise asyncio.TimeoutError
        async def wait(self): self.waited = True
        def kill(self): self.killed = True; self.returncode = -9
    child = Child()
    async def spawn(*a, **k): return child
    monkeypatch.setattr(modal_worker.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(modal_worker.os, "killpg", lambda *a: (_ for _ in ()).throw(ProcessLookupError()))
    with pytest.raises(asyncio.TimeoutError):
        await modal_worker._run_subprocess(["fake"], timeout=.1)
    assert child.waited
    assert child.killed

@pytest.mark.asyncio
async def test_noncooperative_transcription_holds_capacity_until_work_finishes(monkeypatch):
    loop = asyncio.get_running_loop()
    never = loop.create_future()
    monkeypatch.setattr(loop, "run_in_executor", lambda *a, **k: never)
    task = asyncio.create_task(word_sync_worker.generate_word_sync(
            "unused.wav", "artist", "title", whisper_model="heart"
    ))
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(.01)
    assert not task.done(), "the queue slot must remain held while work is still running"
    never.set_result(None)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=.5)


@pytest.mark.asyncio
async def test_modal_cancellation_holds_capacity_until_executor_finishes(monkeypatch, tmp_path):
    loop = asyncio.get_running_loop()
    pending = loop.create_future()
    monkeypatch.setattr(loop, "run_in_executor", lambda *args, **kwargs: pending)
    task = asyncio.create_task(modal_worker._modal_separate_and_mix(
        tmp_path / "audio.wav", tmp_path / "stems", "job", AsyncMock(), "model.ckpt"
    ))
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(.01)
    assert not task.done()
    pending.set_exception(RuntimeError("remote stopped"))
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, .5)


@pytest.mark.parametrize("inventory", [None, "bad", _model_sets(runtimeManifestId="wrong"),
    _model_sets(schema=True), _model_sets(modelManifestId=None), _model_sets(unexpected=True),
    _model_sets(verifiedModelIds=["heart-transcriptor", "heart-transcriptor"]),
    _model_sets(requiredModels={"transcription": [], "separation": []})])
def test_missing_or_malformed_model_evidence_does_not_hide_runtime_or_enable_workflows(monkeypatch, tmp_path, inventory):
    python = tmp_path / "python"; python.write_bytes(b"runtime"); python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cpu")
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(python))
    if inventory is None:
        monkeypatch.delenv("KARAOKE_DESKTOP_MODEL_SETS_JSON")
    else:
        monkeypatch.setenv("KARAOKE_DESKTOP_MODEL_SETS_JSON", inventory)
    result = features._processing_readiness()
    assert result["runtime"]["capabilities"] == ["separation", "transcription"]
    assert result["transcription"]["ready"] is False
    assert result["separation"]["ready"] is False
    with pytest.raises(modal_worker.StemSeparationError, match="model set"):
        modal_worker.configured_accelerator()


def test_partial_model_cache_enables_only_its_complete_workflow(monkeypatch, tmp_path):
    python = tmp_path / "python"; python.write_bytes(b"runtime"); python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(python))
    monkeypatch.setenv("KARAOKE_DESKTOP_MODEL_SETS_JSON", _model_sets(verifiedModelIds=["heart-transcriptor", "demucs-mdx-extra"]))
    result = features._processing_readiness()
    assert result["transcription"]["ready"] is True
    assert result["separation"]["ready"] is False


@pytest.mark.asyncio
async def test_managed_default_cache_does_not_admit_selected_alternate(monkeypatch, tmp_path):
    python = tmp_path / "python"; python.write_bytes(b"runtime"); python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cpu")
    monkeypatch.setenv("KARAOKE_AUDIO_SEPARATOR_DEVICE", "cpu")
    monkeypatch.setattr(modal_worker, "DEMUCS_PYTHON", python)
    subprocess = AsyncMock()
    monkeypatch.setattr(modal_worker, "_await_subprocess", subprocess)
    with pytest.raises(modal_worker.StemSeparationError, match="model set"):
        await modal_worker.run_pass2(tmp_path / "vocals.wav", tmp_path / "out", "UVR_MDXNET_KARA_2.onnx", AsyncMock())
    monkeypatch.setattr(modal_worker, "DEFAULT_DEMUCS_MODEL", "htdemucs")
    monkeypatch.setattr(modal_worker, "_plugin_separator", lambda: None)
    monkeypatch.setattr(modal_worker.modal_offload, "is_enabled", lambda: False)
    with pytest.raises(modal_worker.StemSeparationError, match="model set"):
        await modal_worker.separate_stems(tmp_path / "input.wav", tmp_path / "out", "job")
    subprocess.assert_not_called()


def _cuda_policy(models):
    envelope = {"maxDurationSeconds": 600, "maxSampleRate": 48000, "maxChannels": 2,
                "devices": {"cuda": {"ramBytes": 1, "vramBytes": 1}}}
    return json.dumps({"schema": 1, "executionProfile": "bounded-v1", "evidenceReference": "synthetic-test-only",
                       "models": {model: envelope for model in models}})


@pytest.mark.parametrize("policy,separation,transcription", [
    (_cuda_policy(["demucs-mdx-extra", "karaoke-roformer", "heart-transcriptor"]), True, True),
    ("", False, False),
    (_cuda_policy(["heart-transcriptor"]), False, True),
    # Separation preparation needs every workflow model's envelope.
    (_cuda_policy(["demucs-mdx-extra", "karaoke-roformer"]), False, False),
    ('{"schema": 1, "executionProfile": "stale"}', False, False),
])
def test_cuda_runtime_without_measured_policy_is_not_ready(monkeypatch, tmp_path, policy, separation, transcription):
    python = tmp_path / "bin" / "python"
    python.parent.mkdir()
    python.write_bytes(b"")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(python))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(python, accelerator="cuda"))
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", policy)
    monkeypatch.setattr(features.modal_offload, "readiness", lambda: {"configured": False})
    result = features._processing_readiness()
    assert result["separation"]["ready"] is separation
    assert result["transcription"]["ready"] is transcription
    assert result["runtime"]["memoryPolicy"] is (separation and transcription)
    for name, ready in (("separation", separation), ("transcription", transcription)):
        if not ready:
            assert "no measured memory policy" in result[name]["reason"]


def test_non_cuda_runtime_readiness_does_not_require_policy(monkeypatch, tmp_path):
    python = tmp_path / "bin" / "python"
    python.parent.mkdir()
    python.write_bytes(b"")
    python.chmod(0o700)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", _attestation(python, accelerator="metal"))
    monkeypatch.delenv("KARAOKE_PROCESSING_MEMORY_JSON", raising=False)
    result = features._processing_readiness()
    assert result["separation"]["ready"] is True
    assert "memoryPolicy" not in result["runtime"]
