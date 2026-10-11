# SPDX-License-Identifier: MIT
"""Fusion of several CTC acoustic models' word spans into one re-timing.

Pure numpy. The inputs are per-model ``(n_words, 2)`` arrays of
``[start, end]`` seconds (NaN where a model has no time for a word) plus the
existing result's word times, which vote on starts like one more model.

Steps (all over the whole song, in word order):

1. Starts: per-word NaN-median over the start voters (every acoustic model
   that ran, phoneme model included, plus the existing timing); then made
   non-decreasing.
2. Ends: per-word NaN-median over the character models' ends, floored at the
   character models' own non-decreasing median start.
3. Hybrid: each end clipped to the next word's fused start, and never before
   its own start.
4. Boundary post-processing: shift every start by ``start_shift``; a word whose
   end is within ``join_gap`` of the next start runs up to it, otherwise its
   end extends by ``tail_extend`` (never past the next start). Starts are
   clamped at zero.

A word is flagged low-confidence when the second-largest deviation of a start
voter from the per-word median start exceeds ``flag_threshold``: at least two
voters disagree with the fused time.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field

import numpy as np

CHAR_MODELS: tuple[str, ...] = ("hubl", "w2v2l", "hubxl")
PHONEME_MODELS: tuple[str, ...] = ("phon",)
START_VOTERS: tuple[str, ...] = CHAR_MODELS + PHONEME_MODELS
MIN_CHAR_MODELS = 2

DEFAULT_START_SHIFT = -0.02
DEFAULT_JOIN_GAP = 0.0
DEFAULT_TAIL_EXTEND = 0.2
DEFAULT_FLAG_THRESHOLD = 0.2


@dataclass
class FusionResult:
    applied: bool
    spans: np.ndarray                      # (n, 2); the input voter spans when not applied
    reason: str = ""
    start_voters: list[str] = field(default_factory=list)
    end_voters: list[str] = field(default_factory=list)
    flagged: list[int] = field(default_factory=list)


def _nanmedian(stack: np.ndarray) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN columns stay NaN
        return np.nanmedian(stack, axis=0)


def _monotonic(starts: np.ndarray) -> np.ndarray:
    q = starts.copy()
    for b in range(1, len(q)):
        q[b] = max(q[b], q[b - 1])
    return q


def hybrid(starts: np.ndarray, ends: np.ndarray) -> np.ndarray:
    """Pair starts with ends; clip each end to the next start and to its own start."""
    q = np.stack([np.asarray(starts, float), np.asarray(ends, float)], 1)
    n = len(q)
    for i in range(n):
        if i + 1 < n:
            q[i, 1] = min(q[i, 1], q[i + 1, 0])
        q[i, 1] = max(q[i, 1], q[i, 0])
    return q


def postprocess(
    p: np.ndarray,
    start_shift: float = DEFAULT_START_SHIFT,
    join_gap: float = DEFAULT_JOIN_GAP,
    tail_extend: float = DEFAULT_TAIL_EXTEND,
) -> np.ndarray:
    """Constant start shift, then join or extend each end against the next start."""
    p = np.asarray(p, float)
    q = p.copy()
    q[:, 0] = p[:, 0] + start_shift
    for i in range(len(q)):
        nxt = q[i + 1, 0] if i + 1 < len(q) else np.inf
        e = p[i, 1]
        if nxt - e <= join_gap:
            q[i, 1] = nxt
        else:
            q[i, 1] = min(e + tail_extend, nxt)
        q[i, 1] = max(q[i, 1], q[i, 0])
    return q


def flag_low_confidence(
    voter_starts: np.ndarray, median_starts: np.ndarray, threshold: float = DEFAULT_FLAG_THRESHOLD,
) -> list[int]:
    """Indices whose second-largest |voter start - median start| exceeds ``threshold``.

    ``voter_starts`` is (n_voters, n_words); NaN entries (absent voters) are ignored.
    """
    dev = np.abs(np.asarray(voter_starts, float) - np.asarray(median_starts, float)[None, :])
    flagged = []
    for i in range(dev.shape[1]):
        d = np.sort(dev[~np.isnan(dev[:, i]), i])
        if len(d) >= 2 and d[-2] > threshold:
            flagged.append(i)
    return flagged


def fuse(
    model_spans: dict[str, np.ndarray],
    voter_spans: np.ndarray,
    start_shift: float = DEFAULT_START_SHIFT,
    join_gap: float = DEFAULT_JOIN_GAP,
    tail_extend: float = DEFAULT_TAIL_EXTEND,
    flag_threshold: float = DEFAULT_FLAG_THRESHOLD,
) -> FusionResult:
    """Fuse per-model word spans with the existing timing (``voter_spans``, (n, 2))."""
    voter = np.asarray(voter_spans, float).reshape(-1, 2)
    n = len(voter)
    spans: dict[str, np.ndarray] = {}
    for name, arr in model_spans.items():
        a = np.asarray(arr, float).reshape(-1, 2)
        if a.shape[0] != n:
            return FusionResult(False, voter.copy(),
                                reason=f"model {name} returned {a.shape[0]} spans for {n} words")
        spans[name] = a

    # A character model counts only when it timed at least one word.
    chars = [m for m in CHAR_MODELS if m in spans and not np.all(np.isnan(spans[m][:, 0]))]
    if len(chars) < MIN_CHAR_MODELS:
        return FusionResult(
            False, voter.copy(),
            reason=f"only {len(chars)} character model(s) produced output; need {MIN_CHAR_MODELS}",
            end_voters=chars,
        )
    if n == 0:
        return FusionResult(True, voter.copy(), end_voters=chars)

    start_models = [m for m in START_VOTERS
                    if m in spans and not np.all(np.isnan(spans[m][:, 0]))]
    s_stack = np.stack([spans[m][:, 0] for m in start_models] + [voter[:, 0]])
    s_med = _nanmedian(s_stack)
    # A word no voter could time keeps its existing span.
    starts = _monotonic(np.where(np.isnan(s_med), voter[:, 0], s_med))

    c_stack = np.stack([spans[m] for m in chars])
    c_med = _nanmedian(c_stack)
    c_start = _monotonic(np.where(np.isnan(c_med[:, 0]), starts, c_med[:, 0]))
    ends = np.maximum(np.where(np.isnan(c_med[:, 1]), voter[:, 1], c_med[:, 1]), c_start)

    q = postprocess(hybrid(starts, ends), start_shift, join_gap, tail_extend)
    q[:, 0] = np.maximum(q[:, 0], 0.0)
    q[:, 1] = np.maximum(q[:, 1], q[:, 0])

    flagged = flag_low_confidence(s_stack, s_med, flag_threshold)
    return FusionResult(
        True, q,
        start_voters=start_models + ["transcriber"],
        end_voters=chars,
        flagged=flagged,
    )
