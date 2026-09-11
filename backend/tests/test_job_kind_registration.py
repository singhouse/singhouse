# SPDX-License-Identifier: AGPL-3.0-only
"""The registration seam for job kinds.

An installed extension package runs its long work through core's durable
queue, and its handlers live outside ``karaoke_backend`` — so the registry
has to be add-to-able at composition time. What these tests pin: a registered
kind is indistinguishable from a built-in to the worker and the jobs API; the
registry refuses anything the ``jobs.kind`` column could not store or that
would redefine an existing kind; and the built-ins can never be replaced or
removed, because the rest of core enqueues them by name.

The handlers here live in THIS module and are targeted by dotted path, the
same resolve-on-dispatch mechanism a real registration uses.
"""

from __future__ import annotations

import json

import pytest

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs import queue, registry
from karaoke_backend.jobs.base import JobContext
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Job, JobKind

# ---------------------------------------------------------------------------
# Test-local handlers, resolved by target string exactly as an extension's are
# ---------------------------------------------------------------------------

_THIS_MODULE = "tests.test_job_kind_registration"

# What the handler saw, recorded for the test to assert on. Reset per use.
handled: list[JobContext] = []


async def record_and_report(ctx: JobContext) -> str:
    """A well-behaved handler: writes progress mid-run, returns a message."""
    handled.append(ctx)
    assert await queue.update_progress(
        ctx.job_id, ctx.worker_id, progress=42, message="halfway"
    ) is True
    # The mid-run write must actually land on the row while the job runs;
    # `finish` will overwrite progress with 100 the moment we return.
    async with AsyncSessionLocal() as db:
        row = await db.get(Job, ctx.job_id)
        assert (row.progress, row.message) == (42, "halfway")
    return "batch handled"


@pytest.fixture
def register_kind():
    """Register kinds through this so the module-global registry never leaks.

    The registry is process state shared by every test in the run; a kind
    left behind here would make an unrelated test's "unknown kind" suddenly
    known.
    """
    registered: list[str] = []

    def _register(kind: str, target: str, **kwargs) -> None:
        registry.register_job_kind(kind, target, **kwargs)
        registered.append(kind)

    handled.clear()
    yield _register
    for kind in registered:
        registry.unregister_job_kind(kind)


async def _get(job_id: str) -> Job:
    async with AsyncSessionLocal() as db:
        job = await db.get(Job, job_id)
        assert job is not None
        return job


# ---------------------------------------------------------------------------
# A registered kind is a first-class kind
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_registered_kind_is_enqueued_run_and_finished_like_a_builtin(
    register_kind,
):
    """The whole seam, end to end: enqueue by plain string, drain, done."""
    register_kind("library-sweep", f"{_THIS_MODULE}:record_and_report")
    assert "library-sweep" in registry.known_kinds()
    assert registry.get_spec("library-sweep") is not None

    async with AsyncSessionLocal() as db:
        queue.enqueue(
            db,
            kind="library-sweep",
            job_id="sweep-1",
            song_id=None,
            owner_id=1,
            payload={"paths": ["a", "b"]},
        )
        await db.commit()

    assert await run_queued_jobs_once() == 1

    assert len(handled) == 1
    ctx = handled[0]
    assert ctx.kind == "library-sweep"
    assert ctx.payload == {"paths": ["a", "b"]}

    job = await _get("sweep-1")
    assert (job.status, job.phase, job.progress) == ("done", "done", 100)
    assert job.message == "batch handled"
    assert job.claimed_by is None and job.finished_at is not None


@pytest.mark.asyncio
async def test_a_null_song_id_job_runs_and_polls_like_any_other(
    register_kind, client
):
    """A batch-shaped job has no single song — `Job.song_id` is nullable and
    nothing downstream may assume otherwise. The poll route does no join on
    `songs`, so the row comes back with `song_id: null` and everything else
    intact.
    """
    register_kind("library-sweep", f"{_THIS_MODULE}:record_and_report")

    async with AsyncSessionLocal() as db:
        queue.enqueue(
            db,
            kind="library-sweep",
            job_id="sweep-songless",
            song_id=None,
            owner_id=1,
            payload={},
        )
        await db.commit()

    assert await run_queued_jobs_once() == 1
    assert handled[0].song_id is None

    resp = await client.get("/api/jobs/sweep-songless")
    assert resp.status_code == 200
    body = resp.json()
    assert body["song_id"] is None
    assert (body["status"], body["phase"], body["progress"]) == ("done", "done", 100)
    assert body["message"] == "batch handled"


@pytest.mark.asyncio
async def test_unregistering_returns_the_kind_to_the_unknown_path():
    """Cleanup has to be real: after unregister, a queued row of that kind
    fails through the same "Unknown job kind" path any stray string does.
    """
    registry.register_job_kind(
        "short-lived", f"{_THIS_MODULE}:record_and_report"
    )
    try:
        assert "short-lived" in registry.known_kinds()
    finally:
        registry.unregister_job_kind("short-lived")

    assert "short-lived" not in registry.known_kinds()
    assert registry.get_spec("short-lived") is None

    async with AsyncSessionLocal() as db:
        db.add(
            Job(
                id="orphaned-kind",
                kind="short-lived",
                status="queued",
                phase="queued",
                progress=0,
                owner_id=1,
                payload=json.dumps({}),
                attempts=0,
            )
        )
        await db.commit()

    assert await run_queued_jobs_once() == 1
    job = await _get("orphaned-kind")
    assert job.status == "failed"
    assert "Unknown job kind" in job.message


# ---------------------------------------------------------------------------
# What registration refuses
# ---------------------------------------------------------------------------


def test_reregistering_a_registered_kind_is_refused(register_kind):
    """Add-only: rows of a kind may already be queued, and swapping the spec
    would change what they do on their next claim.
    """
    register_kind("library-sweep", f"{_THIS_MODULE}:record_and_report")

    with pytest.raises(ValueError, match="already registered"):
        registry.register_job_kind(
            "library-sweep", f"{_THIS_MODULE}:record_and_report"
        )


def test_the_builtin_kinds_can_be_neither_replaced_nor_removed():
    for kind in JobKind:
        with pytest.raises(ValueError, match="already registered"):
            registry.register_job_kind(
                kind.value, f"{_THIS_MODULE}:record_and_report"
            )
        with pytest.raises(ValueError, match="built in"):
            registry.unregister_job_kind(kind.value)
        assert kind.value in registry.known_kinds()


def test_a_kind_the_column_cannot_store_is_refused():
    """`jobs.kind` is String(32); an overlong kind must fail loudly here, not
    become a row that never matches its own spec.
    """
    with pytest.raises(ValueError, match="longer than"):
        registry.register_job_kind(
            "x" * 33, f"{_THIS_MODULE}:record_and_report"
        )
    # The boundary itself is fine.
    registry.register_job_kind("x" * 32, f"{_THIS_MODULE}:record_and_report")
    try:
        assert "x" * 32 in registry.known_kinds()
    finally:
        registry.unregister_job_kind("x" * 32)


def test_an_empty_or_non_string_kind_is_refused():
    # (A `JobKind` member would pass the str check — it IS a str — and be
    # refused as already registered, which the built-ins test covers.)
    for bad in ("", None, 7, b"kind"):
        with pytest.raises(ValueError, match="non-empty string"):
            registry.register_job_kind(bad, f"{_THIS_MODULE}:record_and_report")


@pytest.mark.parametrize(
    "target",
    [None, 42, run_queued_jobs_once, "no_colon", ":whoops", "mod:", "", ".rel:fn"],
)
def test_a_malformed_target_is_refused_at_registration(target):
    # Claim time is too late for these: the worker turns a MISSING module or
    # attribute into a clean job failure, but a target that is not
    # "module:attr" at all explodes inside resolution and wedges the claimed
    # row until its lease expires.
    with pytest.raises(ValueError, match="target"):
        registry.register_job_kind("shaped-wrong", target)
    assert registry.get_spec("shaped-wrong") is None


def test_mirrors_song_status_rides_along(register_kind):
    # The seam's one behavioural parameter: a registered kind that mirrors
    # must carry the flag into the spec the worker consults on failure.
    register_kind("mirroring-kind", "tests.test_job_kind_registration:record_and_report",
                  mirrors_song_status=True)
    assert registry.get_spec("mirroring-kind").mirrors_song_status is True
    register_kind("plain-kind", "tests.test_job_kind_registration:record_and_report")
    assert registry.get_spec("plain-kind").mirrors_song_status is False


def test_known_kinds_returns_a_copy_not_the_registry():
    kinds = registry.known_kinds()
    with pytest.raises(AttributeError):
        kinds.add("smuggled")  # frozenset: no mutation path back in
    assert "smuggled" not in registry.known_kinds()


def test_unregistering_an_absent_kind_is_silent():
    """Teardown must be idempotent — a fixture that cleans up after a failed
    registration cannot itself raise.
    """
    registry.unregister_job_kind("never-registered")
