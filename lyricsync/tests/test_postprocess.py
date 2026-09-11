# SPDX-License-Identifier: MIT
"""Tests for line splitting in the no-reference (whisper-only) path."""

from lyricsync._config import PipelineConfig
from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment
from lyricsync.transcription._postprocess import (
    _split_words_into_lines,
    extract_whisper_lines,
)


def _w(text: str, start: float, end: float) -> TimedWord:
    return TimedWord(text=text, start=start, end=end)


class TestSplitWordsIntoLines:
    def test_punctuation_plus_capital(self):
        # "Hello!" then "World" should split — sentence-final + capital.
        words = [_w("Hello!", 0.0, 0.5), _w("World", 0.6, 1.0)]
        lines = _split_words_into_lines(words, gap_sec=2.0, max_words=20)
        assert [[w.text for w in ln] for ln in lines] == [["Hello!"], ["World"]]

    def test_punctuation_without_capital_does_not_split(self):
        # "Hello," (comma, not sentence-final) shouldn't split, even before
        # a capital — we want clauses to stay together.
        words = [_w("hello,", 0.0, 0.5), _w("world", 0.6, 1.0)]
        lines = _split_words_into_lines(words, gap_sec=2.0, max_words=20)
        assert len(lines) == 1

    def test_lowercase_then_capital_splits(self):
        # Whisper sometimes omits punctuation between sustained sung phrases.
        # "punk Hits" — prev fully lowercase, next starts capital → split.
        words = [_w("punk", 0.0, 0.5), _w("Hits", 0.6, 1.0)]
        lines = _split_words_into_lines(words, gap_sec=2.0, max_words=20)
        assert len(lines) == 2

    def test_proper_noun_does_not_split_after_capital(self):
        # "Yep Adam" — prev not fully lowercase, so no break on "Adam".
        words = [_w("Yep", 0.0, 0.5), _w("Adam", 0.6, 1.0)]
        lines = _split_words_into_lines(words, gap_sec=2.0, max_words=20)
        assert len(lines) == 1

    def test_gap_splits(self):
        words = [_w("end", 0.0, 0.5), _w("begin", 2.0, 2.5)]
        lines = _split_words_into_lines(words, gap_sec=0.5, max_words=20)
        assert len(lines) == 2

    def test_word_cap_splits(self):
        words = [_w(f"w{i}", i * 0.1, i * 0.1 + 0.05) for i in range(7)]
        lines = _split_words_into_lines(words, gap_sec=10.0, max_words=3)
        assert [len(ln) for ln in lines] == [3, 3, 1]

    def test_empty(self):
        assert _split_words_into_lines([], gap_sec=0.5, max_words=10) == []


class TestExtractWhisperLines:
    def test_no_segments_returns_empty(self):
        result = TranscriptionResult(segments=[])
        assert extract_whisper_lines(result, PipelineConfig()) == []

    def test_one_segment_with_sentences_splits_into_lines(self):
        # One whisper segment, three sentence-shaped lines inside it.
        words = [
            _w("Hello!", 0.0, 0.5),
            _w("World", 0.6, 1.0),
            _w("Goodbye.", 1.1, 1.6),
            _w("See", 1.7, 2.0),
            _w("you.", 2.1, 2.5),
        ]
        seg = TranscriptionSegment(start=0.0, end=2.5, text="", words=words)
        result = TranscriptionResult(segments=[seg])
        lines = extract_whisper_lines(result, PipelineConfig())
        # "Hello!" → break → "World Goodbye." → break → "See you."
        assert [" ".join(w.text for w in ln) for ln in lines] == [
            "Hello!",
            "World Goodbye.",
            "See you.",
        ]

    def test_filters_hallucinations_before_splitting(self):
        seg = TranscriptionSegment(
            start=0.0, end=1.0, text="thank you", words=[
                _w("thank", 0.0, 0.4), _w("you", 0.5, 1.0),
            ],
        )
        result = TranscriptionResult(segments=[seg])
        assert extract_whisper_lines(result, PipelineConfig()) == []
