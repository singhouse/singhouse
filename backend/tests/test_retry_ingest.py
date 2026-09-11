# SPDX-License-Identifier: AGPL-3.0-only
"""Retrying a failed song: ``POST /api/songs/{id}/retry``.

A failed song used to be a dead row. The options were chosen in a form that is
gone, and — until retry existed — the file the handler had been given was released on
failure, so "try that again" meant supplying something the operator may no
longer have to hand. The two upload-owning handlers now RETAIN their upload on
a permanent failure and release it when the SONG is deleted, and that is what
makes a failure before separation recoverable at all.

What is worth pinning is not that a job appears. It is:

* the retry replays the ORIGINAL payload, options and all, so a second attempt
  is the same attempt — and says so when it cannot;
* it replays whichever KIND of job produced the song. An upload re-ingests, a
  Plex import re-downloads the track from the operator's server, a video
  import re-adopts its video; retrying all three as an ingest ran the wrong
  handler against a payload it could not read;
* every refusal is synchronous and names the thing to fix, because the whole
  feature is a rescue and a rescue that fails silently a minute later is worse
  than no button;
* the source checks follow each handler's own completion marker rather than
  the upload's existence: past separation the stems ARE the input, and a song
  that failed while transcribing must stay retryable even though its upload is
  long gone.
"""

import io
import json
import os
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.orm import Session as SyncSession

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs import queue
from karaoke_backend.jobs.ingest import write_separation_marker
from karaoke_backend.jobs.video_import import AUDIO_STEM_FILENAME
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Job, JobKind, Song
from karaoke_backend.plex.config import PLEX_URL_ENV
from karaoke_backend.workers.modal_worker import StemSeparationError


WAV = (
    b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    b"\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
)


@pytest.fixture(autouse=True)
def clean_dirs():
    """STEMS_DIR and UPLOADS_DIR outlive the per-test database, so song ids
    restart at 1 over another test's leftovers unless both are swept."""
    for var in ("STEMS_DIR", "UPLOADS_DIR"):
        root = Path(os.environ[var])
        for child in root.iterdir():
            shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()
    yield


async def _upload(client: AsyncClient, **form) -> tuple[int, str]:
    """Upload a file and drain the queued ingest with the pipeline stubbed.

    Leaves a TERMINAL ingest job carrying the real upload payload, an upload
    file on disk, and a song still in `processing` — the state a caller is in
    the moment before something goes wrong.
    """
    data = {"artist": "Test", "title": "Retry"}
    data.update(form)
    with patch("karaoke_backend.jobs.ingest.run_ingest", new=AsyncMock()):
        resp = await client.post(
            "/api/separate",
            files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
            data=data,
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1
    body = resp.json()
    return body["song_id"], body["job_id"]


async def _fail(song_id: int, message: str = "Stem separation failed") -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(Song)
            .where(Song.id == song_id)
            .values(status="failed", error_message=message)
        )
        await db.commit()


async def _failed_song(client: AsyncClient, **form) -> tuple[int, str]:
    song_id, job_id = await _upload(client, **form)
    await _fail(song_id)
    return song_id, job_id


async def _song(song_id: int) -> Song:
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(Song).where(Song.id == song_id))).scalar_one()


async def _queued_ingest_payload(song_id: int) -> dict:
    async with AsyncSessionLocal() as db:
        job = (await db.execute(
            select(Job).where(
                Job.song_id == song_id,
                Job.kind == JobKind.INGEST.value,
                Job.status == "queued",
            )
        )).scalars().one()
    return queue.payload_of(job)


def _upload_file(job_id: str) -> Path:
    root = Path(os.environ["UPLOADS_DIR"])
    matches = [p for p in root.iterdir() if p.name.startswith(f"{job_id}_")]
    assert len(matches) == 1, f"expected one upload for {job_id}, found {matches}"
    return matches[0]


def _stems_dir(song_id: int) -> Path:
    d = Path(os.environ["STEMS_DIR"]) / str(song_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _queued_job(song_id: int) -> Job:
    """The one job this song has waiting, whatever kind it is."""
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(Job).where(Job.song_id == song_id, Job.status == "queued")
        )).scalars().one()


async def _failed_import_song(
    *, kind: str, job_id: str, payload: dict, artist="Imported", title="Import",
) -> int:
    """A song produced by an IMPORTER, and the terminal job that produced it.

    Written straight to the database rather than driven through the importer:
    what these tests are about is the retry route reading a durable payload it
    did not write, which is also the real case — the row outlives the process
    that made it.
    """
    async with AsyncSessionLocal() as db:
        song = Song(
            artist=artist, title=title, filename="source.flac",
            status="failed", error_message="Stem separation failed",
            owner_id=1, job_id=job_id,
        )
        db.add(song)
        await db.flush()
        song_id = song.id
        queue.enqueue(
            db, kind=kind, job_id=job_id, song_id=song_id, owner_id=1,
            payload=payload,
        )
        await db.commit()

    # `enqueue` writes a QUEUED row, and the retry route refuses a song with a
    # job in flight — so drive it terminal the way the worker would have.
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(Job).where(Job.id == job_id)
            .values(status="failed", phase="failed")
        )
        await db.commit()
    return song_id


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_song_that_died_during_separation_is_retryable(client: AsyncClient):
    """The whole retry scenario, with a real ingest failure rather than a poked row.

    This is the failure an operator actually hits — a separation backend that
    is not configured yet, or a GPU that said no — and it used to be the one
    kind of failure the retry button could NOT rescue: the handler released the
    upload on its way out, so the route answered 409 "the audio is gone". The
    three facts that have to hold together are pinned in one test because
    separately they each look fine: the ingest really failed, the upload is
    really still there, and the retry really points back at it.
    """
    resp = await client.post(
        "/api/separate",
        files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
        data={"artist": "Test", "title": "Retry"},
    )
    assert resp.status_code == 202
    song_id, job_id = resp.json()["song_id"], resp.json()["job_id"]

    with patch(
        "karaoke_backend.jobs.ingest.separate_stems",
        new=AsyncMock(side_effect=StemSeparationError("no separation backend")),
    ), patch("karaoke_backend.jobs.ingest.asyncio.sleep", new=AsyncMock()):
        assert await run_queued_jobs_once() == 1

    assert (await _song(song_id)).status == "failed"
    upload = _upload_file(job_id)
    assert upload.is_file(), "the failed ingest must not have taken its input"

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    assert resp.json()["kind"] == "ingest"

    payload = await _queued_ingest_payload(song_id)
    assert payload["upload_path"] == upload.name
    assert upload.is_file()


@pytest.mark.asyncio
async def test_retry_requeues_with_the_original_options(client: AsyncClient):
    """The point of the feature: the options the operator picked in a form
    they no longer have in front of them come back with the job."""
    song_id, first_job_id = await _failed_song(
        client,
        karaoke_model="mdxnet_kara2",
        llm_correction="true",
        llm_paging="true",
        plain_lyrics="pasted reference",
    )

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    body = resp.json()
    assert body["options_recovered"] is True
    assert body["song_id"] == song_id
    assert body["job_id"] != first_job_id

    payload = await _queued_ingest_payload(song_id)
    assert payload["karaoke_model"] == "mdxnet_kara2"
    assert payload["llm_correction"] is True
    assert payload["llm_paging"] is True
    assert payload["pasted_lyrics"] == "pasted reference"
    # The upload on disk is named after the FIRST job, so the retry has to
    # keep pointing at that name — one composed from its own id names nothing.
    assert payload["upload_path"] == _upload_file(first_job_id).name


@pytest.mark.asyncio
async def test_retry_clears_the_error_and_reopens_the_song(client: AsyncClient):
    song_id, _ = await _failed_song(client)

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    new_job_id = resp.json()["job_id"]

    song = await _song(song_id)
    assert song.status == "processing"
    assert song.error_message is None
    # The library row has to follow the job that is live, or the list keeps
    # reporting the failure this retry just replaced.
    assert song.job_id == new_job_id

    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["status"] == "processing"
    assert detail["error_message"] is None


@pytest.mark.asyncio
async def test_retry_after_separation_finished_needs_no_upload(client: AsyncClient):
    """The common real failure: separation succeeded, transcription did not.
    Ingest released the upload on the way past the marker, and resumes off the
    stems — so this must be retryable with no upload anywhere on disk."""
    song_id, job_id = await _failed_song(client)
    _upload_file(job_id).unlink()
    write_separation_marker(_stems_dir(song_id))

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    assert resp.json()["options_recovered"] is True


@pytest.mark.asyncio
async def test_retry_carries_metadata_corrected_since_the_failure(client: AsyncClient):
    """`run_ingest` reads artist/title out of the PAYLOAD, so a verbatim replay
    would undo the correction the operator made because the first attempt got
    them wrong — the commonest thing to fix between a failure and its retry."""
    song_id, _ = await _failed_song(client, karaoke_model="mdxnet_kara2")

    patched = await client.patch(
        f"/api/songs/{song_id}",
        json={"artist": "David Bowie", "title": "Heroes"},
    )
    assert patched.status_code == 200

    assert (await client.post(f"/api/songs/{song_id}/retry")).status_code == 202

    payload = await _queued_ingest_payload(song_id)
    assert payload["artist"] == "David Bowie"
    assert payload["title"] == "Heroes"
    # Everything else is still the original job's, untouched.
    assert payload["karaoke_model"] == "mdxnet_kara2"


@pytest.mark.asyncio
async def test_retry_without_a_recoverable_payload_uses_defaults(client: AsyncClient):
    """No ingest job row left to replay: the retry is still worth offering,
    but it is not the same run and the response does not pretend it is."""
    song_id, job_id = await _failed_song(client, karaoke_model="mdxnet_kara2")
    write_separation_marker(_stems_dir(song_id))
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(job_id=None))
        await db.execute(delete(Job).where(Job.song_id == song_id))
        await db.commit()

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    assert resp.json()["options_recovered"] is False

    payload = await _queued_ingest_payload(song_id)
    assert payload["karaoke_model"] == "roformer"       # the server default
    assert payload["llm_correction"] is False
    assert payload["llm_paging"] is False
    assert payload["artist"] == "Test"
    assert payload["title"] == "Retry"


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retry_unknown_song_is_404(client: AsyncClient):
    resp = await client.post("/api/songs/99999/retry")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_retry_song_owned_by_someone_else_is_404(client: AsyncClient):
    """Not a 403: that would confirm the id exists in another library. Same
    answer the stem and video routes give."""
    song_id, _ = await _failed_song(client)
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(owner_id=4242))
        await db.commit()

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["ready", "processing", "uploading"])
async def test_retry_requires_a_failed_song(client: AsyncClient, status: str):
    song_id, _ = await _upload(client)
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(status=status))
        await db.commit()

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 409
    assert status in resp.json()["detail"]


@pytest.mark.asyncio
async def test_retry_replays_the_upload_name_it_checked(client: AsyncClient):
    """The basename the route stats is the string the handler will join.

    A stored value that somehow held a path is checked as its basename — and
    that basename is written back into the replayed payload, so the preflight
    cannot answer about one file while ``run_ingest`` opens another.
    """
    song_id, job_id = await _failed_song(client)
    real = _upload_file(job_id)
    async with AsyncSessionLocal() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one()
        payload = queue.payload_of(job)
        payload["upload_path"] = f"/somewhere/else/{real.name}"
        job.payload = json.dumps(payload)
        await db.commit()

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    assert (await _queued_ingest_payload(song_id))["upload_path"] == real.name


@pytest.mark.asyncio
async def test_retry_with_the_source_audio_gone_is_409(client: AsyncClient):
    """Names the file, because "upload it again" is the whole remedy and the
    operator has to know which one."""
    song_id, job_id = await _failed_song(client)
    missing = _upload_file(job_id)
    missing.unlink()

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 409
    assert missing.name in resp.json()["detail"]

    # And it queued nothing — the song is still failed, still readable.
    song = await _song(song_id)
    assert song.status == "failed"
    async with AsyncSessionLocal() as db:
        queued = (await db.execute(
            select(Job).where(Job.status == "queued")
        )).scalars().all()
    assert queued == []


@pytest.mark.asyncio
async def test_retry_twice_is_409_the_second_time(client: AsyncClient):
    """The first retry leaves a queued job; a second would put two ingests on
    one stems directory, one transcription cache and one songs.job_id."""
    song_id, _ = await _failed_song(client)
    assert (await client.post(f"/api/songs/{song_id}/retry")).status_code == 202

    # Only a failed song is retryable, so re-fail it: that is exactly the race
    # this guard exists for — a stale UI holding a failed row while the retry
    # it already started is running.
    await _fail(song_id)
    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 409
    assert "already in flight" in resp.json()["detail"]

    async with AsyncSessionLocal() as db:
        queued = (await db.execute(
            select(Job).where(Job.song_id == song_id, Job.status == "queued")
        )).scalars().all()
    assert len(queued) == 1


@pytest.mark.asyncio
async def test_retry_that_loses_the_row_queues_nothing(client: AsyncClient):
    """The status flip is the guard, not bookkeeping.

    Both checks above it only READ the row and let it go, so two retries fired
    at one song — a double-click, two tabs — can walk past them; the
    conditional write is what settles which one owns the row. The window is
    opened deterministically here (the row stops being ``failed`` between the
    read and the write) and the two things that have to follow are pinned: a
    409, and NO job left behind. A retry that queued on a lost race would be a
    second ingest writing one stems directory.
    """
    song_id, _ = await _failed_song(client)
    write_separation_marker(_stems_dir(song_id))

    taken = []

    def take_the_row_first(state):
        # Fires inside the route's own session, immediately before its guarded
        # UPDATE — the moment a competing retry would have committed.
        if taken or not state.is_update:
            return
        taken.append(True)
        state.session.execute(
            text("UPDATE songs SET status = 'processing' WHERE id = :id"),
            {"id": song_id},
        )

    event.listen(SyncSession, "do_orm_execute", take_the_row_first)
    try:
        resp = await client.post(f"/api/songs/{song_id}/retry")
    finally:
        event.remove(SyncSession, "do_orm_execute", take_the_row_first)

    assert taken, "the guard never ran — the window this test opens moved"
    assert resp.status_code == 409
    assert "another retry got there first" in resp.json()["detail"]

    async with AsyncSessionLocal() as db:
        queued = (await db.execute(
            select(Job).where(Job.song_id == song_id, Job.status == "queued")
        )).scalars().all()
    assert queued == []


# ---------------------------------------------------------------------------
# Kind-aware retry: the job that PRODUCED the song is the one replayed
# ---------------------------------------------------------------------------


PLEX_PAYLOAD = {
    "rating_key": "5501",
    "artist": "Stale Artist",
    "title": "Stale Title",
    "has_lyrics": True,
    "llm_correction": True,
    "llm_paging": False,
    "karaoke_model": "mdxnet_kara2",
}


@pytest.mark.asyncio
async def test_retry_of_a_plex_import_requeues_a_plex_import(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A Plex-imported song has no ingest job to replay — it has a plex_import.

    Retrying it as an ingest handed `run_ingest` a payload with no
    `upload_path` and a `rating_key` it does not read, so the rescue either
    refused or re-ran on defaults. What is pinned is that the SAME importer
    runs again with the SAME options: the rating key is the only thing that
    can find the track a second time.
    """
    monkeypatch.setenv(PLEX_URL_ENV, "http://media.lan:32400")
    song_id = await _failed_import_song(
        kind=JobKind.PLEX_IMPORT.value, job_id="plex-job", payload=PLEX_PAYLOAD,
    )
    # Corrected on the row since the failure — see the ingest branch's test for
    # why these two are the exception to a verbatim replay.
    assert (await client.patch(
        f"/api/songs/{song_id}",
        json={"artist": "Ackerman", "title": "Zither Blues"},
    )).status_code == 200

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    body = resp.json()
    assert body["kind"] == "plex_import"
    assert body["options_recovered"] is True

    job = await _queued_job(song_id)
    assert job.kind == JobKind.PLEX_IMPORT.value
    payload = queue.payload_of(job)
    assert payload["rating_key"] == "5501"
    assert payload["has_lyrics"] is True
    assert payload["llm_correction"] is True
    assert payload["llm_paging"] is False
    assert payload["karaoke_model"] == "mdxnet_kara2"
    assert payload["artist"] == "Ackerman"
    assert payload["title"] == "Zither Blues"


@pytest.mark.asyncio
async def test_retry_of_a_plex_import_with_no_server_configured_is_409(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """Refused up front rather than a minute later inside the handler.

    Re-importing is a round trip to the operator's server, and the handler's
    very first act is to resolve the rating key against it. With no URL that
    fails asynchronously, into a job row the operator has to go and read — so
    the route says it synchronously, in the words of the thing to fix.
    """
    monkeypatch.delenv(PLEX_URL_ENV, raising=False)
    song_id = await _failed_import_song(
        kind=JobKind.PLEX_IMPORT.value, job_id="plex-nourl", payload=PLEX_PAYLOAD,
    )

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 409
    assert "no media server URL is configured" in resp.json()["detail"]

    # And it queued nothing: the song is still failed and still retryable once
    # the URL is set.
    assert (await _song(song_id)).status == "failed"
    async with AsyncSessionLocal() as db:
        assert (await db.execute(
            select(Job).where(Job.status == "queued")
        )).scalars().all() == []


@pytest.mark.asyncio
async def test_retry_of_a_plex_import_past_separation_needs_no_server(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """The marker is what makes the server irrelevant, exactly as for an upload.

    Past `.separation-complete` the handler skips materialisation entirely and
    hands straight off to ingest, which resumes off the stems — so demanding a
    configured server here would refuse a retry that never touches one.
    """
    monkeypatch.delenv(PLEX_URL_ENV, raising=False)
    song_id = await _failed_import_song(
        kind=JobKind.PLEX_IMPORT.value, job_id="plex-marker", payload=PLEX_PAYLOAD,
    )
    write_separation_marker(_stems_dir(song_id))

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    assert resp.json()["kind"] == "plex_import"


@pytest.mark.asyncio
async def test_retry_of_a_video_import_requeues_a_video_import(client: AsyncClient):
    """Verbatim, all of it: `run_video_import` reads only `upload_name`.

    The payload is the shape the video route really writes — upload name,
    artist, title — and the row's metadata is edited before the retry, so the
    assertion pins the asymmetry with the other two branches: those override
    artist/title from the song row because their handlers read them; this one
    carries the original pair through untouched because nothing downstream
    reads them, and the retry does not pretend otherwise.
    """
    upload = Path(os.environ["UPLOADS_DIR"]) / "video-job_clip.mp4"
    upload.write_bytes(b"fake video bytes")
    original = {"upload_name": upload.name, "artist": "As Uploaded", "title": "Clip"}
    song_id = await _failed_import_song(
        kind=JobKind.VIDEO_IMPORT.value, job_id="video-job", payload=dict(original),
    )
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(Song).where(Song.id == song_id)
            .values(artist="Corrected", title="Corrected Clip")
        )
        await db.commit()

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    body = resp.json()
    assert body["kind"] == "video_import"
    assert body["options_recovered"] is True

    job = await _queued_job(song_id)
    assert job.kind == JobKind.VIDEO_IMPORT.value
    assert queue.payload_of(job) == original
    assert upload.is_file()


@pytest.mark.asyncio
async def test_retry_of_a_video_import_with_the_video_gone_is_409(
    client: AsyncClient,
):
    """Names the file, because "upload the video again" is the whole remedy."""
    upload = Path(os.environ["UPLOADS_DIR"]) / "video-gone_clip.mp4"
    upload.write_bytes(b"fake video bytes")
    song_id = await _failed_import_song(
        kind=JobKind.VIDEO_IMPORT.value, job_id="video-gone",
        payload={"upload_name": upload.name},
    )
    upload.unlink()

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert upload.name in detail
    assert "upload the video again" in detail


@pytest.mark.asyncio
async def test_retry_of_a_finished_video_import_needs_no_upload(client: AsyncClient):
    """The video-import counterpart to the separation marker.

    Both artifacts on disk means an earlier attempt reached the persist, and
    the handler's re-entry gate redoes only that — so a retry of one is a
    retry of a database write, and the upload it no longer reads must not be
    demanded of the operator.
    """
    upload = Path(os.environ["UPLOADS_DIR"]) / "video-done_clip.mp4"
    upload.write_bytes(b"fake video bytes")
    song_id = await _failed_import_song(
        kind=JobKind.VIDEO_IMPORT.value, job_id="video-done",
        payload={"upload_name": upload.name},
    )
    upload.unlink()
    stems_dir = _stems_dir(song_id)
    (stems_dir / AUDIO_STEM_FILENAME).write_bytes(b"flac")
    (stems_dir / "video.mp4").write_bytes(b"fake video bytes")

    resp = await client.post(f"/api/songs/{song_id}/retry")
    assert resp.status_code == 202
    assert resp.json()["kind"] == "video_import"


# ---------------------------------------------------------------------------
# The other end of the retained upload: deleting the song
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deleting_a_song_releases_the_upload_its_retry_would_have_used(
    client: AsyncClient,
):
    """The bound on the retained-upload rule, and the only one there is.

    A failed song keeps its upload for as long as a retry could still read it,
    which means nothing else ever reclaims that disk — so `DELETE` has to, and
    it has to take only the deleted song's. Two songs, because "deletes the
    right uploads" and "deletes every upload" look identical with one.
    """
    doomed_id, doomed_job = await _failed_song(client)
    spared_id, spared_job = await _failed_song(client)
    doomed_upload, spared_upload = _upload_file(doomed_job), _upload_file(spared_job)

    assert (await client.delete(f"/api/songs/{doomed_id}")).status_code == 200

    assert not doomed_upload.exists()
    assert spared_upload.is_file()
    assert (await client.get(f"/api/songs/{spared_id}")).status_code == 200
