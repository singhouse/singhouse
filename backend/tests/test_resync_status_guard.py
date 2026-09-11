# SPDX-License-Identifier: AGPL-3.0-only
"""The re-sync routes refuse a song that is not ready, and `/realign` keeps
`language`.

Two bugs with one shape: a request field that reaches the worker on one route
and is dropped on the other, and a job that queues happily against a song
whose stems are half-written or missing. Both are silent — the caller gets a
202 either way — so what is pinned here is the payload the queue actually
holds and the status code the caller actually gets.
"""

import io
import json
import os
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs import queue
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Job, JobKind, LyricsSet, Song


WAV = (
    b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    b"\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
)


@pytest.fixture(autouse=True)
def clean_stems_root():
    """A song directory per test — STEMS_DIR outlives the database, which is
    recreated per test, so ids restart at 1 and stems would be inherited."""
    root = Path(os.environ["STEMS_DIR"])
    for child in root.iterdir():
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()
    yield


async def _create_song(client: AsyncClient) -> int:
    with patch("karaoke_backend.jobs.ingest.run_ingest", new=AsyncMock()):
        resp = await client.post(
            "/api/separate",
            files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
            data={"artist": "Test", "title": "Guarded"},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1
    return resp.json()["song_id"]


async def _set_status(song_id: int, status: str) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(status=status))
        await db.commit()


def _ensure_vocals(song_id: int) -> Path:
    song_dir = Path(os.environ["STEMS_DIR"]) / str(song_id)
    song_dir.mkdir(parents=True, exist_ok=True)
    path = song_dir / "lead_vocals.wav"
    path.write_bytes(WAV)
    return path


def _write_cache(song_id: int) -> Path:
    path = Path(os.environ["STEMS_DIR"]) / str(song_id) / "transcription.heart-vad.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"segments": [], "language": "en", "full_text": ""}))
    return path


async def _payload_of_kind(kind: str) -> dict:
    """The payload of the single queued job of this kind."""
    async with AsyncSessionLocal() as db:
        jobs = (await db.execute(
            select(Job).where(Job.kind == kind).order_by(Job.created_at.desc())
        )).scalars().all()
    assert jobs, f"no {kind} job was enqueued"
    return queue.payload_of(jobs[0])


# ---------------------------------------------------------------------------
# `language` survives the trip to the queue on BOTH routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transcribe_forwards_language(client: AsyncClient):
    song_id = await _create_song(client)
    await _set_status(song_id, "ready")
    _ensure_vocals(song_id)

    resp = await client.post(
        f"/api/songs/{song_id}/lyrics/transcribe",
        json={"whisper_model": "heart", "use_vad": True, "language": "es"},
    )
    assert resp.status_code == 202
    assert (await _payload_of_kind(JobKind.RETRANSCRIBE.value))["language"] == "es"


@pytest.mark.asyncio
async def test_realign_forwards_language_too(client: AsyncClient):
    """The bug: `/realign` took the same TranscribeRequest and dropped
    `language` on the floor. The aligner it ends up in does not decode audio,
    so nothing downstream reads it yet — the point is that the two routes take
    the same body to the same payload keys, and a caller who sets the field
    can see what happened to it."""
    song_id = await _create_song(client)
    await _set_status(song_id, "ready")
    _ensure_vocals(song_id)
    _write_cache(song_id)

    resp = await client.post(
        f"/api/songs/{song_id}/lyrics/realign",
        json={"whisper_model": "heart", "use_vad": True, "language": "es"},
    )
    assert resp.status_code == 202
    assert (await _payload_of_kind(JobKind.REALIGN.value))["language"] == "es"


@pytest.mark.asyncio
async def test_realign_language_defaults_to_none(client: AsyncClient):
    """Omitting it is not the same as sending a string: the key is present and
    null, which is what the transcribe payload has always carried."""
    song_id = await _create_song(client)
    await _set_status(song_id, "ready")
    _ensure_vocals(song_id)
    _write_cache(song_id)

    resp = await client.post(
        f"/api/songs/{song_id}/lyrics/realign",
        json={"whisper_model": "heart", "use_vad": True},
    )
    assert resp.status_code == 202
    payload = await _payload_of_kind(JobKind.REALIGN.value)
    assert "language" in payload
    assert payload["language"] is None


# ---------------------------------------------------------------------------
# Not ready → 409, and the detail names the status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["processing", "failed", "uploading"])
async def test_transcribe_requires_ready(client: AsyncClient, status: str):
    song_id = await _create_song(client)
    await _set_status(song_id, status)
    _ensure_vocals(song_id)

    resp = await client.post(
        f"/api/songs/{song_id}/lyrics/transcribe",
        json={"whisper_model": "heart", "use_vad": True},
    )
    assert resp.status_code == 409
    assert status in resp.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["processing", "failed", "uploading"])
async def test_realign_requires_ready(client: AsyncClient, status: str):
    """Checked BEFORE the cache: a song mid-ingest may well have a cache file,
    and "there is nothing to realign" would be the wrong answer for it."""
    song_id = await _create_song(client)
    await _set_status(song_id, status)
    _ensure_vocals(song_id)
    _write_cache(song_id)

    resp = await client.post(
        f"/api/songs/{song_id}/lyrics/realign",
        json={"whisper_model": "heart", "use_vad": True},
    )
    assert resp.status_code == 409
    assert status in resp.json()["detail"]


@pytest.mark.asyncio
async def test_page_requires_ready(client: AsyncClient):
    """`/page` guards too — it re-reads a set the running ingest may replace."""
    song_id = await _create_song(client)
    await _set_status(song_id, "ready")
    created = await client.post(
        f"/api/songs/{song_id}/lyrics",
        json={
            "source": "manual",
            "word_sync_json": {"lines": [[{"text": "hi", "start": 0.0, "end": 0.5}]]},
        },
    )
    assert created.status_code == 201
    lid = created.json()["id"]

    await _set_status(song_id, "processing")
    resp = await client.post(f"/api/songs/{song_id}/lyrics/{lid}/page", json={})
    assert resp.status_code == 409
    assert "processing" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_guard_queues_nothing(client: AsyncClient):
    """A refusal is a refusal: no job row, and the song's job_id untouched."""
    song_id = await _create_song(client)
    await _set_status(song_id, "failed")
    _ensure_vocals(song_id)
    _write_cache(song_id)

    async with AsyncSessionLocal() as db:
        before = (await db.execute(select(Song).where(Song.id == song_id))).scalar_one()
        job_id_before = before.job_id

    for route, body in (
        ("transcribe", {"whisper_model": "heart"}),
        ("realign", {"whisper_model": "heart"}),
    ):
        assert (await client.post(
            f"/api/songs/{song_id}/lyrics/{route}", json=body
        )).status_code == 409

    async with AsyncSessionLocal() as db:
        queued = (await db.execute(
            select(Job).where(Job.status == "queued")
        )).scalars().all()
        after = (await db.execute(select(Song).where(Song.id == song_id))).scalar_one()
    assert queued == []
    assert after.job_id == job_id_before


@pytest.mark.asyncio
async def test_lyrics_set_crud_is_unaffected_by_the_guard(client: AsyncClient):
    """The guard covers the three JOB routes only. Reading and editing lyrics
    on a failed song still works — it is how an operator inspects one."""
    song_id = await _create_song(client)
    await _set_status(song_id, "failed")

    created = await client.post(
        f"/api/songs/{song_id}/lyrics",
        json={"source": "manual", "plain_lyrics": "still editable"},
    )
    assert created.status_code == 201
    lid = created.json()["id"]

    assert (await client.get(f"/api/songs/{song_id}/lyrics")).status_code == 200
    patched = await client.patch(
        f"/api/songs/{song_id}/lyrics/{lid}", json={"label": "renamed"}
    )
    assert patched.status_code == 200

    async with AsyncSessionLocal() as db:
        row = (await db.execute(
            select(LyricsSet).where(LyricsSet.id == lid)
        )).scalar_one()
    assert row.label == "renamed"
