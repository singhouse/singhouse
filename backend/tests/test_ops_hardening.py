# SPDX-License-Identifier: AGPL-3.0-only
"""Focused regression tests for the operational hardening.

The startup-recovery half was rewritten with the durable queue, deliberately.
The pre-queue hardening pinned
"a queued job is swept at boot"; the durable queue REVERSES that — surviving a
restart is what the queue is for — so what is pinned here now is the new
contract: legacy rows (no `kind`) are swept and their uploads released,
queue-era rows survive untouched, and interrupted `running` rows are the
lease's problem, not boot's.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import threading
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from karaoke_backend import main as main_module
from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.db import bootstrap
from karaoke_backend.db.sqlite import install_sqlite_pragmas
from karaoke_backend.jobs import queue as job_queue
from karaoke_backend.jobs._llm import make_correction_progress_callback
from karaoke_backend.jobs.queue import (
    RESTART_INTERRUPTION_MESSAGE,
    requeue_expired,
    sweep_legacy,
)
from karaoke_backend.models.song import Job, JobKind, Song
from karaoke_backend.workers import modal_worker


def test_sync_migration_engine_sets_file_sqlite_pragmas(tmp_path: Path):
    engine = bootstrap.make_sync_engine(f"sqlite:///{tmp_path / 'migration.db'}")
    try:
        with engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"
            assert connection.exec_driver_sql("PRAGMA busy_timeout").scalar_one() == 5000
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 0
    finally:
        engine.dispose()


@pytest.mark.asyncio
async def test_async_runtime_sets_file_sqlite_pragmas(tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'runtime.db'}")
    install_sqlite_pragmas(engine.sync_engine, foreign_keys=True)
    try:
        async with engine.connect() as connection:
            assert (await connection.execute(text("PRAGMA journal_mode"))).scalar_one() == "wal"
            assert (await connection.execute(text("PRAGMA busy_timeout"))).scalar_one() == 5000
            assert (await connection.execute(text("PRAGMA foreign_keys"))).scalar_one() == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_in_memory_sqlite_skips_wal_but_sets_busy_timeout():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    install_sqlite_pragmas(engine.sync_engine, foreign_keys=True)
    try:
        async with engine.connect() as connection:
            assert (await connection.execute(text("PRAGMA journal_mode"))).scalar_one() == "memory"
            assert (await connection.execute(text("PRAGMA busy_timeout"))).scalar_one() == 5000
            assert (await connection.execute(text("PRAGMA foreign_keys"))).scalar_one() == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_correction_progress_callback_writes_from_worker_thread():
    async with AsyncSessionLocal() as db:
        db.add(
            Job(
                id="correction-worker",
                kind=JobKind.INGEST.value,
                status="running",
                phase="transcribing",
                progress=80,
                claimed_by="worker-1",
            )
        )
        await db.commit()

    event_loop_thread = threading.get_ident()
    callback = make_correction_progress_callback(
        "correction-worker",
        "worker-1",
        asyncio.get_running_loop(),
    )

    callback_thread = await asyncio.to_thread(
        lambda: (callback(1, 4), threading.get_ident())[1]
    )

    assert callback_thread != event_loop_thread
    async with AsyncSessionLocal() as db:
        job = await db.get(Job, "correction-worker")
        assert job is not None
        assert job.message == "LLM correction: region 2/4"


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_status", ["done", "failed"])
async def test_correction_progress_callback_does_not_overwrite_terminal_message(
    terminal_status: str,
):
    terminal_message = f"{terminal_status} terminal message"
    async with AsyncSessionLocal() as db:
        db.add(
            Job(
                id=f"correction-{terminal_status}",
                kind=JobKind.INGEST.value,
                status=terminal_status,
                progress=100,
                message=terminal_message,
                claimed_by="worker-1",
            )
        )
        await db.commit()

    callback = make_correction_progress_callback(
        f"correction-{terminal_status}",
        "worker-1",
        asyncio.get_running_loop(),
    )
    await asyncio.to_thread(callback, 0, 2)

    async with AsyncSessionLocal() as db:
        job = await db.get(Job, f"correction-{terminal_status}")
        assert job is not None
        assert job.message == terminal_message


@pytest.mark.asyncio
async def test_correction_progress_callback_is_refused_from_a_stale_worker():
    """The claim guard, from the callback that most easily outlives its job.

    A worker wedged behind a hung subprocess keeps firing correction callbacks
    long after its lease lapsed. By then another worker may hold the job; the
    stale write must not land.
    """
    async with AsyncSessionLocal() as db:
        db.add(
            Job(
                id="correction-stale",
                kind=JobKind.INGEST.value,
                status="running",
                progress=50,
                message="held by the new owner",
                claimed_by="worker-2",
            )
        )
        await db.commit()

    callback = make_correction_progress_callback(
        "correction-stale", "worker-1", asyncio.get_running_loop()
    )
    await asyncio.to_thread(callback, 0, 2)

    async with AsyncSessionLocal() as db:
        job = await db.get(Job, "correction-stale")
        assert job.message == "held by the new owner"


@pytest.mark.asyncio
async def test_startup_sweep_fails_only_legacy_rows_and_removes_only_their_uploads(
    tmp_path: Path,
):
    """The new contract, and the reversal at the heart of it.

    A `kind`-less row is pre-queue: its `status` holds a pipeline phase, it has
    no payload, and no handler can ever re-enter it — so boot fails it and
    frees its upload. A row WITH a kind is a durable queue entry and boot must
    not touch it, whatever state it is in. That is the pre-queue sweep
    behaviour this deliberately reverses.
    """
    async with AsyncSessionLocal() as db:
        processing = Song(
            artist="Processing", title="Legacy", filename="legacy.wav",
            status="processing",
        )
        ready = Song(
            artist="Ready", title="Retranscribe", filename="ready.wav",
            status="ready",
        )
        terminal_song = Song(
            artist="Terminal", title="Untouched", filename="done.wav",
            status="processing",
        )
        survivor_song = Song(
            artist="Survivor", title="Queued", filename="survivor.wav",
            status="processing",
        )
        db.add_all([processing, ready, terminal_song, survivor_song])
        await db.flush()
        db.add_all(
            [
                # --- legacy (kind IS NULL): swept ---
                Job(
                    id="legacy-queued", song_id=processing.id,
                    status="queued", progress=0, message="queued",
                ),
                Job(
                    id="legacy-separating", song_id=ready.id,
                    status="separating", progress=40, message="active",
                ),
                Job(
                    id="legacy-no-song", song_id=None,
                    status="aligning", progress=95, message="active without song",
                ),
                # --- already terminal: untouched either way ---
                Job(
                    id="done-job", song_id=terminal_song.id,
                    status="done", progress=100, message="complete",
                ),
                Job(
                    id="failed-job", song_id=None,
                    status="failed", progress=0, message="already failed",
                ),
                # --- queue-era: SURVIVES, which is the point of the durable queue ---
                Job(
                    id="survivor-queued", song_id=survivor_song.id,
                    kind=JobKind.INGEST.value, status="queued",
                    phase="queued", progress=0, message="Job queued",
                ),
                # --- queue-era and interrupted: the LEASE's problem, not boot's ---
                Job(
                    id="survivor-running", song_id=None,
                    kind=JobKind.RETRANSCRIBE.value, status="running",
                    phase="transcribing", progress=30, claimed_by="dead-worker",
                ),
            ]
        )
        await db.commit()
        processing_id = processing.id
        ready_id = ready.id
        terminal_song_id = terminal_song.id
        survivor_song_id = survivor_song.id

    owned = [
        tmp_path / "legacy-queued_upload.wav",
        tmp_path / "legacy-separating_upload.wav",
        tmp_path / "legacy-no-song_upload.wav",
    ]
    for path in owned:
        path.write_bytes(b"owned")
    terminal_upload = tmp_path / "done-job_upload.wav"
    terminal_upload.write_bytes(b"terminal")
    survivor_upload = tmp_path / "survivor-queued_upload.wav"
    survivor_upload.write_bytes(b"still needed")
    unrelated = tmp_path / "legacy-queuedx_upload.wav"
    unrelated.write_bytes(b"unrelated")
    nested = tmp_path / "legacy-separating_nested"
    nested.mkdir()
    nested_child = nested / "upload.wav"
    nested_child.write_bytes(b"nested")

    swept = await sweep_legacy(tmp_path)

    assert swept == 3
    assert all(not path.exists() for path in owned)
    assert terminal_upload.exists()
    assert unrelated.exists()
    assert nested_child.exists()
    assert survivor_upload.exists(), (
        "a surviving queued job still needs the file it will be run against"
    )

    async with AsyncSessionLocal() as db:
        jobs = {
            job.id: job
            for job in (await db.execute(select(Job).order_by(Job.id))).scalars()
        }
        for job_id in ("legacy-queued", "legacy-separating", "legacy-no-song"):
            assert jobs[job_id].status == "failed"
            assert jobs[job_id].phase == "failed"
            assert jobs[job_id].message == RESTART_INTERRUPTION_MESSAGE
            assert jobs[job_id].error_message == RESTART_INTERRUPTION_MESSAGE
        assert jobs["done-job"].status == "done"
        assert jobs["done-job"].message == "complete"
        assert jobs["failed-job"].status == "failed"
        assert jobs["failed-job"].message == "already failed"

        assert jobs["survivor-queued"].status == "queued"
        assert jobs["survivor-queued"].message == "Job queued"
        assert jobs["survivor-running"].status == "running"
        assert jobs["survivor-running"].claimed_by == "dead-worker"

        assert (await db.get(Song, processing_id)).status == "failed"
        assert (await db.get(Song, ready_id)).status == "ready"
        assert (await db.get(Song, terminal_song_id)).status == "processing"
        assert (await db.get(Song, survivor_song_id)).status == "processing"


@pytest.mark.asyncio
async def test_expired_lease_requeues_without_consuming_an_attempt(tmp_path: Path):
    """An interrupted run comes back to the queue.

    The attempt counter is NOT touched here — `claim_next` is what spends an
    attempt, so counting one on the way back would charge a job twice for a
    single crash and halve the retry budget the operator configured.
    """
    stale = datetime.now(timezone.utc) - timedelta(seconds=30)
    async with AsyncSessionLocal() as db:
        db.add_all(
            [
                Job(
                    id="lapsed", kind=JobKind.INGEST.value, status="running",
                    phase="separating", progress=40, attempts=1,
                    claimed_by="dead-worker", lease_expires_at=stale,
                ),
                # A provider-owned import that moved OFF `running`: still
                # claimed, still not terminal, therefore still recoverable.
                Job(
                    id="provider-lapsed", kind=JobKind.CATALOG_IMPORT.value,
                    status="downloading", phase="importing", attempts=1,
                    claimed_by="dead-worker", lease_expires_at=stale,
                ),
                # No claimant: a queued row must never be swept by the lease.
                Job(
                    id="just-queued", kind=JobKind.INGEST.value, status="queued",
                    phase="queued", attempts=0, lease_expires_at=stale,
                ),
                Job(
                    id="live", kind=JobKind.INGEST.value, status="running",
                    phase="separating", attempts=1, claimed_by="other-worker",
                    lease_expires_at=datetime.now(timezone.utc) + timedelta(seconds=60),
                ),
                Job(
                    id="mine", kind=JobKind.INGEST.value, status="running",
                    phase="separating", attempts=1, claimed_by="me",
                    lease_expires_at=stale,
                ),
            ]
        )
        await db.commit()

    assert await requeue_expired("me") == 2

    async with AsyncSessionLocal() as db:
        lapsed = await db.get(Job, "lapsed")
        assert lapsed.status == "queued"
        assert lapsed.phase == "queued"
        assert lapsed.claimed_by is None
        assert lapsed.lease_expires_at is None
        assert lapsed.attempts == 1, "requeue must not consume an attempt; the claim does"

        # The provider's own status string did not make its job invisible.
        provider_lapsed = await db.get(Job, "provider-lapsed")
        assert provider_lapsed.status == "queued"
        assert provider_lapsed.claimed_by is None

        # Unclaimed, so not the lease's business however stale the timestamp.
        assert (await db.get(Job, "just-queued")).status == "queued"
        assert (await db.get(Job, "just-queued")).attempts == 0

        assert (await db.get(Job, "live")).status == "running"
        # Our OWN lapsed claim is never touched: while this process lives its
        # heartbeat owns the lease, and requeueing it would double-run it.
        assert (await db.get(Job, "mine")).status == "running"


@pytest.mark.asyncio
async def test_expired_lease_fails_a_job_that_used_up_its_attempts(
    monkeypatch: pytest.MonkeyPatch
):
    """Requeue is not infinite: a job that keeps killing the process stops.

    Its upload does not stop with it. A job that burns through its attempts is
    typically one that kept killing the process mid-separation, which is the
    case ``POST /api/songs/{id}/retry`` most obviously exists to rescue — and
    that route can only replay phase 1 from the file the run was given. This
    sweep used to unlink it, which made the worst failures the only
    unretryable ones.
    """
    from karaoke_backend.api.separate import UPLOADS_DIR

    monkeypatch.setenv("KARAOKE_JOB_MAX_ATTEMPTS", "2")
    stale = datetime.now(timezone.utc) - timedelta(seconds=30)
    exhausted_id = "exhausted"
    async with AsyncSessionLocal() as db:
        db.add_all(
            [
                Job(
                    id=exhausted_id, kind=JobKind.INGEST.value, status="running",
                    attempts=2, claimed_by="dead-worker", lease_expires_at=stale,
                ),
                Job(
                    id="one-left", kind=JobKind.INGEST.value, status="running",
                    attempts=1, claimed_by="dead-worker", lease_expires_at=stale,
                ),
            ]
        )
        await db.commit()

    # Named the way every handler names its upload — `{job_id}_` is exactly the
    # prefix `unlink_uploads_for` reaps by, so this file is what a sweep that
    # still reaped would take. Derived from the job id, not spelled to match
    # it: a negative assertion on a file the sweep never looked at would pass
    # for the wrong reason.
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    upload = UPLOADS_DIR / f"{exhausted_id}_upload.wav"
    upload.write_bytes(b"the only recoverable input")

    try:
        assert await requeue_expired("me") == 1

        async with AsyncSessionLocal() as db:
            exhausted = await db.get(Job, exhausted_id)
            assert exhausted.status == "failed"
            assert exhausted.phase == "failed"
            assert exhausted.message == job_queue.LEASE_EXPIRED_MESSAGE
            assert exhausted.error_message == job_queue.LEASE_EXPIRED_MESSAGE
            assert (await db.get(Job, "one-left")).status == "queued"

        # Retained as the only input a retry could ever replay phase 1 from.
        # (The song row is not flipped to `failed` on this path, so the retry
        # route cannot reach it yet — that is the song's defect, not the
        # file's, and the file must be there when it is fixed.)
        assert upload.is_file(), "the only recoverable input must survive"
    finally:
        upload.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_startup_sweep_unlink_failure_is_nonfatal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    async with AsyncSessionLocal() as db:
        db.add(Job(id="unlink-failure", status="queued", progress=0))
        await db.commit()

    upload = tmp_path / "unlink-failure_upload.wav"
    upload.write_bytes(b"owned")
    original_unlink = Path.unlink

    def fail_owned_unlink(path: Path, *args, **kwargs):
        if path == upload:
            raise PermissionError("test denial")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_owned_unlink)

    swept = await sweep_legacy(tmp_path)

    assert swept == 1
    assert upload.exists()
    assert "Could not remove orphan upload" in caplog.text
    async with AsyncSessionLocal() as db:
        job = await db.get(Job, "unlink-failure")
        assert job is not None
        assert job.status == "failed"


@pytest.mark.asyncio
async def test_lifespan_sweeps_after_schema_and_starts_the_worker_after_plugins(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """Boot order, and why each edge of it matters.

    The sweep needs the schema (it reads columns c0005 adds). The worker needs
    `plugins.load_all()` — a catalog-import job resolves its provider through
    the registry discovery populates, and the worker can claim one on its very
    first pass, so starting it earlier is a race against an empty registry.

    The lifespan hooks bracket the worker: startup runs once it is up,
    teardown only after it has stopped, so a hook may hold a resource a
    still-running job needs. Core names nothing about what the hooks do — this
    asserts the seam's ordering, not any particular composed package.
    """
    events: list[str] = []

    def core_schema() -> None:
        events.append("core-schema")

    def premium_schema() -> None:
        events.append("premium-schema")

    async def sweep() -> int:
        events.append("sweep")
        return 0

    async def extension_startup(_app) -> None:
        events.append("extension-startup")

    async def extension_shutdown(_app) -> None:
        events.append("extension-shutdown")

    class FakeWorker:
        async def start(self) -> None:
            events.append("worker-start")

        async def stop(self) -> None:
            events.append("worker-stop")

    premium_package = types.ModuleType("karaoke_premium")
    premium_package.__path__ = []
    premium_db_package = types.ModuleType("karaoke_premium.db")
    premium_db_package.__path__ = []
    premium_bootstrap = types.ModuleType("karaoke_premium.db.bootstrap")
    setattr(premium_bootstrap, "ensure_premium_schema", premium_schema)
    monkeypatch.setitem(sys.modules, "karaoke_premium", premium_package)
    monkeypatch.setitem(sys.modules, "karaoke_premium.db", premium_db_package)
    monkeypatch.setitem(
        sys.modules,
        "karaoke_premium.db.bootstrap",
        premium_bootstrap,
    )

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main_module, "AUTH_MODE", "multi_user")
    monkeypatch.setattr(main_module.bootstrap, "ensure_schema", core_schema)
    monkeypatch.setattr(main_module, "sweep_legacy", sweep)
    monkeypatch.setattr(main_module, "JobWorker", FakeWorker)
    monkeypatch.setattr(
        main_module.plugins,
        "load_all",
        lambda: events.append("plugins"),
    )
    monkeypatch.setattr(
        main_module.app.state, "lifespan_startup_hooks", [extension_startup]
    )
    monkeypatch.setattr(
        main_module.app.state, "lifespan_shutdown_hooks", [extension_shutdown]
    )
    # This test pins boot ORDER, not provider mounting — and the app is a
    # module global, so letting the mount block run here would splice provider
    # routes into the route table every other test in the process then sees.
    monkeypatch.setattr(
        main_module.app.state, "provider_routes_mounted", True, raising=False
    )

    async with main_module.lifespan(main_module.app):
        assert events == [
            "core-schema",
            "premium-schema",
            "sweep",
            "plugins",
            "worker-start",
            "extension-startup",
        ]

    assert events[-2:] == ["worker-stop", "extension-shutdown"]


@pytest.mark.asyncio
async def test_mix_and_finalize_runs_probe_transcode_and_mix_off_loop_thread(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    stems_dir = tmp_path / "stems"
    stems_dir.mkdir()
    lead = stems_dir / "lead_vocals.wav"
    backing = stems_dir / "backing_vocals.wav"
    lead.write_bytes(b"lead")
    backing.write_bytes(b"backing")

    drums = tmp_path / "drums.wav"
    bass = tmp_path / "bass.wav"
    other = tmp_path / "other.wav"
    for path in (drums, bass, other):
        path.write_bytes(b"part")

    event_loop_thread = threading.get_ident()
    calls: list[tuple[str, int]] = []

    def fake_run(cmd, **_kwargs):
        calls.append((cmd[0], threading.get_ident()))
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, 0, stdout="flt\n", stderr="")
        Path(cmd[-1]).write_bytes(b"ffmpeg output")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(modal_worker.subprocess, "run", fake_run)
    progress_calls: list[tuple[str, int, str]] = []

    async def progress(status: str, pct: int, message: str) -> None:
        progress_calls.append((status, pct, message))

    result = await modal_worker._mix_and_finalize(
        stems_dir,
        drums,
        bass,
        other,
        progress,
    )

    assert [name for name, _thread in calls].count("ffprobe") == 2
    assert [name for name, _thread in calls].count("ffmpeg") == 4
    assert all(thread != event_loop_thread for _name, thread in calls)
    assert progress_calls == [
        ("mixing", 75, "Mixing instrumental track..."),
        ("mixing", 85, "Instrumental ready"),
        ("mixing", 87, "Mixing karaoke track (instrumental + backing)..."),
        ("mixing", 95, "Karaoke track ready"),
        ("done", 100, "All stems ready"),
    ]
    assert result == {
        "instrumental": stems_dir / "instrumental.wav",
        "lead_vocals": lead,
        "backing_vocals": backing,
        "karaoke": stems_dir / "karaoke.wav",
    }
    assert all(path.exists() for path in result.values())
