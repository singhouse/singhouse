# SPDX-License-Identifier: MIT
"""Tests for word matching and scoring."""

import itertools
import sys

import pytest

from lyricsync.alignment.matching import (
    normalize,
    levenshtein_ratio,
    word_match_score,
    _enhanced_levenshtein,
    _metaphone_match,
)
from lyricsync._config import MatchConfig


class TestNormalize:
    def test_lowercase(self):
        assert normalize("Hello") == "hello"

    def test_strip_punctuation(self):
        assert normalize("don't") == "dont"
        assert normalize("hello!") == "hello"
        assert normalize("(yeah)") == "yeah"

    def test_empty(self):
        assert normalize("") == ""
        assert normalize("...") == ""

    def test_already_clean(self):
        assert normalize("hello") == "hello"


class TestLevenshteinRatio:
    def test_identical(self):
        assert levenshtein_ratio("hello", "hello") == 1.0

    def test_completely_different(self):
        assert levenshtein_ratio("abc", "xyz") == 0.0

    def test_close_match(self):
        r = levenshtein_ratio("dancing", "dancin")
        assert 0.7 < r <= 1.0

    def test_empty(self):
        assert levenshtein_ratio("", "hello") == 0.0
        assert levenshtein_ratio("hello", "") == 0.0


class TestLevenshteinRatioParity:
    """Both code paths compute the indel metric the thresholds were tuned on:
    substitutions cost delete+insert, normalized by len1+len2."""

    WORDS = [
        "love", "lover", "luv", "gonna", "goin", "night", "nite", "want",
        "through", "thru", "singing", "singin", "a", "ab", "abcd", "rhythm",
        "rythm", "misspelled", "mispelled", "yeah", "whoa",
    ]
    PAIRS = list(itertools.combinations(WORDS, 2))

    def test_c_path_routes_through_rapidfuzz(self, monkeypatch):
        pytest.importorskip("rapidfuzz")
        import rapidfuzz.distance

        monkeypatch.setattr(
            rapidfuzz.distance.Indel, "normalized_similarity",
            lambda *a, **k: 0.123,
        )
        assert levenshtein_ratio("night", "nite") == 0.123

    def test_fallback_matches_rapidfuzz(self, monkeypatch):
        pytest.importorskip("rapidfuzz")
        from rapidfuzz.distance import Indel

        expected = {p: Indel.normalized_similarity(*p) for p in self.PAIRS}
        monkeypatch.setitem(sys.modules, "rapidfuzz.distance", None)
        with pytest.raises(ImportError):
            from rapidfuzz.distance import Indel  # noqa: F811
        for (s1, s2), exp in expected.items():
            assert levenshtein_ratio(s1, s2) == pytest.approx(exp), (s1, s2)

    def test_known_values(self):
        # "want"/"nite" discriminates indel from uniform-cost Levenshtein:
        # uniform gives 0.0 (4 substitutions / max_len 4), indel gives 0.5.
        assert levenshtein_ratio("want", "nite") == pytest.approx(0.5)
        assert levenshtein_ratio("night", "nite") == pytest.approx(1 - 3 / 9)

    def test_known_values_fallback(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "rapidfuzz.distance", None)
        assert levenshtein_ratio("want", "nite") == pytest.approx(0.5)
        assert levenshtein_ratio("night", "nite") == pytest.approx(1 - 3 / 9)


class TestWordMatchScore:
    def test_exact_match(self):
        assert word_match_score("hello", "hello") == MatchConfig().exact_score

    def test_case_insensitive(self):
        assert word_match_score("Hello", "hello") == MatchConfig().exact_score

    def test_close_match(self):
        score = word_match_score("dancing", "dancin")
        assert score == MatchConfig().close_score  # >= 0.75 levenshtein

    def test_phonetic_match(self):
        # "night" and "nite" should match phonetically
        score = word_match_score("night", "nite")
        assert score > MatchConfig().mismatch_score

    def test_mismatch(self):
        score = word_match_score("hello", "xyzabc")
        assert score == MatchConfig().mismatch_score

    def test_custom_config(self):
        config = MatchConfig(exact_score=5.0, mismatch_score=-2.0)
        assert word_match_score("hello", "hello", config) == 5.0

    def test_empty_word(self):
        assert word_match_score("", "hello") == MatchConfig().mismatch_score


class TestMetaphoneMatch:
    def test_phonetic_equivalent(self):
        score = _metaphone_match("through", "thru")
        assert score > 0.0

    def test_identical(self):
        # Same word should score high
        score = _metaphone_match("hello", "hello")
        assert score >= 0.7

    def test_unrelated(self):
        score = _metaphone_match("hello", "world")
        assert score < 0.5
