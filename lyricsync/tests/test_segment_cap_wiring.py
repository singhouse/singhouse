# SPDX-License-Identifier: MIT
"""How the maximum VAD segment length reaches each transcriber."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from lyricsync._config import VadConfig


def _heart_argv(tmp_path: Path, vad_config: VadConfig | None, *, use_vad: bool = True):
    from lyricsync.transcription import heart as heart_mod

    python_path = tmp_path / "python"
    python_path.write_text("")
    script_path = tmp_path / "script.py"
    script_path.write_text("")
    transcriber = heart_mod.HeartTranscriber(
        python_path=python_path, script_path=script_path,
        use_vad=use_vad, vad_config=vad_config,
    )
    captured: dict = {}

    class FakePopen:
        returncode = 0
        pid = 12345

        def __init__(self, cmd, **kwargs):
            captured["cmd"] = cmd

        def communicate(self, timeout=None):
            return ('{"segments": [], "language": "en", "full_text": ""}', "")

    with patch("lyricsync.audio.io.read_wav_mono", return_value=([0.0] * 16000, 16000)), \
            patch("lyricsync.audio.vad.rms_vad_segments", return_value=[(0.0, 1.0)]), \
            patch.object(heart_mod.subprocess, "Popen", FakePopen):
        transcriber.transcribe(str(tmp_path / "audio.wav"))
    return captured["cmd"]


def _flag(cmd: list[str]) -> str | None:
    if "--max-segment-seconds" not in cmd:
        return None
    return cmd[cmd.index("--max-segment-seconds") + 1]


@pytest.mark.parametrize("vad_config", [None, VadConfig()])
def test_heart_passes_auto_when_the_cap_is_unset(tmp_path: Path, vad_config):
    cmd = _heart_argv(tmp_path, vad_config)
    assert "--vad-segments" in cmd
    assert _flag(cmd) == "auto"


def test_heart_passes_an_explicit_cap_through(tmp_path: Path):
    cmd = _heart_argv(tmp_path, VadConfig(max_segment_duration=15.0))
    assert float(_flag(cmd)) == 15.0
    cmd = _heart_argv(tmp_path, VadConfig(max_segment_duration=22.5))
    assert float(_flag(cmd)) == 22.5


def test_heart_without_vad_sends_no_cap(tmp_path: Path):
    cmd = _heart_argv(tmp_path, None, use_vad=False)
    assert "--vad-segments" not in cmd
    assert _flag(cmd) is None


def _faster_whisper_vad_config(vad_config: VadConfig | None) -> VadConfig:
    from lyricsync.transcription import faster_whisper as fw_mod

    transcriber = object.__new__(fw_mod.FasterWhisperTranscriber)
    transcriber.allow_temperature_fallback = False
    seen: dict = {}

    def fake_vad(samples, sr, config):
        seen["config"] = config
        return []

    with patch.object(fw_mod, "read_wav_mono", return_value=([0.0] * 16000, 16000)), \
            patch.object(fw_mod, "rms_vad_segments", side_effect=fake_vad):
        transcriber.transcribe("ignored.wav", language="en", vad_config=vad_config)
    return seen["config"]


def test_faster_whisper_treats_auto_as_the_fixed_safe_cap():
    from lyricsync.audio.vad import SAFE_MAX_SEGMENT_DURATION

    assert SAFE_MAX_SEGMENT_DURATION == 15.0
    assert _faster_whisper_vad_config(None).max_segment_duration == 15.0
    cfg = _faster_whisper_vad_config(VadConfig(onset_threshold=0.05))
    assert cfg.max_segment_duration == 15.0
    assert cfg.onset_threshold == 0.05


def test_faster_whisper_keeps_an_explicit_cap():
    cfg = _faster_whisper_vad_config(VadConfig(max_segment_duration=25.0))
    assert cfg.max_segment_duration == 25.0
