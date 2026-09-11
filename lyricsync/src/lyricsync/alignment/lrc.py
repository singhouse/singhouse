# SPDX-License-Identifier: MIT
from __future__ import annotations

import re
from typing import List

from lyricsync._types import LrcLine


def parse_lrc(lrc_string: str) -> List[LrcLine]:
    """Parse LRC format into list of LrcLine."""
    result: list[LrcLine] = []
    line_regex = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)")
    for match in line_regex.finditer(lrc_string):
        mins = int(match.group(1))
        secs = int(match.group(2))
        ms = int(match.group(3).ljust(3, "0")) if match.group(3) else 0
        text = match.group(4).strip()
        if text:
            result.append(LrcLine(time=mins * 60 + secs + ms / 1000, text=text))
    result.sort(key=lambda x: x.time)
    return result


def strip_lrc_tags(text: str) -> str:
    """Remove inline LRC timestamp tags like [00:56.07] from text."""
    return re.sub(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]", "", text).strip()


def estimate_line_singing_duration(
    line_start: float,
    next_line_start: float,
    ref_word_count: int,
    per_word_duration: float = 0.4,
) -> float:
    """Estimate how long the singing actually lasts for a line."""
    gap = next_line_start - line_start
    max_singing_dur = max(ref_word_count * per_word_duration, 2.0)
    return min(gap, max_singing_dur)
