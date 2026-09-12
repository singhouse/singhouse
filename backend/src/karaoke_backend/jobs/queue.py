# SPDX-License-Identifier: AGPL-3.0-only
"""Durable job queue: enqueue, claim, lease, requeue.

The `jobs` table IS the queue. A route only ever writes a `queued` row; a
worker claims it with a guarded UPDATE, holds it under a time-based lease it
renews by heartbeat, and either finishes it or lets the lease lapse so someone
else can pick it up.

Everything here is written to be correct at any process count. The claim is a
single statement, so two claimers race in SQLite's write lock rather than in
Python, and the expiry sweep never touches the calling worker's own rows.
Detaching the worker into its own process is therefore a config change, not a
redesign.

**Exactly what the `claimed_by` predicate protects, and what it does not.**
Every write in this module carries it, so no stale worker can touch the `jobs`
row of a job another worker now holds. That is the whole of the guarantee: it
covers the `jobs` table and nothing else. A handler also writes `songs` and
`lyrics_sets`, which have no claim column and no way to grow one cheaply, so
those writes are unguarded at the SQL layer. What stands in for a guard there
is control flow: a refused job-row write returns False, handlers turn that
into `LeaseLost`, and the worker unwinds without writing a terminal state.
Handlers therefore re-verify the claim immediately before any multi-table
persist, which narrows the window to one statement rather than closing it —
SQLite has no cross-table CAS and inventing one is not worth the schema.

Statuses. `claim_next` claims only `queued` rows, but nothing else here
assumes a running job's status is literally `running`: out-of-tree catalog
providers own their job row and some write their own intermediate strings
("downloading", "adopting") mid-import. The lease predicates are therefore
"claimed and NOT terminal", so such a job keeps its heartbeat and, if its
process dies, is still visible to the expiry sweep.

Sessions are short and per-write by design (the `_persist_correction_
progress` pattern). A long-lived session held across a 15-minute separation
pins a connection and — worse — makes the heartbeat wait behind whatever the
orchestrator is doing.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.models.song import Job, JobPhase, JobStatus, Song

logger = logging.getLogger(__name__)

# Defined ONCE and imported everywhere. It used to be spelled out in
# api/separate.py and twice in main.py; the third copy is how a terminal-state
# guard silently stops guarding.
TERMINAL_STATUSES: tuple[str, ...] = (JobStatus.DONE.value, JobStatus.FAILED.value)

# What boot writes onto a legacy row it can no longer run. Kept at this name
# and wording because operators have already seen it in production.
RESTART_INTERRUPTION_MESSAGE = "Interrupted by server restart"

LEASE_EXPIRED_MESSAGE = "Job lease expired"


# ---------------------------------------------------------------------------
# Environment knobs — read at CALL time, never at import time, so a test or an
# operator can change one without re-importing the world (the `lrclib_enabled`
# convention).
# ---------------------------------------------------------------------------


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("%s=%r is not an integer — using %s", name, raw, default)
        return default
    if value < minimum:
        logger.warning("%s=%r is below %s — using %s", name, raw, minimum, default)
        return default
    return value


def _env_float(name: str, default: float, *, minimum: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number — using %s", name, raw, default)
        return default
    if value < minimum:
        logger.warning("%s=%r is below %s — using %s", name, raw, minimum, default)
        return default
    return value


def concurrency() -> int:
    """How many jobs one worker runs at once. 1 is also the GPU-OOM guard."""
    return _env_int("KARAOKE_JOB_CONCURRENCY", 1)


def lease_seconds() -> float:
    return _env_float("KARAOKE_JOB_LEASE_SECONDS", 180.0, minimum=1.0)


def max_attempts() -> int:
    return _env_int("KARAOKE_JOB_MAX_ATTEMPTS", 2)


def poll_seconds() -> float:
    # Floored well above zero: the idle loop's only brake is this sleep, and a
    # configured 0 turns the worker into a spin on `claim_next` — a SELECT+
    # UPDATE per iteration against the same SQLite file the request path uses.
    return _env_float("KARAOKE_JOB_POLL_SECONDS", 2.0, minimum=0.05)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------


def enqueue(
    session: AsyncSession,
    *,
    kind: str,
    song_id: Optional[int],
    owner_id: int,
    payload: dict[str, Any],
    phase: str = JobPhase.QUEUED.value,
    job_id: Optional[str] = None,
    message: str = "Job queued",
) -> Job:
    """Add a `queued` job to the CALLER's session/transaction.

    Deliberately not async and deliberately not committing: the routes that
    call this create a Song in the same transaction, and a job that outlived a
    rolled-back song would be a job pointing at nothing.

    ``job_id`` is accepted because the callers mint one before they have a row
    to attach it to — the ingest and video-import uploads are both named after
    it, and `Song.job_id` references it.
    """
    job = Job(
        id=job_id,
        song_id=song_id,
        owner_id=owner_id,
        kind=kind,
        status=JobStatus.QUEUED.value,
        phase=phase,
        payload=json.dumps(payload),
        progress=0,
        message=message,
        attempts=0,
    )
    session.add(job)
    return job


def payload_of(job: Job) -> dict[str, Any]:
    """Decode a job payload, tolerating the empty/corrupt case."""
    if not job.payload:
        return {}
    try:
        data = json.loads(job.payload)
    except ValueError:
        logger.warning("Job %s has an unreadable payload — treating as empty", job.id)
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Claim + lease
# ---------------------------------------------------------------------------


async def claim_next(worker_id: str) -> Optional[Job]:
    """Atomically claim the oldest queued job, or return None.

    ONE statement does the whole claim. The inner SELECT picks the candidate
    and the outer WHERE re-asserts `status='queued'`, so a second claimer that
    chose the same row updates zero rows and is told so by the RETURNING
    clause — no read-then-write window exists for it to win in.
    """
    now = _now()
    oldest = (
        select(Job.id)
        .where(Job.status == JobStatus.QUEUED.value)
        .order_by(Job.created_at, Job.id)
        .limit(1)
        .scalar_subquery()
    )

    from karaoke_backend.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        claimed_id = (
            await db.execute(
                update(Job)
                .where(Job.id == oldest, Job.status == JobStatus.QUEUED.value)
                .values(
                    status=JobStatus.RUNNING.value,
                    claimed_by=worker_id,
                    lease_expires_at=now + timedelta(seconds=lease_seconds()),
                    started_at=now,
                    attempts=Job.attempts + 1,
                )
                .returning(Job.id)
                .execution_options(synchronize_session=False)
            )
        ).scalar_one_or_none()
        await db.commit()

        if claimed_id is None:
            return None
        job = (
            await db.execute(select(Job).where(Job.id == claimed_id))
        ).scalar_one_or_none()

    if job is not None:
        logger.info(
            "Worker %s claimed job %s (kind=%s attempt=%s)",
            worker_id, job.id, job.kind, job.attempts,
        )
    return job


async def heartbeat(job_id: str, worker_id: str) -> bool:
    """Extend the lease. False means the claim is gone — stop working.

    Guarded on `claimed_by`: a worker that stalled long enough to lose its
    lease must not be able to take it back by renewing it underneath whoever
    reclaimed the job.

    Guarded on NOT-terminal rather than on `status == 'running'`. An
    out-of-tree catalog provider owns its job row and writes its own progress
    statuses into it mid-import; an equality check would read the first of
    those as "the claim moved on", kill the heartbeat, and hand a healthy
    import's lease away while it was still downloading.
    """
    from karaoke_backend.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(Job)
            .where(
                Job.id == job_id,
                Job.claimed_by == worker_id,
                Job.status.notin_(TERMINAL_STATUSES),
            )
            .values(lease_expires_at=_now() + timedelta(seconds=lease_seconds()))
        )
        await db.commit()
    return result.rowcount == 1


async def requeue_expired(worker_id: str) -> int:
    """Return other workers' lapsed claims to the queue (or fail them).

    A claim, not a status, is what this looks for: `claimed_by IS NOT NULL AND
    NOT terminal`. Keying on `status == 'running'` instead would make every
    catalog import that a provider had moved to its own progress string
    ("downloading", "adopting") invisible here — and since such a row is also
    unclaimable and unsweepable, a provider that died mid-import would leave it
    stuck forever. `claimed_by IS NOT NULL` is what keeps queued rows (which
    have no claimant) out of the sweep now that status no longer does.

    Never touches this process's own rows: while it is alive its heartbeat is
    what keeps the lease current, and a worker that requeued its own running
    job would double-run it against itself.
    """
    from karaoke_backend.database import AsyncSessionLocal

    now = _now()
    limit = max_attempts()
    requeued = 0

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Job.id, Job.attempts).where(
                    Job.claimed_by.is_not(None),
                    Job.claimed_by != worker_id,
                    Job.status.notin_(TERMINAL_STATUSES),
                    Job.lease_expires_at.is_not(None),
                    Job.lease_expires_at < now,
                )
            )
        ).all()
        if not rows:
            return 0

        exhausted = [r.id for r in rows if (r.attempts or 0) >= limit]
        retryable = [r.id for r in rows if (r.attempts or 0) < limit]

        # The UPDATE predicates repeat the SELECT's: between the two, another
        # worker may have finished or reclaimed the row.
        if exhausted:
            failed_ids = list((await db.execute(
                update(Job)
                .where(
                    Job.id.in_(exhausted),
                    Job.claimed_by.is_not(None),
                    Job.claimed_by != worker_id,
                    Job.status.notin_(TERMINAL_STATUSES),
                    Job.lease_expires_at.is_not(None),
                    Job.lease_expires_at < now,
                )
                .values(
                    status=JobStatus.FAILED.value,
                    phase=JobPhase.FAILED.value,
                    message=LEASE_EXPIRED_MESSAGE,
                    error_message=LEASE_EXPIRED_MESSAGE,
                    claimed_by=None,
                    lease_expires_at=None,
                    finished_at=now,
                ).returning(Job.id)
            )).scalars().all())
            # A terminal ingest-like job and an attached Song must tell the
            # same story.  Keeping the upload makes the failure recoverable;
            # marking the Song failed makes that retry path reachable.
            await db.execute(
                update(Song)
                .where(
                    Song.id.in_(
                        select(Job.song_id).where(
                            Job.id.in_(failed_ids), Job.song_id.is_not(None)
                        )
                    ),
                    Song.status.in_(("processing", "uploading")),
                )
                .values(status="failed", error_message=LEASE_EXPIRED_MESSAGE)
            )
        if retryable:
            requeued_ids = list((await db.execute(
                update(Job)
                .where(
                    Job.id.in_(retryable),
                    Job.claimed_by.is_not(None),
                    Job.claimed_by != worker_id,
                    Job.status.notin_(TERMINAL_STATUSES),
                    Job.lease_expires_at.is_not(None),
                    Job.lease_expires_at < now,
                )
                .values(
                    status=JobStatus.QUEUED.value,
                    phase=JobPhase.QUEUED.value,
                    claimed_by=None,
                    lease_expires_at=None,
                ).returning(Job.id)
            )).scalars().all())
            requeued = len(requeued_ids)
        await db.commit()

    if exhausted:
        logger.warning(
            "Lease expired past %d attempt(s) — failed job(s): %s",
            limit, ", ".join(exhausted),
        )
        # The uploads STAY. This used to reap them on the reasoning that a
        # terminal job's input is dead weight — but a job that burned through
        # its attempts is typically one that kept killing the process
        # mid-separation, and that is exactly the case
        # `POST /api/songs/{id}/retry` exists to rescue. It can only replay
        # phase 1 from the file the run was given, so unlinking it here made
        # the worst failures the only unretryable ones. Retained, then, as the
        # only recoverable input — even though this path does not yet flip the
        # SONG to `failed`, so the retry route still refuses such a song (a
        # separate defect; the song row, not the file, is what blocks it). The
        # uploads a song still owns are released when the song is deleted;
        # `sweep_legacy` still reaps the pre-queue rows (kind IS NULL) that no
        # payload can ever replay. The attached song is failed in the same
        # transaction above, so the retry route can replay the retained input.
    if requeued:
        logger.info("Requeued %d job(s) with an expired lease", requeued)
    return requeued


# ---------------------------------------------------------------------------
# Progress + terminal writes
# ---------------------------------------------------------------------------


async def update_progress(
    job_id: str,
    worker_id: str,
    *,
    phase: Optional[str] = None,
    progress: Optional[int] = None,
    message: Optional[str] = None,
    stems_json: Optional[str] = None,
) -> bool:
    """Write job progress from the worker that holds the claim.

    Two predicates, not one. Not-terminal stops a late callback replacing a
    final message. `claimed_by` stops a worker whose lease lapsed —
    say, one wedged behind a hung subprocess — from writing over a job another
    worker has since reclaimed and may already have finished.
    """
    from karaoke_backend.database import AsyncSessionLocal

    values: dict[str, Any] = {}
    if phase is not None:
        values["phase"] = phase
    if progress is not None:
        values["progress"] = progress
    if message is not None:
        values["message"] = message
    if stems_json is not None:
        values["stems"] = stems_json
    if not values:
        return False

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(Job)
            .where(
                Job.id == job_id,
                Job.claimed_by == worker_id,
                Job.status.notin_(TERMINAL_STATUSES),
            )
            .values(**values)
        )
        await db.commit()
    return result.rowcount == 1


async def finish(
    job_id: str,
    worker_id: str,
    *,
    failed: bool = False,
    message: Optional[str] = None,
    error: Optional[str] = None,
    mirror_song_status: bool = False,
) -> None:
    """Write the terminal state for a job this worker still holds.

    Two guarded statements, no read-then-write. The first records THIS
    worker's outcome and only fires on a row that is still claimed by it and
    not already terminal. The second handles the row a handler already
    finished: catalog-import providers own their job row end to end (they are
    out-of-tree code and the protocol is not ours to change), so the worker's
    part is to notice they finished, release the claim, and normalize `phase`
    to the status they wrote — otherwise the UI sits on "importing" forever.

    They cannot both apply: the first clears `claimed_by`, which is the
    second's predicate. If neither applies the claim is gone, and the outcome
    belongs to whoever holds the job now.
    """
    from karaoke_backend.database import AsyncSessionLocal

    now = _now()
    released: dict[str, Any] = {
        "finished_at": now,
        "claimed_by": None,
        "lease_expires_at": None,
    }

    if failed:
        outcome: dict[str, Any] = {
            "status": JobStatus.FAILED.value,
            "phase": JobPhase.FAILED.value,
            "progress": 0,
            "message": message or "Job failed",
            "error_message": error or message or "Job failed",
        }
    else:
        outcome = {
            "status": JobStatus.DONE.value,
            "phase": JobPhase.DONE.value,
            "progress": 100,
        }
        if message is not None:
            outcome["message"] = message

    async with AsyncSessionLocal() as db:
        wrote = (
            await db.execute(
                update(Job)
                .where(
                    Job.id == job_id,
                    Job.claimed_by == worker_id,
                    Job.status.notin_(TERMINAL_STATUSES),
                )
                .values(**outcome, **released)
            )
        ).rowcount

        normalized = (
            await db.execute(
                update(Job)
                .where(
                    Job.id == job_id,
                    Job.claimed_by == worker_id,
                    Job.status.in_(TERMINAL_STATUSES),
                )
                .values(phase=Job.status, **released)
            )
        ).rowcount

        if not wrote and not normalized:
            logger.warning(
                "Worker %s no longer holds job %s — leaving its final state alone",
                worker_id, job_id,
            )
        elif wrote and failed and mirror_song_status:
            # Correlated rather than read-then-write for the same reason: the
            # song id comes from the row we just proved we owned.
            await db.execute(
                update(Song)
                .where(
                    Song.id
                    == select(Job.song_id).where(Job.id == job_id).scalar_subquery()
                )
                .values(status="failed", error_message=error or message)
            )
        await db.commit()


# ---------------------------------------------------------------------------
# Boot-time legacy sweep
# ---------------------------------------------------------------------------


async def sweep_legacy(uploads_dir: Optional[Path] = None) -> int:
    """Fail pre-queue rows left behind by a restart and remove their uploads.

    This REPLACES the older `recover_interrupted_jobs`, and reverses half of it
    on purpose. A `queued` row that carries a `kind` is now a real durable
    queue entry: surviving a restart is the entire point of the durable queue,
    so boot must leave it alone. A `running` row is handled by the lease, not by boot —
    `requeue_expired` gives it back to the queue once nobody is renewing it.

    What is left is rows with no `kind`: written before the queue existed, with
    a pipeline phase where the lifecycle status now goes, and no payload any
    handler could re-enter. Nothing can ever run them, so they are failed here
    and their uploads released.

    Database state is committed before any filesystem cleanup, so an
    unreadable uploads directory can never stop the app recording that the
    in-process work was interrupted.
    """
    from karaoke_backend.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Job.id, Job.song_id).where(
                    Job.status.notin_(TERMINAL_STATUSES),
                    Job.kind.is_(None),
                )
            )
        ).all()
        job_ids = [row.id for row in rows]
        song_ids = {row.song_id for row in rows if row.song_id is not None}

        if job_ids:
            await db.execute(
                update(Job)
                .where(Job.id.in_(job_ids), Job.status.notin_(TERMINAL_STATUSES))
                .values(
                    status=JobStatus.FAILED.value,
                    phase=JobPhase.FAILED.value,
                    message=RESTART_INTERRUPTION_MESSAGE,
                    error_message=RESTART_INTERRUPTION_MESSAGE,
                    finished_at=_now(),
                )
            )
        if song_ids:
            await db.execute(
                update(Song)
                .where(Song.id.in_(song_ids), Song.status == "processing")
                .values(status="failed", error_message=RESTART_INTERRUPTION_MESSAGE)
            )
        await db.commit()

    removed_uploads = unlink_uploads_for(job_ids, uploads_dir)

    logger.info(
        "Startup sweep: failed %d legacy job(s); removed %d orphan upload(s).",
        len(job_ids),
        removed_uploads,
    )
    return len(job_ids)


def unlink_uploads_for(
    job_ids: list[str], uploads_dir: Optional[Path] = None
) -> int:
    """Best-effort removal of the `{job_id}_` uploads owned by these jobs."""
    if not job_ids:
        return 0

    from karaoke_backend.api.separate import UPLOADS_DIR

    upload_root = UPLOADS_DIR if uploads_dir is None else uploads_dir
    try:
        entries = list(upload_root.iterdir())
    except FileNotFoundError:
        return 0
    except OSError as exc:
        logger.warning(
            "Could not inspect uploads directory %s: %s", upload_root, exc
        )
        return 0

    prefixes = tuple(f"{job_id}_" for job_id in job_ids)
    removed = 0
    for path in entries:
        if not path.name.startswith(prefixes):
            continue
        try:
            if not path.is_file():
                continue
            path.unlink()
            removed += 1
        except OSError as exc:
            logger.warning("Could not remove orphan upload %s: %s", path, exc)
    return removed
