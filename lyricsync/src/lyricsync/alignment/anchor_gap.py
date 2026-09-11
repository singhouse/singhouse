# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import List, Optional

from lyricsync._config import MatchConfig, PostProcessConfig
from lyricsync._types import (
    AlignmentReference,
    PlainLyricsReference,
    SyncMetadata,
    SyncResult,
    TimedWord,
)
from lyricsync.alignment._interpolate import fill_unmatched_words
from lyricsync.alignment.matching import normalize
from lyricsync.alignment.needleman_wunsch import _align_sequences


def _norm_concat(words: list[str]) -> str:
    """Concatenate words with all non-word chars stripped (incl. spaces)."""
    return "".join(normalize(w) for w in words)


def _distribute_by_chars(
    whisper_slice: list[TimedWord],
    ref_words: list[str],
) -> list[tuple[int, float, float]]:
    """Distribute whisper-slice timing across ref_words proportional to ref
    character length. Returns list of (ref_local_idx, start, end)."""
    if not whisper_slice or not ref_words:
        return []
    span_start = whisper_slice[0].start
    span_end = whisper_slice[-1].end
    total = max(span_end - span_start, 1e-3)
    char_lens = [max(len(normalize(w)), 1) for w in ref_words]
    total_chars = sum(char_lens)
    out: list[tuple[int, float, float]] = []
    cursor = span_start
    for ri, c in enumerate(char_lens):
        dur = total * (c / total_chars)
        out.append((ri, cursor, cursor + dur))
        cursor += dur
    return out


def _gap_word_count_match(
    whisper_slice: list[TimedWord],
    ref_slice: list[str],
    ref_lo: int,
    ref_to_timing: dict[int, dict],
) -> bool:
    """1:1 substitute when whisper and ref have equal counts in this gap."""
    if not whisper_slice or not ref_slice:
        return False
    if len(whisper_slice) != len(ref_slice):
        return False
    for k, w in enumerate(whisper_slice):
        ref_to_timing[ref_lo + k] = {"start": w.start, "end": w.end}
    return True


def _gap_no_space_punct_match(
    whisper_slice: list[TimedWord],
    ref_slice: list[str],
    ref_lo: int,
    ref_to_timing: dict[int, dict],
) -> bool:
    """Concatenated-no-punct text equal -> distribute whisper timing across
    ref words proportional to character length. Catches splits/joins like
    'do nt' vs 'dont' or 'ima' vs 'i ma'."""
    if not whisper_slice or not ref_slice:
        return False
    if _norm_concat([w.text for w in whisper_slice]) != _norm_concat(ref_slice):
        return False
    for ri, start, end in _distribute_by_chars(whisper_slice, ref_slice):
        ref_to_timing[ref_lo + ri] = {"start": start, "end": end}
    return True

logger = logging.getLogger(__name__)


@dataclass
class _Anchor:
    trans_start: int   # whisper word index
    ref_start: int     # reference word index
    length: int


def _monotonic_bounds(anchors: List[_Anchor], i: int) -> tuple[int, float]:
    """Compute the [lo, hi) reference-index range that a new anchor at trans
    position `i` may occupy without breaking monotonicity with existing
    anchors. Anchors are sorted by trans_start."""
    lo = 0
    hi: float = float("inf")
    for a in anchors:
        if a.trans_start < i:
            lo = max(lo, a.ref_start + a.length)
        else:
            hi = min(hi, a.ref_start)
            break
    return lo, hi


def _find_anchors(
    trans_norm: List[str],
    ref_norm: List[str],
    min_n: int = 3,
) -> List[_Anchor]:
    """Greedy longest-first non-overlapping n-gram match between trans and ref.

    Returns a list of _Anchor sorted by trans_start. Each anchor preserves the
    whisper-side timing for its words; the regions between anchors are 'gaps'
    handled separately by local alignment."""
    n_max = min(len(trans_norm), len(ref_norm))
    if n_max < min_n:
        return []

    anchors: list[_Anchor] = []
    used_trans = [False] * len(trans_norm)
    used_ref = [False] * len(ref_norm)

    for n in range(n_max, min_n - 1, -1):
        # Index free reference n-grams.
        ref_index: dict[tuple[str, ...], list[int]] = {}
        for j in range(len(ref_norm) - n + 1):
            if any(used_ref[k] for k in range(j, j + n)):
                continue
            ref_index.setdefault(tuple(ref_norm[j:j + n]), []).append(j)

        if not ref_index:
            continue

        for i in range(len(trans_norm) - n + 1):
            if any(used_trans[k] for k in range(i, i + n)):
                continue
            positions = ref_index.get(tuple(trans_norm[i:i + n]))
            if not positions:
                continue
            lo, hi = _monotonic_bounds(anchors, i)
            # Prefer the candidate position closest to `i` (small offset bias).
            chosen: Optional[int] = None
            for j in sorted(positions, key=lambda p: abs(p - i)):
                if j < lo or j + n > hi:
                    continue
                if any(used_ref[k] for k in range(j, j + n)):
                    continue
                chosen = j
                break
            if chosen is None:
                continue

            new_anchor = _Anchor(trans_start=i, ref_start=chosen, length=n)
            # Insert keeping anchors sorted by trans_start.
            insert_at = 0
            while insert_at < len(anchors) and anchors[insert_at].trans_start < i:
                insert_at += 1
            anchors.insert(insert_at, new_anchor)
            for k in range(i, i + n):
                used_trans[k] = True
            for k in range(chosen, chosen + n):
                used_ref[k] = True

    return anchors


class AnchorGapAligner:
    """Anchor-and-gap alignment of whisper transcription to plain lyrics.

    Finds n-gram matches as anchors that preserve original whisper timing, then
    runs local Needleman-Wunsch only within the gaps between anchors. Compared
    to global NW this preserves ASR-native timestamps for the (typically
    majority) words that already match the reference, only retiming where
    corrections happen.

    When ``gap_handler_chain`` is set, gaps first go through an ordered
    first-match-wins chain (word-count match, then no-space/punctuation match)
    with NW as the fallback. An optional ``corrector`` handles LLM-driven
    region correction.
    """

    def __init__(
        self,
        match_config: MatchConfig | None = None,
        post_config: PostProcessConfig | None = None,
        min_anchor_length: int = 3,
        gap_handler_chain: bool = False,
        corrector=None,   # lyricsync.correction.RegionCorrector | None
    ):
        self.match_config = match_config or MatchConfig()
        self.post_config = post_config or PostProcessConfig()
        self.min_anchor_length = min_anchor_length
        self.gap_handler_chain = gap_handler_chain
        self.corrector = corrector

    def align(
        self,
        whisper_words: List[TimedWord],
        reference: AlignmentReference,
        vad_segments: Optional[List[tuple[float, float]]] = None,
    ) -> SyncResult:
        if not isinstance(reference, PlainLyricsReference):
            raise TypeError("AnchorGapAligner requires PlainLyricsReference")

        ref_lines = reference.lines
        ref_words: list[str] = []
        ref_line_boundaries: list[int] = []
        for line in ref_lines:
            ref_line_boundaries.append(len(ref_words))
            for word in line.split():
                if re.sub(r"^[^\w]+|[^\w]+$", "", word):
                    ref_words.append(word)
        ref_line_boundaries.append(len(ref_words))

        logger.info(
            "Reference: %d words across %d lines (anchor-gap)",
            len(ref_words), len(ref_lines),
        )

        trans_norm = [normalize(w.text) for w in whisper_words]
        ref_norm = [normalize(w) for w in ref_words]

        anchors = _find_anchors(trans_norm, ref_norm, self.min_anchor_length)
        n_anchor_words = sum(a.length for a in anchors)
        logger.info(
            "Anchors: %d sequences covering %d/%d ref words (%.1f%%)",
            len(anchors), n_anchor_words, len(ref_norm),
            100 * n_anchor_words / max(1, len(ref_norm)),
        )

        # ref_idx -> {start, end} from anchors and gap-local NW.
        ref_to_timing: dict[int, dict] = {}
        # ref idx -> "exact" | "corrected"; absent = interpolated.
        classes: dict[int, str] = {}
        whisper_to_ref: dict[int, int] = {}
        num_corrected = 0
        num_anchored = 0

        for a in anchors:
            for k in range(a.length):
                w = whisper_words[a.trans_start + k]
                ref_to_timing[a.ref_start + k] = {"start": w.start, "end": w.end}
                classes[a.ref_start + k] = "exact"
                whisper_to_ref[a.trans_start + k] = a.ref_start + k
                num_anchored += 1

        # Build gap ranges between anchors (in both trans and ref indices).
        gap_ranges: list[tuple[int, int, int, int]] = []
        prev_trans = 0
        prev_ref = 0
        for a in anchors:
            if a.trans_start > prev_trans or a.ref_start > prev_ref:
                gap_ranges.append((prev_trans, a.trans_start, prev_ref, a.ref_start))
            prev_trans = a.trans_start + a.length
            prev_ref = a.ref_start + a.length
        if prev_trans < len(whisper_words) or prev_ref < len(ref_words):
            gap_ranges.append((prev_trans, len(whisper_words), prev_ref, len(ref_words)))

        gap_handler_hits = {"word_count": 0, "no_space_punct": 0, "nw": 0}
        for trans_lo, trans_hi, ref_lo, ref_hi in gap_ranges:
            if trans_lo == trans_hi or ref_lo == ref_hi:
                continue
            whisper_slice = whisper_words[trans_lo:trans_hi]
            ref_slice = ref_words[ref_lo:ref_hi]

            if self.gap_handler_chain:
                if _gap_word_count_match(whisper_slice, ref_slice, ref_lo, ref_to_timing):
                    gap_handler_hits["word_count"] += 1
                    for k, ref_word in enumerate(ref_slice):
                        is_diff = normalize(whisper_slice[k].text) != normalize(ref_word)
                        if is_diff:
                            num_corrected += 1
                        classes[ref_lo + k] = "corrected" if is_diff else "exact"
                        whisper_to_ref[trans_lo + k] = ref_lo + k
                    continue
                if _gap_no_space_punct_match(whisper_slice, ref_slice, ref_lo, ref_to_timing):
                    gap_handler_hits["no_space_punct"] += 1
                    num_corrected += len(ref_slice)
                    # Char-proportional distribution over a join/split — a
                    # fuzzy assignment, so leave it open to correction.
                    for k in range(len(ref_slice)):
                        classes[ref_lo + k] = "corrected"
                    continue

            gap_handler_hits["nw"] += 1
            whisper_texts = [w.text for w in whisper_slice]
            pairs = _align_sequences(whisper_texts, ref_slice, self.match_config)
            for whisper_idx, ref_idx in pairs:
                if ref_idx < 0:
                    continue
                w = whisper_slice[whisper_idx]
                abs_ref = ref_lo + ref_idx
                is_diff = normalize(w.text) != normalize(ref_words[abs_ref])
                if is_diff:
                    num_corrected += 1
                classes[abs_ref] = "corrected" if is_diff else "exact"
                whisper_to_ref[trans_lo + whisper_idx] = abs_ref
                ref_to_timing[abs_ref] = {"start": w.start, "end": w.end}

        llm_stats = None
        if self.corrector is not None:
            # ref_line_boundaries carries a trailing sentinel here; regions
            # only test membership of line-opening indices, so it's harmless.
            ref_to_timing, llm_stats = self.corrector.correct(
                ref_words=ref_words,
                ref_to_timing=ref_to_timing,
                classes=classes,
                line_starts=ref_line_boundaries[:-1],
                whisper_words=whisper_words,
                whisper_to_ref=whisper_to_ref,
                vad_segments=vad_segments,
            )

        # Place any remaining unmatched ref words (run-aware, line-anchored).
        all_words = fill_unmatched_words(
            ref_words, ref_to_timing, ref_line_boundaries, self.post_config,
        )

        n_matched = len(ref_to_timing)
        n_interpolated = sum(1 for w in all_words if w.interpolated)
        logger.info(
            "Anchor-gap: %d ref words, %d anchored, %d gap-matched, %d corrected, %d interpolated",
            len(ref_words), num_anchored,
            n_matched - num_anchored, num_corrected, n_interpolated,
        )
        if self.gap_handler_chain:
            logger.info(
                "Gap handlers: word_count=%d, no_space_punct=%d, nw_fallback=%d",
                gap_handler_hits["word_count"],
                gap_handler_hits["no_space_punct"],
                gap_handler_hits["nw"],
            )

        grouped_lines: list[list[TimedWord]] = []
        for li in range(len(ref_lines)):
            start_idx = ref_line_boundaries[li]
            end_idx = ref_line_boundaries[li + 1]
            line_words = all_words[start_idx:end_idx]
            if line_words:
                grouped_lines.append(line_words)

        flat_words = [
            {"text": w.text, "start": w.start, "end": w.end}
            for w in all_words
        ]

        return SyncResult(
            segments=[{"words": flat_words}],
            lines=grouped_lines,
            metadata=SyncMetadata(
                words_total=len(all_words),
                words_matched=n_matched,
                words_corrected=num_corrected,
                words_interpolated=n_interpolated,
                method="anchor-gap",
                extra={
                    "n_anchors": len(anchors),
                    "anchor_word_coverage": n_anchor_words / max(1, len(ref_norm)),
                    "gap_handler_chain": self.gap_handler_chain,
                    "gap_handler_hits": gap_handler_hits,
                    **({"llm_correction": llm_stats} if llm_stats else {}),
                },
            ),
        )
