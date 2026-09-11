# SPDX-License-Identifier: MIT
from __future__ import annotations

import asyncio
import logging
from functools import partial
from typing import Optional

from lyricsync._config import PipelineConfig
from lyricsync._pipeline import SyncPipeline
from lyricsync._types import SyncResult
from lyricsync.transcription._base import Transcriber

logger = logging.getLogger(__name__)


class AsyncPipeline:
    """Async wrapper around SyncPipeline.

    Runs the synchronous pipeline in a thread executor so it can be
    used from async code without blocking the event loop.
    """

    def __init__(
        self,
        transcriber: Transcriber,
        config: PipelineConfig | None = None,
    ):
        self._sync = SyncPipeline(transcriber=transcriber, config=config)

    async def run(
        self,
        audio_path: str,
        plain_lyrics: Optional[str] = None,
        synced_lyrics: Optional[str] = None,
        language: Optional[str] = None,
    ) -> Optional[SyncResult]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            partial(
                self._sync.run,
                audio_path=audio_path,
                plain_lyrics=plain_lyrics,
                synced_lyrics=synced_lyrics,
                language=language,
            ),
        )

    async def align_only(
        self,
        whisper_result: "TranscriptionResult",
        plain_lyrics: Optional[str] = None,
        synced_lyrics: Optional[str] = None,
        audio_path: Optional[str] = None,
    ) -> Optional[SyncResult]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            partial(
                self._sync.align_only,
                whisper_result=whisper_result,
                plain_lyrics=plain_lyrics,
                synced_lyrics=synced_lyrics,
                audio_path=audio_path,
            ),
        )
