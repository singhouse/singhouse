# SPDX-License-Identifier: MIT
"""Placement of reference words the transcription couldn't time.

Unmatched reference words used to be interpolated as
``[prev_end + gap*0.1, prev_end + gap*0.9]``, which breaks two ways:

- the span is unbounded, so a phrase-initial word falling into a 30 s
  instrumental gap becomes a 24-second word that starts mid-solo — and
  drags its whole display line (and the player's page grouping) with it;
- consecutive unmatched words all see the same matched anchors, so a run
  gets identical stacked spans that highlight simultaneously.

Here unmatched words are placed run-by-run with a nominal per-word
duration, anchored to the side of their phrase-mates: a run that opens a
reference line hugs the next matched word, one that closes a line hugs
the previous matched word, and only tight gaps are divided evenly. Words
in a run are laid out sequentially, never stacked, and always inside the
(prev_end, next_start) window so global ordering is preserved.

Every word — matched or interpolated — is also floored to
``min_word_duration``. Whisper emits 0-60 ms spans, and an unmatched ref
word between two contiguous matched words would otherwise divide a 0.00 s
gap: both render as "instant" highlights. Tight runs keep their end at
``next_start`` and borrow the shortfall from the previous word's tail
(overlap beats invisibility; the singing is continuous there anyway).
"""

from __future__ import annotations

from bisect import bisect_right
from typing import Dict, List, Optional

from lyricsync._config import PostProcessConfig
from lyricsync._types import TimedWord


def fill_unmatched_words(
    ref_words: List[str],
    ref_to_timing: Dict[int, dict],
    line_starts: List[int],
    post_config: PostProcessConfig,
) -> List[TimedWord]:
    """Build the full timed-word list for ``ref_words``.

    Matched indices (present in ``ref_to_timing``) keep their whisper
    timing; runs of unmatched indices are placed per the module rules and
    flagged ``interpolated``. ``line_starts`` holds the ref-word index at
    which each reference line begins (a trailing sentinel is harmless).
    """
    n = len(ref_words)
    floor = post_config.min_word_duration
    out: List[Optional[TimedWord]] = [None] * n
    for i, word in enumerate(ref_words):
        t = ref_to_timing.get(i)
        if t:
            out[i] = TimedWord(
                text=word, start=t["start"],
                end=max(t["end"], t["start"] + floor),
            )

    def line_of(i: int) -> int:
        return bisect_right(line_starts, i) - 1

    nominal = post_config.per_word_singing_duration
    i = 0
    while i < n:
        if out[i] is not None:
            i += 1
            continue
        j = i
        while j < n and out[j] is None:
            j += 1
        _place_run(out, ref_words, i, j, line_of, nominal, floor)
        i = j
    return out  # type: ignore[return-value]  # every slot filled above


def _place_run(
    out: List[Optional[TimedWord]],
    ref_words: List[str],
    i: int,
    j: int,
    line_of,
    nominal: float,
    floor: float,
) -> None:
    """Assign spans to the unmatched run ``out[i:j]`` (all None on entry)."""
    k = j - i
    prev_end = out[i - 1].end if i > 0 else None
    next_start = out[j].start if j < len(out) else None

    if prev_end is not None and next_start is not None:
        gap = max(0.0, next_start - prev_end)
        needed = k * nominal
        if gap <= needed:
            # Tight gap: the run fills it, ending at the next matched word.
            # A zero/sub-floor gap borrows the shortfall from the previous
            # word's tail rather than emit invisible instant words.
            hi = next_start
            lo = next_start - max(gap, k * floor)
        elif line_of(j - 1) == line_of(j):
            # Run opens the phrase the next matched word belongs to.
            lo, hi = next_start - needed, next_start
        elif line_of(i) == line_of(i - 1):
            # Run closes the phrase the previous matched word belongs to.
            lo, hi = prev_end, prev_end + needed
        else:
            # Whole line(s) missed inside a large gap: no evidence for
            # either side, so center the run.
            mid = (prev_end + next_start) / 2
            lo, hi = mid - needed / 2, mid + needed / 2
    elif prev_end is not None:
        lo, hi = prev_end, prev_end + k * nominal
    elif next_start is not None:
        lo, hi = next_start - k * nominal, next_start
    else:
        lo, hi = 0.0, k * nominal

    lo = max(0.0, lo)
    if i > 0:
        # Borrowing must never invert start order, even against a word
        # that was itself floored from a tiny whisper span.
        lo = max(lo, out[i - 1].start + 0.01)
    hi = max(hi, lo + k * 0.01)  # last resort: sequential, never stacked
    step = (hi - lo) / k
    for t in range(k):
        out[i + t] = TimedWord(
            text=ref_words[i + t],
            start=lo + t * step,
            end=lo + (t + 1) * step,
            interpolated=True,
        )
