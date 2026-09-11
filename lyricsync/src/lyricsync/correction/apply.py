# SPDX-License-Identifier: MIT
"""Orchestration: regions -> LLM calls -> validation -> merged timing.

``RegionCorrector.correct`` is the single entry point the aligners call
between building ``ref_to_timing`` and running ``fill_unmatched_words``.
It never raises and never degrades below the deterministic output: any
region whose call or validation fails (after one retry with the
validator's error appended) simply keeps its heuristic timing.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, Sequence, Tuple

from lyricsync._config import CorrectionConfig
from lyricsync._types import TimedWord
from lyricsync.correction.client import CorrectionUnavailable, OpenAIChatClient
from lyricsync.correction.prompt import (
    SYSTEM_PROMPT,
    build_user_prompt,
    parse_and_validate,
)
from lyricsync.correction.regions import Region, build_regions

logger = logging.getLogger(__name__)


class RegionCorrector:
    def __init__(self, config: CorrectionConfig, client=None, progress_fn=None):
        self.config = config
        self.progress_fn = progress_fn
        self.client = client or OpenAIChatClient(
            base_url=config.base_url,
            model=config.model,
            api_key=config.api_key,
            timeout=config.timeout,
        )

    def correct(
        self,
        *,
        ref_words: Sequence[str],
        ref_to_timing: Dict[int, dict],
        classes: Dict[int, str],
        line_starts: Sequence[int],
        whisper_words: Sequence[TimedWord],
        whisper_to_ref: Dict[int, int],
        vad_segments: Optional[Sequence[Tuple[float, float]]] = None,
        progress_fn=None,
    ) -> Tuple[Dict[int, dict], Dict]:
        """Return ``(updated ref_to_timing copy, stats)``.

        ``progress_fn(region_idx, total)`` is called before each LLM call
        (best-effort; exceptions are swallowed).
        """
        regions = build_regions(
            ref_words, classes, ref_to_timing, line_starts,
            whisper_words, self.config, vad_segments,
        )
        stats = {
            "regions_found": len(regions),
            "regions_applied": 0,
            "words_retimed": 0,
            "failures": 0,
            "regions": [],
        }
        timing = dict(ref_to_timing)
        applied_high_water = 0.0
        for ri, region in enumerate(regions):
            if self.progress_fn:
                try:
                    self.progress_fn(ri, len(regions))
                except Exception:
                    pass
            # Line-split regions can share the same exact-anchor window;
            # clamp each window's floor to what earlier regions already
            # claimed so two calls can't hand out overlapping spans.
            lo, hi = region.window
            if applied_high_water > lo and applied_high_water < hi:
                region.window = (applied_high_water, hi)
            accepted = self._correct_region(
                region, ref_words, timing, whisper_words, whisper_to_ref,
            )
            info = {
                "span": [region.lo, region.hi],
                "reasons": region.reasons,
                "words": [ref_words[i] for i in region.targets],
                "applied": bool(accepted),
            }
            stats["regions"].append(info)
            if not accepted:
                stats["failures"] += 1
                continue
            offset = self.config.calibration_offset
            for ref_idx, span in accepted.items():
                timing[ref_idx] = {
                    "start": span["start"] + offset,
                    "end": span["end"] + offset,
                }
                applied_high_water = max(
                    applied_high_water, span["end"] + offset,
                )
            stats["regions_applied"] += 1
            stats["words_retimed"] += len(accepted)
            logger.info(
                "LLM correction applied to %s (%s): %d/%d words",
                info["words"], ",".join(region.reasons),
                len(accepted), len(region.targets),
            )
        return timing, stats

    def _correct_region(
        self,
        region: Region,
        ref_words: Sequence[str],
        ref_to_timing: Dict[int, dict],
        whisper_words: Sequence[TimedWord],
        whisper_to_ref: Dict[int, int],
    ) -> Optional[Dict[int, dict]]:
        retry_error: Optional[str] = None
        for _attempt in range(2):
            user = build_user_prompt(
                region, ref_words, ref_to_timing, whisper_words,
                whisper_to_ref, self.config, retry_error=retry_error,
            )
            try:
                content = self.client.complete_json(SYSTEM_PROMPT, user)
            except CorrectionUnavailable as e:
                logger.info(
                    "LLM correction unavailable for words %d-%d: %s",
                    region.lo, region.hi, e,
                )
                return None
            accepted, err = parse_and_validate(
                content, region, ref_words, ref_to_timing, self.config,
            )
            if err is None:
                return accepted or None
            logger.info(
                "LLM correction rejected for words %d-%d: %s",
                region.lo, region.hi, err,
            )
            retry_error = err
        return None
