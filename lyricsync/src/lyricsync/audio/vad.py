# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
from typing import List, Tuple

import numpy as np

from lyricsync._config import VadConfig
from lyricsync.audio.io import read_wav_mono

logger = logging.getLogger(__name__)


def compute_rms_vad(
    samples: np.ndarray,
    sample_rate: int,
    frame_size: int = VadConfig.frame_size,
) -> np.ndarray:
    """
    Compute normalized RMS envelope for voice activity detection.

    Returns a 1D array of per-frame RMS values normalized to [0, 1].
    """
    n_frames = len(samples) // frame_size
    rms = np.zeros(n_frames)

    for i in range(n_frames):
        frame = samples[i * frame_size:(i + 1) * frame_size]
        rms[i] = np.sqrt(np.mean(frame ** 2))

    max_rms = rms.max()
    if max_rms > 0:
        rms /= max_rms

    return rms


def rms_vad_segments(
    samples: np.ndarray,
    sample_rate: int,
    config: VadConfig | None = None,
) -> List[Tuple[float, float]]:
    """
    Use RMS-based VAD to find vocal activity regions ("Cut & Merge").

    Returns list of (start_sec, end_sec) tuples representing segments
    to feed to a transcriber individually.
    """
    if config is None:
        config = VadConfig()

    rms = compute_rms_vad(samples, sample_rate, config.frame_size)
    hop = config.frame_size
    frame_dur = hop / sample_rate

    active = rms >= config.onset_threshold
    regions: list[tuple[float, float]] = []
    in_region = False
    region_start = 0

    for i, is_active in enumerate(active):
        if is_active and not in_region:
            region_start = i
            in_region = True
        elif not is_active and in_region:
            if rms[i] < config.offset_threshold:
                regions.append((region_start * frame_dur, i * frame_dur))
                in_region = False

    if in_region:
        regions.append((region_start * frame_dur, len(rms) * frame_dur))

    if not regions:
        duration = len(samples) / sample_rate
        return [(0, min(duration, config.max_segment_duration))]

    # Merge regions separated by less than min_silence
    merged = [regions[0]]
    for start, end in regions[1:]:
        prev_start, prev_end = merged[-1]
        if start - prev_end < config.min_silence_duration:
            merged[-1] = (prev_start, end)
        else:
            merged.append((start, end))

    # Split segments longer than max_duration
    final: list[tuple[float, float]] = []
    for start, end in merged:
        while end - start > config.max_segment_duration:
            final.append((start, start + config.max_segment_duration))
            start += config.max_segment_duration
        if end > start:
            final.append((start, end))

    # Drop sub-threshold blips (see VadConfig.min_segment_duration). If that
    # leaves nothing, fall back to the same whole-file window the no-regions
    # branch above uses rather than handing the transcriber an empty list.
    kept = [(start, end) for start, end in final if end - start >= config.min_segment_duration]
    if not kept:
        duration = len(samples) / sample_rate
        logger.info(
            "RMS-VAD: all %d segments shorter than min_segment_duration=%.1fs "
            "— falling back to whole-file window",
            len(final),
            config.min_segment_duration,
        )
        return [(0, min(duration, config.max_segment_duration))]

    logger.info(
        "RMS-VAD: %d segments from %.1fs audio (%d dropped below %.1fs)",
        len(kept),
        len(samples) / sample_rate,
        len(final) - len(kept),
        config.min_segment_duration,
    )
    return kept
