# SPDX-License-Identifier: AGPL-3.0-only
"""Managed RMS VAD stays inside memory admission without changing segmentation."""
from contextlib import contextmanager
from dataclasses import asdict
import json
import sys
from unittest.mock import Mock
import wave

import numpy as np
import pytest

from lyricsync._config import VadConfig
from lyricsync.transcription.heart import HeartTranscriber
from lyricsync.audio.io import read_wav_mono
from lyricsync.audio.vad import rms_vad_segments
from karaoke_backend.workers import heart_transcriptor as worker
from karaoke_backend.workers import memory_admission


@pytest.mark.parametrize("use_vad", [True, False])
def test_managed_parent_never_reads_audio(monkeypatch, tmp_path, use_vad):
    import lyricsync.audio.io
    monkeypatch.setattr(lyricsync.audio.io, "read_wav_mono", Mock(side_effect=AssertionError("parent allocated audio")))
    process = Mock(returncode=0)
    process.communicate.return_value = ('{"segments": []}', '')
    spawn = Mock(return_value=process)
    monkeypatch.setattr("lyricsync.transcription.heart.subprocess.Popen", spawn)
    script = tmp_path / "worker.py"
    script.touch()
    config = VadConfig()
    transcriber = HeartTranscriber(sys.executable, script, use_vad=use_vad,
                                   vad_config=config, accelerator="cuda", managed_vad=True)
    transcriber.transcribe("unread.wav")
    command = spawn.call_args.args[0]
    assert ("--managed-vad-config" in command) is use_vad
    assert "--vad-segments" not in command
    if use_vad:
        assert json.loads(command[command.index("--managed-vad-config") + 1]) == asdict(config)


def test_vad_executes_after_admission_before_model_loading(monkeypatch, tmp_path):
    events = []
    @contextmanager
    def admit(*args):
        events.append("admit")
        yield "cpu"
        events.append("release")
    monkeypatch.setattr(memory_admission, "admit", admit)
    monkeypatch.setattr(worker, "managed_vad_segments", lambda *args: events.append("vad") or [])
    def inference(args, _):
        assert args.device == "cpu"
        assert args.managed_vad_segments == []  # empty VAD must not mean whole-file decode
        events.append("inference")
    monkeypatch.setattr(worker, "run_inference", inference)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", "managed")
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setattr(sys, "argv", ["heart", "audio.wav", "--device", "cuda", "--model-path", str(tmp_path), "--managed-vad-config", "{}"])
    worker.main()
    assert events == ["admit", "vad", "inference", "release"]


def test_child_uses_identical_rms_segmentation(tmp_path):
    rate = 16000
    samples = np.zeros(rate * 8, dtype=np.int16)
    samples[rate:rate * 3] = (10000 * np.sin(np.arange(rate * 2) * .1)).astype(np.int16)
    samples[rate * 5:rate * 7] = samples[rate:rate * 3]
    audio = tmp_path / "fixture.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(samples.tobytes())
    config = VadConfig()
    original, sr = read_wav_mono(str(audio))
    expected = rms_vad_segments(original, sr, config)
    assert expected
    assert worker.managed_vad_segments(str(audio), json.dumps(asdict(config))) == expected


@pytest.mark.parametrize("accelerator,device", [("cpu", "cpu"), ("metal", "mps")])
def test_old_cpu_metal_pack_does_not_import_new_guard(monkeypatch, tmp_path, accelerator, device):
    import builtins
    original = builtins.__import__
    def missing_guard(name, *args, **kwargs):
        if name == "karaoke_backend.workers.memory_admission":
            raise ModuleNotFoundError("old pack has no admission module")
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", missing_guard)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", "managed-old-pack")
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", accelerator)
    monkeypatch.delenv("KARAOKE_PROCESSING_MEMORY_JSON", raising=False)
    inference = Mock()
    monkeypatch.setattr(worker, "run_inference", inference)
    monkeypatch.setattr(sys, "argv", ["heart", "audio.wav", "--device", device, "--model-path", str(tmp_path)])
    worker.main()
    assert inference.call_args.args[0].device == device
