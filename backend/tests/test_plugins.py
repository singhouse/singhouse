# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for karaoke_backend.plugins — entry-point group loading + the
three-source load path that replaced the old write-at-import autoloader.

Covers:
- entry-point catalog registration goes through the frozen registry;
- a factory (or a plugin import) that raises is logged and skipped, never
  killing boot;
- iter_group isolates a broken ``ep.load()``;
- zero catalog providers by default (core declares none, by design);
- KARAOKE_PROVIDERS_DIR loads an external module AND writes no __init__.py
  (the old autoloader's flaw stays dead);
- the package-adjacent local/ scan stays removed;
- load_all() is idempotent (the _loaded flag).
"""

from __future__ import annotations

import importlib.metadata
import types
from typing import Optional

import pytest

import karaoke_backend.api.providers as registry
from karaoke_backend import plugins
from karaoke_backend.api.catalog import ProviderHit, ProviderInfo


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _StubProvider:
    """Minimal CatalogProvider-shaped object for registration tests."""

    def __init__(self, name: str = "stub") -> None:
        self.name = name
        self.label = name.title()
        self.icon = "🧩"
        self.available = True

    def filename_for(self, external_id: str) -> str:
        return f"{self.name}-{external_id}.bin"

    async def search(self, q, *, offset: int = 0, hydrate: bool = True) -> list[ProviderHit]:
        return []

    async def info(self, external_id: str) -> Optional[ProviderInfo]:
        return None

    async def run_import(self, *, job_id, song_id, owner_id, external_id) -> None:
        return None


class _FakeEntryPoint:
    """Stand-in for importlib.metadata.EntryPoint with a scripted ``load()``.

    ``load()`` returns whatever the entry point *resolves to* — for the catalog
    group that is a zero-arg factory (the loader then calls it), not a provider
    instance. Pass ``raises=`` to simulate a plugin that blows up on import.
    """

    def __init__(self, name: str, *, returns=None, raises: Exception | None = None) -> None:
        self.name = name
        self._returns = returns
        self._raises = raises

    def load(self):
        if self._raises is not None:
            raise self._raises
        return self._returns


def _patch_entry_points(monkeypatch, group_to_eps: dict[str, list[_FakeEntryPoint]]) -> None:
    """Replace importlib.metadata.entry_points with a group-scoped fake."""

    def _fake(*, group: str = "", **_kw):
        return list(group_to_eps.get(group, []))

    monkeypatch.setattr(importlib.metadata, "entry_points", _fake)


@pytest.fixture
def clean_registry():
    """Snapshot + restore the provider registry around a test."""
    before = dict(registry._REGISTRY)
    try:
        yield
    finally:
        registry._REGISTRY.clear()
        registry._REGISTRY.update(before)


# ---------------------------------------------------------------------------
# Group constants
# ---------------------------------------------------------------------------


def test_four_group_constants_are_namespaced_and_distinct() -> None:
    groups = [
        plugins.GROUP_CATALOG_PROVIDERS,
        plugins.GROUP_TRANSCRIBERS,
        plugins.GROUP_SEPARATORS,
        plugins.GROUP_LYRICS_PROVIDERS,
    ]
    assert all(isinstance(g, str) and g.startswith("karaoke_backend.") for g in groups)
    assert len(set(groups)) == 4
    # ALL_GROUPS is the introspection surface; it must include the four.
    assert set(groups) <= set(plugins.ALL_GROUPS)


# ---------------------------------------------------------------------------
# iter_group
# ---------------------------------------------------------------------------


def test_iter_group_yields_name_and_object(monkeypatch) -> None:
    sentinel = object()
    _patch_entry_points(
        monkeypatch,
        {plugins.GROUP_TRANSCRIBERS: [_FakeEntryPoint("x", returns=sentinel)]},
    )
    assert list(plugins.iter_group(plugins.GROUP_TRANSCRIBERS)) == [("x", sentinel)]


def test_iter_group_skips_broken_load(monkeypatch, caplog) -> None:
    _patch_entry_points(
        monkeypatch,
        {
            plugins.GROUP_SEPARATORS: [
                _FakeEntryPoint("bad", raises=RuntimeError("import blew up")),
                _FakeEntryPoint("good", returns="ok"),
            ]
        },
    )
    with caplog.at_level("ERROR"):
        got = list(plugins.iter_group(plugins.GROUP_SEPARATORS))
    assert got == [("good", "ok")]
    assert any("bad" in rec.getMessage() for rec in caplog.records)


# ---------------------------------------------------------------------------
# Catalog entry points -> frozen registry
# ---------------------------------------------------------------------------


def test_catalog_entry_point_registers_via_frozen_registry(
    monkeypatch, clean_registry
) -> None:
    monkeypatch.delenv("KARAOKE_PROVIDERS", raising=False)
    provider = _StubProvider("stub")
    # The entry point resolves to a zero-arg factory returning the provider.
    _patch_entry_points(
        monkeypatch,
        {plugins.GROUP_CATALOG_PROVIDERS: [_FakeEntryPoint("stub", returns=lambda: provider)]},
    )
    plugins._load_catalog_entry_points()
    assert registry.get_provider("stub") is provider


def test_catalog_name_mismatch_warns_but_registers(
    monkeypatch, clean_registry, caplog
) -> None:
    monkeypatch.delenv("KARAOKE_PROVIDERS", raising=False)
    provider = _StubProvider("actual-name")
    _patch_entry_points(
        monkeypatch,
        {
            plugins.GROUP_CATALOG_PROVIDERS: [
                _FakeEntryPoint("declared-name", returns=lambda: provider)
            ]
        },
    )
    with caplog.at_level("WARNING"):
        plugins._load_catalog_entry_points()
    assert registry.get_provider("actual-name") is provider
    assert any("mismatch" in rec.getMessage() for rec in caplog.records)


def test_raising_factory_logged_and_skipped(
    monkeypatch, clean_registry, caplog
) -> None:
    monkeypatch.delenv("KARAOKE_PROVIDERS", raising=False)
    good = _StubProvider("good")

    def _boom_factory():
        raise ValueError("factory exploded")

    _patch_entry_points(
        monkeypatch,
        {
            plugins.GROUP_CATALOG_PROVIDERS: [
                # entry point resolves fine; the factory raises when called
                _FakeEntryPoint("bad", returns=_boom_factory),
                _FakeEntryPoint("good", returns=lambda: good),
            ]
        },
    )
    with caplog.at_level("ERROR"):
        plugins._load_catalog_entry_points()  # must not raise
    assert registry.get_provider("good") is good
    assert registry.get_provider("bad") is None


def test_zero_catalog_providers_by_default(clean_registry) -> None:
    """The CORE distribution declares zero catalog entry points.

    Premium (karaoke-premium) may declare entry points when installed
    editable in a shared dev venv — that's expected. The invariant
    is that karaoke-backend itself ships none.
    """
    core_eps = [
        ep
        for ep in importlib.metadata.entry_points(group=plugins.GROUP_CATALOG_PROVIDERS)
        if ep.dist is not None and ep.dist.name == "karaoke-backend"
    ]
    assert core_eps == []


# ---------------------------------------------------------------------------
# KARAOKE_PROVIDERS_DIR (source 3) — loads + never writes into the dir
# ---------------------------------------------------------------------------


_EXT_PROVIDER_SRC = '''
from karaoke_backend.api.providers import register


class _ExtProvider:
    name = "ext-scratch"
    label = "Ext Scratch"
    icon = "🧩"
    available = True

    def filename_for(self, external_id):
        return f"ext-{external_id}.bin"

    async def search(self, q, *, offset=0, hydrate=True):
        return []

    async def info(self, external_id):
        return None

    async def run_import(self, *, job_id, song_id, owner_id, external_id):
        return None


register(_ExtProvider())
'''


def test_providers_dir_loads_module_and_writes_no_init(
    monkeypatch, clean_registry, tmp_path
) -> None:
    (tmp_path / "extmod.py").write_text(_EXT_PROVIDER_SRC, encoding="utf-8")
    monkeypatch.setenv(plugins.PROVIDERS_DIR_ENV, str(tmp_path))

    plugins._load_providers_dir()

    assert registry.get_provider("ext-scratch") is not None
    # The loader must NEVER write an __init__.py into a provider directory.
    assert not (tmp_path / "__init__.py").exists()


def test_providers_dir_missing_is_noop(monkeypatch, clean_registry, tmp_path) -> None:
    monkeypatch.setenv(plugins.PROVIDERS_DIR_ENV, str(tmp_path / "does-not-exist"))
    before = set(registry._REGISTRY)
    plugins._load_providers_dir()  # must not raise
    assert set(registry._REGISTRY) == before


# ---------------------------------------------------------------------------
# Package-adjacent local/ scan — REMOVED (its transition purpose is over)
# ---------------------------------------------------------------------------


def test_local_dir_scan_is_gone() -> None:
    """The interim local/ scan was deliberately removed: a stale local/ copy would
    silently REPLACE an entry-point-registered provider (later source wins).
    Guard against reintroduction."""
    assert not hasattr(plugins, "_load_local_dir")


# ---------------------------------------------------------------------------
# load_all idempotency
# ---------------------------------------------------------------------------


def test_load_all_is_idempotent(monkeypatch) -> None:
    calls = {"catalog": 0, "dir": 0}

    monkeypatch.setattr(
        plugins, "_load_catalog_entry_points",
        lambda: calls.__setitem__("catalog", calls["catalog"] + 1),
    )
    monkeypatch.setattr(
        plugins, "_load_providers_dir",
        lambda: calls.__setitem__("dir", calls["dir"] + 1),
    )
    monkeypatch.setattr(plugins, "_loaded", False)

    plugins.load_all()
    plugins.load_all()

    assert calls == {"catalog": 1, "dir": 1}
