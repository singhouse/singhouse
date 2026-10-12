# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
import re
from typing import List

from lyricsync._config import MatchConfig, PipelineConfig, PostProcessConfig
from lyricsync._types import (
    AlignmentReference,
    PlainLyricsReference,
    SyncMetadata,
    SyncResult,
    TimedWord,
)
from lyricsync.alignment._interpolate import fill_unmatched_words
from lyricsync.alignment.matching import normalize, word_match_score

logger = logging.getLogger(__name__)


def _align_sequences(
    whisper: List[str],
    reference: List[str],
    match_config: MatchConfig,
) -> List[tuple[int, int]]:
    """Align whisper words to reference using Needleman-Wunsch.

    Returns list of (whisper_idx, reference_idx) pairs.
    reference_idx = -1 means no match (ad-lib / insertion).
    """
    m, n = len(whisper), len(reference)
    gap_penalty = match_config.gap_penalty

    dp = [[0.0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i * gap_penalty
    for j in range(n + 1):
        dp[0][j] = j * gap_penalty

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            match = dp[i - 1][j - 1] + word_match_score(whisper[i - 1], reference[j - 1], match_config)
            delete = dp[i - 1][j] + gap_penalty
            insert = dp[i][j - 1] + gap_penalty
            dp[i][j] = max(match, delete, insert)

    # Traceback
    alignment: list[tuple[int, int]] = []
    i, j = m, n
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            ms = word_match_score(whisper[i - 1], reference[j - 1], match_config)
            if dp[i][j] == dp[i - 1][j - 1] + ms:
                if ms > 0:
                    alignment.append((i - 1, j - 1))
                else:
                    alignment.append((i - 1, -1))
                i -= 1
                j -= 1
                continue
        if i > 0 and dp[i][j] == dp[i - 1][j] + gap_penalty:
            alignment.append((i - 1, -1))
            i -= 1
        elif j > 0:
            j -= 1

    alignment.reverse()
    return alignment


class NeedlemanWunschAligner:
    """Needleman-Wunsch alignment of whisper transcription to plain lyrics."""

    def __init__(
        self,
        match_config: MatchConfig | None = None,
        post_config: PostProcessConfig | None = None,
    ):
        self.match_config = match_config or MatchConfig()
        self.post_config = post_config or PostProcessConfig()

    def align(
        self,
        whisper_words: List[TimedWord],
        reference: AlignmentReference,
    ) -> SyncResult:
        if not isinstance(reference, PlainLyricsReference):
            raise TypeError("NeedlemanWunschAligner requires PlainLyricsReference")

        ref_lines = reference.lines
        ref_words: list[str] = []
        ref_line_boundaries: list[int] = []

        for line in ref_lines:
            ref_line_boundaries.append(len(ref_words))
            for word in line.split():
                cleaned = re.sub(r"^[^\w]+|[^\w]+$", "", word)
                if cleaned:
                    ref_words.append(word)

        logger.info("Reference: %d words across %d lines", len(ref_words), len(ref_lines))

        whisper_texts = [w.text for w in whisper_words]
        alignment = _align_sequences(whisper_texts, ref_words, self.match_config)

        ref_to_timing: dict[int, dict] = {}
        num_corrected = 0
        num_matched = 0

        for whisper_idx, ref_idx in alignment:
            if ref_idx >= 0:
                w = whisper_words[whisper_idx]
                ref_word = ref_words[ref_idx]
                is_different = normalize(w.text) != normalize(ref_word)
                if is_different:
                    num_corrected += 1
                num_matched += 1
                ref_to_timing[ref_idx] = {
                    "start": w.start,
                    "end": w.end,
                }

        logger.info(
            "Alignment: %d ref words, %d matched, %d corrected, %d unmatched whisper words discarded",
            len(ref_words),
            num_matched,
            num_corrected,
            len(whisper_words) - num_matched,
        )

        all_words = fill_unmatched_words(
            ref_words, ref_to_timing, ref_line_boundaries, self.post_config,
        )

        grouped_lines: list[list[TimedWord]] = []
        ref_line_boundaries.append(len(ref_words))
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

        metadata = SyncMetadata(
            words_total=len(all_words),
            words_matched=num_matched,
            words_corrected=num_corrected,
            words_interpolated=sum(1 for w in all_words if w.interpolated),
            method="needleman-wunsch",
        )
        return SyncResult(
            segments=[{"words": flat_words}],
            lines=grouped_lines,
            metadata=metadata,
        )
