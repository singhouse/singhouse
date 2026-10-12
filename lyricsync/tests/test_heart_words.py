# SPDX-License-Identifier: MIT
"""Synthetic no-reference output: no audio/model download or lyric corpus."""
import json
import sys

import pytest

from lyricsync._types import TimedWord
from lyricsync.transcription._heart_words import normalize_heart_words
from lyricsync.transcription.heart import HeartTranscriber


@pytest.mark.parametrize('parts,expected', [
    (["don", "'", "t"], "don't"),
    (["we", "'re"], "we're"),
    (["I", "＇", "m"], "I'm"),
    (["they", "’", "ve"], "they’ve"),
])
def test_contraction_preserves_full_timing(parts, expected):
    words = [TimedWord(text, i * .1, (i + 1) * .1) for i, text in enumerate(parts)]
    result = normalize_heart_words(words)
    assert result == [TimedWord(expected, 0, len(parts) * .1)]
    assert [w.text for w in words] == parts  # caller-owned evidence stays intact


def test_keeps_multilingual_quotes_and_pauses():
    parts = ["안녕하세요", "café", "東京", "rock", "'", "roll", "we", "'re"]
    words = [TimedWord(text, i, i + .2) for i, text in enumerate(parts)]
    assert normalize_heart_words(words) == words


def test_overlapping_suffix_does_not_shrink_timing():
    assert normalize_heart_words([
        TimedWord("we", 1, 2), TimedWord("'re", 1.5, 1.7, True),
    ]) == [TimedWord("we're", 1, 2, True)]


def test_no_reference_subprocess_output(tmp_path):
    segments = [
        {"start": 1, "end": 2, "text": "don ＇ t café 안녕", "words": [
            {"word": "don", "start": 1, "end": 1.2},
            {"word": "＇", "start": 1.2, "end": 1.2},
            {"word": "t", "start": 1.2, "end": 1.4},
            {"word": "café", "start": 1.4, "end": 1.7},
            {"word": "안녕", "start": 1.7, "end": 2},
        ]},
        {"start": 3, "end": 4, "text": "we", "words": [
            {"word": "we", "start": 3, "end": 4},
        ]},
        {"start": 4, "end": 5, "text": "'re", "words": [
            {"word": "'re", "start": 4, "end": 5},
        ]},
    ]
    script = tmp_path / 'runner.py'
    script.write_text('print(' + repr(json.dumps({"segments": segments, "language": "en"})) + ')')
    result = HeartTranscriber(sys.executable, script, use_vad=False).transcribe('synthetic.wav')
    assert result.segments[0].text == "don ' t café 안녕"
    assert result.segments[0].words[0] == TimedWord("don't", 1, 1.4)
    assert [w.text for s in result.segments for w in s.words] == ["don't", "café", "안녕", "we", "'re"]

    # Evaluate the same no-reference path that supplies renderer word spans.
    from lyricsync._pipeline import SyncPipeline
    synced = SyncPipeline(transcriber=None).align_only(result)
    assert synced.metadata.method == "whisper-only"
    assert [w.text for line in synced.lines for w in line] == ["don't", "café", "안녕", "we", "'re"]
    assert synced.segments[0]["words"][0] == {"text": "don't", "start": 1, "end": 1.4}


def test_mixed_script_decoder_spacing_is_preserved(tmp_path):
    parts = ["東京", "で", "I", "＇", "m"]
    payload = {
        "segments": [{"start": 0, "end": .5, "text": "東京でI＇m。", "words": [
            {"word": text, "start": i * .1, "end": (i + 1) * .1}
            for i, text in enumerate(parts)
        ]}],
        "full_text": "東京でI＇m。",
    }
    script = tmp_path / 'runner.py'
    script.write_text('print(' + repr(json.dumps(payload)) + ')')
    result = HeartTranscriber(sys.executable, script, use_vad=False).transcribe('synthetic.wav')
    assert result.segments[0].text == "東京でI'm。"
    assert result.full_text == "東京でI'm。"
    assert [w.text for w in result.segments[0].words] == ["東京", "で", "I'm"]
