# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for the provider registry v2 surface: entry-point discovery,
KARAOKE_PROVIDERS allowlist, provider_routers / extension_routers /
resolve_legacy_metadata, and the /{lid:int} convertor 404 degrade.
"""

from __future__ import annotations

import importlib.metadata
from unittest.mock import patch

import pytest
from httpx import AsyncClient

import karaoke_backend.api.providers as registry
from karaoke_backend import plugins


@pytest.fixture
def clean_registry():
    before = dict(registry._REGISTRY)
    try:
        yield
    finally:
        registry._REGISTRY.clear()
        registry._REGISTRY.update(before)


class _StubProvider:
    def __init__(self, name="stub"):
        self.name = name
        self.label = name.title()
        self.icon = "🔧"
        self.available = True
        self.capabilities = frozenset({"search", "source-doc"})

    def filename_for(self, external_id: str) -> str:
        return f"{self.name}-{external_id}.bin"

    def routers(self):
        return []

    def parse_legacy_metadata(self, md: dict):
        if f"{self.name}_id" in md:
            return (self.name, str(md[f"{self.name}_id"]), md.get("format_version"))
        return None

    async def search(self, q, *, offset=0, hydrate=True):
        return []

    async def info(self, external_id):
        return None

    async def run_import(self, *, job_id, song_id, owner_id, external_id):
        pass


class _FakeEP:
    def __init__(self, name, factory):
        self.name = name
        self._factory = factory
        self.dist = type("D", (), {"name": "karaoke-premium"})()

    def load(self):
        return self._factory


def _patch_eps(monkeypatch, eps_by_group: dict):
    def fake_entry_points(*, group=None):
        return eps_by_group.get(group, [])
    monkeypatch.setattr(importlib.metadata, "entry_points", fake_entry_points)


def test_allowlist_none_blocks_discovery(monkeypatch, clean_registry):
    provider = _StubProvider("blocked")
    _patch_eps(monkeypatch, {
        plugins.GROUP_CATALOG_PROVIDERS: [_FakeEP("blocked", lambda: provider)],
    })
    monkeypatch.setenv("KARAOKE_PROVIDERS", "none")
    plugins._load_catalog_entry_points()
    assert registry.get_provider("blocked") is None


def test_allowlist_comma_restricts(monkeypatch, clean_registry):
    wanted = _StubProvider("wanted")
    unwanted = _StubProvider("unwanted")
    _patch_eps(monkeypatch, {
        plugins.GROUP_CATALOG_PROVIDERS: [
            _FakeEP("wanted", lambda: wanted),
            _FakeEP("unwanted", lambda: unwanted),
        ],
    })
    monkeypatch.setenv("KARAOKE_PROVIDERS", "wanted")
    plugins._load_catalog_entry_points()
    assert registry.get_provider("wanted") is wanted
    assert registry.get_provider("unwanted") is None


def test_allowlist_unset_loads_all(monkeypatch, clean_registry):
    provider = _StubProvider("all")
    _patch_eps(monkeypatch, {
        plugins.GROUP_CATALOG_PROVIDERS: [_FakeEP("all", lambda: provider)],
    })
    monkeypatch.delenv("KARAOKE_PROVIDERS", raising=False)
    plugins._load_catalog_entry_points()
    assert registry.get_provider("all") is provider


def test_broken_factory_containment(monkeypatch, clean_registry):
    good = _StubProvider("good")

    def bad_factory():
        raise RuntimeError("boom")

    _patch_eps(monkeypatch, {
        plugins.GROUP_CATALOG_PROVIDERS: [
            _FakeEP("bad", bad_factory),
            _FakeEP("good", lambda: good),
        ],
    })
    monkeypatch.delenv("KARAOKE_PROVIDERS", raising=False)
    plugins._load_catalog_entry_points()
    assert registry.get_provider("good") is good
    assert registry.get_provider("bad") is None


def test_v1_provider_tolerance(clean_registry):
    class V1Provider:
        name = "v1"
        label = "V1"
        icon = ""
        available = True

        def filename_for(self, eid):
            return f"v1-{eid}.bin"

    registry.register(V1Provider())
    assert registry.get_provider("v1") is not None
    assert registry.provider_routers() == []
    assert registry.resolve_legacy_metadata({"v1_id": "x"}) is None


def test_provider_routers_collects(clean_registry):
    from fastapi import APIRouter

    r = APIRouter()
    provider = _StubProvider("routed")
    provider.routers = lambda: [r]
    registry.register(provider)
    assert registry.provider_routers() == [r]


def test_resolve_legacy_metadata(clean_registry):
    provider = _StubProvider("prov")
    registry.register(provider)
    result = registry.resolve_legacy_metadata({"prov_id": 42, "format_version": 2})
    assert result == ("prov", "42", 2)
    assert registry.resolve_legacy_metadata({"unknown_key": 1}) is None


def test_extension_routers_empty_when_no_eps(monkeypatch, clean_registry):
    _patch_eps(monkeypatch, {})
    assert registry.extension_routers() == []


@pytest.mark.asyncio
async def test_core_only_literal_lyrics_path_404s(client: AsyncClient, host_user: dict):
    """Core-only mode: GET .../lyrics/anything.xml → 404 (int convertor)."""
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import Song

    async with AsyncSessionLocal() as db:
        song = Song(
            artist="A", title="T", filename="a.flac",
            duration=100.0, status="ready", job_id="j",
            owner_id=host_user["id"],
        )
        db.add(song)
        await db.commit()
        await db.refresh(song)
        song_id = song.id

    resp = await client.get(f"/api/songs/{song_id}/lyrics/anything.xml")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_core_only_reparse_literal_404s(client: AsyncClient, host_user: dict):
    """Core-only mode: POST .../reparse-anything → 404."""
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import Song

    async with AsyncSessionLocal() as db:
        song = Song(
            artist="A", title="T", filename="a.flac",
            duration=100.0, status="ready", job_id="j",
            owner_id=host_user["id"],
        )
        db.add(song)
        await db.commit()
        await db.refresh(song)
        song_id = song.id

    resp = await client.post(f"/api/songs/{song_id}/lyrics/reparse-anything")
    assert resp.status_code in (404, 405)


@pytest.mark.asyncio
async def test_providers_endpoint_returns_capabilities(
    client: AsyncClient, clean_registry
):
    """GET /api/catalog/providers includes capabilities for registered providers."""
    provider = _StubProvider("cap-test")
    registry.register(provider)
    resp = await client.get("/api/catalog/providers")
    assert resp.status_code == 200
    data = resp.json()
    match = [p for p in data if p["name"] == "cap-test"]
    assert len(match) == 1
    assert sorted(match[0]["capabilities"]) == ["search", "source-doc"]
