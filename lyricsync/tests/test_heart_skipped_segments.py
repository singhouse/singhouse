# SPDX-License-Identifier: MIT
"""HeartTranscriber surfaces runner-skipped VAD segments as a warning.

The runner script isolates a VAD segment whose decode raised and reports it in
``skipped_segments``; the transcription still succeeds with the other segments.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from lyricsync._types import TranscriptionResult
from lyricsync.transcription.heart import HeartTranscriber

_SEGMENTS = [{
    "start": 1.0, "end": 1.5, "text": "hello",
    "words": [{"word": "hello", "start": 1.0, "end": 1.5}],
}]


def _fake_runner(tmp_path: Path, payload: dict) -> Path:
    script = tmp_path / "fake_heart.py"
    script.write_text(f"import json\nprint(json.dumps({payload!r}))\n")
    return script


def _run(tmp_path: Path, payload: dict) -> TranscriptionResult:
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"")
    t = HeartTranscriber(sys.executable, _fake_runner(tmp_path, payload), use_vad=False)
    return t.transcribe(str(audio))


def test_skipped_segments_are_logged_as_a_warning(tmp_path, caplog):
    payload = {
        "segments": _SEGMENTS, "language": "en", "transcriber": "heart",
        "full_text": "hello",
        "skipped_segments": [{"index": 3, "start": 20.0, "end": 23.6,
                              "error": "IndexError: string index out of range"}],
    }
    with caplog.at_level(logging.WARNING, logger="lyricsync.transcription.heart"):
        result = _run(tmp_path, json.loads(json.dumps(payload)))

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    msg = warnings[0].getMessage()
    assert "skipped 1 VAD segment" in msg
    assert "seg 4 [20.0s-23.6s] IndexError: string index out of range" in msg

    assert isinstance(result, TranscriptionResult)
    assert [w.text for s in result.segments for w in s.words] == ["hello"]
    assert result.full_text == "hello"


def test_clean_result_logs_no_warning(tmp_path, caplog):
    payload = {"segments": _SEGMENTS, "language": "en", "transcriber": "heart",
               "full_text": "hello"}
    with caplog.at_level(logging.WARNING, logger="lyricsync.transcription.heart"):
        result = _run(tmp_path, payload)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert [w.text for s in result.segments for w in s.words] == ["hello"]


def test_malformed_skip_entries_never_fail_the_transcription(tmp_path, caplog):
    payload = {"segments": _SEGMENTS, "language": "en", "transcriber": "heart",
               "full_text": "hello", "skipped_segments": [{"start": 1.0}, None]}
    with caplog.at_level(logging.WARNING, logger="lyricsync.transcription.heart"):
        result = _run(tmp_path, payload)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "count: 2; details unreadable" in warnings[0].getMessage()
    assert [w.text for s in result.segments for w in s.words] == ["hello"]
