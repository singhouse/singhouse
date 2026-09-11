# SPDX-License-Identifier: MIT
"""Detect a global timing offset between an LRC reference and a whisper
transcription using text-anchor matches.

Public LRCs frequently have a consistent offset relative to the actual song
audio (typically 0.1–1.5s, sometimes more). The LRC-anchored aligner uses
LRC line times as anchors, which directly poisons word timing when those
times are shifted: words fall outside the search window, the aligner falls
back to even-distribution, and the shift is locked into the output.

This module computes the offset using only **text-exact n-gram matches**
between whisper words and the concatenated LRC text. Each anchor whose
reference index is the *first word of an LRC line* yields a delta:

    delta = whisper_word.start - lrc_line.time

These deltas are aggregated (trimmed median + IQR) and gated to avoid
applying spurious shifts on noisy or wrong-song inputs.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Optional

from lyricsync._types import LrcLine, TimedWord
from lyricsync.alignment.anchor_gap import _find_anchors
from lyricsync.alignment.lrc import strip_lrc_tags
from lyricsync.alignment.matching import normalize

logger = logging.getLogger(__name__)


@dataclass
class OffsetReport:
    """Result of attempting to detect a global LRC offset.

    `applied` is True when all gates passed and `shift` should be added to
    every LRC line time. When False, `reason` is a short tag explaining why.
    """
    applied: bool
    shift: float = 0.0          # seconds to add to each LRC line time
    raw_median: float = 0.0     # untrimmed median of deltas (whisper - lrc)
    iqr: float = 0.0            # interquartile range of deltas
    n_samples: int = 0          # number of (line-start) anchor matches found
    reason: str = ""            # populated when applied=False


def detect_lrc_offset(
    whisper_words: List[TimedWord],
    lrc_lines: List[LrcLine],
    *,
    min_anchor_length: int = 3,
    min_samples: int = 5,
    min_abs_median: float = 0.10,
    max_abs_shift: float = 3.0,
    trim_pct: float = 0.10,
    min_z: float = 3.0,
) -> OffsetReport:
    """Detect the offset to apply to LRC line times to align them with whisper.

    Returns an OffsetReport. When `applied=True`, callers should add `shift`
    to every LRC line time before running their normal alignment.
    """
    if not whisper_words or not lrc_lines:
        return OffsetReport(applied=False, reason="empty_input")

    # Build the flat reference word list, tracking which positions are line
    # starts (so we know which deltas to keep).
    ref_words: list[str] = []
    line_start_positions: dict[int, int] = {}  # ref_idx -> lrc_line_idx
    for li, line in enumerate(lrc_lines):
        clean = strip_lrc_tags(line.text)
        words = clean.split()
        if not words:
            continue
        line_start_positions[len(ref_words)] = li
        ref_words.extend(words)

    if not ref_words or not line_start_positions:
        return OffsetReport(applied=False, reason="empty_lrc_text")

    trans_norm = [normalize(w.text) for w in whisper_words]
    ref_norm = [normalize(w) for w in ref_words]

    anchors = _find_anchors(trans_norm, ref_norm, min_n=min_anchor_length)
    if not anchors:
        return OffsetReport(applied=False, reason="no_text_anchors")

    deltas: list[float] = []
    for a in anchors:
        for k in range(a.length):
            ref_idx = a.ref_start + k
            if ref_idx in line_start_positions:
                lrc_li = line_start_positions[ref_idx]
                w = whisper_words[a.trans_start + k]
                deltas.append(w.start - lrc_lines[lrc_li].time)

    n = len(deltas)
    if n < min_samples:
        return OffsetReport(
            applied=False, n_samples=n,
            reason=f"too_few_samples({n}<{min_samples})",
        )

    import math

    sorted_d = sorted(deltas)
    raw_median = (
        sorted_d[n // 2] if n % 2 else 0.5 * (sorted_d[n // 2 - 1] + sorted_d[n // 2])
    )

    p25 = sorted_d[n // 4]
    p75 = sorted_d[3 * n // 4]
    iqr = p75 - p25

    trim_n = int(n * trim_pct)
    trimmed = sorted_d[trim_n:n - trim_n] if trim_n and n - 2 * trim_n >= 3 else sorted_d
    tn = len(trimmed)
    trimmed_median = (
        trimmed[tn // 2] if tn % 2 else 0.5 * (trimmed[tn // 2 - 1] + trimmed[tn // 2])
    )

    # Approximate standard error of the median: SE ≈ IQR / (1.349 * 0.798 * sqrt(n))
    # = IQR / (1.077 * sqrt(n)). Robust to non-normal distributions.
    se_median = iqr / (1.077 * math.sqrt(n)) if iqr > 0 else 1e-6
    z = abs(trimmed_median) / se_median if se_median > 0 else float("inf")

    if abs(trimmed_median) < min_abs_median:
        return OffsetReport(
            applied=False, n_samples=n, raw_median=raw_median, iqr=iqr,
            reason=f"trivial_offset({trimmed_median:+.3f}s)",
        )
    if abs(trimmed_median) > max_abs_shift:
        return OffsetReport(
            applied=False, n_samples=n, raw_median=raw_median, iqr=iqr,
            reason=f"suspicious_offset({trimmed_median:+.3f}s>{max_abs_shift}s)",
        )
    if z < min_z:
        return OffsetReport(
            applied=False, n_samples=n, raw_median=raw_median, iqr=iqr,
            reason=f"low_confidence(z={z:.2f}<{min_z})",
        )

    return OffsetReport(
        applied=True,
        shift=trimmed_median,
        raw_median=raw_median,
        iqr=iqr,
        n_samples=n,
    )
