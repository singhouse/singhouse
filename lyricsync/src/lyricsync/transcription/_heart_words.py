# SPDX-License-Identifier: MIT
"""Conservative cleanup of HEART timestamp chunks, without changing language."""
from __future__ import annotations

from dataclasses import replace
import re

from lyricsync._types import TimedWord

# Whisper can emit contraction punctuation and suffixes as separate timestamp
# chunks. Only known contraction suffixes are joined; arbitrary quoted words,
# punctuation, and multilingual text must survive unchanged.
_SUFFIX = re.compile(r"['’](?:t|s|re|ve|ll|d|m)\Z", re.IGNORECASE)
_BASE = re.compile(r"[A-Za-z]+\Z")


def normalize_heart_words(words: list[TimedWord]) -> list[TimedWord]:
    """Join adjacent contraction chunks, retaining their complete time envelope.

    Do not join across segment boundaries or pauses over 100 ms. Fullwidth
    apostrophes are folded explicitly, avoiding blanket Unicode normalization.
    Curly apostrophes and every other Unicode character remain intact.
    """
    words = [replace(w, text=w.text.replace("＇", "'")) for w in words]
    result: list[TimedWord] = []
    i = 0
    while i < len(words):
        word = words[i]
        count = 1
        if result and _BASE.fullmatch(result[-1].text):
            suffix = word.text
            if suffix in ("'", "’") and i + 1 < len(words):
                suffix += words[i + 1].text
                count = 2
            fragments = [result[-1], *words[i:i + count]]
            if _SUFFIX.fullmatch(suffix) and all(
                left.start <= right.start and right.start - left.end <= 0.1
                for left, right in zip(fragments, fragments[1:])
            ):
                result[-1] = replace(
                    result[-1], text=result[-1].text + suffix,
                    end=max(w.end for w in fragments),
                    interpolated=any(w.interpolated for w in fragments),
                )
                i += count
                continue
        result.append(word)
        i += 1
    return result
