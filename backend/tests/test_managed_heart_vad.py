# SPDX-License-Identifier: AGPL-3.0-only
"""Managed RMS VAD stays inside memory admission without changing segmentation."""
from contextlib import contextmanager
from dataclasses import asdict
import json
from pathlib import Path
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
    def admit(*args, **kwargs):
        assert kwargs == {"unmeasured_cuda": None}  # managed VAD greedy decode was measured
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
    def admit(*args, **kwargs):
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


@pytest.mark.parametrize("extra,expected", [
    ([], "whole-file transcription without voice activity detection"),
    (["--temperature-fallback"], "whole-file transcription without voice activity detection"),
    (["--managed-vad-config", "{}", "--temperature-fallback"], "transcription with temperature fallback"),
    (["--managed-vad-config", "{}"], None),
])
def test_unmeasured_heart_paths_are_routed_away_from_cuda(monkeypatch, tmp_path, extra, expected):
    seen = {}
    @contextmanager
    def admit(model, requested, paths, **kwargs):
        seen.update(requested=requested, **kwargs)
        yield "cpu" if kwargs["unmeasured_cuda"] else requested
    monkeypatch.setattr(memory_admission, "admit", admit)
    monkeypatch.setattr(worker, "managed_vad_segments", lambda *args: [])
    inference = Mock()
    monkeypatch.setattr(worker, "run_inference", inference)
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setattr(sys, "argv", ["heart", "audio.wav", "--device", "cuda", "--model-path", str(tmp_path), *extra])
    worker.main()
    assert seen == {"requested": "cuda", "unmeasured_cuda": expected}
    assert inference.call_args.args[0].device == ("cpu" if expected else "cuda")


def test_unmeasured_heart_path_selects_cpu_through_real_admission(monkeypatch, tmp_path, capsys):
    from types import SimpleNamespace
    policy = {"schema": 1, "executionProfile": "bounded-v1", "evidenceReference": "synthetic-test-only",
              "models": {"heart-transcriptor": {"maxDurationSeconds": 60, "maxSampleRate": 48000, "maxChannels": 2,
                                                "devices": {"cuda": {"ramBytes": 1, "vramBytes": 1},
                                                            "cpu": {"ramBytes": 1}}}}}
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setattr(memory_admission, "available_ram", lambda: 10)
    monkeypatch.setattr(memory_admission, "cuda_free", lambda: pytest.fail("unmeasured CUDA path queried the GPU"))
    monkeypatch.setitem(sys.modules, "soundfile", SimpleNamespace(
        info=lambda _: SimpleNamespace(duration=30, samplerate=44100, channels=2)))
    inference = Mock()
    monkeypatch.setattr(worker, "run_inference", inference)
    monkeypatch.setattr(sys, "argv", ["heart", "audio.wav", "--device", "cuda", "--model-path", str(tmp_path)])
    worker.main()
    assert inference.call_args.args[0].device == "cpu"
    [line] = [line for line in capsys.readouterr().err.splitlines() if memory_admission.parse_device_line(line)]
    record = memory_admission.parse_device_line(line)
    assert record["reason"] == "unmeasured-path"
    assert memory_admission.describe_device_selection(record, "Transcribing vocals") == (
        "Transcribing vocals on the CPU because whole-file transcription without voice activity detection "
        "has not been qualified on the GPU; this is slower")


def test_vad_config_from_newer_app_ignores_unknown_fields():
    values = {**asdict(VadConfig()), "field_added_in_a_later_release": 3}
    assert worker.vad_config_from_json(json.dumps(values)) == VadConfig()
    with pytest.raises(ValueError):
        worker.vad_config_from_json("[]")


def test_parent_receives_device_line_while_child_runs(tmp_path):
    script = tmp_path / "child.py"
    script.write_text(
        "import json, sys, time\n"
        "sys.stderr.write('progress\\r50%\\rdone\\n')\n"
        "sys.stderr.write(" + repr(memory_admission.device_line("heart-transcriptor", "cuda", "cpu", "insufficient-vram")) + " + '\\n')\n"
        "sys.stderr.flush()\n"
        "marker = sys.argv[1] + '.seen'\n"
        "deadline = time.monotonic() + 10\n"
        "import os\n"
        "while not os.path.exists(marker) and time.monotonic() < deadline:\n"
        "    time.sleep(0.02)\n"
        "sys.stderr.write('tail without newline')\n"
        "print(json.dumps({'segments': []}))\n"
    )
    audio = tmp_path / "audio.wav"
    lines = []
    def on_line(line):
        lines.append(line)
        if memory_admission.parse_device_line(line):
            # The child waits for this marker, so delivery must happen mid-run.
            Path(str(audio) + ".seen").touch()
    transcriber = HeartTranscriber(sys.executable, script, use_vad=False, timeout=20, on_stderr_line=on_line)
    transcriber.transcribe(str(audio))
    assert lines[:3] == ["progress", "50%", "done"]
    assert memory_admission.parse_device_line(lines[3])["device"] == "cpu"
    assert lines[4:] == ["tail without newline"]


def _silent_wav(path, seconds, rate=8000):
    import soundfile
    soundfile.write(path, np.zeros(int(seconds * rate), dtype=np.int16), rate, subtype="PCM_16")
    return path


SEGMENT_PREFIX = "transcription of supplied segments with "


@pytest.mark.parametrize("segments,problem", [
    ([[0, 10], [12, 20]], None),
    ([[0, 15]], None),
    ([], None),
    ([[0, 600]], "a segment past the end of the audio"),
    ([[0, 16]], "a segment longer than the measured 15 seconds"),
    ([[0, 5], [4, 8]], "overlapping or unordered segments"),
    ([[6, 8], [0, 5]], "overlapping or unordered segments"),
    ([[5, 5]], "overlapping or unordered segments"),
    ([[-1, 2]], "overlapping or unordered segments"),
    ([[0, float("nan")]], "a non-finite boundary"),
    ([[0, float("inf")]], "a non-finite boundary"),
    ([[0, "5"]], "a malformed segment"),
    ([[0, 5, 6]], "a malformed segment"),
    ([[True, 5]], "a malformed segment"),
    ({"start": 0, "end": 5}, "a malformed segment list"),
])
def test_supplied_segments_outside_the_measured_profile_use_the_cpu(monkeypatch, tmp_path, segments, problem):
    audio = _silent_wav(tmp_path / "vocals.wav", 20)
    segment_file = tmp_path / "segments.json"
    segment_file.write_text(json.dumps(segments))
    seen = {}
    @contextmanager
    def admit(model, requested, paths, **kwargs):
        seen.update(kwargs)
        yield "cpu" if kwargs["unmeasured_cuda"] else requested
    monkeypatch.setattr(memory_admission, "admit", admit)
    inference = Mock()
    monkeypatch.setattr(worker, "run_inference", inference)
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setattr(sys, "argv", ["heart", str(audio), "--device", "cuda", "--model-path", str(tmp_path),
                                      "--vad-segments", str(segment_file)])
    worker.main()
    assert seen == {"unmeasured_cuda": None if problem is None else SEGMENT_PREFIX + problem}
    assert inference.call_args.args[0].device == ("cuda" if problem is None else "cpu")


def test_unreadable_supplied_segments_are_unmeasured(tmp_path):
    from types import SimpleNamespace
    audio = _silent_wav(tmp_path / "vocals.wav", 20)
    args = SimpleNamespace(managed_vad_config=None, vad_segments=str(tmp_path / "missing.json"),
                           audio_path=str(audio), temperature_fallback=False)
    assert worker.unmeasured_gpu_path(args) == SEGMENT_PREFIX + "unreadable segments or audio"
    (tmp_path / "segments.json").write_text("[[0, 5]]")
    args.vad_segments, args.audio_path = str(tmp_path / "segments.json"), str(tmp_path / "missing.wav")
    assert worker.unmeasured_gpu_path(args) == SEGMENT_PREFIX + "unreadable segments or audio"


def test_measured_segments_with_temperature_fallback_remain_unmeasured(tmp_path):
    from types import SimpleNamespace
    audio = _silent_wav(tmp_path / "vocals.wav", 20)
    (tmp_path / "segments.json").write_text("[[0, 5]]")
    args = SimpleNamespace(managed_vad_config=None, vad_segments=str(tmp_path / "segments.json"),
                           audio_path=str(audio), temperature_fallback=True)
    assert worker.unmeasured_gpu_path(args) == "transcription with temperature fallback"


@pytest.mark.parametrize("configuration,expected", [
    ({}, None),
    (asdict(VadConfig()), None),
    ({**asdict(VadConfig()), "field_added_in_a_later_release": 3}, None),
    ({"max_segment_duration": 30.0}, "transcription with a non-default voice activity configuration"),
    ({"onset_threshold": 0.001}, "transcription with a non-default voice activity configuration"),
])
def test_only_the_measured_managed_vad_configuration_is_admitted_on_cuda(configuration, expected):
    from types import SimpleNamespace
    args = SimpleNamespace(managed_vad_config=json.dumps(configuration), vad_segments=None,
                           audio_path="unread.wav", temperature_fallback=False)
    assert worker.unmeasured_gpu_path(args) == expected


def test_overlong_supplied_segment_selects_cpu_through_real_admission(monkeypatch, tmp_path, capsys):
    policy = {"schema": 1, "executionProfile": "bounded-v1", "evidenceReference": "synthetic-test-only",
              "models": {"heart-transcriptor": {"maxDurationSeconds": 60, "maxSampleRate": 48000, "maxChannels": 2,
                                                "devices": {"cuda": {"ramBytes": 1, "vramBytes": 1},
                                                            "cpu": {"ramBytes": 1}}}}}
    audio = _silent_wav(tmp_path / "vocals.wav", 40)
    (tmp_path / "segments.json").write_text("[[0, 40]]")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setattr(memory_admission, "available_ram", lambda: 10)
    monkeypatch.setattr(memory_admission, "cuda_free", lambda: pytest.fail("unmeasured CUDA path queried the GPU"))
    inference = Mock()
    monkeypatch.setattr(worker, "run_inference", inference)
    monkeypatch.setattr(sys, "argv", ["heart", str(audio), "--device", "cuda", "--model-path", str(tmp_path),
                                      "--vad-segments", str(tmp_path / "segments.json")])
    worker.main()
    assert inference.call_args.args[0].device == "cpu"
    [line] = [line for line in capsys.readouterr().err.splitlines() if memory_admission.parse_device_line(line)]
    record = memory_admission.parse_device_line(line)
    assert record["reason"] == "unmeasured-path"
    assert record["detail"] == SEGMENT_PREFIX + "a segment longer than the measured 15 seconds"
