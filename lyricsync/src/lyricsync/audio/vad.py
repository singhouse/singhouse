# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
from typing import List, Tuple

import numpy as np

from lyricsync._config import VadConfig
from lyricsync.audio.io import read_wav_mono

logger = logging.getLogger(__name__)

# Splitting ceiling used when ``VadConfig.max_segment_duration`` is ``None``
# ("auto"). Whisper's window is 30 s, so no slice longer than this is useful.
# A decode subprocess that can measure device memory may re-split these slices
# further; see the Heart decode script.
AUTO_MAX_SEGMENT_CEILING = 30.0

# Fixed cap for transcribers that cannot measure accelerator memory when the
# config asks for "auto". Safe on ~8 GB cards.
SAFE_MAX_SEGMENT_DURATION = 15.0


def _fallback_window(config: VadConfig) -> float:
    """Length of the single whole-file window used when VAD finds nothing.

    Auto keeps the safe fixed window: a silent or near-silent stem gives the
    decoder nothing to size against, so it gets the same 15 s window as before.
    """
    if config.max_segment_duration is None:
        return SAFE_MAX_SEGMENT_DURATION
    return config.max_segment_duration


def effective_max_segment_duration(config: VadConfig) -> float:
    """The splitting cap for ``config``: the explicit value, else the ceiling."""
    if config.max_segment_duration is None:
        return AUTO_MAX_SEGMENT_CEILING
    return config.max_segment_duration


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
    max_duration = effective_max_segment_duration(config)

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
        return [(0, min(duration, _fallback_window(config)))]

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
        while end - start > max_duration:
            final.append((start, start + max_duration))
            start += max_duration
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
        return [(0, min(duration, _fallback_window(config)))]

    logger.info(
        "RMS-VAD: %d segments from %.1fs audio (%d dropped below %.1fs)",
        len(kept),
        len(samples) / sample_rate,
        len(final) - len(kept),
        config.min_segment_duration,
    )
    return kept
