# SPDX-License-Identifier: MIT
from __future__ import annotations

from typing import Protocol, runtime_checkable

from lyricsync._types import AlignmentReference, SyncResult, TimedWord


@runtime_checkable
class Aligner(Protocol):
    """Protocol for alignment strategies."""

    def align(
        self,
        whisper_words: list[TimedWord],
        reference: AlignmentReference,
    ) -> SyncResult: ...
