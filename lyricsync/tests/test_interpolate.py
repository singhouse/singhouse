# SPDX-License-Identifier: MIT
"""Tests for run-aware placement of unmatched reference words."""

import pytest

from lyricsync._config import PostProcessConfig
from lyricsync._types import PlainLyricsReference, TimedWord
from lyricsync.alignment._interpolate import fill_unmatched_words
from lyricsync.alignment.needleman_wunsch import NeedlemanWunschAligner

POST = PostProcessConfig()
NOMINAL = POST.per_word_singing_duration


def _timing(pairs):
    return {i: {"start": s, "end": e} for i, (s, e) in pairs.items()}


class TestFillUnmatchedWords:
    def test_matched_words_pass_through(self):
        words = ["a", "b"]
        out = fill_unmatched_words(
            words, _timing({0: (1.0, 1.5), 1: (1.5, 2.0)}), [0], POST,
        )
        assert [(w.start, w.end) for w in out] == [(1.0, 1.5), (1.5, 2.0)]
        assert not any(w.interpolated for w in out)

    def test_phrase_initial_word_hugs_next_match_across_big_gap(self):
        # "wind | I know" — "I" opens the same line as matched "know", with a
        # 30s instrumental gap before it. It must right-align to "know", not
        # spread into the solo (the old gap*0.1/0.9 behaviour).
        words = ["wind", "I", "know"]
        line_starts = [0, 1]  # "wind" / "I know"
        out = fill_unmatched_words(
            words, _timing({0: (79.6, 80.2), 2: (110.1, 110.7)}), line_starts, POST,
        )
        assert out[1].interpolated
        assert out[1].end == pytest.approx(110.1)
        assert out[1].start == pytest.approx(110.1 - NOMINAL)

    def test_phrase_final_word_hugs_prev_match(self):
        # "hello world extra | next" — "extra" closes the first line; the next
        # matched word starts a different line far away. Left-align.
        words = ["hello", "world", "extra", "next"]
        line_starts = [0, 3]
        out = fill_unmatched_words(
            words, _timing({0: (1.0, 1.4), 1: (1.4, 1.8), 3: (30.0, 30.4)}),
            line_starts, POST,
        )
        assert out[2].interpolated
        assert out[2].start == pytest.approx(1.8)
        assert out[2].end == pytest.approx(1.8 + NOMINAL)

    def test_tight_gap_divides_evenly_without_stacking(self):
        # "fly [a thousand] miles" — 0.7s gap, two unmatched words. The old
        # code gave both the identical span; they must be sequential now.
        words = ["fly", "a", "thousand", "miles"]
        out = fill_unmatched_words(
            words, _timing({0: (1.0, 1.3), 3: (2.0, 2.4)}), [0], POST,
        )
        a, thousand = out[1], out[2]
        assert a.interpolated and thousand.interpolated
        assert a.start == pytest.approx(1.3)
        assert a.end == pytest.approx(thousand.start)
        assert thousand.end == pytest.approx(2.0)
        assert a.end - a.start == pytest.approx(0.35)

    def test_wholly_missed_line_centers_in_gap(self):
        words = ["one", "two", "gone", "away", "three"]
        line_starts = [0, 2, 4]  # "one two" / "gone away" / "three"
        out = fill_unmatched_words(
            words, _timing({0: (1.0, 1.5), 1: (1.5, 2.0), 4: (42.0, 42.5)}),
            line_starts, POST,
        )
        run = out[2:4]
        mid = (2.0 + 42.0) / 2
        assert run[0].start == pytest.approx(mid - NOMINAL)
        assert run[1].end == pytest.approx(mid + NOMINAL)
        assert run[0].end == pytest.approx(run[1].start)

    def test_run_stays_inside_anchor_window(self):
        words = ["a", "x", "y", "z", "b"]
        out = fill_unmatched_words(
            words, _timing({0: (5.0, 5.5), 4: (50.0, 50.5)}), [0], POST,
        )
        starts = [w.start for w in out]
        assert starts == sorted(starts)
        for w in out[1:4]:
            assert 5.5 <= w.start < w.end <= 50.0

    def test_no_next_anchor_places_sequentially_after_prev(self):
        words = ["a", "x", "y"]
        out = fill_unmatched_words(words, _timing({0: (1.0, 1.5)}), [0], POST)
        assert out[1].start == pytest.approx(1.5)
        assert out[1].end == pytest.approx(out[2].start)
        assert out[2].end == pytest.approx(1.5 + 2 * NOMINAL)

    def test_no_prev_anchor_ends_at_next(self):
        words = ["x", "y", "a"]
        out = fill_unmatched_words(words, _timing({2: (3.0, 3.5)}), [0], POST)
        assert out[1].end == pytest.approx(3.0)
        assert out[0].start == pytest.approx(max(0.0, 3.0 - 2 * NOMINAL))

    def test_no_anchors_at_all(self):
        words = ["x", "y"]
        out = fill_unmatched_words(words, {}, [0], POST)
        assert out[0].start == 0.0
        assert out[1].end == pytest.approx(2 * NOMINAL)

    def test_never_negative(self):
        words = ["x", "a"]
        out = fill_unmatched_words(words, _timing({1: (0.1, 0.5)}), [0], POST)
        assert out[0].start >= 0.0

    def test_zero_gap_word_gets_floor_duration(self):
        # "through [And] it" — matched neighbours are contiguous (Heart tiles
        # time), so the old tight-gap division produced a 0.00s "instant"
        # word. It must now borrow from the previous tail: floor duration,
        # ending exactly at the next matched start.
        words = ["through", "And", "it"]
        out = fill_unmatched_words(
            words, _timing({0: (11.2, 11.8), 2: (11.8, 12.1)}), [0, 1], POST,
        )
        w = out[1]
        assert w.interpolated
        assert w.end == pytest.approx(11.8)
        assert w.end - w.start == pytest.approx(POST.min_word_duration)

    def test_zero_gap_run_sequential_not_stacked(self):
        words = ["a", "x", "y", "b"]
        out = fill_unmatched_words(
            words, _timing({0: (5.0, 5.6), 3: (5.6, 6.0)}), [0], POST,
        )
        x, y = out[1], out[2]
        assert y.end == pytest.approx(5.6)
        assert x.end == pytest.approx(y.start)
        assert x.end - x.start == pytest.approx(POST.min_word_duration)
        assert y.end - y.start == pytest.approx(POST.min_word_duration)

    def test_matched_tiny_whisper_word_end_floored(self):
        # Heart emits 20-60ms words ('it' 20.08→20.14); the floor extends
        # the end (starts are the trusted edge, ends are cosmetic).
        words = ["it", "is"]
        out = fill_unmatched_words(
            words, _timing({0: (20.08, 20.14), 1: (21.0, 21.4)}), [0], POST,
        )
        assert out[0].start == pytest.approx(20.08)
        assert out[0].end == pytest.approx(20.08 + POST.min_word_duration)

    def test_borrow_never_inverts_start_order(self):
        # Pathological: previous matched word is itself tiny (floored), and
        # the zero-gap run would borrow past its start. Starts must stay
        # strictly increasing even if the floor can't be honoured.
        words = ["a", "x", "b"]
        out = fill_unmatched_words(
            words, _timing({0: (10.0, 10.02), 2: (10.02, 10.4)}), [0], POST,
        )
        starts = [w.start for w in out]
        assert starts == sorted(starts)
        assert len(set(starts)) == len(starts)


class TestNeedlemanWunschIntegration:
    def test_post_solo_line_start_not_dragged_into_gap(self):
        # End-to-end: whisper missed "I" after a 30s solo; the aligned line
        # "I know a man" must start near 110, not 3s after the prior phrase.
        whisper = [
            TimedWord(text="the", start=79.0, end=79.6),
            TimedWord(text="wind", start=79.6, end=80.2),
            TimedWord(text="know", start=110.1, end=110.7),
            TimedWord(text="a", start=110.7, end=110.9),
            TimedWord(text="man", start=110.9, end=111.3),
        ]
        ref = PlainLyricsReference(lines=["the wind", "I know a man"])
        result = NeedlemanWunschAligner().align(whisper, ref)
        line2 = result.lines[1]
        assert line2[0].text == "I"
        assert line2[0].start >= 109.0
        assert line2[0].end == pytest.approx(110.1)

    def test_interpolated_run_not_stacked(self):
        whisper = [
            TimedWord(text="fly", start=1.0, end=1.3),
            TimedWord(text="miles", start=2.0, end=2.4),
        ]
        ref = PlainLyricsReference(lines=["fly a thousand miles"])
        result = NeedlemanWunschAligner().align(whisper, ref)
        words = result.lines[0]
        spans = [(w.start, w.end) for w in words]
        assert len(set(spans)) == len(spans), f"stacked spans: {spans}"
        starts = [w.start for w in words]
        assert starts == sorted(starts)
