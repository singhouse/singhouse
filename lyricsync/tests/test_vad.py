# SPDX-License-Identifier: MIT
"""Tests for RMS-VAD segmentation."""

import numpy as np
import pytest

from lyricsync._config import VadConfig
from lyricsync.audio.vad import (
    AUTO_MAX_SEGMENT_CEILING,
    compute_rms_vad,
    effective_max_segment_duration,
    rms_vad_segments,
)


class TestComputeRmsVad:
    def test_silence(self, sample_audio):
        audio, sr = np.zeros(16000, dtype=np.float32), 16000
        rms = compute_rms_vad(audio, sr)
        assert len(rms) > 0
        assert all(v == 0.0 for v in rms)

    def test_signal(self, sample_audio):
        audio, sr = sample_audio
        rms = compute_rms_vad(audio, sr)
        assert len(rms) > 0
        assert rms.max() > 0  # should normalize to 1.0

    def test_custom_frame_size(self):
        audio = np.random.randn(16000).astype(np.float32) * 0.1
        rms = compute_rms_vad(audio, 16000, frame_size=512)
        assert len(rms) == 16000 // 512


class TestRmsVadSegments:
    def test_silence_returns_single_segment(self):
        audio = np.zeros(16000 * 5, dtype=np.float32)
        config = VadConfig(max_segment_duration=30.0)
        segs = rms_vad_segments(audio, 16000, config)
        # Fallback: entire file as one segment
        assert len(segs) == 1
        assert segs[0][0] == 0.0

    def test_continuous_signal(self, sample_audio):
        audio, sr = sample_audio
        config = VadConfig(onset_threshold=0.01, offset_threshold=0.005)
        segs = rms_vad_segments(audio, sr, config)
        assert len(segs) >= 1
        # Segments should cover most of the audio
        total = sum(end - start for start, end in segs)
        assert total > 1.0

    def test_gaps_create_multiple_segments(self, sample_audio_with_silence):
        audio, sr = sample_audio_with_silence
        config = VadConfig(
            onset_threshold=0.05,
            offset_threshold=0.02,
            min_silence_duration=0.5,
        )
        segs = rms_vad_segments(audio, sr, config)
        assert len(segs) >= 2

    def test_max_duration_split(self):
        # 60s of continuous signal should be split into 30s chunks
        sr = 16000
        audio = (np.sin(2 * np.pi * 440 * np.linspace(0, 60, sr * 60)) * 0.5).astype(np.float32)
        config = VadConfig(
            onset_threshold=0.01,
            offset_threshold=0.005,
            max_segment_duration=30.0,
        )
        segs = rms_vad_segments(audio, sr, config)
        for start, end in segs:
            assert end - start <= 30.0

    def test_short_blips_dropped(self):
        # A long tone plus an isolated 0.3s blip. The blip carries no lyric but
        # would be padded to Whisper's 30s window and hallucinated into words,
        # so VAD must not emit it.
        sr = 16000

        def tone(seconds: float) -> np.ndarray:
            t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
            return (np.sin(2 * np.pi * 440 * t) * 0.5).astype(np.float32)

        audio = np.concatenate([
            tone(4.0),
            np.zeros(sr * 3, dtype=np.float32),
            tone(0.3),
            np.zeros(sr * 3, dtype=np.float32),
        ])
        config = VadConfig(
            onset_threshold=0.01,
            offset_threshold=0.005,
            min_silence_duration=0.5,
            min_segment_duration=1.0,
        )
        segs = rms_vad_segments(audio, sr, config)
        assert segs, "the 4s region must survive"
        assert all(end - start >= 1.0 for start, end in segs)
        # The 4s region starts at 0; the blip sits near 7s and must be gone.
        assert not any(start > 6.0 for start, _ in segs)

    def test_all_blips_falls_back_to_whole_file(self):
        # If every region is sub-threshold, returning [] would starve the
        # transcriber — fall back to the whole-file window instead.
        sr = 16000

        def tone(seconds: float) -> np.ndarray:
            t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
            return (np.sin(2 * np.pi * 440 * t) * 0.5).astype(np.float32)

        audio = np.concatenate([
            tone(0.3),
            np.zeros(sr * 3, dtype=np.float32),
            tone(0.3),
            np.zeros(sr * 3, dtype=np.float32),
        ])
        config = VadConfig(
            onset_threshold=0.01,
            offset_threshold=0.005,
            min_silence_duration=0.5,
            min_segment_duration=1.0,
        )
        segs = rms_vad_segments(audio, sr, config)
        assert len(segs) == 1
        assert segs[0][0] == 0


class TestAutoMaxSegmentDuration:
    """``max_segment_duration=None`` ("auto") splits at the 30 s ceiling."""

    @staticmethod
    def _tone(seconds: float, sr: int = 16000) -> np.ndarray:
        t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
        return (np.sin(2 * np.pi * 440 * t) * 0.5).astype(np.float32)

    def test_default_is_auto(self):
        assert VadConfig().max_segment_duration is None
        assert effective_max_segment_duration(VadConfig()) == AUTO_MAX_SEGMENT_CEILING == 30.0
        assert effective_max_segment_duration(VadConfig(max_segment_duration=12.5)) == 12.5

    def test_none_splits_at_the_30s_ceiling(self):
        sr = 16000
        audio = self._tone(65.0, sr)
        config = VadConfig(onset_threshold=0.01, offset_threshold=0.005)
        segs = rms_vad_segments(audio, sr, config)
        assert all(end - start <= 30.0 + 1e-9 for start, end in segs)
        # Longer than 15 s slices survive: the ceiling, not the old 15 s cap.
        assert max(end - start for start, end in segs) == pytest.approx(30.0)

    def test_explicit_cap_is_still_honoured(self):
        sr = 16000
        audio = self._tone(65.0, sr)
        config = VadConfig(onset_threshold=0.01, offset_threshold=0.005,
                           max_segment_duration=15.0)
        segs = rms_vad_segments(audio, sr, config)
        assert all(end - start <= 15.0 + 1e-9 for start, end in segs)
        assert max(end - start for start, end in segs) == pytest.approx(15.0)

    def test_none_whole_file_fallback_keeps_the_safe_window(self):
        # Silent stem: no regions at all.
        audio = np.zeros(16000 * 45, dtype=np.float32)
        assert rms_vad_segments(audio, 16000, VadConfig()) == [(0, 15.0)]

    def test_none_all_blips_fallback_keeps_the_safe_window(self):
        sr = 16000
        audio = np.concatenate([
            self._tone(0.3, sr), np.zeros(sr * 20, dtype=np.float32),
            self._tone(0.3, sr), np.zeros(sr * 20, dtype=np.float32),
        ])
        config = VadConfig(onset_threshold=0.01, offset_threshold=0.005,
                           min_silence_duration=0.5, min_segment_duration=1.0)
        assert rms_vad_segments(audio, sr, config) == [(0, 15.0)]

    def test_explicit_cap_whole_file_fallback_is_unchanged(self):
        audio = np.zeros(16000 * 45, dtype=np.float32)
        segs = rms_vad_segments(audio, 16000, VadConfig(max_segment_duration=25.0))
        assert segs == [(0, 25.0)]
