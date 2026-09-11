# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for /api/songs CRUD endpoints.

Uploads here exist to produce a Song row, nothing more. Since the durable
queue ``POST /api/separate`` only enqueues, and no worker runs under
``ASGITransport`` (the lifespan never fires), so the pipeline stays put on its
own and the ingest handler needs no stubbing. Tests that DO want the job to
run drain it explicitly — see ``test_lyrics_sets_realign.py``.
"""

import io

import pytest
from httpx import AsyncClient
from sqlalchemy import update

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.models.song import Song


async def _mark_ready(song_id: int) -> None:
    """Put a freshly-uploaded row where a finished ingest would leave it."""
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(status="ready"))
        await db.commit()


@pytest.mark.asyncio
async def test_list_songs_empty(client: AsyncClient):
    """GET /api/songs returns empty list when no songs exist."""
    response = await client.get("/api/songs")
    assert response.status_code == 200
    data = response.json()
    assert "songs" in data
    assert isinstance(data["songs"], list)
    assert "total" in data


@pytest.mark.asyncio
async def test_get_song_not_found(client: AsyncClient):
    """GET /api/songs/99999 returns 404."""
    response = await client.get("/api/songs/99999")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_songs_crud_flow(client: AsyncClient):
    """Full flow: create via separate → list → get → patch → delete."""
    wav_data = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"

    # 1. Create song via separation endpoint
    resp = await client.post(
        "/api/separate",
        files={"file": ("my_song.wav", io.BytesIO(wav_data), "audio/wav")},
        data={"artist": "Nirvana", "title": "Come as You Are"},
    )
    assert resp.status_code == 202
    song_id = resp.json()["song_id"]

    # 2. List songs — should include our new entry
    list_resp = await client.get("/api/songs")
    assert list_resp.status_code == 200
    ids = [s["id"] for s in list_resp.json()["songs"]]
    assert song_id in ids

    # 3. Get detail
    detail_resp = await client.get(f"/api/songs/{song_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["artist"] == "Nirvana"
    assert detail["title"] == "Come as You Are"

    # 4. Patch metadata
    patch_resp = await client.patch(
        f"/api/songs/{song_id}",
        json={"artist": "Nirvana (Updated)", "lyrics_synced": True},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["artist"] == "Nirvana (Updated)"
    assert patch_resp.json()["lyrics_synced"] is True

    # 5. Delete
    del_resp = await client.delete(f"/api/songs/{song_id}")
    assert del_resp.status_code == 200

    # 6. Confirm gone
    gone_resp = await client.get(f"/api/songs/{song_id}")
    assert gone_resp.status_code == 404


@pytest.mark.asyncio
async def test_songs_filter_by_status(client: AsyncClient):
    """GET /api/songs?status=ready returns only ready songs."""
    response = await client.get("/api/songs", params={"status": "ready"})
    assert response.status_code == 200
    for song in response.json()["songs"]:
        assert song["status"] == "ready"


@pytest.mark.asyncio
async def test_stem_download_not_ready(client: AsyncClient):
    """Downloading stems from a non-ready song returns 409."""
    wav_data = b"\x00" * 64  # garbage — just needs to write to disk

    resp = await client.post(
        "/api/separate",
        files={"file": ("dummy.wav", io.BytesIO(wav_data), "audio/wav")},
    )
    assert resp.status_code == 202
    song_id = resp.json()["song_id"]

    stem_resp = await client.get(f"/api/songs/{song_id}/stems/instrumental.wav")
    assert stem_resp.status_code == 409  # not ready yet


@pytest.mark.asyncio
async def test_stem_download_invalid_filename(client: AsyncClient):
    """Requesting a non-allowed stem filename returns 400."""
    response = await client.get("/api/songs/1/stems/../../etc/passwd")
    assert response.status_code in (400, 404)


@pytest.mark.asyncio
async def test_custom_lyrics_patch(client: AsyncClient):
    """PATCH /api/songs/{id} with custom_lyrics persists and returns in GET."""
    wav_data = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"

    resp = await client.post(
        "/api/separate",
        files={"file": ("test.wav", io.BytesIO(wav_data), "audio/wav")},
        data={"artist": "Test", "title": "Song"},
    )
    assert resp.status_code == 202
    song_id = resp.json()["song_id"]

    custom = "Line one\nLine two\nLine three"

    # Patch with custom lyrics
    patch_resp = await client.patch(
        f"/api/songs/{song_id}",
        json={"custom_lyrics": custom},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["custom_lyrics"] == custom

    # Verify it persists via GET
    get_resp = await client.get(f"/api/songs/{song_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["custom_lyrics"] == custom


@pytest.mark.asyncio
async def test_retranscribe_with_custom_lyrics(client: AsyncClient):
    """POST /api/songs/{id}/lyrics/transcribe accepts a plain_lyrics override
    (with reference_mode='paste' — the 'none' default rejects stray lyrics)."""
    wav_data = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"

    resp = await client.post(
        "/api/separate",
        files={"file": ("test.wav", io.BytesIO(wav_data), "audio/wav")},
        data={"artist": "Test", "title": "WordSync"},
    )
    assert resp.status_code == 202
    song_id = resp.json()["song_id"]
    # Ready first: otherwise the status guard answers, and this test
    # would stop exercising the missing-stem refusal it is here for.
    await _mark_ready(song_id)

    # No vocals stem on disk yet, so we expect 409, not 5xx.
    ws_resp = await client.post(
        f"/api/songs/{song_id}/lyrics/transcribe",
        json={"plain_lyrics": "Hello world\nSecond line", "reference_mode": "paste"},
    )
    assert ws_resp.status_code == 409


@pytest.mark.asyncio
async def test_lyrics_set_crud(client: AsyncClient):
    """List/create/activate/verify/delete a LyricsSet via the new endpoints."""
    wav_data = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    resp = await client.post(
        "/api/separate",
        files={"file": ("t.wav", io.BytesIO(wav_data), "audio/wav")},
        data={"artist": "T", "title": "T"},
    )
    song_id = resp.json()["song_id"]

    # initially: no sets
    list_resp = await client.get(f"/api/songs/{song_id}/lyrics")
    assert list_resp.status_code == 200
    assert list_resp.json() == []

    # create a manual set
    create_resp = await client.post(f"/api/songs/{song_id}/lyrics", json={
        "source": "manual",
        "label": "test edit",
        "plain_lyrics": "line one\nline two",
        "activate": True,
    })
    assert create_resp.status_code == 201
    lid = create_resp.json()["id"]
    assert create_resp.json()["is_active"] is True
    assert create_resp.json()["has_plain_lyrics"] is True

    # song detail should now report this set as active
    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["active_lyrics_id"] == lid
    assert len(detail["lyrics_sets"]) == 1

    # mark verified
    ver_resp = await client.post(f"/api/songs/{song_id}/lyrics/{lid}/verify")
    assert ver_resp.status_code == 200
    assert ver_resp.json()["is_verified"] is True

    # delete (will fall back to no active set)
    del_resp = await client.delete(f"/api/songs/{song_id}/lyrics/{lid}")
    assert del_resp.status_code == 200
    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["active_lyrics_id"] is None


@pytest.mark.asyncio
async def test_lyrics_set_copy(client: AsyncClient):
    """POST /lyrics/{lid}/copy duplicates payloads, drops verified, tracks provenance."""
    wav_data = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    resp = await client.post(
        "/api/separate",
        files={"file": ("t.wav", io.BytesIO(wav_data), "audio/wav")},
        data={"artist": "T", "title": "Copy"},
    )
    song_id = resp.json()["song_id"]

    word_sync = {"lines": [[{"text": "hello", "start": 0.0, "end": 0.5}]], "metadata": {"method": "test"}}
    create_resp = await client.post(f"/api/songs/{song_id}/lyrics", json={
        "source": "reference",
        "label": "provider-v2",
        "plain_lyrics": "hello",
        "synced_lyrics": "[00:00.00]hello",
        "word_sync_json": word_sync,
        "metadata_json": {"method": "test"},
        "activate": True,
    })
    lid = create_resp.json()["id"]
    await client.post(f"/api/songs/{song_id}/lyrics/{lid}/verify")

    # copy with no body: payloads + source carried over, verified/active NOT
    copy_resp = await client.post(f"/api/songs/{song_id}/lyrics/{lid}/copy")
    assert copy_resp.status_code == 201
    copied = copy_resp.json()
    assert copied["id"] != lid
    assert copied["source"] == "reference"
    assert copied["label"] == "copy of provider-v2"
    assert copied["is_verified"] is False
    assert copied["is_active"] is False
    assert copied["word_sync"] == word_sync
    assert copied["plain_lyrics"] == "hello"
    assert copied["synced_lyrics"] == "[00:00.00]hello"
    assert copied["metadata"]["copied_from_set"] == lid

    # original still active + verified
    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["active_lyrics_id"] == lid

    # copy with explicit label + activate
    copy2 = (await client.post(
        f"/api/songs/{song_id}/lyrics/{lid}/copy",
        json={"label": "editing draft", "activate": True},
    )).json()
    assert copy2["label"] == "editing draft"
    assert copy2["is_active"] is True
    detail = (await client.get(f"/api/songs/{song_id}")).json()
    assert detail["active_lyrics_id"] == copy2["id"]

    # copying a missing set 404s
    missing = await client.post(f"/api/songs/{song_id}/lyrics/999999/copy")
    assert missing.status_code == 404
