# SPDX-License-Identifier: MIT
"""Region prompt construction and response validation.

The prompt is experiment 2's template: reference words flagged
locked/unlocked, every ASR token in the window (matched and discarded
alike) with timestamps, the window bounds, any VAD onset, and the two
hints that demonstrably steered the model — held notes land on
phrase-final words, and token splits/joins are common.

Validation is mechanical and unforgiving; anything it rejects is retried
once with the error appended, then the region falls back to the
heuristic. Confidence gating happens here too (drop ``low``).
"""

from __future__ import annotations

import json
import re
from typing import Dict, List, Optional, Sequence, Tuple

from lyricsync._config import CorrectionConfig
from lyricsync._types import TimedWord
from lyricsync.alignment.matching import normalize
from lyricsync.correction.regions import Region

SYSTEM_PROMPT = (
    "You repair word-level karaoke timing. An automatic aligner matched an "
    "ASR transcription against known-correct reference lyrics; in the "
    "passage below its assignments are suspect. Using the ASR tokens as "
    "timing evidence, assign each UNLOCKED reference word a start and end "
    "in seconds. The reference text is the truth about WHAT was sung; the "
    "tokens are evidence for WHEN. The evidence is short — decide quickly, "
    "reason briefly, and answer with strict JSON only."
)

_CONF_RANK = {"low": 0, "medium": 1, "high": 2}


def _fmt(t: float) -> str:
    return f"{t:.2f}"


def region_tokens(
    region: Region,
    whisper_words: Sequence[TimedWord],
    whisper_to_ref: Dict[int, int],
    slack: float,
) -> List[Tuple[int, TimedWord, Optional[int]]]:
    """All ASR tokens overlapping the region window, with their ref match."""
    lo, hi = region.window
    out = []
    for wi, w in enumerate(whisper_words):
        if w.end < lo - slack or w.start > hi + slack:
            continue
        out.append((wi, w, whisper_to_ref.get(wi)))
    return out


def build_user_prompt(
    region: Region,
    ref_words: Sequence[str],
    ref_to_timing: Dict[int, dict],
    whisper_words: Sequence[TimedWord],
    whisper_to_ref: Dict[int, int],
    config: CorrectionConfig,
    retry_error: Optional[str] = None,
) -> str:
    lo, hi = region.window
    lines: List[str] = []
    lines.append(
        f"Time window: {_fmt(lo)} to {_fmt(hi)}. Every start/end must stay "
        f"inside it (tolerance {config.window_slack_sec:.1f}s)."
    )
    if region.vad_onset is not None:
        lines.append(
            f"Voice-activity onset at {_fmt(region.vad_onset)}: the first "
            f"sung word of this phrase starts there."
        )

    lines.append("")
    lines.append("Reference words (sung in this order):")
    for i in range(region.lo, region.hi + 1):
        word = ref_words[i]
        t = ref_to_timing.get(i)
        if i in region.locked:
            lines.append(
                f'  "{word}" LOCKED [{_fmt(t["start"])}, {_fmt(t["end"])}]'
            )
        elif t is not None:
            lines.append(
                f'  "{word}" UNLOCKED (aligner guess '
                f'[{_fmt(t["start"])}, {_fmt(t["end"])}] — may be wrong)'
            )
        else:
            lines.append(f'  "{word}" UNLOCKED (no timing evidence)')

    lines.append("")
    lines.append("ASR tokens in this window (what the model heard):")
    for _wi, w, ref_idx in region_tokens(
        region, whisper_words, whisper_to_ref, config.window_slack_sec,
    ):
        dur = w.end - w.start
        tag = (
            f'aligner matched it to "{ref_words[ref_idx]}"'
            if ref_idx is not None
            else "unmatched (discarded by the aligner)"
        )
        lines.append(
            f'  "{w.text}" [{_fmt(w.start)}, {_fmt(w.end)}] '
            f"(duration {dur:.2f}s) — {tag}"
        )

    lines.append("")
    lines.append("Facts about sung timing:")
    lines.append(
        "- An unusually long token is a held note; holds land on "
        "phrase-final words, not function words."
    )
    lines.append(
        "- ASR splits and joins words freely (\"key chain\"=\"keychain\", "
        "\"a thousand\"=\"a 1,000\"); a garbled token span can cover a "
        "different number of reference words."
    )
    lines.append(
        "- Words are sung in order: starts must be non-decreasing and must "
        "not reorder around LOCKED spans."
    )

    lines.append("")
    lines.append(
        'Return strict JSON: {"words": [{"word": "...", "start": 0.0, '
        '"end": 0.0, "confidence": "high|medium|low"}]} — every UNLOCKED '
        "word exactly once, in order; do not include LOCKED words. If the "
        'evidence does not pin a word down, rate it "low".'
    )

    if retry_error:
        lines.append("")
        lines.append(
            f"Your previous answer was rejected: {retry_error}. Fix exactly "
            f"that and return the corrected JSON."
        )
    return "\n".join(lines)


def _coerce_confidence(value) -> Optional[str]:
    """Accept the contract's high/medium/low, but also the numeric scores
    local models sometimes emit instead (0.9 -> high)."""
    if isinstance(value, str):
        v = value.lower().strip()
        if v in _CONF_RANK:
            return v
        try:
            value = float(v)
        except ValueError:
            return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 0.0 <= value <= 1.0:
            return "high" if value >= 0.75 else "medium" if value >= 0.5 else "low"
    return None


def _strip_fences(content: str) -> str:
    content = content.strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", content, re.DOTALL)
    return m.group(1) if m else content


def parse_and_validate(
    content: str,
    region: Region,
    ref_words: Sequence[str],
    ref_to_timing: Dict[int, dict],
    config: CorrectionConfig,
) -> Tuple[Optional[Dict[int, dict]], Optional[str]]:
    """Validate a completion against the region contract.

    Returns ``(mappings, None)`` on success — ref idx -> {start, end} for
    every accepted (confidence-gated) target — or ``(None, error)`` where
    ``error`` is the message to append to the retry prompt.
    """
    try:
        data = json.loads(_strip_fences(content))
    except json.JSONDecodeError as e:
        return None, f"not valid JSON ({e})"

    words = data.get("words") if isinstance(data, dict) else None
    if not isinstance(words, list):
        return None, 'missing "words" array'

    targets = region.targets
    if len(words) != len(targets):
        return None, (
            f"expected exactly {len(targets)} unlocked words, got {len(words)}"
        )

    slack = config.window_slack_sec
    win_lo, win_hi = region.window
    proposed: Dict[int, dict] = {}
    prev_start = None
    for entry, ref_idx in zip(words, targets):
        if not isinstance(entry, dict):
            return None, "each words[] entry must be an object"
        word = str(entry.get("word", ""))
        if normalize(word) != normalize(ref_words[ref_idx]):
            return None, (
                f'word order mismatch: expected "{ref_words[ref_idx]}", '
                f'got "{word}"'
            )
        try:
            start = float(entry["start"])
            end = float(entry["end"])
        except (KeyError, TypeError, ValueError):
            return None, f'"{word}" is missing numeric start/end'
        conf = _coerce_confidence(entry.get("confidence"))
        if conf is None:
            return None, (
                f'"{word}" has invalid confidence '
                f'{entry.get("confidence")!r} (use high/medium/low)'
            )
        if end < start:
            return None, f'"{word}" ends before it starts'
        if start < win_lo - slack or end > win_hi + slack:
            return None, (
                f'"{word}" [{start:.2f}, {end:.2f}] leaves the window '
                f"[{win_lo:.2f}, {win_hi:.2f}]"
            )
        if prev_start is not None and start < prev_start - 1e-6:
            return None, f'"{word}" starts before the preceding word'
        prev_start = start
        proposed[ref_idx] = {"start": start, "end": end, "confidence": conf}

    # Locked spans are immovable context: proposals on either side of a
    # locked word must not reorder around it.
    for locked_idx in region.locked:
        lt = ref_to_timing[locked_idx]
        for ref_idx, span in proposed.items():
            if ref_idx < locked_idx and span["start"] > lt["start"] + slack:
                return None, (
                    f'"{ref_words[ref_idx]}" would be sung after the locked '
                    f'"{ref_words[locked_idx]}"'
                )
            if ref_idx > locked_idx and span["start"] < lt["start"] - slack:
                return None, (
                    f'"{ref_words[ref_idx]}" would be sung before the locked '
                    f'"{ref_words[locked_idx]}"'
                )

    gate = _CONF_RANK.get(config.confidence_gate, 1)
    accepted = {
        i: {"start": s["start"], "end": s["end"]}
        for i, s in proposed.items()
        if _CONF_RANK[s["confidence"]] >= gate
    }
    return accepted, None
