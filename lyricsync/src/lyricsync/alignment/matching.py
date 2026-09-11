# SPDX-License-Identifier: MIT
from __future__ import annotations

import re

from lyricsync._config import MatchConfig


def normalize(word: str) -> str:
    """Normalize word for comparison."""
    return re.sub(r"[^\w]", "", word.lower()).strip()


def levenshtein_ratio(s1: str, s2: str) -> float:
    """Normalized indel similarity in [0, 1].

    The metric is Levenshtein with substitutions counted as delete+insert
    (`1 - distance / (len1 + len2)`) — identical to the `Levenshtein.ratio()`
    the matcher thresholds were tuned against. Uses C-optimized rapidfuzz
    when available, falling back to pure-Python single-row DP computing the
    same metric.
    """
    if not s1 or not s2:
        return 0.0
    if s1 == s2:
        return 1.0

    try:
        from rapidfuzz.distance import Indel as _indel
        return _indel.normalized_similarity(s1, s2)
    except ImportError:
        pass

    len1, len2 = len(s1), len(s2)
    prev = list(range(len2 + 1))
    for i in range(1, len1 + 1):
        curr = [i] + [0] * len2
        for j in range(1, len2 + 1):
            if s1[i - 1] == s2[j - 1]:
                curr[j] = prev[j - 1]
            else:
                curr[j] = min(curr[j - 1], prev[j]) + 1
        prev = curr

    distance = prev[len2]
    return 1.0 - (distance / (len1 + len2))


def _enhanced_levenshtein(w1: str, w2: str) -> float:
    """Enhanced Levenshtein similarity with first-letter and length bonuses."""
    if not w1 or not w2:
        return 0.0
    if w1 == w2:
        return 1.0

    base = levenshtein_ratio(w1, w2)

    if w1[0] == w2[0]:
        similarity = (base + 1.0) / 2.0
    else:
        similarity = base * 0.9

    length_ratio = min(len(w1), len(w2)) / max(len(w1), len(w2))
    similarity = (similarity + length_ratio) / 2.0

    return similarity


def _metaphone_match(w1: str, w2: str) -> float:
    """Phonetic matching using Double Metaphone."""
    try:
        from metaphone import doublemetaphone
    except ImportError:
        return 0.0

    codes1 = doublemetaphone(w1)
    codes2 = doublemetaphone(w2)

    codes1_set = {c for c in codes1 if c}
    codes2_set = {c for c in codes2 if c}

    if not codes1_set or not codes2_set:
        return 0.0

    best = 0.0
    for c1 in codes1_set:
        for c2 in codes2_set:
            if c1 == c2:
                best = max(best, 1.0)
                continue

            if len(c1) <= 2 or len(c2) <= 2:
                if c1 in c2 or c2 in c1:
                    best = max(best, 0.8)
                elif c1[0] == c2[0]:
                    best = max(best, 0.6)
                continue

            if abs(len(c1) - len(c2)) > 3:
                continue

            min_len = min(len(c1), len(c2))
            prefix_len = 0
            for a, b in zip(c1, c2):
                if a != b:
                    break
                prefix_len += 1

            if prefix_len >= 2:
                best = max(best, 0.7 + 0.1 * prefix_len / max(len(c1), len(c2)))
                continue

            shared = sum(1 for ch in c1 if ch in c2)
            if shared >= 2:
                best = max(best, 0.6 + 0.1 * shared / max(len(c1), len(c2)))

    return best


def word_match_score(w1: str, w2: str, config: MatchConfig | None = None) -> float:
    """Score for matching two words. Higher = better match.

    Uses a 3-tier matching strategy:
      1. Exact match after normalization
      2. Enhanced Levenshtein (with bonuses)
      3. Double Metaphone phonetic fallback
    """
    if config is None:
        config = MatchConfig()

    n1, n2 = normalize(w1), normalize(w2)
    if not n1 or not n2:
        return config.mismatch_score
    if n1 == n2:
        return config.exact_score

    lev = _enhanced_levenshtein(n1, n2)
    if lev >= config.lev_close_threshold:
        return config.close_score
    if lev >= config.lev_weak_threshold:
        return config.weak_score

    phon = _metaphone_match(n1, n2)
    if phon >= config.phonetic_threshold:
        return config.phonetic_score

    return config.mismatch_score
