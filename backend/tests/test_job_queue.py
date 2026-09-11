# SPDX-License-Identifier: AGPL-3.0-only
"""The durable job queue: claims, leases, and phase resume.

These are the tests for the properties the queue is *for*. The claim has to be
atomic or two workers run the same separation; the lease has to be renewable
or a live job gets stolen from underneath itself; the progress writes have to
be guarded or a worker that lost its claim corrupts the row that replaced it;
and ingest has to re-enter where the artifacts say it left off, or a requeue
is just a slower way to start over.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs import queue
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.jobs.ingest import (
    SEPARATION_MARKER,
    run_ingest,
    separation_is_complete,
)
from karaoke_backend.jobs.worker import _run_one, run_queued_jobs_once
from karaoke_backend.models.song import Job, JobKind, LyricsSet, Song
from karaoke_backend.workers.modal_worker import StemSeparationError


async def _seed_job(job_id: str, **overrides) -> None:
    values = dict(
        id=job_id,
        kind=JobKind.INGEST.value,
        status="queued",
        phase="queued",
        progress=0,
        owner_id=1,
        payload=json.dumps({}),
        attempts=0,
    )
    values.update(overrides)
    async with AsyncSessionLocal() as db:
        db.add(Job(**values))
        await db.commit()


async def _get(job_id: str) -> Job:
    async with AsyncSessionLocal() as db:
        job = await db.get(Job, job_id)
        assert job is not None
        return job


# ---------------------------------------------------------------------------
# Claim
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_only_one_claimer_wins_the_same_job():
    """The whole safety argument rests on this being one atomic statement.

    Two workers reaching for the last queued row must not both get it — that is
    two demucs runs on one GPU, and two writers on one job row.
    """
    await _seed_job("contended")

    a, b = await asyncio.gather(
        queue.claim_next("worker-a"), queue.claim_next("worker-b")
    )
    winners = [job for job in (a, b) if job is not None]

    assert len(winners) == 1
    claimed = await _get("contended")
    assert claimed.status == "running"
    assert claimed.claimed_by == winners[0].claimed_by
    assert claimed.claimed_by in ("worker-a", "worker-b")


@pytest.mark.asyncio
async def test_claim_takes_the_oldest_queued_job_and_counts_the_attempt():
    old = datetime.now(timezone.utc) - timedelta(hours=1)
    await _seed_job("newer")
    await _seed_job("older", created_at=old)

    job = await queue.claim_next("worker-a")

    assert job.id == "older"
    assert job.attempts == 1, "the claim is what consumes an attempt"
    assert job.started_at is not None
    assert job.lease_expires_at is not None
    assert (await _get("newer")).status == "queued"


@pytest.mark.asyncio
async def test_claim_returns_none_when_nothing_is_queued():
    await _seed_job("busy", status="running", claimed_by="someone")
    assert await queue.claim_next("worker-a") is None


# ---------------------------------------------------------------------------
# Lease
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_heartbeat_extends_the_lease_of_the_worker_that_holds_it():
    stale = datetime.now(timezone.utc) - timedelta(seconds=5)
    await _seed_job(
        "leased", status="running", claimed_by="worker-a", lease_expires_at=stale
    )

    assert await queue.heartbeat("leased", "worker-a") is True

    refreshed = (await _get("leased")).lease_expires_at
    assert refreshed.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_heartbeat_is_refused_once_the_claim_has_moved_on():
    """A stalled worker must not be able to take a lease back by renewing it."""
    await _seed_job("stolen", status="running", claimed_by="worker-b")

    assert await queue.heartbeat("stolen", "worker-a") is False


@pytest.mark.asyncio
async def test_heartbeat_is_refused_on_a_terminal_job():
    await _seed_job("finished", status="done", claimed_by="worker-a")

    assert await queue.heartbeat("finished", "worker-a") is False


# ---------------------------------------------------------------------------
# Guarded progress writes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_progress_from_a_stale_worker_is_rejected():
    await _seed_job(
        "reclaimed", status="running", claimed_by="worker-b", message="worker-b is here"
    )

    assert await queue.update_progress(
        "reclaimed", "worker-a", message="worker-a is confused", progress=99
    ) is False

    job = await _get("reclaimed")
    assert job.message == "worker-b is here"
    assert job.progress == 0


@pytest.mark.asyncio
async def test_progress_is_rejected_once_the_job_is_terminal():
    await _seed_job(
        "already-done", status="done", claimed_by="worker-a", message="Ingest complete"
    )

    assert await queue.update_progress(
        "already-done", "worker-a", message="late callback"
    ) is False
    assert (await _get("already-done")).message == "Ingest complete"


@pytest.mark.asyncio
async def test_finish_leaves_a_provider_written_terminal_state_alone():
    """The catalog-import contract: providers own their row, end to end.

    They are out-of-tree code and the protocol is not ours to change, so the
    worker's job is to notice they finished — and to normalize `phase`, which
    a provider that predates the queue never writes.
    """
    await _seed_job(
        "provider-owned",
        kind=JobKind.CATALOG_IMPORT.value,
        status="done",
        phase="queued",
        progress=100,
        claimed_by="worker-a",
        message="fake import done",
    )

    await queue.finish("provider-owned", "worker-a")

    job = await _get("provider-owned")
    assert job.status == "done"
    assert job.message == "fake import done"
    assert job.phase == "done"
    assert job.finished_at is not None


@pytest.mark.asyncio
async def test_a_failed_ingest_drags_its_song_down_with_it():
    async with AsyncSessionLocal() as db:
        song = Song(
            artist="A", title="B", filename="c.wav", status="processing", owner_id=1
        )
        db.add(song)
        await db.commit()
        song_id = song.id

    await _seed_job(
        "ingest-fail", status="running", claimed_by="worker-a", song_id=song_id
    )
    await queue.finish(
        "ingest-fail", "worker-a",
        failed=True, message="Stem separation failed", error="boom",
        mirror_song_status=True,
    )

    job = await _get("ingest-fail")
    assert (job.status, job.phase, job.error_message) == ("failed", "failed", "boom")
    async with AsyncSessionLocal() as db:
        assert (await db.get(Song, song_id)).status == "failed"


@pytest.mark.asyncio
async def test_a_failed_retranscribe_leaves_the_song_in_the_library():
    """Pre-queue semantics, preserved: re-transcription is not the song's life."""
    async with AsyncSessionLocal() as db:
        song = Song(
            artist="A", title="B", filename="c.wav", status="ready", owner_id=1
        )
        db.add(song)
        await db.commit()
        song_id = song.id

    await _seed_job(
        "retry-fail",
        kind=JobKind.RETRANSCRIBE.value,
        status="running",
        claimed_by="worker-a",
        song_id=song_id,
    )
    await queue.finish(
        "retry-fail", "worker-a",
        failed=True, message="Re-transcription failed", error="boom",
        mirror_song_status=False,
    )

    async with AsyncSessionLocal() as db:
        assert (await db.get(Song, song_id)).status == "ready"


# ---------------------------------------------------------------------------
# Env knobs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_knobs_are_read_at_call_time(monkeypatch: pytest.MonkeyPatch):
    """Import-time reads would make every one of these need a restart."""
    assert (queue.concurrency(), queue.max_attempts()) == (1, 2)
    assert (queue.lease_seconds(), queue.poll_seconds()) == (180.0, 2.0)

    monkeypatch.setenv("KARAOKE_JOB_CONCURRENCY", "3")
    monkeypatch.setenv("KARAOKE_JOB_LEASE_SECONDS", "45")
    monkeypatch.setenv("KARAOKE_JOB_MAX_ATTEMPTS", "5")
    monkeypatch.setenv("KARAOKE_JOB_POLL_SECONDS", "0.25")

    assert queue.concurrency() == 3
    assert queue.lease_seconds() == 45.0
    assert queue.max_attempts() == 5
    assert queue.poll_seconds() == 0.25

    monkeypatch.setenv("KARAOKE_JOB_CONCURRENCY", "not-a-number")
    assert queue.concurrency() == 1, "a garbage knob falls back, it does not crash"

    # The idle loop's only brake. Zero would turn the worker into a spin on
    # claim_next against the same SQLite file the request path is using, so
    # it is refused in favour of the default rather than honoured.
    monkeypatch.setenv("KARAOKE_JOB_POLL_SECONDS", "0")
    assert queue.poll_seconds() == 2.0
    monkeypatch.setenv("KARAOKE_JOB_POLL_SECONDS", "0.05")
    assert queue.poll_seconds() == 0.05, "the floor itself must still be settable"


# ---------------------------------------------------------------------------
# Ingest phase resume
# ---------------------------------------------------------------------------


CANNED_WORD_DATA = {
    "segments": [],
    "lines": [],
    "metadata": {"ref_mode": "none", "method": "whisper-only"},
}


async def _ingest_fixture(tmp_path_unused=None) -> tuple[JobContext, Path, Path]:
    """A claimed ingest job with an upload on disk and an empty stems dir."""
    async with AsyncSessionLocal() as db:
        song = Song(
            artist="A", title="B", filename="c.wav", status="processing", owner_id=1
        )
        db.add(song)
        await db.commit()
        song_id = song.id

    job_id = f"ingest-{song_id}"
    upload = Path(os.environ["UPLOADS_DIR"]) / f"{job_id}_c.wav"
    upload.write_bytes(b"audio")
    # STEMS_DIR is shared for the whole session while song ids restart at 1 per
    # test, so an earlier test's artifacts would silently satisfy this one's
    # resume check. Start every ingest from a genuinely empty directory.
    stems_dir = Path(os.environ["STEMS_DIR"]) / str(song_id)
    shutil.rmtree(stems_dir, ignore_errors=True)

    await _seed_job(
        job_id,
        status="running",
        phase="separating",
        claimed_by="worker-a",
        song_id=song_id,
        attempts=1,
    )
    ctx = JobContext(
        job_id=job_id,
        kind=JobKind.INGEST.value,
        worker_id="worker-a",
        owner_id=1,
        song_id=song_id,
        attempts=1,
        payload={
            "upload_path": upload.name,
            "artist": "A",
            "title": "B",
            "pasted_lyrics": None,
            "llm_correction": False,
            "llm_paging": False,
        },
    )
    return ctx, upload, stems_dir


def _write_stems(stems_dir: Path, *, marker: bool = True) -> None:
    """Simulate a separation run. ``marker=False`` is the killed-mid-mix case."""
    stems_dir.mkdir(parents=True, exist_ok=True)
    for name in ("lead_vocals.wav", "instrumental.wav", "karaoke.wav"):
        (stems_dir / name).write_bytes(b"stem")
    if marker:
        (stems_dir / SEPARATION_MARKER).write_text("{}")


@pytest.mark.asyncio
async def test_ingest_skips_separation_when_the_marker_is_present():
    """The phase-1 checkpoint. A requeued job must not redo fifteen minutes."""
    ctx, upload, stems_dir = await _ingest_fixture()
    _write_stems(stems_dir)

    separate = AsyncMock()
    gws = AsyncMock(return_value=CANNED_WORD_DATA)
    with patch("karaoke_backend.jobs.ingest.separate_stems", new=separate), patch(
        "karaoke_backend.jobs.ingest.generate_word_sync", new=gws
    ):
        assert await run_ingest(ctx) == "Ingest complete"

    separate.assert_not_called()
    assert gws.called
    # song_id is the whole transcription-phase checkpoint: it is what writes the
    # transcription cache, and what makes a later attempt align-only.
    assert gws.call_args.kwargs["song_id"] == ctx.song_id


@pytest.mark.asyncio
async def test_ingest_separates_when_a_stem_is_missing():
    """Two of three artifacts is a half-finished separation, not a checkpoint."""
    ctx, upload, stems_dir = await _ingest_fixture()
    stems_dir.mkdir(parents=True, exist_ok=True)
    (stems_dir / "lead_vocals.wav").write_bytes(b"stem")

    async def fake_separate(**kwargs):
        _write_stems(stems_dir, marker=False)

    separate = AsyncMock(side_effect=fake_separate)
    gws = AsyncMock(return_value=CANNED_WORD_DATA)
    with patch("karaoke_backend.jobs.ingest.separate_stems", new=separate), patch(
        "karaoke_backend.jobs.ingest.generate_word_sync", new=gws
    ):
        await run_ingest(ctx)

    separate.assert_called_once()


@pytest.mark.asyncio
async def test_all_three_stems_without_a_marker_is_a_crashed_mix_not_a_checkpoint():
    """The regression for the resume-on-truncated-stems hazard.

    ``modal_worker`` writes the three stems non-atomically — lead_vocals by
    copy, then instrumental, then karaoke, each straight to its final name. A
    process killed during the karaoke mix leaves all three NAMES present with
    the last one truncated. Existence alone cannot tell that apart from a
    clean run, so a resume keyed on the filenames would publish corrupt stems
    and delete the upload that was the only way to redo them.
    """
    ctx, upload, stems_dir = await _ingest_fixture()
    _write_stems(stems_dir, marker=False)
    assert not separation_is_complete(stems_dir)

    upload_present_during_separation: list[bool] = []

    async def fake_separate(**kwargs):
        upload_present_during_separation.append(upload.exists())
        _write_stems(stems_dir, marker=False)

    separate = AsyncMock(side_effect=fake_separate)
    with patch("karaoke_backend.jobs.ingest.separate_stems", new=separate), patch(
        "karaoke_backend.jobs.ingest.generate_word_sync",
        new=AsyncMock(return_value=CANNED_WORD_DATA),
    ):
        await run_ingest(ctx)

    separate.assert_called_once()
    assert upload_present_during_separation == [True], (
        "the upload must still be there for the re-run that needs it"
    )
    assert separation_is_complete(stems_dir), "a clean run must leave the marker"


@pytest.mark.asyncio
async def test_the_marker_is_written_atomically_and_names_the_artifacts():
    ctx, upload, stems_dir = await _ingest_fixture()

    async def fake_separate(**kwargs):
        _write_stems(stems_dir, marker=False)

    with patch(
        "karaoke_backend.jobs.ingest.separate_stems", new=AsyncMock(side_effect=fake_separate)
    ), patch(
        "karaoke_backend.jobs.ingest.generate_word_sync",
        new=AsyncMock(return_value=CANNED_WORD_DATA),
    ):
        await run_ingest(ctx)

    marker = stems_dir / SEPARATION_MARKER
    assert json.loads(marker.read_text())["artifacts"] == [
        "lead_vocals.wav", "instrumental.wav", "karaoke.wav",
    ]
    assert not (stems_dir / f"{SEPARATION_MARKER}.tmp").exists(), (
        "the temp file must be renamed, never left beside the marker"
    )


@pytest.mark.asyncio
async def test_a_crash_during_the_mix_leaves_no_marker_and_keeps_the_upload():
    """The other side of the same coin: an interrupted mix is not a checkpoint."""
    ctx, upload, stems_dir = await _ingest_fixture()

    async def die_mid_mix(**kwargs):
        # Exactly what a killed ffmpeg leaves behind: every name present.
        _write_stems(stems_dir, marker=False)
        raise asyncio.CancelledError()

    with patch(
        "karaoke_backend.jobs.ingest.separate_stems", new=AsyncMock(side_effect=die_mid_mix)
    ):
        with pytest.raises(asyncio.CancelledError):
            await run_ingest(ctx)

    assert not separation_is_complete(stems_dir)
    assert upload.exists()


@pytest.mark.asyncio
async def test_a_cached_transcription_makes_the_pipeline_align_only(tmp_path: Path):
    """The other half of transcription-phase resume, at the layer that implements it.

    ``generate_word_sync`` given a ``song_id`` finds the cache and calls
    ``align_only`` instead of transcribing — seconds instead of a GPU minute.
    """
    from karaoke_backend.workers import transcription_cache, word_sync_worker

    vocals = tmp_path / "lead_vocals.wav"
    vocals.write_bytes(b"audio")

    cache_file = transcription_cache.cache_path(4242, "heart-vad")
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps({"segments": [], "language": "en", "full_text": ""}))

    class _Pipeline:
        def __init__(self):
            self.aligned = False
            self.transcribed = False

            class _T:
                def transcribe(inner_self, *a, **k):  # noqa: N805
                    self.transcribed = True
                    raise AssertionError("cache hit must not transcribe")

            self.transcriber = _T()

        def align_only(self, **kwargs):
            self.aligned = True
            return None  # enough: the call is what is being pinned

    pipeline = _Pipeline()
    with patch.object(word_sync_worker, "_make_pipeline", return_value=pipeline):
        word_sync_worker._run_blocking(
            vocals_path=str(vocals),
            artist="A",
            title="B",
            plain_lyrics=None,
            synced_lyrics=None,
            whisper_model="heart",
            language=None,
            use_vad=True,
            song_id=4242,
            pipeline_config=None,
        )

    assert pipeline.aligned is True
    assert pipeline.transcribed is False


@pytest.mark.asyncio
async def test_force_transcribe_bypasses_the_cache_but_still_rewrites_it(tmp_path: Path):
    """The other side of the cache: the manual re-transcribe must actually run.

    Ingest always leaves a cache entry behind, so a re-transcribe with unchanged
    settings would hit that entry and replay the old run — the action would be a
    no-op and the temperature rescue ladder it exists to trigger would never
    execute. ``force_transcribe`` skips the READ only; the write still lands so a
    later realign works off the newest transcription, not the stale one.
    """
    from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

    from karaoke_backend.workers import transcription_cache, word_sync_worker

    vocals = tmp_path / "lead_vocals.wav"
    vocals.write_bytes(b"audio")

    cache_file = transcription_cache.cache_path(4343, "heart-vad")
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(
        json.dumps({"segments": [], "language": "en", "full_text": "stale"})
    )

    fresh = TranscriptionResult(
        segments=[
            TranscriptionSegment(
                start=0.0, end=1.0, text="fresh",
                words=[TimedWord(text="fresh", start=0.0, end=1.0)],
            )
        ],
        language="en",
        full_text="fresh",
    )

    class _Pipeline:
        def __init__(self):
            self.aligned_with = None
            self.transcribed = False

            class _T:
                def transcribe(inner_self, *a, **k):  # noqa: N805
                    self.transcribed = True
                    return fresh

            self.transcriber = _T()

        def align_only(self, **kwargs):
            self.aligned_with = kwargs["whisper_result"]
            return None  # enough: the call is what is being pinned

    pipeline = _Pipeline()
    with patch.object(word_sync_worker, "_make_pipeline", return_value=pipeline):
        word_sync_worker._run_blocking(
            vocals_path=str(vocals),
            artist="A",
            title="B",
            plain_lyrics=None,
            synced_lyrics=None,
            whisper_model="heart",
            language=None,
            use_vad=True,
            song_id=4343,
            pipeline_config=None,
            force_transcribe=True,
        )

    assert pipeline.transcribed is True
    assert pipeline.aligned_with is fresh
    assert json.loads(cache_file.read_text())["full_text"] == "fresh"


def _forced_transcribe(song_id: int, *, cache_write_guard, tmp_path: Path) -> Path:
    """Force a transcription over an existing cache entry; return the cache file.

    The entry on disk says "stale", the transcriber returns "fresh" — so which
    one survives is exactly the question the guard answers.
    """
    from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

    from karaoke_backend.workers import transcription_cache, word_sync_worker

    vocals = tmp_path / "lead_vocals.wav"
    vocals.write_bytes(b"audio")

    cache_file = transcription_cache.cache_path(song_id, "heart-vad")
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(
        json.dumps({"segments": [], "language": "en", "full_text": "stale"})
    )

    fresh = TranscriptionResult(
        segments=[
            TranscriptionSegment(
                start=0.0, end=1.0, text="fresh",
                words=[TimedWord(text="fresh", start=0.0, end=1.0)],
            )
        ],
        language="en",
        full_text="fresh",
    )

    class _Pipeline:
        def __init__(self):
            class _T:
                def transcribe(inner_self, *a, **k):  # noqa: N805
                    return fresh

            self.transcriber = _T()

        def align_only(self, **kwargs):
            return None  # enough: the cache write is what is being pinned

    with patch.object(word_sync_worker, "_make_pipeline", return_value=_Pipeline()):
        word_sync_worker._run_blocking(
            vocals_path=str(vocals),
            artist="A",
            title="B",
            plain_lyrics=None,
            synced_lyrics=None,
            whisper_model="heart",
            language=None,
            use_vad=True,
            song_id=song_id,
            pipeline_config=None,
            force_transcribe=True,
            cache_write_guard=cache_write_guard,
        )
    return cache_file


def test_a_worker_that_lost_its_claim_does_not_overwrite_the_cache(tmp_path: Path):
    """`force_transcribe` made the cache write reachable on a path that used to
    always hit the cache, so it needs the claim re-check the DB write has.

    Without it, a worker whose lease lapsed mid-transcription wakes up and
    publishes a transcription no lyrics set corresponds to — and the next
    /realign aligns against it.
    """
    cache_file = _forced_transcribe(
        4444, cache_write_guard=lambda: False, tmp_path=tmp_path
    )
    assert json.loads(cache_file.read_text())["full_text"] == "stale"


def test_a_guard_that_raises_declines_the_write_rather_than_killing_the_run(
    tmp_path: Path,
):
    """The guard hops to the event loop from a worker thread — it can time out
    or find the DB gone. That must skip the write, not take down a 30 s GPU run.
    """

    def boom() -> bool:
        raise RuntimeError("the loop is gone")

    cache_file = _forced_transcribe(4445, cache_write_guard=boom, tmp_path=tmp_path)
    assert json.loads(cache_file.read_text())["full_text"] == "stale"


def test_with_no_guard_supplied_the_cache_write_still_happens(tmp_path: Path):
    """Ingest passes no guard and must be completely unaffected."""
    cache_file = _forced_transcribe(4446, cache_write_guard=None, tmp_path=tmp_path)
    assert json.loads(cache_file.read_text())["full_text"] == "fresh"


def test_two_saves_of_one_song_do_not_share_a_temp_file(tmp_path: Path):
    """A fixed ``.tmp`` name was safe only while every write came from a cache
    MISS. Forced re-transcription means two runs for one song can overlap, and
    a shared temp file publishes half of each — which `load` swallows as a miss.

    Deterministic, not a timing race: the second save is started from inside the
    first one's write.
    """
    from lyricsync._types import TranscriptionResult

    from karaoke_backend.workers import transcription_cache

    path = tmp_path / "transcription.heart-vad.json"
    first = TranscriptionResult(segments=[], language="en", full_text="first")
    second = TranscriptionResult(segments=[], language="en", full_text="second")

    tmp_names: list[str] = []
    real_mkstemp = transcription_cache.tempfile.mkstemp
    real_dump = transcription_cache.json.dump

    def recording_mkstemp(**kwargs):
        fd, name = real_mkstemp(**kwargs)
        tmp_names.append(name)
        return fd, name

    def interleaving_dump(payload, fp, *args, **kwargs):
        if len(tmp_names) == 1:
            transcription_cache.save(path, second)
        return real_dump(payload, fp, *args, **kwargs)

    with patch.object(
        transcription_cache.tempfile, "mkstemp", new=recording_mkstemp
    ), patch.object(transcription_cache.json, "dump", new=interleaving_dump):
        transcription_cache.save(path, first)

    assert len(tmp_names) == 2, "both saves must have staged a file"
    assert len(set(tmp_names)) == 2, "and it must not be the same file"
    # Last publisher wins, whole — no interleaved bytes, no unreadable cache.
    assert json.loads(path.read_text())["full_text"] == "first"
    assert list(tmp_path.glob("*.tmp")) == [], "temp files must not survive"


@pytest.mark.asyncio
async def test_a_manual_retranscribe_takes_the_rescue_path():
    """Only the manual action re-arms the temperature ladder and forces a run."""
    from karaoke_backend.jobs.transcribe import run_retranscribe

    async with AsyncSessionLocal() as db:
        song = Song(
            artist="A", title="B", filename="c.wav", status="ready", owner_id=1
        )
        db.add(song)
        await db.commit()
        song_id = song.id

    job_id = f"retranscribe-{song_id}"
    await _seed_job(
        job_id,
        kind=JobKind.RETRANSCRIBE.value,
        status="running",
        phase="transcribing",
        claimed_by="worker-a",
        song_id=song_id,
        attempts=1,
    )
    ctx = JobContext(
        job_id=job_id,
        kind=JobKind.RETRANSCRIBE.value,
        worker_id="worker-a",
        owner_id=1,
        song_id=song_id,
        attempts=1,
        payload={
            "whisper_model": "heart",
            "use_vad": True,
            "vocals_path": "/nonexistent/lead_vocals.wav",
            "artist": "A",
            "title": "B",
        },
    )

    gws = AsyncMock(return_value=CANNED_WORD_DATA)
    with patch("karaoke_backend.jobs.transcribe.generate_word_sync", new=gws):
        summary = await run_retranscribe(ctx)

    assert gws.call_args.kwargs["allow_temperature_fallback"] is True
    assert gws.call_args.kwargs["force_transcribe"] is True
    # …and the set it saves says so, or a rescue result is indistinguishable
    # from an ingest-produced one in the picker.
    assert summary == "Saved as 'heart-vad-rescue'"
    # The write is guarded the same way the DB write is (see the guard tests).
    assert gws.call_args.kwargs["cache_write_guard"] is not None


@pytest.mark.asyncio
async def test_ingest_transcribes_deterministically_off_the_cache():
    """The inverse pin: the first pass inherits both defaults, never the ladder."""
    ctx, upload, stems_dir = await _ingest_fixture()
    _write_stems(stems_dir)

    separate = AsyncMock()
    gws = AsyncMock(return_value=CANNED_WORD_DATA)
    with patch("karaoke_backend.jobs.ingest.separate_stems", new=separate), patch(
        "karaoke_backend.jobs.ingest.generate_word_sync", new=gws
    ):
        await run_ingest(ctx)

    assert gws.called
    # The EFFECTIVE value, not the absence of the kwarg: passing either one
    # explicitly as False is the same behaviour, and a refactor that did so
    # should not read as a regression.
    kwargs = gws.call_args.kwargs
    assert kwargs.get("allow_temperature_fallback", False) is False
    assert kwargs.get("force_transcribe", False) is False


# ---------------------------------------------------------------------------
# Upload lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_upload_is_released_as_soon_as_separation_succeeds():
    ctx, upload, stems_dir = await _ingest_fixture()

    async def fake_separate(**kwargs):
        _write_stems(stems_dir)
        assert upload.exists(), "separation must still have its input"

    with patch(
        "karaoke_backend.jobs.ingest.separate_stems", new=AsyncMock(side_effect=fake_separate)
    ), patch(
        "karaoke_backend.jobs.ingest.generate_word_sync",
        new=AsyncMock(return_value=CANNED_WORD_DATA),
    ):
        await run_ingest(ctx)

    assert not upload.exists(), "the stems are the artifact now"


@pytest.mark.asyncio
async def test_the_upload_survives_an_interrupted_run_so_the_retry_can_use_it():
    """The blanket ``finally`` this replaces made phase 1 unretryable.

    A process killed mid-separation leaves the row `running`; the lease lapses,
    the sweep requeues it — and the retry needs the file the old code had
    already deleted on its way out.
    """
    ctx, upload, stems_dir = await _ingest_fixture()

    async def die(**kwargs):
        raise asyncio.CancelledError()

    with patch(
        "karaoke_backend.jobs.ingest.separate_stems", new=AsyncMock(side_effect=die)
    ):
        with pytest.raises(asyncio.CancelledError):
            await run_ingest(ctx)

    assert upload.exists()


@pytest.mark.asyncio
async def test_the_upload_is_retained_on_permanent_failure_for_the_retry():
    """A terminal failure is exactly when the file is still needed.

    ``POST /api/songs/{id}/retry`` replays this job, and phase 1 has nothing to
    separate without the upload. Releasing it here — which this handler used to
    do — made every failure BEFORE the separation marker unretryable, which is
    the whole class the retry route exists to rescue. The file is reclaimed
    when the SONG is deleted, not when its ingest fails.
    """
    ctx, upload, stems_dir = await _ingest_fixture()

    async def boom(**kwargs):
        raise StemSeparationError("gpu said no")

    with patch(
        "karaoke_backend.jobs.ingest.separate_stems", new=AsyncMock(side_effect=boom)
    ), patch("karaoke_backend.jobs.ingest.asyncio.sleep", new=AsyncMock()):
        with pytest.raises(JobFailure) as exc:
            await run_ingest(ctx)

    assert "Stem separation failed" in exc.value.message
    assert upload.exists(), "the retry replays this job and needs its input"


@pytest.mark.asyncio
async def test_a_requeued_ingest_whose_upload_is_gone_fails_legibly():
    """Better than a FileNotFoundError traceback the operator has to decode."""
    ctx, upload, stems_dir = await _ingest_fixture()
    upload.unlink()

    with pytest.raises(JobFailure) as exc:
        await run_ingest(ctx)
    assert "re-upload" in exc.value.message.lower()


# ---------------------------------------------------------------------------
# End to end through the worker
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_drain_helper_runs_a_queued_ingest_to_done():
    async with AsyncSessionLocal() as db:
        song = Song(
            artist="A", title="B", filename="c.wav", status="processing", owner_id=1
        )
        db.add(song)
        await db.commit()
        song_id = song.id

    upload = Path(os.environ["UPLOADS_DIR"]) / "e2e_c.wav"
    upload.write_bytes(b"audio")
    stems_dir = Path(os.environ["STEMS_DIR"]) / str(song_id)
    _write_stems(stems_dir)

    async with AsyncSessionLocal() as db:
        queue.enqueue(
            db,
            kind=JobKind.INGEST.value,
            job_id="e2e",
            song_id=song_id,
            owner_id=1,
            payload={
                "upload_path": upload.name,
                "artist": "A",
                "title": "B",
                "pasted_lyrics": None,
                "llm_correction": False,
                "llm_paging": False,
            },
        )
        await db.commit()

    with patch(
        "karaoke_backend.jobs.ingest.generate_word_sync",
        new=AsyncMock(return_value=CANNED_WORD_DATA),
    ):
        assert await run_queued_jobs_once() == 1

    job = await _get("e2e")
    assert (job.status, job.phase, job.progress) == ("done", "done", 100)
    assert job.message == "Ingest complete"
    assert job.claimed_by is None and job.finished_at is not None
    assert json.loads(job.stems)["lead_vocals"].endswith("lead_vocals.wav")

    async with AsyncSessionLocal() as db:
        assert (await db.get(Song, song_id)).status == "ready"
        sets = (await db.execute(LyricsSet.__table__.select())).all()
        assert len(sets) == 1


@pytest.mark.asyncio
async def test_the_worker_loop_claims_runs_and_heartbeats(
    monkeypatch: pytest.MonkeyPatch,
):
    """The production path, not the drain helper.

    The job must OUTLIVE the lease it was claimed under, or the heartbeat is
    not being asked to do anything, and the beats must arrive FASTER than the
    lease expires — that gap, not the total runtime, is the property that
    makes expiry-based requeue safe. `worker._heartbeat` sleeps LEASE/3 to
    achieve it, but nothing here assumes that number: the assertion below
    measures the observed interval against the lease, so it holds for any
    cadence tighter than the lease and fails for any looser one.

    That distinction is not academic. An earlier version of this test asserted
    `finished_at - started_at > lease`, which reads like the same thing and is
    not: it measures the test's own `beats_required x cadence` arithmetic, and
    it is inverted. Tightening the cadence to LEASE/10 — strictly SAFER, more
    renewals per lease — made it fail, complaining the heartbeat "was never
    actually load-bearing", while loosening it to LEASE*3 — every lease lapsing
    between beats, which in production is another worker stealing a live job —
    made it pass. A failure message naming a property the test does not
    measure is worse than no assertion at all.

    No REAL-TIME DURATION is baked in here, and that is the point. The handler
    returns when the heartbeat has really beaten, and the test wakes when
    `finish` has really returned, so a slow machine makes this test slower and
    never redder. (The beat-gap assertion does read a clock — a monotonic one
    — but it compares two observed intervals rather than waiting out a fixed
    one.) It also keeps exactly ONE task doing database
    work at a time, which this suite needs more than it looks: tests run on
    `sqlite+aiosqlite:///:memory:` with a StaticPool, i.e. a single DBAPI
    connection shared by every session. Two tasks using it at once is not a
    lock, it is one transaction — a second session closing mid-`finish` takes
    the terminal UPDATE down with its rollback (the job stays `running`), and
    a task cancelled *inside* a database call invalidates the connection,
    which for `:memory:` silently replaces the whole database with an empty
    one. Both were live flakes here. So: the poll interval parks the claim
    loop once it has claimed, and the heartbeat stands down once the handler
    is done — leaving `finish` and `stop()` a clear field.
    """
    from karaoke_backend.jobs.worker import JobWorker

    lease_seconds = 1
    # 4 beats at the production LEASE/3 cadence puts the run at 4/3 of a lease,
    # so it outlasts its own claim. 4 also yields 3 inter-beat gaps to measure,
    # which is what the cadence assertion needs; 2 beats would give only 1.
    beats_required = 4

    monkeypatch.setenv("KARAOKE_JOB_LEASE_SECONDS", str(lease_seconds))
    # Deliberately far longer than this test: the claim loop takes the job on
    # its first pass and then has nothing left to do (concurrency is 1), so
    # parking it keeps its expiry sweep and its `claim_next` out of the window
    # where `finish` is committing. Shutdown is unaffected — `stop()` cancels
    # the sleep, and cancelling a sleep is safe in a way that cancelling a
    # query is not. The sweep's own behaviour, including that it never touches
    # its own worker's rows, is covered directly in test_ops_hardening.py.
    monkeypatch.setenv("KARAOKE_JOB_POLL_SECONDS", "30")

    beats: list[bool] = []
    renewals: list[datetime] = []
    beat_times: list[float] = []
    beaten = asyncio.Event()
    handler_returned = False
    real_heartbeat = queue.heartbeat

    async def counting_heartbeat(job_id, worker_id):
        if handler_returned:
            # The run is over and the worker cancels this task microseconds
            # from now. A real beat here would race `finish` on the shared
            # connection to prove nothing: every beat asserted on is already
            # recorded, and a beat after the job is terminal is refused anyway.
            # In practice this never fires — `finish` completes well inside one
            # beat interval — so it is a guard for a slow `finish`, not a path
            # the happy case takes.
            return True
        ok = await real_heartbeat(job_id, worker_id)
        # Monotonic, so a clock adjustment mid-run cannot forge a gap.
        beat_times.append(asyncio.get_running_loop().time())
        beats.append(ok)
        async with AsyncSessionLocal() as db:
            renewals.append((await db.get(Job, job_id)).lease_expires_at)
        if len(beats) >= beats_required:
            # Set AFTER the session above has closed. That ordering is
            # load-bearing: the close performs a real rollback on the shared
            # StaticPool connection, and waking the handler any earlier would
            # let `finish` commit while this session was still checked out —
            # which is exactly the flake this test was rewritten to remove.
            beaten.set()
        return ok

    monkeypatch.setattr(queue, "heartbeat", counting_heartbeat)

    finished = asyncio.Event()
    real_finish = queue.finish

    async def signalling_finish(job_id, worker_id, **kwargs):
        await real_finish(job_id, worker_id, **kwargs)
        finished.set()

    monkeypatch.setattr(queue, "finish", signalling_finish)

    async def slow_handler(ctx):
        nonlocal handler_returned
        # Event-driven, not duration-driven: the handler lives exactly as long
        # as it takes this machine to produce `beats_required` real renewals.
        await beaten.wait()
        handler_returned = True
        return "handled"

    monkeypatch.setattr(
        "karaoke_backend.jobs.transcribe.run_retranscribe", slow_handler
    )
    await _seed_job("looped", kind=JobKind.RETRANSCRIBE.value)

    worker = JobWorker("loop-worker")
    await worker.start()
    try:
        # A deadline, not an iteration budget. This needs ~1.3s; a loaded box
        # may take many times that and still be correct, and only a genuinely
        # stuck worker takes 30.
        try:
            await asyncio.wait_for(finished.wait(), timeout=30)
        except asyncio.TimeoutError:  # pragma: no cover - diagnosis path
            pytest.fail(
                f"the job never finished in 30s: {len(beats)}/{beats_required} "
                f"heartbeat(s) landed. A count of 0 means the heartbeat task "
                f"never ran or never renewed — the failure this test exists "
                f"to catch, not a slow machine."
            )
    finally:
        await worker.stop()

    job = await _get("looped")
    assert job.status == "done"
    assert job.message == "handled"
    assert job.attempts == 1, "a mid-flight requeue would show up here"
    assert beats and all(beats), "the lease must be renewed while the job runs"
    assert len(beats) >= beats_required
    # A heartbeat that returned True without moving `lease_expires_at` is a
    # heartbeat that renews nothing — the failure `all(beats)` cannot see,
    # because the claim never moves in a single-worker test. STRICTLY
    # increasing, not merely sorted: a heartbeat that renews on the first and
    # last beat while no-opping in between yields [r, r, r, R], which is sorted
    # and ends higher than it starts, and is still broken.
    assert all(r is not None for r in renewals), (
        "a beat reported success but left lease_expires_at NULL"
    )
    assert all(b > a for a, b in zip(renewals, renewals[1:])), (
        f"every heartbeat must push lease_expires_at further out, got {renewals}"
    )
    # THE cadence invariant, and the reason this test exists: renewals have to
    # arrive faster than the lease expires. A gap wider than the lease means
    # that in production the claim lapsed between beats and another worker's
    # sweep could steal a job that is alive and running.
    #
    # Deliberately measured, not derived: asserting on total runtime instead
    # passes when the cadence is dangerously slow and fails when it is safely
    # fast (see the docstring). This is also the only coverage anywhere in the
    # suite for `worker._heartbeat`'s LEASE/3 interval.
    gaps = [b - a for a, b in zip(beat_times, beat_times[1:])]
    assert gaps, "need at least two beats to measure a cadence"
    assert max(gaps) < lease_seconds, (
        f"heartbeats arrived {max(gaps):.2f}s apart on a {lease_seconds}s "
        f"lease — the claim lapses between beats. All gaps: "
        f"{[round(g, 3) for g in gaps]}"
    )


@pytest.mark.asyncio
async def test_stopping_the_worker_leaves_a_running_job_to_the_lease(
    monkeypatch: pytest.MonkeyPatch,
):
    """Shutdown writes NO job state — the lease is what recovers the row.

    A half-written terminal state is worse than a `running` row: the row is
    reclaimable, the terminal state is a lie nothing will correct.
    """
    from karaoke_backend.jobs.worker import JobWorker

    monkeypatch.setenv("KARAOKE_JOB_POLL_SECONDS", "0.05")
    started = asyncio.Event()

    async def never_finishes(ctx):
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(
        "karaoke_backend.jobs.transcribe.run_retranscribe", never_finishes
    )
    await _seed_job("abandoned", kind=JobKind.RETRANSCRIBE.value)

    worker = JobWorker("shutdown-worker")
    await worker.start()
    await asyncio.wait_for(started.wait(), timeout=5)
    await worker.stop()

    job = await _get("abandoned")
    assert job.status == "running"
    assert job.claimed_by == "shutdown-worker"
    assert job.finished_at is None


# ---------------------------------------------------------------------------
# Lease loss is fail-closed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_stale_ingest_stops_before_it_can_write_songs_or_lyrics_sets():
    """The gap the `claimed_by` predicate cannot cover, closed by control flow.

    `songs` and `lyrics_sets` have no claim column, so nothing at the SQL
    layer would stop a worker whose lease lapsed from adding a second lyrics
    set and flipping the song to `ready` underneath whoever reclaimed the job.
    The refused job-row write has to become an exception, and it has to unwind
    the handler before it reaches those tables.
    """
    ctx, upload, stems_dir = await _ingest_fixture()
    _write_stems(stems_dir)

    # Someone else now holds the job.
    async with AsyncSessionLocal() as db:
        await db.execute(
            Job.__table__.update()
            .where(Job.id == ctx.job_id)
            .values(claimed_by="worker-b")
        )
        await db.commit()

    gws = AsyncMock(return_value=CANNED_WORD_DATA)
    with patch("karaoke_backend.jobs.ingest.generate_word_sync", new=gws):
        with pytest.raises(LeaseLost):
            await run_ingest(ctx)

    gws.assert_not_called(), "the very first phase write should have stopped it"
    async with AsyncSessionLocal() as db:
        assert (await db.execute(LyricsSet.__table__.select())).all() == []
        assert (await db.get(Song, ctx.song_id)).status == "processing"
    assert upload.exists(), "the upload belongs to whoever holds the claim now"


@pytest.mark.asyncio
async def test_losing_the_lease_just_before_the_persist_writes_nothing():
    """The window a long transcription opens, and the check that narrows it."""
    ctx, upload, stems_dir = await _ingest_fixture()
    _write_stems(stems_dir)

    async def steal_then_return(**kwargs):
        # The claim moves while transcription is running — minutes, in reality.
        async with AsyncSessionLocal() as db:
            await db.execute(
                Job.__table__.update()
                .where(Job.id == ctx.job_id)
                .values(claimed_by="worker-b")
            )
            await db.commit()
        return CANNED_WORD_DATA

    with patch(
        "karaoke_backend.jobs.ingest.generate_word_sync",
        new=AsyncMock(side_effect=steal_then_return),
    ):
        with pytest.raises(LeaseLost):
            await run_ingest(ctx)

    async with AsyncSessionLocal() as db:
        assert (await db.execute(LyricsSet.__table__.select())).all() == [], (
            "a stale worker must not add a duplicate lyrics set"
        )
        assert (await db.get(Song, ctx.song_id)).status == "processing"


@pytest.mark.asyncio
async def test_the_worker_abandons_a_lost_job_without_writing_a_terminal_state(
    monkeypatch: pytest.MonkeyPatch,
):
    """`LeaseLost` is not a failure this worker gets to record."""
    await _seed_job(
        "handed-over",
        kind=JobKind.RETRANSCRIBE.value,
        status="running",
        phase="transcribing",
        message="worker-b is running this",
        claimed_by="worker-b",
        attempts=1,
    )

    async def loses_it(ctx):
        raise LeaseLost(ctx.job_id)

    monkeypatch.setattr("karaoke_backend.jobs.transcribe.run_retranscribe", loses_it)

    class _Row:
        id = "handed-over"
        kind = JobKind.RETRANSCRIBE.value
        owner_id = 1
        song_id = None
        attempts = 1
        payload = None

    await _run_one(_Row(), "worker-a")

    job = await _get("handed-over")
    assert job.status == "running", "the row still belongs to worker-b"
    assert job.claimed_by == "worker-b"
    assert job.message == "worker-b is running this"
    assert job.finished_at is None


# ---------------------------------------------------------------------------
# Provider-owned status strings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_provider_status_string_does_not_cost_the_job_its_heartbeat():
    """Shipped providers write "downloading"/"adopting" into `status`.

    That column was their only progress channel before the queue existed. A
    heartbeat keyed on `status == 'running'` would read the first such write
    as "the claim moved on", stop renewing, and hand a healthy import's lease
    away while it was still downloading.
    """
    await _seed_job(
        "importing",
        kind=JobKind.CATALOG_IMPORT.value,
        status="downloading",
        phase="importing",
        claimed_by="worker-a",
        lease_expires_at=datetime.now(timezone.utc) - timedelta(seconds=5),
    )

    assert await queue.heartbeat("importing", "worker-a") is True

    refreshed = (await _get("importing")).lease_expires_at
    assert refreshed.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_a_handler_that_moves_the_status_still_finishes_cleanly():
    """End to end: the worker supplies the terminal state a provider omitted."""
    await _seed_job("mid-status", kind=JobKind.CATALOG_IMPORT.value)

    async def writes_its_own_status(ctx):
        async with AsyncSessionLocal() as db:
            await db.execute(
                Job.__table__.update()
                .where(Job.id == ctx.job_id)
                .values(status="adopting", message="adopting stems")
            )
            await db.commit()
        assert await queue.heartbeat(ctx.job_id, ctx.worker_id) is True
        return None

    with patch(
        "karaoke_backend.jobs.catalog_import.run_catalog_import",
        new=writes_its_own_status,
    ):
        assert await run_queued_jobs_once() == 1

    job = await _get("mid-status")
    assert job.status == "done"
    assert job.phase == "done"
    assert job.claimed_by is None


@pytest.mark.asyncio
async def test_a_job_kind_with_no_handler_fails_rather_than_looping():
    await _seed_job("mystery", kind="not-a-kind")

    assert await run_queued_jobs_once() == 1

    job = await _get("mystery")
    assert job.status == "failed"
    assert "Unknown job kind" in job.message


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled,plain,pasted,expected", [
    (True, "Fetched words", None, "Fetched words"),
    (True, None, None, None),
    (True, "  ", None, None),
    (False, "Fetched words", None, None),
    (True, "Fetched words", "My words", "My words"),
    (False, "Fetched words", "My words", "My words"),
])
async def test_ingest_plain_lookup_alignment(monkeypatch, enabled, plain, pasted, expected):
    from karaoke_backend.workers.lyrics_worker import LyricsResult

    monkeypatch.setenv("KARAOKE_LRCLIB", "1" if enabled else "0")
    ctx, upload, stems_dir = await _ingest_fixture()
    ctx.payload["pasted_lyrics"] = pasted
    _write_stems(stems_dir)
    lookup = AsyncMock(return_value=LyricsResult(
        artist="A", title="B", album=None, duration=None,
        plain_lyrics=plain, synced_lyrics="[00:01.00]Fetched words",
    ))
    gws = AsyncMock(return_value=CANNED_WORD_DATA)
    progress = AsyncMock(return_value=True)
    with patch("karaoke_backend.jobs.ingest.fetch_lyrics", lookup), patch(
        "karaoke_backend.jobs.ingest.generate_word_sync", gws
    ), patch("karaoke_backend.jobs.ingest.queue.update_progress", progress):
        await run_ingest(ctx)
    assert gws.call_args.kwargs["plain_lyrics"] == expected
    assert gws.call_args.kwargs["synced_lyrics"] is None
    assert lookup.await_count == int(enabled and not pasted)
    if enabled and not pasted and not expected:
        assert any("No plain lyrics found" in str(c) for c in progress.call_args_list)
