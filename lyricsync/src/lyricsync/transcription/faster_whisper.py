# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
import os
import site
from pathlib import Path
from typing import Optional

from lyricsync._config import VadConfig
from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment
from lyricsync.audio.io import read_wav_mono
from lyricsync.audio.vad import rms_vad_segments

logger = logging.getLogger(__name__)

# faster-whisper's own default is a six-step ladder up to 1.0, applied whenever
# `temperature` is left unset. We always pass one explicitly: greedy 0.0 for a
# reproducible pass, and the same 0.0/0.1/0.2/0.4 ladder the Heart runners use
# when a caller opts into the rescue path.
TEMPERATURE_LADDER = (0.0, 0.1, 0.2, 0.4)


def _preload_cuda_libs() -> None:
    import ctypes
    for sp in site.getsitepackages():
        for so_name in (
            "nvidia/cublas/lib/libcublas.so.12",
            "nvidia/cublas/lib/libcublasLt.so.12",
            "nvidia/cudnn/lib/libcudnn.so.9",
        ):
            path = os.path.join(sp, so_name)
            if os.path.exists(path):
                try:
                    ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


class FasterWhisperTranscriber:
    """Transcription using faster-whisper with RMS-VAD segmentation."""

    def __init__(
        self,
        model: str = "large-v2",
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
        allow_temperature_fallback: bool = False,
    ):
        self.allow_temperature_fallback = allow_temperature_fallback
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise ImportError(
                "faster-whisper is required for FasterWhisperTranscriber. "
                "Install with: pip install lyricsync[whisper]"
            )

        _preload_cuda_libs()

        if device is None or compute_type is None:
            try:
                import ctranslate2
                ctranslate2.get_supported_compute_types("cuda")
                device = device or "cuda"
                compute_type = compute_type or "float16"
            except Exception:
                device = device or "cpu"
                compute_type = compute_type or "int8"

        logger.info("Loading faster-whisper model %r on %s (%s)", model, device, compute_type)
        self._model = WhisperModel(model, device=device, compute_type=compute_type)

    def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        vad_config: VadConfig | None = None,
    ) -> TranscriptionResult:
        if vad_config is None:
            vad_config = VadConfig()

        samples, sample_rate = read_wav_mono(audio_path)
        vad_segs = rms_vad_segments(samples, sample_rate, vad_config)

        all_segments: list[TranscriptionSegment] = []
        detected_lang = language

        for seg_i, (seg_start, seg_end) in enumerate(vad_segs):
            start_sample = int(seg_start * sample_rate)
            end_sample = int(seg_end * sample_rate)
            segment_audio = samples[start_sample:end_sample]

            if len(segment_audio) < sample_rate * 0.1:
                continue

            transcribe_kwargs = {
                "word_timestamps": True,
                "beam_size": 5,
                "temperature": (
                    TEMPERATURE_LADDER if self.allow_temperature_fallback else 0.0
                ),
            }
            if detected_lang:
                transcribe_kwargs["language"] = detected_lang

            segments_iter, info = self._model.transcribe(segment_audio, **transcribe_kwargs)

            if not detected_lang and seg_i == 0:
                detected_lang = getattr(info, "language", None)
                if detected_lang:
                    logger.info("Auto-detected language: %s (locked for remaining segments)", detected_lang)

            for seg in segments_iter:
                words: list[TimedWord] = []
                if seg.words:
                    for w in seg.words:
                        words.append(TimedWord(
                            text=w.word.strip(),
                            start=w.start + seg_start,
                            end=w.end + seg_start,
                        ))

                if words:
                    all_segments.append(TranscriptionSegment(
                        start=seg.start + seg_start,
                        end=seg.end + seg_start,
                        text=seg.text.strip(),
                        words=words,
                    ))

        logger.info(
            "faster-whisper: %d segments, %d total words, detected language: %s",
            len(all_segments),
            sum(len(s.words) for s in all_segments),
            detected_lang,
        )

        return TranscriptionResult(segments=all_segments, language=detected_lang)
