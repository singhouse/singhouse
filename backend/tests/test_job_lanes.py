# SPDX-License-Identifier: AGPL-3.0-only
"""The two claim lanes: processing work and fast work, budgeted apart.

The scenario these exist for: an operator queues a stack of imports that each
separate and transcribe for minutes, and then a singer asks for a catalog
track that only needs downloading. With one FIFO and one GPU-sized budget the
download waits for every generation in front of it. What these tests pin:
the fast lane claims while the processing lane is full; each lane is FIFO
within itself and capped by its own knob; the processing cap is still
``KARAOKE_JOB_CONCURRENCY``; an extension kind lands in the processing lane
unless it opts out; and deferred kinds and unknown kinds behave in both lanes
exactly as they did before lanes existed.

Handlers live in THIS module and are registered by dotted path, the same
resolve-on-dispatch mechanism an extension uses.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from karaoke_backend import database
from karaoke_backend.db.sqlite import install_sqlite_pragmas
from karaoke_backend.jobs import queue, registry
from karaoke_backend.jobs import worker as worker_module
from karaoke_backend.jobs.base import JobContext
from karaoke_backend.jobs.worker import JobWorker
from karaoke_backend.models.song import Base, Job, JobKind
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_THIS_MODULE = "tests.test_job_lanes"
_BASE_TIME = datetime(2026, 1, 1, tzinfo=UTC)

# Per-test coordination for the blocking handlers. Reset by the fixture.
# Releases are per job so a test lets exactly one finish at a time.
started: dict[str, asyncio.Event] = {}
_releases: dict[str, asyncio.Event] = {}
_finished_runs: dict[str, asyncio.Event] = {}
finished: list[str] = []


def _started(job_id: str) -> asyncio.Event:
    return started.setdefault(job_id, asyncio.Event())


def _done(job_id: str) -> asyncio.Event:
    return _finished_runs.setdefault(job_id, asyncio.Event())


async def block_until_released(ctx: JobContext) -> str:
    """Stand-in for a long separation: holds its slot until told to stop.

    Touches no database while it waits, so a blocked job is never the
    statement that interleaves with someone else's.
    """
    _started(ctx.job_id).set()
    await _releases.setdefault(ctx.job_id, asyncio.Event()).wait()
    finished.append(ctx.job_id)
    return "released"


async def finish_immediately(ctx: JobContext) -> str:
    """Stand-in for a catalog download: done as soon as it starts."""
    _started(ctx.job_id).set()
    finished.append(ctx.job_id)
    return "imported"


@pytest_asyncio.fixture
async def file_db(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """Point the queue at a FILE-backed SQLite for the length of one test.

    The suite's default database is in-memory behind a single shared
    connection, which cannot represent what these tests are about: two lanes
    means a job's `finish` and the next claim are in flight at the same time.
    On one shared connection those are two transactions interleaved on a
    single SQLite handle and one can lose the other's write; in production
    each session has its own connection and SQLite's write lock orders them.
    A file database with the product's own PRAGMA policy is the production
    shape. Every queue function resolves ``AsyncSessionLocal`` at call time,
    so swapping the module attribute is enough.
    """
    file_engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'lanes.db'}",
        connect_args={"check_same_thread": False},
    )
    install_sqlite_pragmas(file_engine.sync_engine, foreign_keys=True)
    async with file_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(
        database,
        "AsyncSessionLocal",
        async_sessionmaker(
            file_engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
        ),
    )
    yield
    await file_engine.dispose()


@pytest.fixture
def lanes(file_db, monkeypatch: pytest.MonkeyPatch):
    """Register a slow processing kind and a fast kind, and clean up after.

    The registry is process state shared by the whole run; a kind left behind
    would make some other test's unknown kind suddenly known.
    """
    started.clear()
    _releases.clear()
    _finished_runs.clear()
    finished.clear()

    # Signal when the worker's own run of a job — terminal write included —
    # has returned. A task that finishes inside the claim pass is gone from
    # the worker's running set before the pass returns, so the set cannot be
    # what a test waits on.
    real_run = worker_module._run_with_heartbeat

    async def signalling_run(job, worker_id):
        try:
            await real_run(job, worker_id)
        finally:
            _done(job.id).set()

    monkeypatch.setattr(worker_module, "_run_with_heartbeat", signalling_run)
    monkeypatch.setenv("KARAOKE_JOB_POLL_SECONDS", "0.05")
    registry.register_job_kind("test-slow", f"{_THIS_MODULE}:block_until_released")
    registry.register_job_kind(
        "test-fast-slow", f"{_THIS_MODULE}:block_until_released",
        lane=registry.LANE_FAST,
    )
    registry.register_job_kind(
        "test-fast", f"{_THIS_MODULE}:finish_immediately", lane=registry.LANE_FAST
    )
    yield
    for kind in ("test-slow", "test-fast-slow", "test-fast"):
        registry.unregister_job_kind(kind)


async def _seed(job_id: str, kind: str | None, *, order: int, **overrides) -> None:
    """A queued job whose place in line is set explicitly by ``order``."""
    values = dict(
        id=job_id,
        kind=kind,
        status="queued",
        phase="queued",
        progress=0,
        owner_id=1,
        payload=json.dumps({}),
        attempts=0,
        created_at=_BASE_TIME + timedelta(seconds=order),
    )
    values.update(overrides)
    async with database.AsyncSessionLocal() as db:
        db.add(Job(**values))
        await db.commit()


async def _get(job_id: str) -> Job:
    async with database.AsyncSessionLocal() as db:
        job = await db.get(Job, job_id)
        assert job is not None
        return job


async def _statuses(*job_ids: str) -> list[str]:
    return [(await _get(job_id)).status for job_id in job_ids]


# ---------------------------------------------------------------------------
# The worker: lanes fill independently
#
# These drive the worker's claim pass directly rather than through its
# polling loop, so each assertion sees the state after a known number of
# passes instead of after however many a poll interval happened to fit.
# ---------------------------------------------------------------------------


async def _settled(worker: JobWorker, job_id: str) -> None:
    """Wait until the worker has run a job to its terminal write AND let go
    of its slot — the lane's running set is emptied by a done-callback that
    runs a tick after the run itself returns."""
    async def released() -> None:
        await _done(job_id).wait()
        while any(task.get_name() == f"job-{job_id}" for task in worker._running):
            await asyncio.sleep(0)

    await asyncio.wait_for(released(), timeout=10)


async def _release_one(worker: JobWorker, job_id: str) -> None:
    """Let exactly one blocked job finish, and wait until its slot is free."""
    _releases.setdefault(job_id, asyncio.Event()).set()
    await _settled(worker, job_id)


@pytest.mark.asyncio
async def test_a_fast_job_runs_while_the_processing_lane_is_saturated(lanes):
    """The live-show case: a download must not wait behind generations.

    An earlier processing job holds the only processing slot and a second
    processing job queues behind it. A fast job queued LAST is claimed in the
    same pass and runs to completion while both of those are where they were.
    """
    await _seed("gen-running", "test-slow", order=0)
    await _seed("gen-waiting", "test-slow", order=1)
    await _seed("download", "test-fast", order=2)

    worker = JobWorker("lane-worker")
    try:
        assert await worker._claim_up_to_concurrency() == 2
        await _settled(worker, "download")
        await asyncio.wait_for(_started("gen-running").wait(), timeout=10)

        assert await _statuses("gen-running", "gen-waiting", "download") == [
            "running", "queued", "done",
        ]
        assert finished == ["download"]
        assert (await _get("download")).message == "imported"

        # A later pass with the processing lane still full claims nothing.
        assert await worker._claim_up_to_concurrency() == 0
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_a_full_fast_lane_does_not_hold_up_processing(lanes, monkeypatch):
    """The converse: fast work can saturate its own lane and nothing else."""
    monkeypatch.setenv("KARAOKE_FAST_JOB_CONCURRENCY", "1")
    await _seed("fast-running", "test-fast-slow", order=0)
    await _seed("fast-waiting", "test-fast-slow", order=1)
    await _seed("generation", "test-slow", order=2)

    worker = JobWorker("lane-worker")
    try:
        assert await worker._claim_up_to_concurrency() == 2
        assert await _statuses("fast-running", "fast-waiting", "generation") == [
            "running", "queued", "running",
        ]
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_the_processing_lane_is_still_capped_by_job_concurrency(lanes, monkeypatch):
    """KARAOKE_JOB_CONCURRENCY keeps its meaning: the GPU-work cap.

    Room for two and three queued: exactly the two oldest run. A fast lane
    with room to spare must not lend the third a slot, and the slot that
    frees is refilled from the same lane, in order.
    """
    monkeypatch.setenv("KARAOKE_JOB_CONCURRENCY", "2")
    monkeypatch.setenv("KARAOKE_FAST_JOB_CONCURRENCY", "5")
    for index in range(3):
        await _seed(f"gen-{index}", "test-slow", order=index)

    worker = JobWorker("lane-worker")
    try:
        assert await worker._claim_up_to_concurrency() == 2
        assert await worker._claim_up_to_concurrency() == 0
        assert await _statuses("gen-0", "gen-1", "gen-2") == [
            "running", "running", "queued",
        ]
        assert len(worker._running_by_lane[registry.LANE_PROCESSING]) == 2
        assert len(worker._running_by_lane[registry.LANE_FAST]) == 0

        await _release_one(worker, "gen-0")
        assert await worker._claim_up_to_concurrency() == 1
        assert await _statuses("gen-0", "gen-1", "gen-2") == [
            "done", "running", "running",
        ]
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_the_fast_lane_is_capped_by_its_own_knob(lanes, monkeypatch):
    monkeypatch.setenv("KARAOKE_FAST_JOB_CONCURRENCY", "2")
    for index in range(3):
        await _seed(f"fast-{index}", "test-fast-slow", order=index)

    worker = JobWorker("lane-worker")
    try:
        assert await worker._claim_up_to_concurrency() == 2
        assert await worker._claim_up_to_concurrency() == 0
        assert await _statuses("fast-0", "fast-1", "fast-2") == [
            "running", "running", "queued",
        ]
        assert len(worker._running_by_lane[registry.LANE_FAST]) == 2
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_the_worker_still_fails_an_unknown_kind(lanes):
    """No spec means no lane to opt into: processing claims it and fails it."""
    await _seed("mystery", "no-such-kind", order=0)

    worker = JobWorker("lane-worker")
    try:
        assert await worker._claim_up_to_concurrency() == 1
        await _settled(worker, "mystery")
    finally:
        await worker.stop()
    job = await _get("mystery")
    assert (job.status, job.message) == ("failed", "Unknown job kind")


@pytest.mark.asyncio
async def test_a_stop_that_lands_mid_claim_runs_nothing_and_writes_nothing(
    lanes, monkeypatch
):
    """Shutdown arriving while a fast-lane claim is in flight.

    This one runs the real loop. A processing job holds its slot, and the
    fast lane has room, so the loop is busy claiming a queued fast job at the
    moment `stop` is called. That claim is allowed to finish rather than be
    cancelled mid-statement, and the row it took is then left exactly as
    `stop` leaves every running job: `running` under this worker's claim,
    with no handler started and no task spawned, for the lease and the next
    boot's `requeue_expired` to settle. The running processing job is left
    the same way.
    """
    await _seed("gen", "test-slow", order=0)
    await _seed("late", "test-fast-slow", order=1)

    real_claim = queue.claim_next
    claim_in_flight = asyncio.Event()
    let_claim_finish = asyncio.Event()

    async def gated_claim(worker_id, lane=None):
        if lane == registry.LANE_FAST:
            claim_in_flight.set()
            await let_claim_finish.wait()
        return await real_claim(worker_id, lane=lane)

    monkeypatch.setattr(queue, "claim_next", gated_claim)

    worker = JobWorker("stopping-worker")
    await worker.start()
    await asyncio.wait_for(_started("gen").wait(), timeout=10)
    await asyncio.wait_for(claim_in_flight.wait(), timeout=10)

    stopping = asyncio.create_task(worker.stop())
    while not worker._stopping.is_set():
        await asyncio.sleep(0)
    let_claim_finish.set()
    await asyncio.wait_for(stopping, timeout=10)

    for job_id in ("gen", "late"):
        job = await _get(job_id)
        assert (job.status, job.claimed_by, job.finished_at, job.attempts) == (
            "running", "stopping-worker", None, 1,
        )
    assert "late" not in started, "the handler of a job claimed during stop ran"
    assert not _done("late").is_set(), "a task was spawned for it"
    assert not worker._running
    assert not any(worker._running_by_lane.values())


# ---------------------------------------------------------------------------
# The claim: one lane at a time, oldest first
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_each_lane_claims_oldest_first_and_only_its_own_kinds():
    """FIFO survives within each lane however the two are interleaved."""
    await _seed("p1", JobKind.INGEST.value, order=0)
    await _seed("f1", JobKind.CATALOG_IMPORT.value, order=1)
    await _seed("p2", JobKind.RETRANSCRIBE.value, order=2)
    await _seed("f2", JobKind.VIDEO_IMPORT.value, order=3)
    await _seed("f3", JobKind.CDG_IMPORT.value, order=4)

    fast = [(await queue.claim_next("w", lane=registry.LANE_FAST)) for _ in range(4)]
    assert [job.id if job else None for job in fast] == ["f1", "f2", "f3", None]

    processing = [
        (await queue.claim_next("w", lane=registry.LANE_PROCESSING)) for _ in range(3)
    ]
    assert [job.id if job else None for job in processing] == ["p1", "p2", None]


@pytest.mark.asyncio
async def test_claiming_without_a_lane_is_plain_fifo_across_both():
    """The one-shot drain and older callers keep the single-queue order."""
    await _seed("p1", JobKind.INGEST.value, order=0)
    await _seed("f1", JobKind.CATALOG_IMPORT.value, order=1)
    await _seed("p2", JobKind.PAGE.value, order=2)

    claimed = [(await queue.claim_next("w")).id for _ in range(3)]
    assert claimed == ["p1", "f1", "p2"]
    assert await queue.claim_next("w") is None


@pytest.mark.asyncio
async def test_an_unknown_lane_is_refused():
    with pytest.raises(ValueError):
        await queue.claim_next("w", lane="gpu")
    with pytest.raises(ValueError):
        queue.lane_concurrency("gpu")


@pytest.mark.asyncio
async def test_deferred_kinds_stay_queued_in_both_lanes(monkeypatch):
    """Setup-gated kinds must not leak out through the new lane.

    The fast built-ins are never in the deferred set today, but the exclusion
    is applied to both lanes rather than reasoned about, so one deferred
    there is held as firmly as an ingest is.
    """
    from karaoke_backend.workers import managed_processing

    deferred = frozenset({JobKind.INGEST.value, JobKind.CATALOG_IMPORT.value})
    monkeypatch.setattr(managed_processing, "deferred_job_kinds", lambda: deferred)
    await _seed("ingest", JobKind.INGEST.value, order=0)
    await _seed("catalog", JobKind.CATALOG_IMPORT.value, order=1)

    assert await queue.claim_next("w", lane=registry.LANE_PROCESSING) is None
    assert await queue.claim_next("w", lane=registry.LANE_FAST) is None
    assert await queue.claim_next("w") is None
    for job_id in ("ingest", "catalog"):
        job = await _get(job_id)
        assert (job.status, job.attempts, job.claimed_by) == ("queued", 0, None)

    # Readiness releases them into their own lanes.
    monkeypatch.setattr(managed_processing, "deferred_job_kinds", frozenset)
    assert (await queue.claim_next("w", lane=registry.LANE_FAST)).id == "catalog"
    assert (await queue.claim_next("w", lane=registry.LANE_PROCESSING)).id == "ingest"


@pytest.mark.asyncio
async def test_unknown_and_legacy_kinds_stay_on_the_processing_path():
    """A kind with no spec is still claimed and terminally failed, as before.

    The fast lane never sees it — only a spec can opt into that lane — and
    the processing lane, being "everything not fast", still does. That
    includes a legacy NULL kind, which SQL's NOT IN would otherwise drop.
    """
    await _seed("mystery", "no-such-kind", order=0)
    await _seed("legacy", None, order=1)

    assert await queue.claim_next("w", lane=registry.LANE_FAST) is None
    first = await queue.claim_next("w", lane=registry.LANE_PROCESSING)
    second = await queue.claim_next("w", lane=registry.LANE_PROCESSING)
    assert [first.id, second.id] == ["mystery", "legacy"]


# ---------------------------------------------------------------------------
# Registry: where each kind lives
# ---------------------------------------------------------------------------


def test_builtin_kinds_are_classified_by_what_their_handlers_do():
    """Only the kinds that adopt finished media are fast.

    Every kind that separates, transcribes or aligns — the ones
    managed_processing can hold for setup — draws from the processing lane,
    and so does re-paging, whose LLM endpoint may share the GPU.
    """
    fast = {
        JobKind.CATALOG_IMPORT.value,
        JobKind.VIDEO_IMPORT.value,
        JobKind.CDG_IMPORT.value,
    }
    processing = {
        JobKind.INGEST.value,
        JobKind.PLEX_IMPORT.value,
        JobKind.RETRANSCRIBE.value,
        JobKind.REALIGN.value,
        JobKind.RESPLIT.value,
        JobKind.PAGE.value,
    }
    assert fast | processing == {kind.value for kind in JobKind} & registry.known_kinds()
    assert registry.fast_lane_kinds() & registry.known_kinds() >= fast
    for kind in fast:
        assert registry.lane_of(kind) == registry.LANE_FAST
    for kind in processing:
        assert registry.lane_of(kind) == registry.LANE_PROCESSING
    assert registry.lane_of("no-such-kind") == registry.LANE_PROCESSING
    assert registry.lane_of(None) == registry.LANE_PROCESSING


def test_an_extension_kind_defaults_to_processing_and_can_opt_into_fast():
    try:
        registry.register_job_kind("ext-default", f"{_THIS_MODULE}:finish_immediately")
        registry.register_job_kind(
            "ext-fast", f"{_THIS_MODULE}:finish_immediately", lane=registry.LANE_FAST
        )
        assert registry.get_spec("ext-default").lane == registry.LANE_PROCESSING
        assert registry.get_spec("ext-fast").lane == registry.LANE_FAST
        assert "ext-fast" in registry.fast_lane_kinds()
        assert "ext-default" not in registry.fast_lane_kinds()
    finally:
        registry.unregister_job_kind("ext-default")
        registry.unregister_job_kind("ext-fast")
    assert "ext-fast" not in registry.fast_lane_kinds()


@pytest.mark.parametrize("lane", ["gpu", "", None, "FAST"])
def test_an_unknown_lane_is_refused_at_registration(lane):
    with pytest.raises(ValueError):
        registry.register_job_kind("ext-bad-lane", f"{_THIS_MODULE}:finish_immediately", lane=lane)
    assert registry.get_spec("ext-bad-lane") is None
    with pytest.raises(ValueError):
        registry.JobSpec(f"{_THIS_MODULE}:finish_immediately", lane=lane)


# ---------------------------------------------------------------------------
# Knobs
# ---------------------------------------------------------------------------


def test_fast_concurrency_is_its_own_validated_knob(monkeypatch):
    assert queue.fast_concurrency() == 2
    assert queue.lane_concurrency(registry.LANE_FAST) == 2
    assert queue.lane_concurrency(registry.LANE_PROCESSING) == 1

    monkeypatch.setenv("KARAOKE_FAST_JOB_CONCURRENCY", "4")
    assert queue.fast_concurrency() == 4
    assert queue.concurrency() == 1, "the processing cap must not follow it"

    monkeypatch.setenv("KARAOKE_FAST_JOB_CONCURRENCY", "0")
    assert queue.fast_concurrency() == 2, "a lane that can never claim is refused"
    monkeypatch.setenv("KARAOKE_FAST_JOB_CONCURRENCY", "lots")
    assert queue.fast_concurrency() == 2
