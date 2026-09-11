# SPDX-License-Identifier: MIT
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from lyricsync._types import TranscriptionResult


@runtime_checkable
class Transcriber(Protocol):
    """Protocol for transcription backends."""

    def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
    ) -> TranscriptionResult: ...
