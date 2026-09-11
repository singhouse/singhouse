# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
import re
from typing import List

from lyricsync._config import PipelineConfig
from lyricsync._types import TimedWord, TranscriptionResult

logger = logging.getLogger(__name__)

_SHORT_SEG_MAX_WORDS = 12
_SHORT_SEG_MAX_SEC = 8.0


def _is_hallucination_segment(seg, config: PipelineConfig) -> bool:
    """Detect Whisper hallucination segments without destroying real lyrics.

    Only fires when the segment is SHORT and the hallucination phrase
    dominates it. Long segments containing "goodbye" or "thank you" as
    ordinary lyrics are left alone.
    """
    words = seg.words
    if not words:
        return True
    if len(words) > _SHORT_SEG_MAX_WORDS:
        return False
    dur = words[-1].end - words[0].start if len(words) > 1 else 0
    if dur > _SHORT_SEG_MAX_SEC:
        return False
    seg_text = seg.text.strip().lower()
    seg_text = re.sub(r"[^\w\s']", "", seg_text).strip()
    for phrase in config.hallucination_phrases:
        pattern = r"\b" + re.escape(phrase) + r"\b"
        if re.search(pattern, seg_text):
            phrase_words = len(phrase.split())
            if phrase_words >= len(words) - 1:
                return True
    return False


def _filter_segment_words(
    seg, config: PipelineConfig, song_duration: float,
) -> List[TimedWord]:
    """Apply post-processing filters to one transcription segment's words."""
    if _is_hallucination_segment(seg, config):
        logger.debug("Skipping hallucination segment: %s", seg.text.strip()[:80])
        return []

    out: list[TimedWord] = []
    for w in seg.words:
        text = w.text.strip()
        if not text or text in ["[*]", "."]:
            continue
        if w.end > 0 and abs(w.end - w.start) < 0.01 and w.start > 10:
            continue
        if song_duration > 0 and w.start > song_duration + 5:
            continue
        out.append(TimedWord(text=text, start=w.start, end=w.end))
    return out


def extract_whisper_words(
    result: TranscriptionResult,
    config: PipelineConfig | None = None,
    song_duration: float = 0,
) -> List[TimedWord]:
    """Extract flat word list from transcription result, filtering hallucinations."""
    if config is None:
        config = PipelineConfig()
    words: list[TimedWord] = []
    for seg in result.segments:
        words.extend(_filter_segment_words(seg, config, song_duration))
    return words


_SENTENCE_FINAL = (".", "!", "?")


def _split_words_into_lines(
    words: List[TimedWord],
    *,
    gap_sec: float,
    max_words: int,
) -> List[List[TimedWord]]:
    """Subdivide a flat word list into singable lines.

    A Whisper segment can span an entire verse when sung phrases have no
    long silences between them, so segment-as-line produces 100+ word lines.
    This splitter looks for four signals (any one triggers a break):

      - prev word ends with .!? AND next starts with a capital letter
        (Whisper preserves both — strongest "new sentence" signal)
      - prev word is fully lowercase AND next word starts with a capital
        (weaker, but the only signal we have when Whisper omits punctuation
        between sustained sung phrases — proper-noun false positives are
        bounded because prev being "Word Word" / "Klein" / etc. blocks it)
      - inter-word gap > gap_sec
      - current line has accumulated max_words words
    """
    if not words:
        return []
    lines: list[list[TimedWord]] = []
    current: list[TimedWord] = []
    for w in words:
        if current:
            prev = current[-1]
            starts_capital = bool(w.text) and w.text[0].isupper()
            ends_sentence = prev.text.endswith(_SENTENCE_FINAL)
            prev_lower = prev.text.islower()
            big_gap = (w.start - prev.end) > gap_sec
            full = len(current) >= max_words
            if (
                (ends_sentence and starts_capital)
                or (prev_lower and starts_capital)
                or big_gap
                or full
            ):
                lines.append(current)
                current = []
        current.append(w)
    if current:
        lines.append(current)
    return lines


def extract_whisper_lines(
    result: TranscriptionResult,
    config: PipelineConfig | None = None,
    song_duration: float = 0,
) -> List[List[TimedWord]]:
    """Filter words like extract_whisper_words, then split each transcription
    segment into singable lines using punctuation/capitalization/gap signals."""
    if config is None:
        config = PipelineConfig()
    pp = config.postprocess
    lines: list[list[TimedWord]] = []
    for seg in result.segments:
        seg_words = _filter_segment_words(seg, config, song_duration)
        if not seg_words:
            continue
        lines.extend(_split_words_into_lines(
            seg_words,
            gap_sec=pp.line_break_gap_sec,
            max_words=pp.line_break_max_words,
        ))
    return lines
