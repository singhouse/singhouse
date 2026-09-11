# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for the realign endpoint and reference_mode handling.

Since the durable queue these routes only ENQUEUE: the orchestrators live in
``karaoke_backend.jobs.transcribe`` and run on the worker, so a test that
wants the result has to drain the queue itself. ``run_queued_jobs_once``
does that deterministically — claim, run, repeat until empty — with no
wall-clock polling.
"""

import io
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from sqlalchemy import update

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Song


WAV = (
    b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    b"\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
)


async def _create_song(client: AsyncClient) -> int:
    """Upload a song, clear the ingest job it queues, and mark it ready.

    Draining it here (with the pipeline stubbed) leaves the queue empty, so a
    later `run_queued_jobs_once()` counts only the job the test just made.

    The row is flipped to `ready` because the pipeline is STUBBED: a real
    ingest ends there, and the re-sync routes refuse anything else.
    The refusal itself is pinned in `test_resync_status_guard.py`.
    """
    with patch("karaoke_backend.jobs.ingest.run_ingest", new=AsyncMock()):
        resp = await client.post(
            "/api/separate",
            files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
            data={"artist": "Test", "title": "Realign"},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1
    song_id = resp.json()["song_id"]
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(status="ready"))
        await db.commit()
    return song_id


def _ensure_vocals(song_id: int) -> Path:
    """Drop a non-empty vocals.wav under STEMS_DIR/{song_id}/ so the
    transcribe endpoint passes its existence check."""
    stems_root = Path(os.environ["STEMS_DIR"])
    song_dir = stems_root / str(song_id)
    song_dir.mkdir(parents=True, exist_ok=True)
    path = song_dir / "lead_vocals.wav"
    path.write_bytes(WAV)
    return path


@pytest.mark.asyncio
async def test_realign_without_cache_returns_409(client: AsyncClient):
    """POST /lyrics/realign with no cached transcription → 409."""
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    resp = await client.post(
        f"/api/songs/{song_id}/lyrics/realign",
        json={"whisper_model": "heart", "use_vad": True, "reference_mode": "none"},
    )
    assert resp.status_code == 409
    assert "cached transcription" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_transcribe_reference_mode_none(client: AsyncClient):
    """`transcribe` with reference_mode=none stores method='whisper-only'."""
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    canned = {
        "segments": [],
        "lines": [[{"text": "hello", "start": 0.0, "end": 0.5}]],
        "metadata": {
            "words_total": 1,
            "words_matched": 0,
            "words_corrected": 0,
            "words_interpolated": 0,
            "lines_total": 1,
            "method": "whisper-only",
            "artist": "Test",
            "title": "Realign",
            "language": None,
            "model": "heart",
            "use_vad": True,
            "ref_mode": "none",
            "pipeline_config": {"vad": {}, "matching": {}, "postprocess": {}},
        },
    }

    mock_gws = AsyncMock(return_value=canned)
    with patch("karaoke_backend.jobs.transcribe.generate_word_sync", new=mock_gws):
        resp = await client.post(
            f"/api/songs/{song_id}/lyrics/transcribe",
            json={
                "whisper_model": "heart",
                "use_vad": True,
                "reference_mode": "none",
            },
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1

    # Prove that reference_mode=none actually reached the worker as
    # plain_lyrics=None and synced_lyrics=None — not just that the canned
    # mock return value happened to contain "whisper-only".
    assert mock_gws.called is True
    call_kwargs = mock_gws.call_args.kwargs
    assert call_kwargs["plain_lyrics"] is None
    assert call_kwargs["synced_lyrics"] is None

    sets_resp = await client.get(f"/api/songs/{song_id}/lyrics")
    assert sets_resp.status_code == 200
    sets = sets_resp.json()
    assert len(sets) == 1
    new_id = sets[0]["id"]

    detail = (await client.get(f"/api/songs/{song_id}/lyrics/{new_id}")).json()
    assert detail["metadata"]["method"] == "whisper-only"
    # No reference fed in → both reference fields should be None.
    assert detail["plain_lyrics"] is None
    assert detail["synced_lyrics"] is None


@pytest.mark.asyncio
async def test_realign_with_cache_uses_realign_only(client: AsyncClient, tmp_path):
    """A cache file present → realign endpoint queues realign_only and
    persists a -realigned LyricsSet."""
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    # Create the cache file at the path the worker expects.
    stems_root = Path(os.environ["STEMS_DIR"])
    cache_path = stems_root / str(song_id) / "transcription.heart-vad.json"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({
        "segments": [],
        "language": "en",
        "full_text": "",
    }))

    canned = {
        "segments": [],
        "lines": [],
        "metadata": {
            "words_total": 0, "words_matched": 0, "words_corrected": 0,
            "words_interpolated": 0, "lines_total": 0,
            "method": "whisper-only",
            "artist": "Test", "title": "Realign", "language": "en",
            "model": "heart", "use_vad": True, "ref_mode": "none",
            "pipeline_config": {},
        },
    }

    mock_realign = AsyncMock(return_value=canned)
    mock_gws = AsyncMock(return_value=canned)
    pasted_plain = "hello world\nfrom the test"
    with patch("karaoke_backend.jobs.transcribe.realign_only", new=mock_realign), patch(
        "karaoke_backend.jobs.transcribe.generate_word_sync", new=mock_gws
    ):
        resp = await client.post(
            f"/api/songs/{song_id}/lyrics/realign",
            json={
                "whisper_model": "heart",
                "use_vad": True,
                "reference_mode": "paste",
                "plain_lyrics": pasted_plain,
            },
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1

    # Prove the realign path was taken — and crucially that the full-pipeline
    # transcribe worker was NOT invoked. A regression that wired realign
    # through generate_word_sync would otherwise pass silently.
    assert mock_realign.called is True
    mock_gws.assert_not_called()

    # Confirm the pasted reference lyrics reached the worker (i.e. the
    # endpoint resolved reference_mode=paste correctly).
    realign_kwargs = mock_realign.call_args.kwargs
    assert realign_kwargs["plain_lyrics"] == pasted_plain
    assert realign_kwargs["synced_lyrics"] is None

    sets = (await client.get(f"/api/songs/{song_id}/lyrics")).json()
    assert any(s["label"].endswith("-realigned") for s in sets)


@pytest.mark.asyncio
async def test_transcribe_rejects_lyrics_without_paste_mode(client: AsyncClient):
    """Lyrics in the body + default reference_mode ('none') → 400, not a
    silent discard. Guards callers written against the old 'auto' default."""
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    resp = await client.post(
        f"/api/songs/{song_id}/lyrics/transcribe",
        json={"plain_lyrics": "Hello world\nSecond line"},
    )
    assert resp.status_code == 400
    assert "reference_mode" in resp.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["lrclib", "auto"])
async def test_lookup_reference_uses_plain_words_without_fetched_timestamps(mode):
    from karaoke_backend.api.lyrics_sets import _resolve_reference, TranscribeRequest
    from karaoke_backend.workers.lyrics_worker import LyricsResult
    song = Song(id=1, artist="A", title="B", filename="song.wav")
    result = LyricsResult("A", "B", None, None, "Plain words", "[00:01]Wrong timing")
    with patch("karaoke_backend.api.lyrics_sets.fetch_lyrics", AsyncMock(return_value=result)):
        assert await _resolve_reference(mode, TranscribeRequest(), song, AsyncMock(), 1) == (
            "Plain words", None,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("plain", [None, "", "   "])
async def test_explicit_lookup_without_plain_lyrics_has_actionable_error(plain):
    from fastapi import HTTPException
    from karaoke_backend.api.lyrics_sets import _resolve_reference, TranscribeRequest
    from karaoke_backend.workers.lyrics_worker import LyricsResult
    song = Song(id=1, artist="A", title="B", filename="song.wav")
    result = LyricsResult("A", "B", None, None, plain, "[00:01]Words")
    with patch("karaoke_backend.api.lyrics_sets.fetch_lyrics", AsyncMock(return_value=result)):
        with pytest.raises(HTTPException) as error:
            await _resolve_reference("lrclib", TranscribeRequest(), song, AsyncMock(), 1)
    assert error.value.status_code == 404
    assert "Paste lyrics or choose audio-only" in error.value.detail


@pytest.mark.asyncio
async def test_auto_synced_only_lookup_falls_back_without_lrc():
    from karaoke_backend.api.lyrics_sets import _resolve_reference, TranscribeRequest
    from karaoke_backend.workers.lyrics_worker import LyricsResult
    song = Song(id=1, artist="A", title="B", filename="song.wav")
    result = LyricsResult("A", "B", None, None, None, "[00:01]Words")
    with patch("karaoke_backend.api.lyrics_sets.fetch_lyrics", AsyncMock(return_value=result)):
        assert await _resolve_reference("auto", TranscribeRequest(), song, AsyncMock(), 1) == (None, None)
