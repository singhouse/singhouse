# SPDX-License-Identifier: MIT
"""Tests for alignment methods."""

import pytest

from lyricsync._types import (
    LrcLine,
    LrcReference,
    PlainLyricsReference,
    TimedWord,
)
from lyricsync.alignment.lrc import parse_lrc, strip_lrc_tags
from lyricsync.alignment.lrc_anchored import LrcAnchoredAligner
from lyricsync.alignment.needleman_wunsch import NeedlemanWunschAligner


class TestParseLrc:
    def test_basic(self):
        lrc = "[00:01.00]Hello world\n[00:03.50]This is a test"
        lines = parse_lrc(lrc)
        assert len(lines) == 2
        assert lines[0].time == pytest.approx(1.0)
        assert lines[0].text == "Hello world"
        assert lines[1].time == pytest.approx(3.5)

    def test_milliseconds(self):
        lrc = "[01:23.456]Testing"
        lines = parse_lrc(lrc)
        assert len(lines) == 1
        assert lines[0].time == pytest.approx(83.456)

    def test_no_milliseconds(self):
        lrc = "[00:10]No ms"
        lines = parse_lrc(lrc)
        assert lines[0].time == pytest.approx(10.0)

    def test_empty_lines_skipped(self):
        lrc = "[00:01.00]\n[00:02.00]Hello"
        lines = parse_lrc(lrc)
        assert len(lines) == 1

    def test_sorting(self):
        lrc = "[00:05.00]Second\n[00:01.00]First"
        lines = parse_lrc(lrc)
        assert lines[0].text == "First"
        assert lines[1].text == "Second"


class TestStripLrcTags:
    def test_removes_tags(self):
        assert strip_lrc_tags("hello [00:56.07] world") == "hello  world"

    def test_no_tags(self):
        assert strip_lrc_tags("hello world") == "hello world"


class TestNeedlemanWunschAligner:
    def test_exact_match(self):
        whisper = [
            TimedWord(text="hello", start=0.0, end=0.5),
            TimedWord(text="world", start=0.6, end=1.0),
        ]
        ref = PlainLyricsReference(lines=["hello world"])
        aligner = NeedlemanWunschAligner()
        result = aligner.align(whisper, ref)

        assert result.metadata.words_total == 2
        assert result.metadata.words_matched == 2
        assert len(result.lines) == 1
        assert result.lines[0][0].text == "hello"
        assert result.lines[0][1].text == "world"

    def test_case_insensitive(self):
        whisper = [TimedWord(text="Hello", start=0.0, end=0.5)]
        ref = PlainLyricsReference(lines=["hello"])
        result = NeedlemanWunschAligner().align(whisper, ref)
        assert result.metadata.words_matched == 1

    def test_interpolation_for_unmatched(self):
        whisper = [
            TimedWord(text="hello", start=0.0, end=0.5),
            TimedWord(text="test", start=2.0, end=2.5),
        ]
        ref = PlainLyricsReference(lines=["hello world test"])
        result = NeedlemanWunschAligner().align(whisper, ref)
        # "world" should be interpolated between hello and test
        assert result.metadata.words_interpolated >= 1

    def test_extra_whisper_words_discarded(self):
        whisper = [
            TimedWord(text="yeah", start=0.0, end=0.3),
            TimedWord(text="hello", start=0.4, end=0.8),
            TimedWord(text="world", start=0.9, end=1.2),
        ]
        ref = PlainLyricsReference(lines=["hello world"])
        result = NeedlemanWunschAligner().align(whisper, ref)
        assert result.metadata.words_matched == 2

    def test_requires_plain_reference(self):
        whisper = [TimedWord(text="hello", start=0.0, end=0.5)]
        lrc_ref = LrcReference(lines=[LrcLine(time=0.0, text="hello")])
        with pytest.raises(TypeError):
            NeedlemanWunschAligner().align(whisper, lrc_ref)


class TestLrcAnchoredAligner:
    def test_basic_lrc_alignment(self):
        whisper = [
            TimedWord(text="hello", start=0.0, end=0.5),
            TimedWord(text="world", start=1.0, end=1.5),
        ]
        lrc = LrcReference(lines=[
            LrcLine(time=0.0, text="hello"),
            LrcLine(time=1.0, text="world"),
        ])
        result = LrcAnchoredAligner().align(whisper, lrc)
        assert result.metadata.words_total == 2
        assert len(result.lines) == 2

    def test_even_distribution_fallback(self):
        # Gibberish whisper words — quality will be low
        whisper = [
            TimedWord(text="xyz", start=0.0, end=0.5),
            TimedWord(text="abc", start=1.0, end=1.5),
        ]
        lrc = LrcReference(lines=[
            LrcLine(time=0.0, text="hello world"),
            LrcLine(time=2.0, text="foo bar"),
        ])
        result = LrcAnchoredAligner().align(whisper, lrc)
        # Should fall back to even distribution
        assert result.metadata.method == "lrc-distributed"

    def test_requires_lrc_reference(self):
        whisper = [TimedWord(text="hello", start=0.0, end=0.5)]
        plain_ref = PlainLyricsReference(lines=["hello"])
        with pytest.raises(TypeError):
            LrcAnchoredAligner().align(whisper, plain_ref)

    def test_monotonic_timestamps(self):
        whisper = [
            TimedWord(text="one", start=0.0, end=0.5),
            TimedWord(text="two", start=1.0, end=1.5),
            TimedWord(text="three", start=2.0, end=2.5),
        ]
        lrc = LrcReference(lines=[
            LrcLine(time=0.0, text="one"),
            LrcLine(time=1.0, text="two"),
            LrcLine(time=2.0, text="three"),
        ])
        result = LrcAnchoredAligner().align(whisper, lrc)
        # All timestamps should be monotonically non-decreasing
        all_words = [w for line in result.lines for w in line]
        for i in range(len(all_words) - 1):
            assert all_words[i].start <= all_words[i + 1].start
