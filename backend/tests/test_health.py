# SPDX-License-Identifier: AGPL-3.0-only
"""Basic health / meta endpoint tests."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health(client: AsyncClient):
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data


@pytest.mark.asyncio
async def test_api_info(client: AsyncClient):
    response = await client.get("/api")
    assert response.status_code == 200
    data = response.json()
    assert "endpoints" in data
    assert "separate" in data["endpoints"]
    assert "lyrics" in data["endpoints"]


@pytest.mark.asyncio
async def test_openapi_docs_available(client: AsyncClient):
    response = await client.get("/docs")
    assert response.status_code == 200
