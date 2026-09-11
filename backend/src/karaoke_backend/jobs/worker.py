# SPDX-License-Identifier: AGPL-3.0-only
"""The job worker: claim, run, heartbeat, repeat.

One instance runs in the FastAPI lifespan today. Nothing here assumes that:
the claim is atomic, the sweep skips this worker's own rows, and every write
carries the `claimed_by` guard — so running the same loop in a separate
`kb-worker` process is a deployment choice, not a rewrite.

The heartbeat is the load-bearing part of the safety argument. It runs on its
own task at LEASE/3 and does not consult job progress, so a job that is alive
but silent for twenty minutes (a long separation reports nothing between
callbacks) keeps its lease. That is what makes expiry-based requeue safe: a
lease only lapses when the process holding it is genuinely gone.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid
from typing import Optional

from karaoke_backend.jobs import queue, registry
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost

logger = logging.getLogger(__name__)


def make_worker_id() -> str:
    """Unique per process, and legible in a log line."""
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


async def _run_one(job, worker_id: str) -> None:
    """Run a claimed job to its terminal state. Never raises."""
    spec = registry.get_spec(job.kind)
    if spec is None:
        await queue.finish(
            job.id, worker_id,
            failed=True,
            message="Unknown job kind",
            error=f"no handler registered for job kind {job.kind!r}",
        )
        return

    ctx = JobContext(
        job_id=job.id,
        kind=job.kind,
        worker_id=worker_id,
        owner_id=job.owner_id,
        song_id=job.song_id,
        attempts=job.attempts or 1,
        payload=queue.payload_of(job),
    )

    try:
        handler = spec.handler
    except (ImportError, AttributeError) as exc:
        logger.exception("Job %s: handler for kind %r is unresolvable", job.id, job.kind)
        await queue.finish(
            job.id, worker_id,
            failed=True,
            message="Job handler unavailable",
            error=str(exc),
        )
        return

    try:
        message = await handler(ctx)
    except asyncio.CancelledError:
        # Process shutdown. Deliberately leave the row `running`: the lease
        # lapses on its own and the next boot requeues it, which is strictly
        # better than writing a terminal state on the way out the door.
        raise
    except LeaseLost:
        # The job is somebody else's now. Returning here — writing nothing at
        # all — is the point: a terminal state from this worker would be the
        # conclusions of a dead run landing on top of a live one.
        logger.warning(
            "Worker %s lost its claim on job %s mid-run — abandoning it", worker_id, job.id
        )
        return
    except JobFailure as exc:
        logger.error("Job %s failed: %s", job.id, exc.error)
        await queue.finish(
            job.id, worker_id,
            failed=True,
            message=exc.message,
            error=exc.error,
            mirror_song_status=spec.mirrors_song_status,
        )
    except Exception as exc:  # noqa: BLE001 — the loop must survive any handler
        logger.exception("Unexpected error in job %s", job.id)
        await queue.finish(
            job.id, worker_id,
            failed=True,
            message="Unexpected error",
            error=str(exc),
            mirror_song_status=spec.mirrors_song_status,
        )
    else:
        # A handler's return value is its FINAL MESSAGE or nothing; anything
        # else is a handler that does not implement the contract, and the one
        # thing it must not do is end up bound into the job row.
        await queue.finish(
            job.id, worker_id,
            message=message if isinstance(message, str) else None,
        )


async def _heartbeat(job_id: str, worker_id: str) -> None:
    """Renew the lease until cancelled. Independent of job progress."""
    while True:
        await asyncio.sleep(max(queue.lease_seconds() / 3.0, 0.1))
        try:
            if not await queue.heartbeat(job_id, worker_id):
                logger.warning(
                    "Job %s is no longer claimed by %s — heartbeat stopping",
                    job_id, worker_id,
                )
                return
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            # A transient DB error must not kill the heartbeat; the lease has
            # room for several missed beats before it lapses.
            logger.warning("Heartbeat for job %s failed", job_id, exc_info=True)


async def _run_with_heartbeat(job, worker_id: str) -> None:
    beat = asyncio.create_task(
        _heartbeat(job.id, worker_id), name=f"job-heartbeat-{job.id}"
    )
    try:
        await _run_one(job, worker_id)
    finally:
        beat.cancel()
        try:
            await beat
        except asyncio.CancelledError:
            pass


class JobWorker:
    """Owns one claim loop and the tasks it spawns."""

    def __init__(self, worker_id: Optional[str] = None) -> None:
        self.worker_id = worker_id or make_worker_id()
        self._loop_task: Optional[asyncio.Task] = None
        self._running: set[asyncio.Task] = set()

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        self._loop_task = asyncio.create_task(self._loop(), name="job-worker")
        logger.info("Job worker %s started", self.worker_id)

    async def stop(self) -> None:
        """Graceful shutdown. Deliberately writes NO job state.

        Anything still running keeps its `running` row and its lease; once
        this process is gone nothing renews it, and the next `requeue_expired`
        — from this worker's own next boot or a sibling's sweep — puts it back
        on the queue. Trying to record a state during shutdown is how you get
        a half-written terminal row when the shutdown is itself interrupted.
        """
        if self._loop_task is not None:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None

        for task in list(self._running):
            task.cancel()
        for task in list(self._running):
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                logger.warning("Job task raised during shutdown", exc_info=True)
        self._running.clear()
        logger.info("Job worker %s stopped", self.worker_id)

    async def _loop(self) -> None:
        loop = asyncio.get_running_loop()
        next_sweep = 0.0
        while True:
            now = loop.time()
            if now >= next_sweep:
                try:
                    await queue.requeue_expired(self.worker_id)
                except Exception:  # noqa: BLE001
                    logger.warning("Expired-lease sweep failed", exc_info=True)
                # Heartbeat cadence, not lease cadence. At one sweep per lease
                # the boot sweep runs before any lease has had time to lapse
                # and the next is a full lease away, so a job interrupted by a
                # restart could sit unclaimable for nearly twice the lease
                # before anything noticed. Sweeping at LEASE/3 costs one cheap
                # indexed query and bounds the delay at LEASE + LEASE/3.
                next_sweep = now + queue.lease_seconds() / 3.0

            claimed = await self._claim_up_to_concurrency()
            if not claimed:
                await asyncio.sleep(queue.poll_seconds())

    async def _claim_up_to_concurrency(self) -> int:
        claimed = 0
        while len(self._running) < queue.concurrency():
            try:
                job = await queue.claim_next(self.worker_id)
            except Exception:  # noqa: BLE001
                logger.warning("Claim failed", exc_info=True)
                return claimed
            if job is None:
                break
            task = asyncio.create_task(
                _run_with_heartbeat(job, self.worker_id), name=f"job-{job.id}"
            )
            self._running.add(task)
            task.add_done_callback(self._running.discard)
            claimed += 1
        return claimed


async def run_queued_jobs_once(worker_id: str = "test-worker") -> int:
    """Drain the queue synchronously — for tests and one-shot batch callers.

    No heartbeat, no polling, no wall clock: claim and run to completion, one
    at a time, until nothing is queued. Tests that used to rely on
    ``BackgroundTasks`` finishing before the response returned call this
    instead of sleeping and hoping.
    """
    ran = 0
    while True:
        job = await queue.claim_next(worker_id)
        if job is None:
            return ran
        await _run_one(job, worker_id)
        ran += 1
