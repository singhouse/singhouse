# SPDX-License-Identifier: MIT
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class TimedWord:
    """A word with timing information."""
    text: str
    start: float
    end: float
    interpolated: bool = False


@dataclass
class TranscriptionSegment:
    """A segment from transcription with word-level timestamps."""
    start: float
    end: float
    text: str
    words: List[TimedWord]


@dataclass
class TranscriptionResult:
    """Output from any transcription backend."""
    segments: List[TranscriptionSegment]
    language: Optional[str] = None
    full_text: str = ""


@dataclass
class LrcLine:
    """A parsed LRC line with timestamp and text."""
    time: float
    text: str


@dataclass
class PlainLyricsReference:
    """Reference lyrics as plain text lines."""
    lines: List[str]


@dataclass
class LrcReference:
    """Reference lyrics as parsed LRC lines."""
    lines: List[LrcLine]


AlignmentReference = PlainLyricsReference | LrcReference


@dataclass
class SyncMetadata:
    words_total: int = 0
    words_matched: int = 0
    words_corrected: int = 0
    words_interpolated: int = 0
    lines_total: int = 0
    method: str = ""
    language: Optional[str] = None
    artist: Optional[str] = None
    title: Optional[str] = None
    extra: Dict = field(default_factory=dict)


@dataclass
class SyncResult:
    """Final word-level sync output."""
    segments: List[Dict]
    lines: List[List[TimedWord]]
    metadata: SyncMetadata
