# SPDX-License-Identifier: AGPL-3.0-only
"""Optional paging on sync routes and existing lyric sets."""

import io
import json
import os
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from sqlalchemy import update

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Song
from karaoke_backend.workers import llm_paging


WAV = (
    b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    b"\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
)



@pytest.fixture(autouse=True)
def clean_stems_root(monkeypatch):
    monkeypatch.setenv("KARAOKE_LLM_BASE_URL", "http://llm.invalid/v1")
    """A song directory per test, not per session.

    ``STEMS_DIR`` is one temp directory for the whole run while the database
    is recreated per test, so song ids restart at 1 and every test would
    inherit the previous one's stem files under the same path.
    """
    root = Path(os.environ["STEMS_DIR"])
    for child in root.iterdir():
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()
    yield


def _canned_word_data(lines=None) -> dict:
    """A minimal word_data payload in the shape the workers return."""
    return {
        "segments": [],
        "lines": lines if lines is not None else [
            [
                {"text": "hello", "start": 0.0, "end": 0.5},
                {"text": "world", "start": 0.5, "end": 1.0},
            ],
            [
                {"text": "second", "start": 1.5, "end": 2.0},
                {"text": "line", "start": 2.0, "end": 2.5},
            ],
        ],
        "metadata": {
            "words_total": 4, "words_matched": 0, "words_corrected": 0,
            "words_interpolated": 0, "lines_total": 2,
            "method": "whisper-only",
            "artist": "Test", "title": "Pager", "language": "en",
            "model": "heart", "use_vad": True, "ref_mode": "none",
            "pipeline_config": {},
        },
    }


async def _create_song(client: AsyncClient) -> int:
    """Upload a song with the pipeline stubbed, then mark it ready.

    A real ingest leaves the row `ready`, and the three re-trigger routes
    refuse anything else — so the stub has to leave it there too, or
    every test below would be measuring the status guard.
    """
    with patch("karaoke_backend.jobs.ingest.run_ingest", new=AsyncMock()):
        resp = await client.post(
            "/api/separate",
            files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
            data={"artist": "Test", "title": "Pager"},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1
    song_id = resp.json()["song_id"]
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(status="ready"))
        await db.commit()
    return song_id


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


async def _newest_set(client: AsyncClient, song_id: int) -> dict:
    sets = (await client.get(f"/api/songs/{song_id}/lyrics")).json()
    assert sets, "no lyrics sets were saved"
    detail = await client.get(f"/api/songs/{song_id}/lyrics/{sets[-1]['id']}")
    return detail.json()


# ---------------------------------------------------------------------------
# The flags travel: route → payload → worker
# ---------------------------------------------------------------------------






@pytest.mark.asyncio
async def test_llm_flags_default_off(client: AsyncClient):
    """A re-sync that says nothing must reach no third party at all."""
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    mock_gws = AsyncMock(return_value=_canned_word_data())
    mock_paging = AsyncMock()
    with patch("karaoke_backend.jobs.transcribe.generate_word_sync", new=mock_gws), \
         patch("karaoke_backend.jobs.transcribe.page_word_sync", new=mock_paging):
        resp = await client.post(
            f"/api/songs/{song_id}/lyrics/transcribe",
            json={"whisper_model": "heart"},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1

    assert not hasattr(mock_gws.call_args.kwargs["pipeline_config"], "correction")
    assert "correction_progress_fn" not in mock_gws.call_args.kwargs
    mock_paging.assert_not_called()


# ---------------------------------------------------------------------------
# Paging on the two sync routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transcribe_pages_against_the_reference_when_there_is_one(
    client: AsyncClient,
):
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    pages = [{"lines": ["hello world"], "new_section": True},
             {"lines": ["second line"], "new_section": False}]
    with patch("karaoke_backend.jobs.transcribe.generate_word_sync",
               new=AsyncMock(return_value=_canned_word_data())), \
         patch.object(llm_paging, "structure_pages", return_value=pages) as sp:
        resp = await client.post(
            f"/api/songs/{song_id}/lyrics/transcribe",
            json={
                "whisper_model": "heart",
                "reference_mode": "paste",
                "plain_lyrics": "hello world\nsecond line",
                "llm_paging": True,
            },
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1

    assert sp.call_args.args[1] == "hello world\nsecond line"
    saved = await _newest_set(client, song_id)
    assert saved["metadata"][llm_paging.PAGING_STATUS_KEY] == llm_paging.PAGING_APPLIED
    assert len(saved["word_sync"]["pages"]) == 2
    # No label suffix — paging is a display grouping, and the upload path that
    # has always done it adds none either.
    assert not saved["label"].endswith("-paged")


@pytest.mark.asyncio
async def test_paging_falls_back_to_the_transcription_lines(client: AsyncClient):
    """With no reference, the transcription's own lines are the paging input —
    otherwise the far more common unanchored run could never be paged."""
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    with patch("karaoke_backend.jobs.transcribe.generate_word_sync",
               new=AsyncMock(return_value=_canned_word_data())), \
         patch.object(llm_paging, "structure_pages", return_value=None) as sp:
        resp = await client.post(
            f"/api/songs/{song_id}/lyrics/transcribe",
            json={"whisper_model": "heart", "llm_paging": True},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1

    assert sp.call_args.args[1] == "hello world\nsecond line"


@pytest.mark.asyncio
async def test_paging_that_produces_nothing_still_saves_the_set(client: AsyncClient):
    """A song with un-paged lyrics is a working song. The metadata says the
    LLM was asked and declined, so the outcome is not silent."""
    song_id = await _create_song(client)
    _ensure_vocals(song_id)

    with patch("karaoke_backend.jobs.transcribe.generate_word_sync",
               new=AsyncMock(return_value=_canned_word_data())), \
         patch.object(llm_paging, "structure_pages", return_value=None):
        resp = await client.post(
            f"/api/songs/{song_id}/lyrics/transcribe",
            json={"whisper_model": "heart", "llm_paging": True},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1

    saved = await _newest_set(client, song_id)
    assert (
        saved["metadata"][llm_paging.PAGING_STATUS_KEY]
        == llm_paging.PAGING_UNAVAILABLE
    )
    assert "pages" not in (saved["word_sync"] or {})


@pytest.mark.asyncio
async def test_realign_pages_too(client: AsyncClient):
    song_id = await _create_song(client)
    _ensure_vocals(song_id)
    _write_cache(song_id)

    pages = [{"lines": ["hello world", "second line"], "new_section": True}]
    with patch("karaoke_backend.jobs.transcribe.realign_only",
               new=AsyncMock(return_value=_canned_word_data())), \
         patch.object(llm_paging, "structure_pages", return_value=pages):
        resp = await client.post(
            f"/api/songs/{song_id}/lyrics/realign",
            json={"whisper_model": "heart", "llm_paging": True},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1

    saved = await _newest_set(client, song_id)
    assert saved["metadata"][llm_paging.PAGING_STATUS_KEY] == llm_paging.PAGING_APPLIED


# ---------------------------------------------------------------------------
# The standalone re-page
# ---------------------------------------------------------------------------


async def _make_word_sync_set(client: AsyncClient, song_id: int, **over) -> int:
    body = {
        "source": "transcription",
        "label": "heart-vad",
        "word_sync_json": _canned_word_data(),
        "activate": True,
    }
    body.update(over)
    resp = await client.post(f"/api/songs/{song_id}/lyrics", json=body)
    assert resp.status_code == 201
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_page_without_word_sync_is_409(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("KARAOKE_LLM_BASE_URL", "http://llm.invalid/v1")
    song_id = await _create_song(client)
    resp = await client.post(
        f"/api/songs/{song_id}/lyrics",
        json={"source": "manual", "plain_lyrics": "hello world", "activate": True},
    )
    lid = resp.json()["id"]

    page = await client.post(f"/api/songs/{song_id}/lyrics/{lid}/page", json={})
    assert page.status_code == 409
    assert "word timings" in page.json()["detail"]


@pytest.mark.asyncio
async def test_page_without_an_llm_endpoint_is_503(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    """An unconfigured endpoint is an operator setting, not a job that queues
    and quietly declines a minute later."""
    monkeypatch.setenv("KARAOKE_LLM_BASE_URL", "   ")
    song_id = await _create_song(client)
    lid = await _make_word_sync_set(client, song_id)

    page = await client.post(f"/api/songs/{song_id}/lyrics/{lid}/page", json={})
    assert page.status_code == 503
    assert "KARAOKE_LLM_BASE_URL" in page.json()["detail"]


@pytest.mark.asyncio
async def test_page_saves_a_paged_sibling_with_the_same_source(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("KARAOKE_LLM_BASE_URL", "http://llm.invalid/v1")
    song_id = await _create_song(client)
    lid = await _make_word_sync_set(
        client, song_id, source="manual", label="hand-timed",
        plain_lyrics="hello world\nsecond line",
    )

    pages = [{"lines": ["hello world"], "new_section": True},
             {"lines": ["second line"], "new_section": False}]
    with patch.object(llm_paging, "structure_pages", return_value=pages) as sp:
        page = await client.post(
            f"/api/songs/{song_id}/lyrics/{lid}/page", json={"activate": True}
        )
        assert page.status_code == 202
        assert await run_queued_jobs_once() == 1

    # The set carries plain lyrics, so those are the paging input.
    assert sp.call_args.args[1] == "hello world\nsecond line"

    sets = (await client.get(f"/api/songs/{song_id}/lyrics")).json()
    assert len(sets) == 2
    new = [s for s in sets if s["id"] != lid][0]
    assert new["label"] == "hand-timed-paged"
    # Paging regroups words that were already there — it does not make a
    # hand-timed set into a transcription.
    assert new["source"] == "manual"
    assert new["is_active"] is True


@pytest.mark.asyncio
async def test_page_that_produces_nothing_saves_no_duplicate(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    """The failure mode this job exists to avoid: a library filling with
    identical sets labelled `-paged` that are not paged."""
    monkeypatch.setenv("KARAOKE_LLM_BASE_URL", "http://llm.invalid/v1")
    song_id = await _create_song(client)
    lid = await _make_word_sync_set(client, song_id)

    with patch.object(llm_paging, "structure_pages", return_value=None):
        page = await client.post(f"/api/songs/{song_id}/lyrics/{lid}/page", json={})
        assert page.status_code == 202
        job_id = page.json()["job_id"]
        assert await run_queued_jobs_once() == 1

    sets = (await client.get(f"/api/songs/{song_id}/lyrics")).json()
    assert [s["id"] for s in sets] == [lid]

    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "failed"
    assert job["message"] == "LLM paging produced no pages"


@pytest.mark.asyncio
async def test_page_uses_the_transcription_lines_when_the_set_has_no_reference(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("KARAOKE_LLM_BASE_URL", "http://llm.invalid/v1")
    song_id = await _create_song(client)
    lid = await _make_word_sync_set(client, song_id)

    with patch.object(llm_paging, "structure_pages", return_value=None) as sp:
        page = await client.post(f"/api/songs/{song_id}/lyrics/{lid}/page", json={})
        assert page.status_code == 202
        assert await run_queued_jobs_once() == 1

    assert sp.call_args.args[1] == "hello world\nsecond line"


# ---------------------------------------------------------------------------
