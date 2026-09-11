# SPDX-License-Identifier: MIT
"""Tests for the full pipeline."""

import pytest

from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment


class MockTranscriber:
    """Mock transcriber for pipeline testing."""

    def __init__(self, words):
        self._words = words

    def transcribe(self, audio_path, language=None):
        return TranscriptionResult(
            segments=[
                TranscriptionSegment(
                    start=self._words[0].start if self._words else 0,
                    end=self._words[-1].end if self._words else 0,
                    text=" ".join(w.text for w in self._words),
                    words=list(self._words),
                )
            ],
            language=language or "en",
        )


from lyricsync import SyncPipeline, AsyncPipeline, PipelineConfig


class TestSyncPipeline:
    def test_full_pipeline_plain_lyrics(self):
        words = [
            TimedWord(text="hello", start=0.0, end=0.5),
            TimedWord(text="world", start=0.6, end=1.0),
        ]
        pipeline = SyncPipeline(transcriber=MockTranscriber(words))
        result = pipeline.run(
            audio_path="/dev/null",
            plain_lyrics="hello world",
        )
        assert result is not None
        assert result.metadata.words_total == 2
        assert result.metadata.words_matched == 2

    def test_full_pipeline_lrc(self):
        words = [
            TimedWord(text="hello", start=0.0, end=0.5),
            TimedWord(text="world", start=1.0, end=1.5),
        ]
        pipeline = SyncPipeline(transcriber=MockTranscriber(words))
        result = pipeline.run(
            audio_path="/dev/null",
            synced_lyrics="[00:00.00]hello\n[00:01.00]world",
        )
        assert result is not None
        assert result.metadata.words_total >= 2

    def test_no_reference_lyrics(self):
        words = [TimedWord(text="hello", start=0.0, end=0.5)]
        pipeline = SyncPipeline(transcriber=MockTranscriber(words))
        result = pipeline.run(audio_path="/dev/null")
        assert result is not None
        assert result.metadata.method == "whisper-only"

    def test_transcription_failure(self):
        class FailTranscriber:
            def transcribe(self, audio_path, language=None):
                raise RuntimeError("GPU on fire")

        pipeline = SyncPipeline(transcriber=FailTranscriber())
        result = pipeline.run(audio_path="/dev/null", plain_lyrics="hello")
        assert result is None

    def test_align_only(self):
        words = [
            TimedWord(text="hello", start=0.0, end=0.5),
            TimedWord(text="world", start=0.6, end=1.0),
        ]
        transcription = TranscriptionResult(
            segments=[
                TranscriptionSegment(
                    start=0.0, end=1.0,
                    text="hello world",
                    words=words,
                )
            ],
            language="en",
        )
        pipeline = SyncPipeline(transcriber=MockTranscriber(words))
        result = pipeline.align_only(
            whisper_result=transcription,
            plain_lyrics="hello world",
        )
        assert result is not None
        assert result.metadata.words_matched == 2


class TestAsyncPipeline:
    @pytest.mark.asyncio
    async def test_async_run(self):
        words = [
            TimedWord(text="hello", start=0.0, end=0.5),
            TimedWord(text="world", start=0.6, end=1.0),
        ]
        pipeline = AsyncPipeline(transcriber=MockTranscriber(words))
        result = await pipeline.run(
            audio_path="/dev/null",
            plain_lyrics="hello world",
        )
        assert result is not None
        assert result.metadata.words_matched == 2
