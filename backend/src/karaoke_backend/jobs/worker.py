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

The loop fills two lanes, each against its own budget (see ``registry`` for
what a lane is). A job is charged to the lane it was CLAIMED from, held in
that lane's running set until its task ends, so a saturated processing lane
cannot stop a fast-lane claim and a burst of fast jobs cannot borrow a
processing slot. Everything below the claim — heartbeat, lease, finish, the
shutdown that writes nothing — is identical for both lanes; the lane decides
only when a job may start.
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


# How long `stop` lets an in-flight sweep or claim pass finish before it falls
# back to cancelling it. A pass is a handful of indexed statements that
# normally finish in milliseconds. Kept below the desktop shell's 5s SIGTERM to
# SIGKILL escalation so a graceful stop is not itself killed mid-shutdown.
# That puts it under SQLite's 5s busy_timeout as well: a statement still waiting
# on another writer's lock at the deadline is cancelled rather than waited out.
# This is the pre-lane behaviour, and the guarded claim keeps it safe — at
# worst the row is left claimed for the lease to settle.
_STOP_GRACE_SECONDS = 2.0


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
        self._stopping = asyncio.Event()
        # Every live job task, whatever its lane — what `stop` cancels.
        self._running: set[asyncio.Task] = set()
        # The same tasks partitioned by the lane they were claimed from;
        # these, not `_running`, are what the budgets are counted against.
        self._running_by_lane: dict[str, set[asyncio.Task]] = {
            lane: set() for lane in registry.LANES
        }

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        self._stopping.clear()
        self._loop_task = asyncio.create_task(self._loop(), name="job-worker")
        logger.info("Job worker %s started", self.worker_id)

    async def stop(self) -> None:
        """Graceful shutdown. Deliberately writes NO job state.

        Anything still running keeps its `running` row and its lease; once
        this process is gone nothing renews it, and the next `requeue_expired`
        — from this worker's own next boot or a sibling's sweep — puts it back
        on the queue. Trying to record a state during shutdown is how you get
        a half-written terminal row when the shutdown is itself interrupted.

        The claim loop is asked to stop rather than cancelled outright. With
        two lanes the loop keeps polling whichever lane has room while the
        other runs, so a shutdown is far more likely than it used to be to
        land in the middle of a claim or a sweep; cancelling a coroutine
        inside a database statement is how a connection gets dropped half
        way through a write. The loop finishes its current pass, claims
        nothing further, and exits — and is cancelled only if that pass has
        not ended within ``_STOP_GRACE_SECONDS``.
        """
        if self._loop_task is not None:
            self._stopping.set()
            done, _ = await asyncio.wait(
                {self._loop_task}, timeout=_STOP_GRACE_SECONDS
            )
            if not done:
                logger.warning(
                    "Job worker %s claim loop did not stop in %ss — cancelling it",
                    self.worker_id, _STOP_GRACE_SECONDS,
                )
                self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                logger.warning("Job worker loop raised during shutdown", exc_info=True)
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
        for lane_tasks in self._running_by_lane.values():
            lane_tasks.clear()
        logger.info("Job worker %s stopped", self.worker_id)

    async def _loop(self) -> None:
        loop = asyncio.get_running_loop()
        next_sweep = 0.0
        while not self._stopping.is_set():
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

            if self._stopping.is_set():
                return
            claimed = await self._claim_up_to_concurrency()
            if not claimed:
                # The idle wait doubles as the stop signal's wake-up, so a
                # shutdown never waits out a long poll interval.
                try:
                    await asyncio.wait_for(
                        self._stopping.wait(), timeout=queue.poll_seconds()
                    )
                except TimeoutError:
                    pass

    async def _claim_up_to_concurrency(self) -> int:
        """Top up every lane to its own budget; return how many were claimed.

        The lanes are filled one after the other but independently: a lane
        that is full, empty, or whose claim raised is simply done for this
        pass, and the next lane still gets its turn. That independence is the
        whole feature — a full processing lane must not keep a queued
        catalog import waiting.
        """
        claimed = 0
        for lane in registry.LANES:
            claimed += await self._claim_lane(lane)
        return claimed

    async def _claim_lane(self, lane: str) -> int:
        claimed = 0
        lane_tasks = self._running_by_lane[lane]
        while len(lane_tasks) < queue.lane_concurrency(lane):
            # Once shutdown has begun nothing new is claimed: a job started
            # now would only be cancelled the moment it began.
            if self._stopping.is_set():
                return claimed
            try:
                job = await queue.claim_next(self.worker_id, lane=lane)
            except Exception:  # noqa: BLE001
                logger.warning("Claim failed (lane=%s)", lane, exc_info=True)
                return claimed
            if job is None:
                break
            if self._stopping.is_set():
                # The stop arrived while this claim was in flight, and the row
                # is already ours. Run nothing and write nothing: like every
                # job that `stop` leaves behind, it stays `running` under this
                # worker's claim until the lease lapses and the next
                # `requeue_expired` puts it back on the queue.
                logger.info(
                    "Job %s claimed as worker %s stopped — leaving it to its lease",
                    job.id, self.worker_id,
                )
                return claimed
            task = asyncio.create_task(
                _run_with_heartbeat(job, self.worker_id), name=f"job-{job.id}"
            )
            self._running.add(task)
            lane_tasks.add(task)
            task.add_done_callback(self._running.discard)
            task.add_done_callback(lane_tasks.discard)
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
