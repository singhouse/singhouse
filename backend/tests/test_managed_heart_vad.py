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


@pytest.mark.parametrize("sample_width", [2, 4])
def test_child_uses_identical_rms_segmentation(tmp_path, sample_width):
    rate = 16000
    dtype = np.int16 if sample_width == 2 else np.int32
    samples = np.zeros(rate * 8, dtype=dtype)
    samples[rate:rate * 3] = (10000 * np.sin(np.arange(rate * 2) * .1)).astype(np.int16)
    samples[rate * 5:rate * 7] = samples[rate:rate * 3]
    audio = tmp_path / "fixture.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(sample_width)
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


def test_managed_vad_supports_float_stereo_wav(tmp_path):
    import soundfile
    rate = 16000
    signal = np.zeros(rate * 8, dtype=np.float32)
    signal[rate:rate * 3] = .3 * np.sin(np.arange(rate * 2) * .1)
    signal[rate * 5:rate * 7] = signal[rate:rate * 3]
    stereo = np.stack([signal, signal * .5], axis=1)
    audio = tmp_path / "managed-vocals.wav"
    soundfile.write(audio, stereo, rate, subtype="FLOAT")
    assert soundfile.info(audio).subtype == "FLOAT"
    config = VadConfig()
    expected = rms_vad_segments(stereo.mean(axis=1), rate, config)
    assert expected
    assert worker.managed_vad_segments(str(audio), json.dumps(asdict(config))) == expected


def test_managed_float_decoder_is_never_called_before_admission(monkeypatch, tmp_path):
    import soundfile
    active = False
    @contextmanager
    def admit(*args):
        nonlocal active
        active = True
        try:
            yield "cpu"
        finally:
            active = False
    calls = []
    def decode(*args, **kwargs):
        assert active
        assert kwargs == {"dtype": "float32", "always_2d": True}
        calls.append(args[0])
        return np.zeros((32000, 2), dtype=np.float32), 16000
    monkeypatch.setattr(memory_admission, "admit", admit)
    monkeypatch.setattr(soundfile, "read", decode)
    monkeypatch.setattr(worker, "run_inference", Mock())
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setattr(sys, "argv", ["heart", "audio.wav", "--device", "cuda", "--model-path", str(tmp_path), "--managed-vad-config", "{}"])
    worker.main()
    assert calls == ["audio.wav"]
    assert not active
