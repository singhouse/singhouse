# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for /api/catalog/providers — the core discovery endpoint.

Search, info, and import routes live in the premium package and are
tested in premium/backend/tests/test_catalog_routes.py.
"""

from __future__ import annotations

from typing import Iterator

import pytest
from httpx import AsyncClient

from karaoke_backend.api.auth import Principal, require_user_or_guest
from karaoke_backend.api.identity import Identity
from karaoke_backend.main import app
from tests.fake_provider import FakeProvider


@pytest.fixture
def fake_provider() -> Iterator[FakeProvider]:
    """Register a fresh FakeProvider for the duration of one test."""
    import karaoke_backend.api.providers as registry

    fake = FakeProvider()
    registry.register(fake)
    try:
        yield fake
    finally:
        registry._REGISTRY.pop(fake.name, None)


@pytest.mark.asyncio
async def test_providers_lists_available_only(
    client: AsyncClient, fake_provider: FakeProvider
):
    fake_provider.available = True
    resp = await client.get("/api/catalog/providers")
    assert resp.status_code == 200
    names = [p["name"] for p in resp.json()]
    assert "fake" in names

    fake_provider.available = False
    resp = await client.get("/api/catalog/providers")
    assert resp.status_code == 200
    assert "fake" not in [p["name"] for p in resp.json()]


@pytest.mark.asyncio
async def test_providers_empty_when_none_registered(client: AsyncClient):
    resp = await client.get("/api/catalog/providers")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("is_guest", [True, False], ids=["guest", "host"])
@pytest.mark.parametrize("guest_capable", [True, False], ids=["opted-in", "host-only"])
@pytest.mark.parametrize("gate", ["default", "global-off", "provider-off", "on"])
async def test_provider_discovery_respects_guest_import_access(
    client: AsyncClient,
    fake_provider: FakeProvider,
    monkeypatch: pytest.MonkeyPatch,
    is_guest: bool,
    guest_capable: bool,
    gate: str,
):
    monkeypatch.delenv("KARAOKE_GUEST_IMPORT", raising=False)
    monkeypatch.delenv("KARAOKE_GUEST_IMPORT_FAKE", raising=False)
    if guest_capable:
        fake_provider.capabilities = fake_provider.capabilities | {"guest-import"}
    if gate == "global-off":
        monkeypatch.setenv("KARAOKE_GUEST_IMPORT", "off")
    elif gate == "provider-off":
        monkeypatch.setenv("KARAOKE_GUEST_IMPORT_FAKE", "off")
    elif gate == "on":
        # Environment values cannot grant access without provider opt-in.
        monkeypatch.setenv("KARAOKE_GUEST_IMPORT", "on")
        monkeypatch.setenv("KARAOKE_GUEST_IMPORT_FAKE", "on")

    principal = Principal(
        host_id=1,
        identity=None if is_guest else Identity(id=1),
    )
    monkeypatch.setitem(app.dependency_overrides, require_user_or_guest, lambda: principal)

    resp = await client.get("/api/catalog/providers")
    assert resp.status_code == 200
    guest_allowed = guest_capable and gate in {"default", "on"}
    if is_guest and not guest_allowed:
        assert resp.json() == []
    else:
        assert resp.json() == [{
            "name": fake_provider.name,
            "label": fake_provider.label,
            "icon": fake_provider.icon,
            "capabilities": sorted(fake_provider.capabilities),
            "guest_import": guest_allowed,
        }]


@pytest.mark.asyncio
async def test_search_404_without_premium_routes(client: AsyncClient):
    """Core-only boot: search routes don't exist (premium not mounted)."""
    resp = await client.get("/api/catalog/anything/search", params={"q": "test"})
    assert resp.status_code == 404
