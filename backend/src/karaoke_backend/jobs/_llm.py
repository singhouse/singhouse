# SPDX-License-Identifier: AGPL-3.0-only
"""Job-side glue for the LLM stages: correction progress, from any handler.

Lived in ``jobs.ingest`` while ingest was the only place LLM correction could
be switched on. Re-transcribe and re-align can ask for it too, and importing
the ingest orchestrator to borrow one callback would drag the whole
separation pipeline — and its module-level worker imports — into handlers that
never separate anything.

``make_progress_message_callback`` is the same bridge for any other stage
that runs inside the blocking pipeline thread (the acoustic word-timing
stage reports through it).
"""

from __future__ import annotations

import asyncio
import logging

from karaoke_backend.jobs import queue
from karaoke_backend.jobs.base import LeaseLost

logger = logging.getLogger(__name__)

_CORRECTION_PROGRESS_TIMEOUT_SECONDS = 5.0


async def _persist_correction_progress(
    job_id: str, worker_id: str, message: str
) -> None:
    """Write correction progress without sharing the handler's session."""
    if not await queue.update_progress(job_id, worker_id, message=message):
        raise LeaseLost(job_id)


def make_correction_progress_callback(
    job_id: str,
    worker_id: str,
    loop: asyncio.AbstractEventLoop,
):
    """Bridge lyricsync's executor-thread callback to the async DB engine."""
    progress = make_progress_message_callback(job_id, worker_id, loop)

    def correction_progress(ri: int, total: int) -> None:
        progress(f"LLM correction: region {ri + 1}/{total}")

    return correction_progress


def make_progress_message_callback(
    job_id: str,
    worker_id: str,
    loop: asyncio.AbstractEventLoop,
):
    """Bridge a pipeline-thread ``progress(message)`` call to the job row."""

    def progress(message: str) -> None:
        future = asyncio.run_coroutine_threadsafe(
            _persist_correction_progress(job_id, worker_id, message),
            loop,
        )
        try:
            future.result(timeout=_CORRECTION_PROGRESS_TIMEOUT_SECONDS)
        # A LeaseLost here is logged, not propagated: this runs on lyricsync's
        # executor thread, deep inside a synchronous pipeline that has no way
        # to unwind. The next `set_phase` on the orchestrator's own path is
        # what actually stops the run — this just refuses to write.
        except Exception as exc:
            future.cancel()
            logger.warning(
                "Could not persist progress for job %s: %s", job_id, exc,
            )

    return progress
