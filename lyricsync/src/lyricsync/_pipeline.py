# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional

from lyricsync._config import PipelineConfig
from lyricsync._types import (
    LrcReference,
    PlainLyricsReference,
    SyncResult,
    TimedWord,
    TranscriptionResult,
)
from lyricsync.alignment.anchor_gap import AnchorGapAligner
from lyricsync.alignment.lrc import parse_lrc
from lyricsync.alignment.lrc_anchored import LrcAnchoredAligner
from lyricsync.alignment.needleman_wunsch import NeedlemanWunschAligner
from lyricsync.audio.io import read_wav_mono
from lyricsync.audio.onset_trim import trim_word_starts_to_onsets
from lyricsync.transcription._base import Transcriber
from lyricsync.transcription._postprocess import (
    extract_whisper_lines,
    extract_whisper_words,
)

logger = logging.getLogger(__name__)


class SyncPipeline:
    """Synchronous lyrics transcription and alignment pipeline."""

    def __init__(
        self,
        transcriber: Transcriber,
        config: PipelineConfig | None = None,
        correction_progress_fn=None,
    ):
        self.transcriber = transcriber
        self.config = config or PipelineConfig()
        corrector = None
        if self.config.correction.enabled and self.config.correction.base_url:
            from lyricsync.correction import RegionCorrector
            corrector = RegionCorrector(
                self.config.correction, progress_fn=correction_progress_fn,
            )
        self._nw_aligner = NeedlemanWunschAligner(
            match_config=self.config.matching,
            post_config=self.config.postprocess,
            corrector=corrector,
        )
        self._anchor_gap_aligner = AnchorGapAligner(
            match_config=self.config.matching,
            post_config=self.config.postprocess,
            min_anchor_length=self.config.anchor_gap_min_length,
            gap_handler_chain=self.config.gap_handler_chain,
            corrector=corrector,
        )
        self._lrc_aligner = LrcAnchoredAligner(
            match_config=self.config.matching,
            post_config=self.config.postprocess,
            detect_offset=self.config.detect_lrc_offset,
        )

    def run(
        self,
        audio_path: str,
        plain_lyrics: Optional[str] = None,
        synced_lyrics: Optional[str] = None,
        language: Optional[str] = None,
    ) -> Optional[SyncResult]:
        """Full pipeline: transcribe -> extract words -> align -> sync result."""
        if not Path(audio_path).exists():
            logger.warning("Audio file not found: %s", audio_path)
            return None

        # 1. Transcribe
        try:
            transcription = self.transcriber.transcribe(audio_path, language)
        except Exception as e:
            logger.error("Transcription failed: %s", e)
            return None

        transcription, n_trimmed = self._maybe_trim_starts(transcription, audio_path)

        whisper_words = extract_whisper_words(transcription, self.config)
        if not whisper_words:
            logger.warning("Transcriber produced no words")
            return None

        logger.info("Transcriber: %d words extracted", len(whisper_words))

        result = self._align(whisper_words, plain_lyrics, synced_lyrics, transcription)
        if result is not None:
            result.metadata.extra["starts_trimmed_to_onset"] = n_trimmed
        return result

    def align_only(
        self,
        whisper_result: TranscriptionResult,
        plain_lyrics: Optional[str] = None,
        synced_lyrics: Optional[str] = None,
        audio_path: Optional[str] = None,
    ) -> Optional[SyncResult]:
        """Align pre-computed transcription to reference lyrics.

        ``audio_path`` is optional: when the original audio is available the
        onset-trim pass runs against it, correcting Whisper word starts that
        sit in silence (cached transcriptions store the raw timestamps, so
        the trim re-applies on every realign).
        """
        whisper_result, n_trimmed = self._maybe_trim_starts(whisper_result, audio_path)

        whisper_words = extract_whisper_words(whisper_result, self.config)
        if not whisper_words:
            logger.warning("No words extracted from transcription result")
            return None

        result = self._align(whisper_words, plain_lyrics, synced_lyrics, whisper_result)
        if result is not None:
            result.metadata.extra["starts_trimmed_to_onset"] = n_trimmed
        return result

    def _maybe_trim_starts(
        self,
        transcription: TranscriptionResult,
        audio_path: Optional[str],
    ) -> tuple[TranscriptionResult, int]:
        """Run the onset-trim pass when enabled and the audio is readable."""
        if not self.config.postprocess.trim_starts_to_onset:
            return transcription, 0
        if not audio_path or not Path(audio_path).exists():
            return transcription, 0
        try:
            samples, sample_rate = read_wav_mono(audio_path)
        except Exception as e:  # non-WAV input (mp3/flac) — trim is best-effort
            logger.info("Onset trim skipped (could not read %s: %s)", audio_path, e)
            return transcription, 0
        return trim_word_starts_to_onsets(
            transcription, samples, sample_rate,
            vad_config=self.config.vad,
            post_config=self.config.postprocess,
        )

    def _align(
        self,
        whisper_words: List[TimedWord],
        plain_lyrics: Optional[str],
        synced_lyrics: Optional[str],
        transcription: TranscriptionResult,
    ) -> Optional[SyncResult]:
        # LRC-anchored if synced lyrics available
        if synced_lyrics:
            lrc_lines = parse_lrc(synced_lyrics)
            if lrc_lines:
                logger.info("Using LRC-anchored word sync (%d LRC lines)", len(lrc_lines))
                result = self._lrc_aligner.align(
                    whisper_words, LrcReference(lines=lrc_lines),
                )
                self._annotate_metadata(result, transcription)
                return result

        # Plain lyrics: anchor-gap if enabled, otherwise global Needleman-Wunsch.
        if plain_lyrics:
            ref_lines = [l.strip() for l in plain_lyrics.splitlines() if l.strip()]
            if ref_lines:
                aligner = (
                    self._anchor_gap_aligner
                    if self.config.use_anchor_gap_alignment
                    else self._nw_aligner
                )
                logger.info(
                    "Aligning %d whisper words to %d reference lines (%s)",
                    len(whisper_words), len(ref_lines),
                    "anchor-gap" if self.config.use_anchor_gap_alignment else "needleman-wunsch",
                )
                # Transcription segments are VAD segments when VAD is on —
                # phrase-onset evidence for the correction pass.
                vad_segments = [
                    (s.start, s.end) for s in transcription.segments
                ]
                result = aligner.align(
                    whisper_words, PlainLyricsReference(lines=ref_lines),
                    vad_segments=vad_segments,
                )
                self._annotate_metadata(result, transcription)
                return result

        # No reference lyrics — group words into lines by transcription
        # segment boundaries (with VAD on, these are natural phrase breaks).
        logger.warning("No reference lyrics provided, using transcription text as-is")
        seg_lines = extract_whisper_lines(transcription, self.config)
        if not seg_lines:
            seg_lines = [[w] for w in whisper_words]   # last-ditch fallback

        flat_words = [
            {"text": w.text, "start": w.start, "end": w.end}
            for w in whisper_words
        ]
        return SyncResult(
            segments=[{"words": flat_words}],
            lines=seg_lines,
            metadata=self._make_metadata(
                len(whisper_words), 0, 0, 0, "whisper-only", transcription,
            ),
        )

    @staticmethod
    def _annotate_metadata(result: SyncResult, transcription: TranscriptionResult) -> None:
        result.metadata.language = transcription.language

    @staticmethod
    def _make_metadata(
        total: int, matched: int, corrected: int, interpolated: int,
        method: str, transcription: TranscriptionResult,
    ) -> "SyncMetadata":
        from lyricsync._types import SyncMetadata
        return SyncMetadata(
            words_total=total,
            words_matched=matched,
            words_corrected=corrected,
            words_interpolated=interpolated,
            method=method,
            language=transcription.language,
        )
