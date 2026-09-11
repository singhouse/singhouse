# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for the /api/lyrics endpoint."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from karaoke_backend.workers.lyrics_worker import LyricsNotFoundError, LyricsResult, LyricsServiceError


@pytest.mark.asyncio
async def test_lyrics_found(client: AsyncClient):
    """Successful lyrics fetch returns 200 with expected fields."""
    mock_result = LyricsResult(
        artist="Radiohead",
        title="Creep",
        album="Pablo Honey",
        duration=238.0,
        plain_lyrics="When you were here before\nCouldn't look you in the eye",
        synced_lyrics="[00:01.00] When you were here before\n[00:03.50] Couldn't look you in the eye",
    )

    with patch("karaoke_backend.api.lyrics.fetch_lyrics", new=AsyncMock(return_value=mock_result)):
        response = await client.get("/api/lyrics", params={"artist": "Radiohead", "title": "Creep"})

    assert response.status_code == 200
    data = response.json()
    assert data["artist"] == "Radiohead"
    assert data["title"] == "Creep"
    assert data["has_sync"] is True
    assert "When you were here before" in data["plain_lyrics"]
    assert len(data["lines"]) == 2
    assert data["source"] == "lrclib.net"


@pytest.mark.asyncio
async def test_lyrics_not_found(client: AsyncClient):
    """Unknown song returns 404."""
    with patch(
        "karaoke_backend.api.lyrics.fetch_lyrics",
        new=AsyncMock(side_effect=LyricsNotFoundError("not found")),
    ):
        response = await client.get(
            "/api/lyrics", params={"artist": "Unknown Artist", "title": "No Such Song"}
        )

    assert response.status_code == 404
    assert "No lyrics found" in response.json()["detail"]


@pytest.mark.asyncio
async def test_lyrics_service_error(client: AsyncClient):
    """Upstream service failure returns 502."""
    with patch(
        "karaoke_backend.api.lyrics.fetch_lyrics",
        new=AsyncMock(side_effect=LyricsServiceError("network error")),
    ):
        response = await client.get(
            "/api/lyrics", params={"artist": "Radiohead", "title": "Creep"}
        )

    assert response.status_code == 502


@pytest.mark.asyncio
async def test_lyrics_missing_params(client: AsyncClient):
    """Missing required query params returns 422."""
    response = await client.get("/api/lyrics")
    assert response.status_code == 422

    response = await client.get("/api/lyrics", params={"artist": "Radiohead"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_lyrics_no_sync(client: AsyncClient):
    """Song without synced lyrics returns has_sync=False."""
    mock_result = LyricsResult(
        artist="Bob Dylan",
        title="Blowin in the Wind",
        album=None,
        duration=None,
        plain_lyrics="How many roads must a man walk down",
        synced_lyrics=None,
    )

    with patch("karaoke_backend.api.lyrics.fetch_lyrics", new=AsyncMock(return_value=mock_result)):
        response = await client.get(
            "/api/lyrics", params={"artist": "Bob Dylan", "title": "Blowin in the Wind"}
        )

    assert response.status_code == 200
    assert response.json()["has_sync"] is False
    assert response.json()["synced_lyrics"] is None
