# SPDX-License-Identifier: AGPL-3.0-only
"""Job-message bridge for notices raised on an executor thread.

Local transcription runs in a worker thread. A guarded processing worker
reports which device it selected while it runs; this publishes that text as
the job's message without changing its phase or progress.
"""

from __future__ import annotations

import asyncio
import logging

from karaoke_backend.jobs import queue

logger = logging.getLogger(__name__)

_MESSAGE_TIMEOUT_SECONDS = 5.0


def make_message_callback(job_id: str, worker_id: str, loop: asyncio.AbstractEventLoop):
    """Return a thread-safe callable that sets this job's message."""

    def publish(message: str) -> None:
        future = asyncio.run_coroutine_threadsafe(
            queue.update_progress(job_id, worker_id, message=message), loop
        )
        try:
            future.result(timeout=_MESSAGE_TIMEOUT_SECONDS)
        # A lost claim is detected by the handler's own next progress write;
        # an informational notice must not unwind the transcription thread.
        except Exception as exc:  # noqa: BLE001
            future.cancel()
            logger.warning("Could not publish job message for %s: %s", job_id, exc)

    return publish
