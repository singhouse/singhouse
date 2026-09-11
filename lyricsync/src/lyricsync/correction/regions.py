# SPDX-License-Identifier: MIT
"""Suspect-region detection over classified alignment output.

A region is a maximal cluster of non-``exact`` reference words — the
words whose timing is either a guess (interpolated) or a fuzzy match that
can be outright wrong (corrected). Isolated exact singletons between
non-exact neighbours are absorbed into the cluster but stay *locked*:
their spans are fixed context the LLM must plan around. Clusters are
bounded by exact runs of length >= ``min_anchor_run`` (or song edges),
because a lone exact "anchor" inside a garble is exactly the kind of
false friend experiment 2 warned about.

Not every region is worth an LLM call (experiment 1: the heuristic ties
the LLM when a single missing word sits in a tight gap). A region
qualifies when it contains any corrected word (garble cluster), spans a
wide time gap, or opens a phrase after silence — in which case the
unlock rule also hands the LLM the line's first exact words, since
Whisper's first matched word tends to absorb the pickup word's onset.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from lyricsync._config import CorrectionConfig
from lyricsync._types import TimedWord

EXACT = "exact"
CORRECTED = "corrected"
INTERPOLATED = "interpolated"


@dataclass
class Region:
    """A contiguous span of ref-word indices the LLM may re-time."""

    lo: int                             # first ref idx, inclusive
    hi: int                             # last ref idx, inclusive
    locked: List[int] = field(default_factory=list)
    unlocked_exact: List[int] = field(default_factory=list)
    window: Tuple[float, float] = (0.0, 0.0)
    vad_onset: Optional[float] = None
    reasons: List[str] = field(default_factory=list)

    @property
    def targets(self) -> List[int]:
        """Ref indices the LLM re-times, in order (everything not locked)."""
        return [i for i in range(self.lo, self.hi + 1) if i not in self.locked]


def _clusters(n: int, classes: Dict[int, str], min_anchor_run: int) -> List[Tuple[int, int]]:
    """Maximal [lo, hi] runs of non-exact words, absorbing exact islands
    shorter than ``min_anchor_run``."""
    def is_exact(i: int) -> bool:
        return classes.get(i) == EXACT

    clusters: List[Tuple[int, int]] = []
    i = 0
    while i < n:
        if is_exact(i):
            i += 1
            continue
        lo = i
        hi = i
        j = i + 1
        while j < n:
            if not is_exact(j):
                hi = j
                j += 1
                continue
            # Exact run starting at j: absorb it only if it's short and
            # more non-exact words follow it.
            k = j
            while k < n and is_exact(k):
                k += 1
            if k - j < min_anchor_run and k < n:
                hi = k  # k is non-exact; the exacts j..k-1 ride along locked
                j = k + 1
            else:
                break
        clusters.append((lo, hi))
        i = hi + 1
    return clusters


def _nearest_exact_end(
    idx: int, classes: Dict[int, str], timing: Dict[int, dict],
) -> Optional[float]:
    for i in range(idx, -1, -1):
        if classes.get(i) == EXACT and i in timing:
            return timing[i]["end"]
    return None


def _nearest_exact_start(
    idx: int, n: int, classes: Dict[int, str], timing: Dict[int, dict],
) -> Optional[float]:
    for i in range(idx, n):
        if classes.get(i) == EXACT and i in timing:
            return timing[i]["start"]
    return None


def _pick_vad_onset(
    vad_segments: Optional[Sequence[Tuple[float, float]]],
    window: Tuple[float, float],
) -> Optional[float]:
    """First VAD segment onset inside the window — the phrase entry point."""
    if not vad_segments:
        return None
    lo, hi = window
    for seg_start, _seg_end in sorted(vad_segments):
        if lo <= seg_start <= hi:
            return seg_start
    return None


def build_regions(
    ref_words: Sequence[str],
    classes: Dict[int, str],
    ref_to_timing: Dict[int, dict],
    line_starts: Sequence[int],
    whisper_words: Sequence[TimedWord],
    config: CorrectionConfig,
    vad_segments: Optional[Sequence[Tuple[float, float]]] = None,
) -> List[Region]:
    """Detect and qualify suspect regions.

    ``classes`` maps ref idx -> exact|corrected; absent indices are
    interpolated (no timing evidence at all).
    """
    n = len(ref_words)
    if n == 0:
        return []
    song_end = max((w.end for w in whisper_words), default=0.0) + 5.0
    line_start_set = set(line_starts)

    # Clusters split at reference-line boundaries: cross-line authority is
    # what broke experiment 2 (the model shifted the next line a token early),
    # and 8-word regions drive local thinking models into timeout-length
    # reasoning. Singing pauses at line ends; a garble joining across the
    # break is rare enough to give up on.
    spans: List[Tuple[int, int]] = []
    for lo, hi in _clusters(n, classes, config.min_anchor_run):
        start = lo
        for i in range(lo + 1, hi + 1):
            if i in line_start_set:
                spans.append((start, i - 1))
                start = i
        spans.append((start, hi))

    def _trim(lo: int, hi: int) -> Optional[Tuple[int, int]]:
        # Splitting can leave absorbed exact islands at a sub-span's edge,
        # where they're no longer *between* suspects — shed them.
        while lo <= hi and classes.get(lo) == EXACT:
            lo += 1
        while hi >= lo and classes.get(hi) == EXACT:
            hi -= 1
        return (lo, hi) if lo <= hi else None

    regions: List[Region] = []
    for span in spans:
        trimmed = _trim(*span)
        if trimmed is None:
            continue
        lo, hi = trimmed
        region = Region(lo=lo, hi=hi)
        region.locked = [
            i for i in range(lo, hi + 1) if classes.get(i) == EXACT
        ]

        prev_end = _nearest_exact_end(lo - 1, classes, ref_to_timing)
        next_start = _nearest_exact_start(hi + 1, n, classes, ref_to_timing)
        win_lo = prev_end if prev_end is not None else 0.0
        win_hi = next_start if next_start is not None else song_end
        if win_hi <= win_lo:
            # Degenerate window (anchor mis-order upstream): nothing the
            # LLM could legally do here.
            continue
        region.window = (win_lo, win_hi)
        region.vad_onset = _pick_vad_onset(vad_segments, region.window)

        gap = win_hi - win_lo
        has_corrected = any(
            classes.get(i) == CORRECTED for i in range(lo, hi + 1)
        )
        n_suspect = (hi - lo + 1) - len(region.locked)
        # A lone corrected word between exact neighbours is almost always a
        # spelling variant ("tryin'"/"trying") whose 1:1 timing is already
        # right — garble cascades show up as *clusters* of non-exact words.
        if has_corrected and n_suspect >= 2:
            region.reasons.append("garble")
        if gap > config.wide_gap_sec and not has_corrected:
            region.reasons.append("wide-gap")

        # Unlock rule: an interpolated run that opens a reference line
        # after real silence gets authority over the line's first exact
        # words too — window total stays fixed at the last unlocked end.
        opens_line = lo in line_start_set and classes.get(lo) is None
        if opens_line and gap > config.phrase_gap_sec:
            unlocked: List[int] = []
            j = hi + 1
            while (
                j < n
                and len(unlocked) < config.unlock_words
                and classes.get(j) == EXACT
                and j in ref_to_timing
                and j not in line_start_set
            ):
                unlocked.append(j)
                j += 1
            if unlocked:
                region.hi = unlocked[-1]
                region.unlocked_exact = unlocked
                region.window = (
                    region.vad_onset if region.vad_onset is not None else win_lo,
                    ref_to_timing[unlocked[-1]]["end"],
                )
                region.reasons.append("phrase-open")

        if not region.reasons:
            continue
        regions.append(region)

    # Final filter: pure interpolated singletons in tight gaps never
    # qualify (cheap guard against mis-tuned thresholds upstream).
    qualified: List[Region] = []
    for r in regions:
        tgt = r.targets
        if (
            len(tgt) == 1
            and not r.unlocked_exact
            and classes.get(tgt[0]) is None
            and (r.window[1] - r.window[0]) < config.tight_gap_sec
        ):
            continue
        qualified.append(r)
    return qualified
