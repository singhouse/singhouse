# SPDX-License-Identifier: MIT
"""Tests for CTC span fusion and boundary post-processing (pure numpy)."""

import numpy as np
import pytest
from lyricsync.alignment import ctc_fusion
from lyricsync.alignment.ctc_fusion import flag_low_confidence, fuse, hybrid, postprocess

NAN = np.nan


def _arr(rows):
    return np.array(rows, dtype=float)


def _no_pp(model_spans, voter):
    """Fusion with post-processing neutralised (no shift, no join, no tail)."""
    return fuse(model_spans, voter, start_shift=0.0, join_gap=-np.inf, tail_extend=0.0)


class TestFuseStarts:
    def test_median_over_all_start_voters(self):
        voter = _arr([[1.0, 1.4], [3.0, 3.4]])
        spans = {
            "hubl": _arr([[1.1, 1.5], [2.0, 2.5]]),
            "w2v2l": _arr([[1.2, 1.6], [2.1, 2.6]]),
            "hubxl": _arr([[1.3, 1.7], [2.2, 2.7]]),
            "phon": _arr([[1.4, 1.8], [2.3, 2.8]]),
        }
        r = _no_pp(spans, voter)
        assert r.applied
        # word 0: median(1.1, 1.2, 1.3, 1.4, 1.0) = 1.2; word 1: median(2.0..2.3, 3.0) = 2.2
        assert r.spans[:, 0] == pytest.approx([1.2, 2.2])
        assert r.start_voters == ["hubl", "w2v2l", "hubxl", "phon", "transcriber"]

    def test_nan_voters_are_ignored(self):
        voter = _arr([[1.0, 1.5], [2.0, 2.5]])
        spans = {
            "hubl": _arr([[1.1, 1.5], [NAN, NAN]]),
            "w2v2l": _arr([[1.3, 1.6], [2.3, 2.6]]),
            "hubxl": _arr([[NAN, NAN], [2.1, 2.7]]),
        }
        r = _no_pp(spans, voter)
        # word 0: median(1.1, 1.3, 1.0) = 1.1; word 1: median(2.3, 2.1, 2.0) = 2.1
        assert r.spans[:, 0] == pytest.approx([1.1, 2.1])

    def test_absent_phoneme_model_is_not_a_voter(self):
        voter = _arr([[0.0, 0.5]])
        spans = {m: _arr([[1.0, 1.5]]) for m in ("hubl", "w2v2l", "hubxl")}
        r = _no_pp(spans, voter)
        # median(1, 1, 1, 0) = 1.0 — four voters
        assert r.spans[0, 0] == pytest.approx(1.0)
        assert "phon" not in r.start_voters

    def test_starts_made_non_decreasing(self):
        voter = _arr([[2.0, 2.2], [1.0, 1.2], [3.0, 3.2]])
        spans = {m: voter.copy() for m in ("hubl", "w2v2l", "hubxl")}
        r = _no_pp(spans, voter)
        assert list(r.spans[:, 0]) == pytest.approx([2.0, 2.0, 3.0])
        assert np.all(np.diff(r.spans[:, 0]) >= 0)


class TestFuseEnds:
    def test_ends_use_character_models_only(self):
        voter = _arr([[1.0, 9.0], [5.0, 9.5]])
        spans = {
            "hubl": _arr([[1.0, 1.5], [5.0, 5.5]]),
            "w2v2l": _arr([[1.0, 1.7], [5.0, 5.7]]),
            "hubxl": _arr([[1.0, 1.9], [5.0, 5.9]]),
            "phon": _arr([[1.0, 4.0], [5.0, 8.0]]),
        }
        r = _no_pp(spans, voter)
        assert r.spans[:, 1] == pytest.approx([1.7, 5.7])
        assert r.end_voters == ["hubl", "w2v2l", "hubxl"]

    def test_end_clipped_to_next_start(self):
        voter = _arr([[1.0, 1.2], [2.0, 2.2]])
        spans = {m: _arr([[1.0, 2.6], [2.0, 2.4]]) for m in ("hubl", "w2v2l", "hubxl")}
        r = _no_pp(spans, voter)
        assert r.spans[0, 1] == pytest.approx(2.0)

    def test_end_never_before_start(self):
        # character models end the word before the (voter-dominated) fused start
        voter = _arr([[3.0, 3.1], [4.0, 4.1]])
        spans = {
            "hubl": _arr([[3.0, 3.1], [4.0, 4.1]]),
            "w2v2l": _arr([[1.5, 2.0], [4.0, 4.1]]),
            "hubxl": _arr([[1.5, 2.0], [4.0, 4.1]]),
            "phon": _arr([[3.0, 3.1], [4.0, 4.1]]),
        }
        r = _no_pp(spans, voter)
        assert r.spans[0, 0] == pytest.approx(3.0)   # median(3, 1.5, 1.5, 3, 3)
        assert r.spans[0, 1] == pytest.approx(3.0)   # character-model end 2.0 floored


class TestHybridAndPostprocess:
    def test_hybrid_clips_and_floors(self):
        q = hybrid(np.array([0.0, 1.0, 2.0]), np.array([1.5, 0.5, 3.0]))
        assert q.tolist() == [[0.0, 1.0], [1.0, 1.0], [2.0, 3.0]]

    def test_shift_applies_to_every_start(self):
        p = _arr([[1.0, 1.2], [2.0, 2.2]])
        q = postprocess(p, -0.05, 0.0, 0.0)
        assert q[:, 0] == pytest.approx([0.95, 1.95])

    def test_join_when_gap_within_g(self):
        p = _arr([[1.0, 1.8], [2.0, 2.5]])
        q = postprocess(p, 0.0, 0.3, 0.1)
        assert q[0, 1] == pytest.approx(2.0)   # gap 0.2 <= G -> runs up to the next start

    def test_tail_extend_when_gap_exceeds_g(self):
        p = _arr([[1.0, 1.2], [2.0, 2.5]])
        q = postprocess(p, 0.0, 0.3, 0.1)
        assert q[0, 1] == pytest.approx(1.3)   # gap 0.8 > G -> end + T
        assert q[1, 1] == pytest.approx(2.6)   # last word: next start is infinite

    def test_tail_extend_never_passes_next_start(self):
        p = _arr([[1.0, 1.9], [2.0, 2.5]])
        q = postprocess(p, 0.0, 0.0, 0.5)
        assert q[0, 1] == pytest.approx(2.0)

    def test_defaults(self):
        p = _arr([[1.0, 1.5], [2.0, 2.5]])
        q = postprocess(p)
        assert q[:, 0] == pytest.approx([0.98, 1.98])
        assert q[0, 1] == pytest.approx(1.7)
        assert q[1, 1] == pytest.approx(2.7)

    def test_fuse_applies_postprocess_and_clamps_at_zero(self):
        voter = _arr([[0.0, 0.3], [1.0, 1.3]])
        spans = {m: voter.copy() for m in ("hubl", "w2v2l", "hubxl")}
        r = fuse(spans, voter)
        assert r.spans[0, 0] == 0.0            # 0.0 - 0.02 clamped
        assert r.spans[1, 0] == pytest.approx(0.98)
        assert r.spans[0, 1] == pytest.approx(0.5)
        assert r.spans[1, 1] == pytest.approx(1.5)
        assert np.all(r.spans[:, 1] >= r.spans[:, 0])

    def test_fuse_matches_manual_pipeline(self):
        rng = np.random.default_rng(0)
        n = 40
        base = np.cumsum(rng.uniform(0.2, 0.8, n))
        voter = np.stack([base + rng.normal(0, 0.05, n), base + 0.3], 1)
        spans = {}
        for m in ("hubl", "w2v2l", "hubxl", "phon"):
            s = base + rng.normal(0, 0.05, n)
            spans[m] = np.stack([s, s + rng.uniform(0.1, 0.4, n)], 1)
        r = fuse(spans, voter, start_shift=-0.03, join_gap=0.1, tail_extend=0.15)

        s5 = np.median(np.stack([spans[m][:, 0] for m in spans] + [voter[:, 0]]), 0)
        s5 = np.maximum.accumulate(s5)
        c = np.median(np.stack([spans[m] for m in ("hubl", "w2v2l", "hubxl")]), 0)
        e3 = np.maximum(c[:, 1], np.maximum.accumulate(c[:, 0]))
        expected = postprocess(hybrid(s5, e3), -0.03, 0.1, 0.15)
        expected[:, 0] = np.maximum(expected[:, 0], 0)
        expected[:, 1] = np.maximum(expected[:, 1], expected[:, 0])
        np.testing.assert_allclose(r.spans, expected)


class TestFlagging:
    def test_flag_requires_two_deviating_voters(self):
        med = np.array([1.0, 2.0])
        voters = np.array([
            [1.0, 2.0],
            [1.0, 2.5],   # word 1: one outlier
            [1.5, 2.0],   # word 0: one outlier ...
            [1.3, 2.0],   # ... and a second one
            [1.0, NAN],
        ])
        assert flag_low_confidence(voters, med, 0.2) == [0]

    def test_threshold_is_strict(self):
        med = np.array([1.0])
        voters = np.array([[1.2], [1.2], [1.0]])
        assert flag_low_confidence(voters, med, 0.2) == []
        assert flag_low_confidence(voters, med, 0.19) == [0]

    def test_fuse_reports_flagged_indices(self):
        voter = _arr([[1.0, 1.2], [3.0, 3.2]])
        spans = {
            "hubl": _arr([[1.0, 1.2], [2.0, 2.2]]),
            "w2v2l": _arr([[1.0, 1.2], [2.0, 2.2]]),
            "hubxl": _arr([[1.0, 1.2], [2.6, 2.8]]),
            "phon": _arr([[1.0, 1.2], [2.0, 2.2]]),
        }
        r = fuse(spans, voter)
        assert r.flagged == [1]   # hubxl (0.6 s) and the transcriber (1.0 s) disagree


class TestFallback:
    def test_fewer_than_two_character_models(self):
        voter = _arr([[1.0, 1.5], [2.0, 2.5]])
        spans = {"hubl": _arr([[1.1, 1.4], [2.1, 2.4]]), "phon": _arr([[1.0, 1.4], [2.0, 2.4]])}
        r = fuse(spans, voter)
        assert not r.applied
        assert "character model" in r.reason
        np.testing.assert_array_equal(r.spans, voter)

    def test_all_nan_character_model_does_not_count(self):
        voter = _arr([[1.0, 1.5]])
        spans = {"hubl": _arr([[1.1, 1.4]]), "w2v2l": _arr([[NAN, NAN]])}
        r = fuse(spans, voter)
        assert not r.applied

    def test_span_count_mismatch(self):
        voter = _arr([[1.0, 1.5], [2.0, 2.5]])
        spans = {m: _arr([[1.0, 1.5]]) for m in ("hubl", "w2v2l")}
        r = fuse(spans, voter)
        assert not r.applied
        assert "spans" in r.reason

    def test_two_character_models_are_enough(self):
        voter = _arr([[1.0, 1.5]])
        spans = {"hubl": _arr([[1.1, 1.4]]), "hubxl": _arr([[1.2, 1.5]])}
        assert fuse(spans, voter).applied
        assert ctc_fusion.MIN_CHAR_MODELS == 2
