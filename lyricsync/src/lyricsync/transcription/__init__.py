# SPDX-License-Identifier: MIT
from lyricsync.transcription._base import Transcriber

__all__ = ["Transcriber"]

def __getattr__(name):
    if name == "FasterWhisperTranscriber":
        from lyricsync.transcription.faster_whisper import FasterWhisperTranscriber
        return FasterWhisperTranscriber
    if name == "HeartTranscriber":
        from lyricsync.transcription.heart import HeartTranscriber
        return HeartTranscriber
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
