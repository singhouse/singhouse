# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for GET /api/lyrics/lookup — the pre-ingest reference-lyrics preview."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from karaoke_backend.workers.lyrics_worker import (
    LRCLIB_ENV,
    LyricsNotFoundError,
    LyricsResult,
    LyricsServiceError,
)

PARAMS = {"artist": "Test Artist", "title": "Test Title"}
FETCH = "karaoke_backend.api.lyrics.fetch_lyrics"


@pytest.fixture
def lookup_on(monkeypatch):
    monkeypatch.setenv(LRCLIB_ENV, "1")


@pytest.fixture
def lookup_off(monkeypatch):
    monkeypatch.delenv(LRCLIB_ENV, raising=False)


@pytest.mark.asyncio
async def test_found_returns_plain_lyrics(lookup_on, client: AsyncClient):
    result = LyricsResult(
        artist="Test Artist",
        title="Test Title",
        album=None,
        duration=200.0,
        plain_lyrics="  la la line one\nla la line two  ",
        synced_lyrics="[00:01.00] la la line one\n[00:02.00] la la line two",
    )
    fetch = AsyncMock(return_value=result)
    with patch(FETCH, new=fetch):
        response = await client.get("/api/lyrics/lookup", params=PARAMS)

    assert response.status_code == 200
    assert response.json() == {
        "found": True,
        "plain_lyrics": "la la line one\nla la line two",
        "synced": True,
    }
    fetch.assert_awaited_once_with(artist="Test Artist", title="Test Title")


@pytest.mark.asyncio
async def test_not_found_is_an_ordinary_answer(lookup_on, client: AsyncClient):
    with patch(FETCH, new=AsyncMock(side_effect=LyricsNotFoundError("nope"))):
        response = await client.get("/api/lyrics/lookup", params=PARAMS)

    assert response.status_code == 200
    assert response.json() == {"found": False, "plain_lyrics": None, "synced": False}


@pytest.mark.asyncio
async def test_synced_only_match_has_no_plain_text(lookup_on, client: AsyncClient):
    result = LyricsResult(
        artist="Test Artist", title="Test Title", album=None, duration=None,
        plain_lyrics=None, synced_lyrics="[00:01.00] la la",
    )
    with patch(FETCH, new=AsyncMock(return_value=result)):
        response = await client.get("/api/lyrics/lookup", params=PARAMS)

    assert response.status_code == 200
    assert response.json() == {"found": False, "plain_lyrics": None, "synced": True}


@pytest.mark.asyncio
async def test_service_error_is_502(lookup_on, client: AsyncClient):
    with patch(FETCH, new=AsyncMock(side_effect=LyricsServiceError("down"))):
        response = await client.get("/api/lyrics/lookup", params=PARAMS)

    assert response.status_code == 502


@pytest.mark.asyncio
async def test_refuses_without_contacting_anything_when_off(lookup_off, client: AsyncClient):
    fetch = AsyncMock()
    with patch(FETCH, new=fetch):
        response = await client.get("/api/lyrics/lookup", params=PARAMS)

    assert response.status_code == 404
    fetch.assert_not_called()


@pytest.mark.asyncio
async def test_requires_artist_and_title(lookup_on, client: AsyncClient):
    response = await client.get("/api/lyrics/lookup", params={"artist": "Test Artist"})
    assert response.status_code == 422
