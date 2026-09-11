# SPDX-License-Identifier: MIT
"""Correct Whisper word starts that sit in silence.

Whisper derives word timestamps by DTW over decoder cross-attention, which
partitions each transcription window into contiguous word spans — word N's
end IS word N+1's start by construction. Silence between sung phrases has no
representation in the output; it gets absorbed into an adjacent word,
usually the following word's start. The result is phrase-initial words whose
"start" is the moment the previous phrase ended, up to the VAD merge
threshold (~1.5 s) too early.

The transcription can't tell us where those words really begin, but the
audio can: this module scans the same RMS envelope the VAD uses and pushes
any word start that lands in silent frames forward to the next voice onset.
Ends are never moved, so word order and span containment are preserved.
"""

from __future__ import annotations

import logging
from typing import Tuple

import numpy as np

from lyricsync._config import PostProcessConfig, VadConfig
from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment
from lyricsync.audio.vad import compute_rms_vad

logger = logging.getLogger(__name__)

# Back the trimmed start off the detected onset slightly so the highlight
# never clips the attack of the word (RMS frames are ~23 ms at 44.1 kHz, and
# the envelope crosses the threshold a beat after the true acoustic start).
ONSET_LEAD_IN_SEC = 0.05


def trim_word_starts_to_onsets(
    result: TranscriptionResult,
    samples: np.ndarray,
    sample_rate: int,
    vad_config: VadConfig | None = None,
    post_config: PostProcessConfig | None = None,
) -> Tuple[TranscriptionResult, int]:
    """Return a copy of ``result`` with silent word starts moved to the next
    RMS onset, plus the number of words trimmed.

    A word is trimmed when its start frame is below the VAD offset threshold
    (clearly silent — hysteresis guards words that start during a decaying
    tail) and a frame at or above the onset threshold exists within
    ``trim_start_max_sec``. The new start never crosses ``end`` minus
    ``min_word_duration``, so spans stay valid and start order is preserved.
    """
    vad = vad_config or VadConfig()
    post = post_config or PostProcessConfig()

    if len(samples) < vad.frame_size:
        return result, 0
    rms = compute_rms_vad(samples, sample_rate, vad.frame_size)
    frame_dur = vad.frame_size / sample_rate

    trimmed = 0
    new_segments: list[TranscriptionSegment] = []
    for seg in result.segments:
        new_words: list[TimedWord] = []
        for w in seg.words:
            new_words.append(_trim_word(w, rms, frame_dur, vad, post))
            if new_words[-1].start != w.start:
                trimmed += 1
        seg_start = new_words[0].start if new_words else seg.start
        new_segments.append(TranscriptionSegment(
            start=seg_start, end=seg.end, text=seg.text, words=new_words,
        ))

    if trimmed:
        logger.info(
            "Onset trim: %d/%d word starts moved forward to voice onset",
            trimmed, sum(len(s.words) for s in result.segments),
        )
    return TranscriptionResult(
        segments=new_segments,
        language=result.language,
        full_text=result.full_text,
    ), trimmed


def _trim_word(
    w: TimedWord,
    rms: np.ndarray,
    frame_dur: float,
    vad: VadConfig,
    post: PostProcessConfig,
) -> TimedWord:
    # Whisper word spans tile, so w.start is exactly where the previous
    # word's audio ends — the frame containing it straddles that tail.
    # Judge silence from the first full frame after the start instead.
    i = int(np.ceil(w.start / frame_dur))
    if i >= len(rms) or rms[i] >= vad.offset_threshold:
        return w  # start sits in (or near) active audio — trust it

    j = i
    while j < len(rms) and rms[j] < vad.onset_threshold:
        j += 1
    if j >= len(rms):
        return w  # no voice ever resumes — leave the word alone

    onset = j * frame_dur
    if onset - w.start > post.trim_start_max_sec:
        return w

    new_start = min(onset - ONSET_LEAD_IN_SEC, w.end - post.min_word_duration)
    if new_start <= w.start:
        return w
    return TimedWord(
        text=w.text, start=new_start, end=w.end, interpolated=w.interpolated,
    )
