# SPDX-License-Identifier: AGPL-3.0-only
"""Importing a karaoke video file the operator already has.

Three surfaces, tested together because they only make sense together: the
upload route (`POST /api/import/video`), the job that adopts the file
(`jobs.video_import`), and the streaming route the player reads it back
through (`GET /api/songs/{id}/video`).

**No real media.** Every fixture here is synthetic bytes with a made-up name;
ffprobe and ffmpeg are replaced by a fake that answers from a dict. The one
test that runs the real tools generates its own clip from ffmpeg's synthetic
sources and is skipped when they are not installed — nothing on disk anywhere
in this file came from a recording.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import update

from karaoke_backend.api.separate import STEMS_DIR, UPLOADS_DIR
from karaoke_backend.api.songs import SongSummary, _to_guest_summary
from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs import queue, video_import as video_import_job
from karaoke_backend.jobs.base import JobContext, LeaseLost
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Job, JobKind, JobPhase, JobStatus, Song

HAVE_FFMPEG = (
    shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
)

GATE_PW = "test-gate-pw"

# Not a video by any measure — the route only ever writes these bytes to disk,
# and every test that would decode them fakes the decoder.
FAKE_VIDEO_BYTES = b"\x00\x01\x02\x03" * 64

PROBE_DURATION = 12.5


def test_legacy_audio_symbol_and_completed_flac_with_mp3_default(tmp_path, monkeypatch):
    from karaoke_backend.jobs.video_import import AUDIO_STEM_FILENAME

    monkeypatch.delenv("STEM_FORMAT", raising=False)
    assert video_import_job.stem_format() == "mp3"
    assert AUDIO_STEM_FILENAME == "instrumental.flac"
    (tmp_path / AUDIO_STEM_FILENAME).write_bytes(b"legacy audio")
    assert video_import_job.completed_video_name(tmp_path) is None
    (tmp_path / "video.mp4").write_bytes(FAKE_VIDEO_BYTES)
    assert video_import_job.completed_video_name(tmp_path) == "video.mp4"


@pytest.fixture(autouse=True)
def _isolated_stems():
    """Give every test a clean per-song stems directory.

    ``STEMS_DIR`` is one temp directory for the whole session while song ids
    restart at 1 for every test (conftest drops and recreates the tables), so
    without this a directory left by an earlier test would masquerade as this
    one's output.
    """
    def _wipe() -> None:
        if not STEMS_DIR.exists():
            return
        for child in STEMS_DIR.iterdir():
            if child.is_dir() and child.name.isdigit():
                shutil.rmtree(child, ignore_errors=True)

    _wipe()
    yield
    _wipe()


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _probe_payload(
    *,
    has_audio: bool = True,
    has_video: bool = True,
    attached_pic: bool | None = None,
    duration: float | None = PROBE_DURATION,
) -> str:
    """ffprobe JSON for a synthetic file.

    ``attached_pic`` is the interesting knob: None leaves the disposition out
    entirely (what a plain video stream usually looks like), False writes an
    explicit 0, and True writes the 1 that marks cover art — a still image
    riding along inside an audio file, which ffprobe reports as a video stream
    like any other.
    """
    streams: list[dict] = []
    if has_video:
        video: dict = {"codec_type": "video"}
        if attached_pic is not None:
            video["disposition"] = {"attached_pic": 1 if attached_pic else 0}
        streams.append(video)
    if has_audio:
        streams.append({"codec_type": "audio"})
    fmt: dict = {}
    if duration is not None:
        fmt["duration"] = str(duration)
    return json.dumps({"streams": streams, "format": fmt})


def _install_fake_media_tools(
    monkeypatch: pytest.MonkeyPatch,
    *,
    has_audio: bool = True,
    has_video: bool = True,
    attached_pic: bool | None = None,
    duration: float | None = PROBE_DURATION,
    ffmpeg_returncode: int = 0,
    missing_tool: str | None = None,
) -> list[list[str]]:
    """Replace ffprobe/ffmpeg with a dict-answering fake; return the calls.

    Patched at the ``subprocess.run`` seam the job actually uses (the house
    pattern from ``test_ops_hardening``), so the ``asyncio.to_thread`` hop and
    the return-code handling around it are exercised for real.
    """
    calls: list[list[str]] = []

    def fake_run(cmd, **_kwargs):
        calls.append(list(cmd))
        if missing_tool is not None and cmd[0] == missing_tool:
            raise FileNotFoundError(2, "No such file or directory", cmd[0])
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(
                cmd, 0,
                stdout=_probe_payload(
                    has_audio=has_audio,
                    has_video=has_video,
                    attached_pic=attached_pic,
                    duration=duration,
                ),
                stderr="",
            )
        if ffmpeg_returncode == 0:
            Path(cmd[-1]).write_bytes(b"fake flac bytes")
        return subprocess.CompletedProcess(
            cmd, ffmpeg_returncode, stdout="", stderr="synthetic ffmpeg stderr"
        )

    monkeypatch.setattr(video_import_job.subprocess, "run", fake_run)
    return calls


async def _submit(
    client: AsyncClient,
    *,
    filename: str = "video.mp4",
    content_type: str = "video/mp4",
    data: bytes = FAKE_VIDEO_BYTES,
    form: dict | None = None,
):
    if form is None:
        form = {"artist": "Fixture Artist", "title": "Fixture Title"}
    return await client.post(
        "/api/import/video",
        files={"file": (filename, io.BytesIO(data), content_type)},
        data=form,
    )


async def _job(job_id: str) -> Job:
    async with AsyncSessionLocal() as db:
        row = await db.get(Job, job_id)
        assert row is not None
        return row


async def _requeue(job_id: str) -> None:
    """Put a job back on the queue exactly as ``requeue_expired`` leaves it.

    A lease lapses whenever the process holding it dies, and the sweep returns
    the row to ``queued`` with its claim cleared — whatever the handler had
    already done on disk. This is how a finished import gets a second run.
    """
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(
                status=JobStatus.QUEUED.value,
                phase=JobPhase.QUEUED.value,
                claimed_by=None,
                lease_expires_at=None,
                finished_at=None,
                progress=0,
            )
        )
        await db.commit()


async def _song(song_id: int) -> Song:
    async with AsyncSessionLocal() as db:
        row = await db.get(Song, song_id)
        assert row is not None
        return row


async def _seed_video_song(
    *,
    owner_id: int = 1,
    status: str = "ready",
    video_filename: str | None = "video.mp4",
    on_disk: bytes | None = FAKE_VIDEO_BYTES,
) -> int:
    """A song row shaped like a finished video import, with its file on disk."""
    async with AsyncSessionLocal() as db:
        song = Song(
            artist="Fixture Artist",
            title="Fixture Title",
            filename="video.mp4",
            status=status,
            owner_id=owner_id,
            duration=PROBE_DURATION,
            video_filename=video_filename,
        )
        db.add(song)
        await db.flush()
        song_id = song.id
        stems_dir = STEMS_DIR / str(song_id)
        song.stems_path = str(stems_dir)
        await db.commit()

    if on_disk is not None and video_filename:
        stems_dir = STEMS_DIR / str(song_id)
        stems_dir.mkdir(parents=True, exist_ok=True)
        (stems_dir / video_filename).write_bytes(on_disk)
    return song_id


# ---------------------------------------------------------------------------
# The upload route
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_creates_a_processing_song_and_a_queued_job(client: AsyncClient):
    resp = await _submit(client)

    assert resp.status_code == 202
    body = resp.json()
    assert set(body) == {"job_id", "song_id", "status", "status_url", "message"}
    assert body["status"] == "queued"
    assert body["message"] == "File uploaded. Video import queued."
    assert f"/api/jobs/{body['job_id']}" in body["status_url"]

    song = await _song(body["song_id"])
    assert song.status == "processing"
    assert song.filename == "video.mp4"
    assert song.job_id == body["job_id"]
    assert song.video_filename is None, "the column is the job's to write, not the route's"

    job = await _job(body["job_id"])
    assert job.kind == JobKind.VIDEO_IMPORT.value
    assert job.status == "queued"
    assert job.song_id == body["song_id"]

    payload = queue.payload_of(job)
    assert payload["artist"] == "Fixture Artist"
    assert payload["title"] == "Fixture Title"
    # The NAME, never the path — the uploads directory is resolved at run time.
    assert payload["upload_name"] == f"{body['job_id']}_video.mp4"
    assert (UPLOADS_DIR / payload["upload_name"]).read_bytes() == FAKE_VIDEO_BYTES


@pytest.mark.asyncio
async def test_artist_and_title_are_inferred_from_the_filename(client: AsyncClient):
    resp = await _submit(client, filename="Fixture Band - Fixture Song.mkv", form={})

    assert resp.status_code == 202
    song = await _song(resp.json()["song_id"])
    assert (song.artist, song.title) == ("Fixture Band", "Fixture Song")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "filename,content_type",
    [
        ("clip.mp3", "audio/mpeg"),          # a recognized type, wrong family
        ("clip.avi", "application/octet-stream"),  # generic type, wrong container
        ("clip", "application/octet-stream"),      # generic type, no extension
    ],
)
async def test_unsupported_uploads_are_refused_with_415(
    client: AsyncClient, filename: str, content_type: str
):
    resp = await _submit(client, filename=filename, content_type=content_type)

    assert resp.status_code == 415
    detail = resp.json()["detail"]
    assert "MP4, WebM, MOV, or MKV" in detail
    assert "Download" not in detail


@pytest.mark.asyncio
async def test_a_generic_media_type_is_accepted_on_the_extension(client: AsyncClient):
    """Every file picker falls back to octet-stream; the extension decides."""
    resp = await _submit(client, filename="clip.webm", content_type="application/octet-stream")
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_an_oversize_upload_is_refused_and_leaves_no_partial_file(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("MAX_VIDEO_SIZE_MB", "1")
    before = set(UPLOADS_DIR.iterdir())

    resp = await _submit(client, filename="big.mp4", data=b"\x00" * (2 * 1024 * 1024))

    assert resp.status_code == 413
    assert "maximum is 1 MB" in resp.json()["detail"]
    assert set(UPLOADS_DIR.iterdir()) == before, "the partial upload was left behind"

    async with AsyncSessionLocal() as db:
        assert (await db.execute(Song.__table__.select())).first() is None


@pytest.mark.asyncio
async def test_an_oversize_declared_length_is_refused_before_the_body_is_read(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """The one check that can refuse an upload without receiving it.

    The body sent here is a few hundred bytes; only the declared length says
    64 MB. A 413 therefore proves the refusal came from the header, before the
    file was touched — which is the whole point of having the check.
    """
    monkeypatch.setenv("MAX_VIDEO_SIZE_MB", "1")
    before = set(UPLOADS_DIR.iterdir())

    resp = await client.post(
        "/api/import/video",
        files={"file": ("big.mp4", io.BytesIO(FAKE_VIDEO_BYTES), "video/mp4")},
        data={"artist": "Fixture Artist", "title": "Fixture Title"},
        headers={"content-length": str(64 * 1024 * 1024)},
    )

    assert resp.status_code == 413
    assert "maximum is 1 MB" in resp.json()["detail"]
    assert set(UPLOADS_DIR.iterdir()) == before
    async with AsyncSessionLocal() as db:
        assert (await db.execute(Song.__table__.select())).first() is None


@pytest.mark.asyncio
async def test_a_declared_length_at_the_cap_is_accepted(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """The slack exists so multipart framing cannot fail a file AT the cap.

    A file of exactly the cap arrives with a declared length larger than it —
    boundaries, part headers, the artist/title fields. Without the slack the
    header check would refuse a file the chunk cap then accepts.
    """
    monkeypatch.setenv("MAX_VIDEO_SIZE_MB", "1")

    resp = await _submit(client, filename="exact.mp4", data=b"\x00" * (1024 * 1024))

    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_the_route_is_behind_the_gate(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """With a gate password configured, an unlocked session is refused.

    The only posture in which core can show `require_user` does anything:
    without a password every core caller already IS the Host.
    """
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)
    assert (await _submit(client)).status_code == 401

    await client.post("/api/auth/gate", json={"password": GATE_PW})
    assert (await _submit(client)).status_code == 202


@pytest.mark.asyncio
async def test_submit_without_a_file_is_422(client: AsyncClient):
    assert (await client.post("/api/import/video")).status_code == 422


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_job_extracts_audio_retains_the_video_and_readies_the_song(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    calls = _install_fake_media_tools(monkeypatch)

    submitted = (await _submit(client, filename="Fixture Band - Fixture Song.mp4", form={})).json()
    song_id = submitted["song_id"]
    upload_path = UPLOADS_DIR / f"{submitted['job_id']}_Fixture Band - Fixture Song.mp4"
    assert upload_path.is_file()

    assert await run_queued_jobs_once() == 1

    stems_dir = STEMS_DIR / str(song_id)
    assert (stems_dir / "instrumental.mp3").read_bytes() == b"fake flac bytes"
    assert (stems_dir / "video.mp4").read_bytes() == FAKE_VIDEO_BYTES
    # Nothing half-written is left where the atomic moves staged their files.
    assert [p.name for p in stems_dir.iterdir() if p.name.endswith(".tmp")] == []

    song = await _song(song_id)
    assert song.status == "ready"
    assert song.duration == PROBE_DURATION
    assert song.stems_path == str(stems_dir)
    assert song.video_filename == "video.mp4"

    job = await _job(submitted["job_id"])
    assert (job.status, job.phase, job.progress) == ("done", "done", 100)
    assert job.message == "Video import complete"

    assert not upload_path.exists(), "the consumed upload should be released"

    # Default new imports use MP3 at the shared constant bitrate.
    ffmpeg_cmd = next(cmd for cmd in calls if cmd[0] == "ffmpeg")
    assert "-vn" in ffmpeg_cmd
    assert ffmpeg_cmd[ffmpeg_cmd.index("-c:a") + 1] == "libmp3lame"
    assert ffmpeg_cmd[ffmpeg_cmd.index("-b:a") + 1] == "256k"
    assert "-q:a" not in ffmpeg_cmd


@pytest.mark.asyncio
async def test_a_video_with_no_duration_still_imports(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A container that declares no duration is odd, not fatal."""
    _install_fake_media_tools(monkeypatch, duration=None)

    song_id = (await _submit(client)).json()["song_id"]
    assert await run_queued_jobs_once() == 1

    song = await _song(song_id)
    assert song.status == "ready"
    assert song.duration is None


@pytest.mark.asyncio
async def test_a_video_with_no_audio_track_fails_the_song(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    _install_fake_media_tools(monkeypatch, has_audio=False)

    submitted = (await _submit(client)).json()
    assert await run_queued_jobs_once() == 1

    job = await _job(submitted["job_id"])
    assert job.status == "failed"
    assert job.message == "The video file has no audio track."

    # mirrors_song_status: this job IS the song's creation, so a failure that
    # leaves no stems has to take the row with it.
    song = await _song(submitted["song_id"])
    assert song.status == "failed"


@pytest.mark.asyncio
async def test_a_file_with_no_picture_is_refused(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """An audio file in a video container would import as a black screen."""
    _install_fake_media_tools(monkeypatch, has_video=False)

    submitted = (await _submit(client)).json()
    assert await run_queued_jobs_once() == 1

    job = await _job(submitted["job_id"])
    assert job.status == "failed"
    assert job.message == (
        "The file has no picture — import it through the audio upload instead."
    )
    assert "Download" not in job.message
    assert (await _song(submitted["song_id"])).status == "failed"
    # Refused on the probe, so nothing was extracted on the way to finding out.
    assert not (STEMS_DIR / str(submitted["song_id"]) / "instrumental.mp3").exists()


@pytest.mark.asyncio
async def test_embedded_cover_art_does_not_count_as_a_picture(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """Album art probes as a video stream; its disposition is the only tell."""
    _install_fake_media_tools(monkeypatch, attached_pic=True)

    submitted = (await _submit(client)).json()
    assert await run_queued_jobs_once() == 1

    job = await _job(submitted["job_id"])
    assert job.status == "failed"
    assert "no picture" in job.message
    assert (await _song(submitted["song_id"])).status == "failed"


@pytest.mark.asyncio
async def test_a_picture_with_an_explicit_disposition_still_imports(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """`attached_pic: 0` is an ordinary picture — the common case, spelled out."""
    _install_fake_media_tools(monkeypatch, attached_pic=False)

    song_id = (await _submit(client)).json()["song_id"]
    assert await run_queued_jobs_once() == 1

    assert (await _song(song_id)).status == "ready"


@pytest.mark.asyncio
async def test_a_requeued_run_of_a_finished_import_keeps_the_song_ready(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """The crash-in-the-tail case, which used to unmake a finished song.

    The success path releases the upload before the worker writes the job's
    terminal state. A process that dies in that gap leaves a non-terminal row
    whose lease lapses and is requeued; the second attempt finds no upload. Its
    only correct move is to notice both artifacts are on disk and redo the
    persist — anything else fails a song that is complete and playable.
    """
    calls = _install_fake_media_tools(monkeypatch)

    submitted = (await _submit(client)).json()
    song_id, job_id = submitted["song_id"], submitted["job_id"]
    assert await run_queued_jobs_once() == 1
    assert (await _song(song_id)).status == "ready"

    upload_path = UPLOADS_DIR / f"{job_id}_video.mp4"
    assert not upload_path.exists(), "the first run releases the upload"

    await _requeue(job_id)
    assert await run_queued_jobs_once() == 1

    job = await _job(job_id)
    assert (job.status, job.message) == ("done", "Video import complete")

    song = await _song(song_id)
    assert song.status == "ready"
    assert song.duration == PROBE_DURATION
    assert song.video_filename == "video.mp4"
    assert song.stems_path == str(STEMS_DIR / str(song_id))

    # The persist is redone; the expensive half is not.
    assert [cmd[0] for cmd in calls].count("ffmpeg") == 1


@pytest.mark.asyncio
async def test_a_requeued_run_leaves_a_surviving_upload_released(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """The same tail crash, one statement earlier — before the unlink."""
    _install_fake_media_tools(monkeypatch)

    submitted = (await _submit(client)).json()
    song_id, job_id = submitted["song_id"], submitted["job_id"]
    assert await run_queued_jobs_once() == 1

    upload_path = UPLOADS_DIR / f"{job_id}_video.mp4"
    upload_path.write_bytes(FAKE_VIDEO_BYTES)  # as if the unlink never ran

    await _requeue(job_id)
    assert await run_queued_jobs_once() == 1

    assert (await _song(song_id)).status == "ready"
    assert not upload_path.exists()


@pytest.mark.asyncio
async def test_a_half_finished_import_is_not_mistaken_for_a_finished_one(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A stem with no video is not a completed import.

    The persist only ever runs after BOTH artifacts land, so a song in this
    state was never `ready` and there is nothing to protect — the missing
    upload is correctly fatal.
    """
    _install_fake_media_tools(monkeypatch)

    submitted = (await _submit(client)).json()
    song_id = submitted["song_id"]
    stems_dir = STEMS_DIR / str(song_id)
    stems_dir.mkdir(parents=True, exist_ok=True)
    (stems_dir / "instrumental.flac").write_bytes(b"fake flac bytes")

    upload_name = queue.payload_of(await _job(submitted["job_id"]))["upload_name"]
    (UPLOADS_DIR / upload_name).unlink()

    assert await run_queued_jobs_once() == 1

    job = await _job(submitted["job_id"])
    assert job.status == "failed"
    assert "upload the file again" in job.message
    assert (await _song(song_id)).status == "failed"


@pytest.mark.asyncio
async def test_a_stale_temp_file_from_a_crashed_run_is_cleared(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """Multi-gigabyte partials must not accumulate in the stems directory."""
    _install_fake_media_tools(monkeypatch)

    submitted = (await _submit(client)).json()
    song_id = submitted["song_id"]
    stems_dir = STEMS_DIR / str(song_id)
    stems_dir.mkdir(parents=True, exist_ok=True)
    (stems_dir / ".video.mp4.tmp").write_bytes(b"\x00" * 4096)
    (stems_dir / ".instrumental.mp3.tmp").write_bytes(b"\x00" * 4096)

    assert await run_queued_jobs_once() == 1

    assert (await _song(song_id)).status == "ready"
    assert [p.name for p in stems_dir.iterdir() if p.name.endswith(".tmp")] == []


@pytest.mark.asyncio
async def test_a_missing_upload_fails_the_song(client: AsyncClient):
    submitted = (await _submit(client)).json()
    upload_name = queue.payload_of(await _job(submitted["job_id"]))["upload_name"]
    (UPLOADS_DIR / upload_name).unlink()

    assert await run_queued_jobs_once() == 1

    job = await _job(submitted["job_id"])
    assert job.status == "failed"
    assert "upload the file again" in job.message
    assert (await _song(submitted["song_id"])).status == "failed"


@pytest.mark.asyncio
async def test_a_missing_ffmpeg_says_so(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """The one failure an operator can act on gets told to them plainly."""
    _install_fake_media_tools(monkeypatch, missing_tool="ffmpeg")

    submitted = (await _submit(client)).json()
    assert await run_queued_jobs_once() == 1

    job = await _job(submitted["job_id"])
    assert job.status == "failed"
    assert "Install ffmpeg" in job.message
    assert "PATH" in job.message


@pytest.mark.asyncio
async def test_a_failed_extraction_leaves_the_song_failed_and_keeps_the_upload(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """No stem, no video — and the upload still there, because this is
    retryable.

    A bad ffmpeg run is the operator's to fix, and ``POST /api/songs/{id}/retry``
    re-queues this very job. With no completed video on disk the handler has
    nothing to probe or adopt but the upload, so releasing it on the way out of
    a failure turned "fix ffmpeg and try again" into "go and find the file
    again". The disk is reclaimed when the song is deleted.
    """
    _install_fake_media_tools(monkeypatch, ffmpeg_returncode=1)

    submitted = (await _submit(client)).json()
    upload_name = queue.payload_of(await _job(submitted["job_id"]))["upload_name"]
    assert await run_queued_jobs_once() == 1

    job = await _job(submitted["job_id"])
    assert job.status == "failed"
    assert job.message == "The audio track could not be extracted from the video."
    assert (await _song(submitted["song_id"])).status == "failed"

    stems_dir = STEMS_DIR / str(submitted["song_id"])
    assert not (stems_dir / "instrumental.mp3").exists()
    assert not (stems_dir / "video.mp4").exists()

    assert (UPLOADS_DIR / upload_name).is_file()


@pytest.mark.asyncio
async def test_an_unsupported_container_in_a_stored_payload_is_refused(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """The payload is durable — it may predate today's route allowlist."""
    _install_fake_media_tools(monkeypatch)

    stray = UPLOADS_DIR / "stray-job_clip.avi"
    stray.write_bytes(FAKE_VIDEO_BYTES)

    async with AsyncSessionLocal() as db:
        song = Song(
            artist="Fixture Artist", title="Fixture Title",
            filename="clip.avi", status="processing", owner_id=1,
            job_id="stray-job",
        )
        db.add(song)
        await db.flush()
        song_id = song.id
        queue.enqueue(
            db,
            kind=JobKind.VIDEO_IMPORT.value,
            job_id="stray-job",
            song_id=song_id,
            owner_id=1,
            payload={"upload_name": stray.name},
        )
        await db.commit()

    assert await run_queued_jobs_once() == 1

    job = await _job("stray-job")
    assert job.status == "failed"
    assert "MP4, WebM, MOV, or MKV" in job.message
    assert (await _song(song_id)).status == "failed"


@pytest.mark.asyncio
async def test_a_lost_lease_raises_and_writes_nothing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A worker that no longer holds the claim must not touch song or disk."""
    _install_fake_media_tools(monkeypatch)

    submitted = (await _submit(client)).json()
    claimed = await queue.claim_next("worker-holding-the-claim")
    assert claimed is not None

    ctx = JobContext(
        job_id=claimed.id,
        kind=claimed.kind,
        worker_id="worker-that-lost-it",
        owner_id=1,
        song_id=submitted["song_id"],
        payload=queue.payload_of(claimed),
    )
    with pytest.raises(LeaseLost):
        await video_import_job.run_video_import(ctx)

    assert (await _song(submitted["song_id"])).status == "processing"
    assert not (STEMS_DIR / str(submitted["song_id"])).exists()
    # The upload belongs to whoever holds the claim now — it must survive.
    assert (UPLOADS_DIR / queue.payload_of(claimed)["upload_name"]).is_file()


# ---------------------------------------------------------------------------
# The streaming route
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_video_streams_whole_and_by_range(client: AsyncClient):
    song_id = await _seed_video_song()

    whole = await client.get(f"/api/songs/{song_id}/video")
    assert whole.status_code == 200
    assert whole.headers["content-type"] == "video/mp4"
    assert whole.content == FAKE_VIDEO_BYTES
    # Played in place, never handed over as a file.
    assert "content-disposition" not in whole.headers

    sliced = await client.get(
        f"/api/songs/{song_id}/video", headers={"Range": "bytes=0-3"}
    )
    assert sliced.status_code == 206
    assert sliced.content == FAKE_VIDEO_BYTES[:4]
    assert sliced.headers["content-range"] == f"bytes 0-3/{len(FAKE_VIDEO_BYTES)}"


@pytest.mark.asyncio
@pytest.mark.parametrize("extension,media_type", [
    (".webm", "video/webm"),
    (".mov", "video/quicktime"),
    (".mkv", "video/x-matroska"),
])
async def test_each_container_is_served_with_its_own_media_type(
    client: AsyncClient, extension: str, media_type: str
):
    song_id = await _seed_video_song(video_filename=f"video{extension}")
    resp = await client.get(f"/api/songs/{song_id}/video")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == media_type


@pytest.mark.asyncio
async def test_a_song_with_no_video_is_404(client: AsyncClient):
    song_id = await _seed_video_song(video_filename=None)
    assert (await client.get(f"/api/songs/{song_id}/video")).status_code == 404


@pytest.mark.asyncio
async def test_a_recorded_video_missing_from_disk_is_404(client: AsyncClient):
    song_id = await _seed_video_song(on_disk=None)
    assert (await client.get(f"/api/songs/{song_id}/video")).status_code == 404


@pytest.mark.asyncio
async def test_a_traversing_video_filename_is_refused(client: AsyncClient):
    """A corrupt row must not be able to read outside the stems directory."""
    song_id = await _seed_video_song(video_filename="../../etc/passwd", on_disk=None)
    assert (await client.get(f"/api/songs/{song_id}/video")).status_code == 404


@pytest.mark.asyncio
async def test_another_owners_video_is_404_not_403(client: AsyncClient):
    song_id = await _seed_video_song(owner_id=4242)
    resp = await client.get(f"/api/songs/{song_id}/video")
    assert resp.status_code == 404, "a 403 would confirm the id exists"


@pytest.mark.asyncio
async def test_a_song_still_processing_is_409(client: AsyncClient):
    song_id = await _seed_video_song(status="processing")
    assert (await client.get(f"/api/songs/{song_id}/video")).status_code == 409


# ---------------------------------------------------------------------------
# What the DTOs say
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_detail_and_summary_advertise_the_video(client: AsyncClient):
    song_id = await _seed_video_song()

    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["has_video"] is True
    assert detail["video_url"] == f"/api/songs/{song_id}/video"

    row = next(
        s for s in (await client.get("/api/songs")).json()["songs"] if s["id"] == song_id
    )
    assert row["has_video"] is True


@pytest.mark.asyncio
async def test_an_ordinary_song_advertises_no_video(client: AsyncClient):
    song_id = await _seed_video_song(video_filename=None)

    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["has_video"] is False
    assert detail["video_url"] is None


@pytest.mark.asyncio
async def test_the_url_is_withheld_when_the_file_is_not_on_disk(client: AsyncClient):
    """`has_video` says what the row IS; `video_url` says what can be played."""
    song_id = await _seed_video_song(on_disk=None)

    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["has_video"] is True
    assert detail["video_url"] is None


def test_the_guest_projection_withholds_has_video():
    guest = _to_guest_summary(
        SongSummary(
            id=1,
            artist="Artist",
            title="Title",
            filename="video.mp4",
            duration=180.0,
            status="ready",
            created_at="2026-01-01T00:00:00",
            lyrics_synced=False,
            has_video=True,
        )
    )
    assert guest.has_video is False


# ---------------------------------------------------------------------------
# The real tools, when they are here
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
@pytest.mark.parametrize("format", ["mp3", "flac"])
async def test_end_to_end_with_real_ffmpeg(client: AsyncClient, tmp_path: Path, monkeypatch, format):
    """A generated one-second clip, through the whole path, unpatched.

    The clip is ffmpeg's own synthetic test pattern and a sine tone — no
    recording, no third-party media.
    """
    monkeypatch.setenv("STEM_FORMAT", format)
    clip = tmp_path / "generated.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-shortest", str(clip),
        ],
        capture_output=True, check=True, timeout=120,
    )

    submitted = (await _submit(client, data=clip.read_bytes())).json()
    assert await run_queued_jobs_once() == 1

    song = await _song(submitted["song_id"])
    assert song.status == "ready", song.error_message
    assert song.video_filename == "video.mp4"
    assert song.duration is not None and song.duration > 0

    stem = STEMS_DIR / str(submitted["song_id"]) / f"instrumental.{format}"
    assert stem.is_file()

    probed = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,sample_fmt",
            "-of", "csv=p=0", str(stem),
        ],
        capture_output=True, text=True, timeout=120,
    )
    assert probed.stdout.strip() == ("mp3,fltp" if format == "mp3" else "flac,s16")
    audio = await client.get(f"/api/songs/{submitted['song_id']}/stems/{stem.name}")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == ("audio/mpeg" if format == "mp3" else "audio/flac")

    streamed = await client.get(f"/api/songs/{submitted['song_id']}/video")
    assert streamed.status_code == 200
    assert streamed.content == clip.read_bytes()


@pytest.mark.asyncio
@pytest.mark.parametrize("first_format,next_format", [("mp3", "flac"), ("flac", "mp3")])
async def test_retry_changed_format_retires_stale_audio_only_after_success(
    client, monkeypatch, first_format, next_format
):
    _install_fake_media_tools(monkeypatch)
    monkeypatch.setenv("STEM_FORMAT", first_format)
    adopt = video_import_job._adopt_video

    async def fail_adopt(*args):
        raise video_import_job.VideoImportError("synthetic video copy failure")

    monkeypatch.setattr(video_import_job, "_adopt_video", fail_adopt)
    submitted = (await _submit(client)).json()
    song_id, job_id = submitted["song_id"], submitted["job_id"]
    upload_name = queue.payload_of(await _job(job_id))["upload_name"]
    assert await run_queued_jobs_once() == 1
    stems = STEMS_DIR / str(song_id)
    old_audio = stems / f"instrumental.{first_format}"
    assert old_audio.is_file()
    assert not (stems / "video.mp4").exists()
    assert (UPLOADS_DIR / upload_name).is_file()

    # Failed encoding of the new format preserves the earlier audio and input.
    monkeypatch.setenv("STEM_FORMAT", next_format)
    monkeypatch.setattr(video_import_job, "_adopt_video", adopt)
    _install_fake_media_tools(monkeypatch, ffmpeg_returncode=1)
    await _requeue(job_id)
    assert await run_queued_jobs_once() == 1
    assert old_audio.is_file()
    assert (UPLOADS_DIR / upload_name).is_file()

    _install_fake_media_tools(monkeypatch)
    await _requeue(job_id)
    assert await run_queued_jobs_once() == 1
    assert (await _song(song_id)).status == "ready"
    assert not old_audio.exists()
    assert video_import_job.resolve_stem(stems, "instrumental").name == f"instrumental.{next_format}"
    assert not (UPLOADS_DIR / upload_name).exists()


@pytest.mark.asyncio
@pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
@pytest.mark.parametrize("extension,codec,mime", [
    ("m4a", "aac", "audio/mp4"),
    ("webm", "libopus", "audio/webm"),
    ("webm", "libvorbis", "audio/webm"),
])
async def test_retained_audio_streaming_and_completed_retry(
    client, tmp_path, monkeypatch, extension, codec, mime
):
    """Already-produced audio survives crash recovery and remains seekable."""
    source = tmp_path / f"tone.{extension}"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", codec, str(source),
    ], check=True, timeout=30)
    expected = source.read_bytes()
    real_run = subprocess.run
    calls = _install_fake_media_tools(monkeypatch)
    submitted = (await _submit(client)).json()
    song_id, job_id = submitted["song_id"], submitted["job_id"]
    stems = STEMS_DIR / str(song_id)
    stems.mkdir(parents=True, exist_ok=True)
    stem = stems / f"instrumental.{extension}"
    stem.write_bytes(expected)
    (stems / "video.mp4").write_bytes(FAKE_VIDEO_BYTES)
    upload = UPLOADS_DIR / queue.payload_of(await _job(job_id))["upload_name"]
    upload.unlink()
    assert video_import_job.completed_video_name(stems) == "video.mp4"
    assert await run_queued_jobs_once() == 1
    assert (await _song(song_id)).status == "ready"
    assert not any(command[0] == "ffmpeg" for command in calls)
    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["stems"]["instrumental"].endswith(stem.name)
    url = f"/api/songs/{song_id}/stems/{stem.name}"
    audio = await client.get(url)
    assert audio.status_code == 200
    assert audio.headers["content-type"] == mime
    assert audio.content == expected
    partial = await client.get(url, headers={"Range": "bytes=5-19"})
    assert partial.status_code == 206
    assert partial.headers["content-range"] == f"bytes 5-19/{len(expected)}"
    assert partial.content == expected[5:20]
    # Decode the actual HTTP response, ensuring the playback payload is intact.
    returned = tmp_path / f"returned.{extension}"
    returned.write_bytes(audio.content)
    decoded = real_run([
        "ffmpeg", "-v", "error", "-i", str(returned), "-f", "s16le", "pipe:1",
    ], check=True, stdout=subprocess.PIPE, timeout=30).stdout
    assert len(decoded) >= 48000 * 2
