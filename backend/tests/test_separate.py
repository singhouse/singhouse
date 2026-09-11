# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for /api/separate and /api/jobs/{job_id} endpoints.

The route ENQUEUES and returns; no worker runs under ``ASGITransport``
because the lifespan never fires, so nothing needs stubbing to keep the
pipeline from starting. What these pin is the 202 contract and the poll
route's shape.
"""

import io
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.models.song import Job
from karaoke_backend.workers import karaoke_models


def _make_wav_bytes() -> bytes:
    """Return a minimal valid WAV file (1-sample silence) for upload tests."""
    sample_rate = 44100
    num_samples = 100
    data_size = num_samples * 2
    return (
        b"RIFF"
        + (36 + data_size).to_bytes(4, "little")
        + b"WAVE"
        + b"fmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")
        + (1).to_bytes(2, "little")
        + sample_rate.to_bytes(4, "little")
        + (sample_rate * 2).to_bytes(4, "little")
        + (2).to_bytes(2, "little")
        + (16).to_bytes(2, "little")
        + b"data"
        + data_size.to_bytes(4, "little")
        + b"\x00" * data_size
    )


@pytest.mark.asyncio
async def test_submit_separation(client: AsyncClient):
    """POST /api/separate returns 202 with job_id and song_id."""
    wav_data = _make_wav_bytes()

    response = await client.post(
        "/api/separate",
        files={"file": ("test_song.wav", io.BytesIO(wav_data), "audio/wav")},
        data={"artist": "Test Artist", "title": "Test Song"},
    )

    assert response.status_code == 202
    data = response.json()
    assert "job_id" in data
    assert "song_id" in data
    assert data["status"] == "queued"
    assert "/api/jobs/" in data["status_url"]


@pytest.mark.asyncio
async def test_job_status_not_found(client: AsyncClient):
    """GET /api/jobs/{unknown_id} returns 404."""
    response = await client.get("/api/jobs/nonexistent-job-id")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_job_status_after_submit(client: AsyncClient):
    """Job can be polled after submission."""
    wav_data = _make_wav_bytes()

    submit = await client.post(
        "/api/separate",
        files={"file": ("another.wav", io.BytesIO(wav_data), "audio/wav")},
        data={"artist": "Artist B", "title": "Song B"},
    )

    assert submit.status_code == 202
    job_id = submit.json()["job_id"]

    poll = await client.get(f"/api/jobs/{job_id}")
    assert poll.status_code == 200
    data = poll.json()
    assert data["job_id"] == job_id
    assert data["status"] in ("queued", "uploading", "processing", "done", "failed")
    assert isinstance(data["progress"], int)


@pytest.mark.asyncio
async def test_submit_no_file(client: AsyncClient):
    """POST /api/separate without a file returns 422."""
    response = await client.post("/api/separate")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Pass-2 karaoke model picker
# ---------------------------------------------------------------------------


async def _payload_for(client: AsyncClient, **data) -> dict:
    """Submit one upload and return the enqueued ingest job's payload dict."""
    response = await client.post(
        "/api/separate",
        files={"file": ("test_song.wav", io.BytesIO(_make_wav_bytes()), "audio/wav")},
        data={"artist": "Test Artist", "title": "Test Song", **data},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]

    async with AsyncSessionLocal() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one()
        return json.loads(job.payload)


@pytest.mark.asyncio
async def test_karaoke_model_defaults_when_unset(client: AsyncClient):
    """An upload that never touched the picker records the default choice."""
    payload = await _payload_for(client)
    assert payload["karaoke_model"] == karaoke_models.DEFAULT_CHOICE


@pytest.mark.asyncio
async def test_karaoke_model_pick_reaches_the_job_payload(client: AsyncClient):
    """A valid pick is what the worker will read — the whole point of the form
    field. Pinned by ID, because the ID is what crosses the wire."""
    payload = await _payload_for(client, karaoke_model="mdxnet_kara2")
    assert payload["karaoke_model"] == "mdxnet_kara2"


@pytest.mark.asyncio
async def test_karaoke_model_unknown_id_is_refused(client: AsyncClient):
    """An ID outside the allowlist is a 400, not a silent fall back.

    The filename case matters most: a caller sending a checkpoint filename
    instead of an ID must be refused, since that string would otherwise reach
    a subprocess argument and an audio-separator download.
    """
    for bad in ("UVR_MDXNET_KARA_2.onnx", "../../etc/passwd", "nope"):
        response = await client.post(
            "/api/separate",
            files={"file": ("t.wav", io.BytesIO(_make_wav_bytes()), "audio/wav")},
            data={"karaoke_model": bad},
        )
        assert response.status_code == 400, f"{bad!r} was not refused"
        assert "karaoke_model" in response.json()["detail"]


# ---------------------------------------------------------------------------
# safe_upload_name — the one place a caller-supplied filename becomes a name
# ---------------------------------------------------------------------------
#
# Shared with the Plex import job, which composes `{job_id}_{this}` for a file
# it writes into the uploads directory. Anything that survives this function
# with a directory component in it is a path traversal in whichever caller
# joins it next, so the traversal cases are pinned here rather than at each
# call site.


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("song.wav", "song.wav"),
        ("../../etc/passwd", "passwd"),
        ("/etc/passwd", "passwd"),
        ("a/b/c/track.flac", "track.flac"),
        ("..\\..\\windows\\system32", "..\\..\\windows\\system32"),
    ],
)
def test_safe_upload_name_keeps_only_the_basename(raw, expected):
    from karaoke_backend.api.separate import safe_upload_name

    assert safe_upload_name(raw, "fallback.wav") == expected


@pytest.mark.parametrize("raw", ["", ".", "..", None, "   /  ../.."])
def test_safe_upload_name_falls_back_on_names_that_are_not_files(raw):
    """The three names that survive a basename and still are not filenames.

    `""`, `"."` and `".."` each compose a `{job_id}_` upload name that means
    something else to the filesystem than it reads as, so each takes the
    caller's default instead.
    """
    from karaoke_backend.api.separate import safe_upload_name

    assert safe_upload_name(raw, "fallback.wav") == "fallback.wav"


def test_safe_upload_name_never_returns_a_path_separator():
    from karaoke_backend.api.separate import safe_upload_name

    for raw in ("../../etc/passwd", "/a/b", "x/y/z.mp3", "..", "."):
        assert "/" not in safe_upload_name(raw, "fallback.wav")
