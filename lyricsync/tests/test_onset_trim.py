# SPDX-License-Identifier: MIT
"""Tests for the onset-trim pass (word starts pushed to voice onset)."""

import numpy as np
import pytest

from lyricsync._config import PostProcessConfig, VadConfig
from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment
from lyricsync.audio.onset_trim import ONSET_LEAD_IN_SEC, trim_word_starts_to_onsets

SR = 16000


def _audio(*spans, duration=10.0):
    """Silence with 440Hz tone in the given (start, end) spans."""
    samples = np.zeros(int(SR * duration), dtype=np.float32)
    for start, end in spans:
        n = int(SR * (end - start))
        t = np.linspace(0, end - start, n, dtype=np.float32)
        samples[int(SR * start):int(SR * start) + n] = np.sin(2 * np.pi * 440 * t) * 0.5
    return samples


def _result(words):
    return TranscriptionResult(segments=[
        TranscriptionSegment(
            start=words[0].start, end=words[-1].end,
            text=" ".join(w.text for w in words), words=list(words),
        ),
    ])


class TestTrimWordStartsToOnsets:
    def test_start_in_silence_moves_to_onset(self):
        # Voice at 1.0-2.0s and 3.0-4.0s; second word stamped at the end of
        # the first phrase (the tiling artifact) though it's sung at 3.0.
        audio = _audio((1.0, 2.0), (3.0, 4.0))
        words = [
            TimedWord(text="first", start=1.0, end=2.0),
            TimedWord(text="second", start=2.0, end=3.5),
        ]
        trimmed, n = trim_word_starts_to_onsets(_result(words), audio, SR)
        assert n == 1
        out = trimmed.segments[0].words
        assert out[0].start == 1.0  # active at stamp — untouched
        assert out[1].start == pytest.approx(3.0 - ONSET_LEAD_IN_SEC, abs=0.1)
        assert out[1].end == 3.5  # ends never move

    def test_start_in_active_audio_untouched(self):
        audio = _audio((0.5, 4.0))
        words = [TimedWord(text="word", start=1.0, end=2.0)]
        trimmed, n = trim_word_starts_to_onsets(_result(words), audio, SR)
        assert n == 0
        assert trimmed.segments[0].words[0].start == 1.0

    def test_trim_capped(self):
        # Onset is 5s after the stamped start — beyond trim_start_max_sec,
        # so the word is left alone (a huge scan-ahead means the word itself
        # is misplaced, not just its start).
        audio = _audio((6.0, 7.0), duration=8.0)
        words = [TimedWord(text="word", start=1.0, end=6.5)]
        trimmed, n = trim_word_starts_to_onsets(_result(words), audio, SR)
        assert n == 0
        assert trimmed.segments[0].words[0].start == 1.0

    def test_start_never_crosses_end(self):
        # Whole word span sits in silence; onset is just past the word's
        # end. Start clamps to end - min_word_duration, not past it.
        audio = _audio((2.0, 3.0))
        words = [TimedWord(text="word", start=1.0, end=1.9)]
        post = PostProcessConfig()
        trimmed, n = trim_word_starts_to_onsets(
            _result(words), audio, SR, post_config=post,
        )
        assert n == 1
        w = trimmed.segments[0].words[0]
        assert w.start == pytest.approx(1.9 - post.min_word_duration)
        assert w.end == 1.9

    def test_no_onset_after_start_untouched(self):
        # Silence forever after the stamp — nothing to snap to.
        audio = _audio((0.0, 1.0), duration=6.0)
        words = [TimedWord(text="word", start=2.0, end=3.0)]
        trimmed, n = trim_word_starts_to_onsets(_result(words), audio, SR)
        assert n == 0
        assert trimmed.segments[0].words[0].start == 2.0

    def test_start_order_preserved(self):
        # Tiled words across a pause: trimming may not reorder starts.
        audio = _audio((1.0, 2.0), (3.0, 5.0))
        words = [
            TimedWord(text="a", start=1.0, end=2.0),
            TimedWord(text="b", start=2.0, end=3.4),
            TimedWord(text="c", start=3.4, end=4.0),
        ]
        trimmed, n = trim_word_starts_to_onsets(_result(words), audio, SR)
        out = trimmed.segments[0].words
        starts = [w.start for w in out]
        assert starts == sorted(starts)
        assert n == 1

    def test_segment_start_follows_first_word(self):
        audio = _audio((3.0, 4.0))
        words = [TimedWord(text="word", start=2.0, end=3.5)]
        trimmed, _ = trim_word_starts_to_onsets(_result(words), audio, SR)
        assert trimmed.segments[0].start == trimmed.segments[0].words[0].start

    def test_empty_audio(self):
        words = [TimedWord(text="word", start=1.0, end=2.0)]
        trimmed, n = trim_word_starts_to_onsets(
            _result(words), np.zeros(100, dtype=np.float32), SR,
        )
        assert n == 0

    def test_original_result_not_mutated(self):
        audio = _audio((1.0, 2.0), (3.0, 4.0))
        words = [
            TimedWord(text="a", start=1.0, end=2.0),
            TimedWord(text="b", start=2.0, end=3.5),
        ]
        result = _result(words)
        trim_word_starts_to_onsets(result, audio, SR)
        assert result.segments[0].words[1].start == 2.0


class TestPipelineIntegration:
    def _write_wav(self, path, samples):
        import wave

        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SR)
            wf.writeframes((samples * 32767).astype(np.int16).tobytes())

    def test_align_only_trims_with_audio_path(self, tmp_path):
        from lyricsync import PipelineConfig, SyncPipeline

        audio = _audio((1.0, 2.0), (3.0, 4.0))
        wav = tmp_path / "vocals.wav"
        self._write_wav(wav, audio)

        result = _result([
            TimedWord(text="Hello", start=1.0, end=2.0),
            TimedWord(text="World", start=2.0, end=3.5),
        ])
        pipeline = SyncPipeline(transcriber=None, config=PipelineConfig())
        sync = pipeline.align_only(result, audio_path=str(wav))
        assert sync is not None
        assert sync.metadata.extra["starts_trimmed_to_onset"] == 1
        # whisper-only path: line words carry the trimmed start
        flat = [w for line in sync.lines for w in line]
        world = next(w for w in flat if w.text == "World")
        assert world.start == pytest.approx(3.0 - ONSET_LEAD_IN_SEC, abs=0.1)

    def test_align_only_without_audio_path_unchanged(self):
        from lyricsync import PipelineConfig, SyncPipeline

        result = _result([
            TimedWord(text="Hello", start=1.0, end=2.0),
            TimedWord(text="World", start=2.0, end=3.5),
        ])
        pipeline = SyncPipeline(transcriber=None, config=PipelineConfig())
        sync = pipeline.align_only(result)
        assert sync is not None
        assert sync.metadata.extra["starts_trimmed_to_onset"] == 0
        flat = [w for line in sync.lines for w in line]
        assert next(w for w in flat if w.text == "World").start == 2.0

    def test_trim_disabled_by_config(self, tmp_path):
        from lyricsync import PipelineConfig, PostProcessConfig, SyncPipeline

        audio = _audio((1.0, 2.0), (3.0, 4.0))
        wav = tmp_path / "vocals.wav"
        self._write_wav(wav, audio)

        result = _result([
            TimedWord(text="Hello", start=1.0, end=2.0),
            TimedWord(text="World", start=2.0, end=3.5),
        ])
        config = PipelineConfig(
            postprocess=PostProcessConfig(trim_starts_to_onset=False),
        )
        pipeline = SyncPipeline(transcriber=None, config=config)
        sync = pipeline.align_only(result, audio_path=str(wav))
        flat = [w for line in sync.lines for w in line]
        assert next(w for w in flat if w.text == "World").start == 2.0
