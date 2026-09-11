# SPDX-License-Identifier: AGPL-3.0-only
"""Plugin discovery + entry-point group contracts for ``karaoke_backend``.

This module is the single owner of the plugin ABI. It declares the
entry-point group names a future premium wheel registers into, documents the
per-group factory contracts every consumer codes against, and drives the
one-shot, three-source plugin load that runs from the app lifespan (never at
import time).

Entry-point groups
==================

The four constants below are the *only* place group names are spelled. Group
names embed the package name **by design**: core and premium wheels are cut
in a single packaging operation at release, so a plugin ABI rename is
atomic. Do not "stabilize" the interim names — they move with the package
name.

This block is owned here and is deliberately extensible. Keep new group
constants in this block and mirror them into ``ALL_GROUPS``.

Per-group factory contracts
===========================

``catalog_providers`` (fully loaded by :func:`load_all` now):
    Each entry point resolves to a **zero-arg factory** returning an object
    satisfying the ``CatalogProvider`` protocol (``api/catalog.py``). The
    loader calls ``factory()`` and passes the result to the **unchanged**
    registry ``register()`` (``api/providers/__init__.py`` — a frozen seam). If
    ``ep.name != provider.name`` a warning is logged. Core declares **zero**
    catalog entry points by design; providers arrive from installed packages'
    entry points or from ``KARAOKE_PROVIDERS_DIR``.

``transcribers`` (contract documented here; consumed by ``word_sync_worker``
via :func:`instantiate_group` — additive selection only, the built-in dispatch
chain is never refactored):
    Factory resolves to an object exposing
    ``{name: str, models: frozenset[str], priority: int,
       is_enabled() -> bool, create(model, *, use_vad) -> lyricsync Transcriber}``.
    Documented built-in priorities encode today's verified chain in
    ``word_sync_worker`` (modal -> remote -> heart-local -> faster-whisper),
    see :data:`BUILTIN_TRANSCRIBER_PRIORITIES`. Plugins may only **add** model
    names; built-in names win collisions (a warning is logged), and the
    built-in dispatch chain is never reordered by a plugin.

``separators`` (contract documented here; consumed by ``modal_worker`` via
:func:`instantiate_group` — a plugin is selected only when ``KARAOKE_SEPARATOR``
names it):
    Factory resolves to an object exposing
    ``{name: str, priority: int, is_enabled() -> bool,
       async separate(audio_path, stems_dir, job_id, on_progress) -> dict}``
    codifying the ``modal_worker`` dispatch contract (``lead_vocals`` +
    ``backing_vocals`` land in ``stems_dir``). A plugin separator is selected
    **only** when the ``KARAOKE_SEPARATOR`` env names it; default dispatch is
    untouched.

``lyrics_providers`` (contract documented here; consumed by the lyrics path via
:func:`instantiate_group` — name-keyed, with ``lrclib`` the hardcoded default):
    Factory resolves to an object exposing
    ``{name: str, label: str, is_enabled() -> bool,
       async fetch(artist, title) -> LyricsResult}`` raising the existing
    ``LyricsNotFoundError`` / ``LyricsServiceError``. ``lrclib`` stays the
    **hardcoded built-in**; its opt-in / labeled / default-OFF semantics are
    untouched by plugin loading (bright line).

Built-ins are NEVER self-registered via entry points
====================================================

In shim / no-install mode ``importlib.metadata`` has no ``karaoke-backend``
distribution, so entry-point-registered built-ins would silently vanish
exactly when running uninstalled. Built-ins are hardcoded (lrclib), so
installed and shim modes stay behaviorally identical.

Two-source load (never writes into any source or provider directory)
=====================================================================

:func:`load_all` runs, in order:

1. **entry-point groups** — installed provider packages (premium wheels or
   out-of-repo packages such as the personal provider package);
2. ``KARAOKE_PROVIDERS_DIR`` **external dir** — the permanent self-hoster
   extension point, loaded under synthetic module names so an arbitrary
   directory never collides with the package namespace.

The interim package-adjacent ``api/providers/local/`` scan (the transition
carrier for the then-gitignored provider) was deliberately removed — the
provider is tracked out-of-repo and a stale ``local/`` copy would
silently REPLACE the entry-point registration (later source wins).

No loader path ever writes a file into a source or provider directory (the old
import-time autoloader wrote a ``local/__init__.py``; that flaw is gone).
"""

from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
import logging
import os
import sys
from pathlib import Path
from typing import Any, Iterator, Tuple

logger = logging.getLogger(__name__)

# --- Entry-point group names (ONE owner: this block) -------------------------
GROUP_CATALOG_PROVIDERS = "karaoke_backend.catalog_providers"
GROUP_API_ROUTERS = "karaoke_backend.api_routers"
GROUP_TRANSCRIBERS = "karaoke_backend.transcribers"
GROUP_SEPARATORS = "karaoke_backend.separators"
GROUP_LYRICS_PROVIDERS = "karaoke_backend.lyrics_providers"

#: Every declared entry-point group, for introspection and tooling. Grows when
#: a new GROUP_* constant is added above.
ALL_GROUPS: Tuple[str, ...] = (
    GROUP_CATALOG_PROVIDERS,
    GROUP_API_ROUTERS,
    GROUP_TRANSCRIBERS,
    GROUP_SEPARATORS,
    GROUP_LYRICS_PROVIDERS,
)

#: Documented built-in transcriber priorities — today's verified chain in
#: ``word_sync_worker`` (modal -> remote -> heart-local -> faster-whisper).
#: Plugins may only ADD model names; these built-ins win collisions.
BUILTIN_TRANSCRIBER_PRIORITIES: dict[str, int] = {
    "modal": 90,
    "remote": 80,
    "heart": 50,
    "faster-whisper": 10,
}

#: Env var naming an external directory of extra provider modules (source 3).
PROVIDERS_DIR_ENV = "KARAOKE_PROVIDERS_DIR"

#: Synthetic import-namespace for external ``KARAOKE_PROVIDERS_DIR`` modules —
#: keeps them off the real package namespace.
_EXTERNAL_NS = "karaoke_backend._local_providers"

_loaded = False


def iter_group(group: str) -> Iterator[Tuple[str, Any]]:
    """Yield ``(entry_point_name, loaded_object)`` for each entry point in
    ``group``.

    Each ``ep.load()`` is isolated: a plugin that raises on import is logged
    and skipped, never killing boot. This is the generic accessor every
    per-group consumer uses (catalog registration here; transcriber /
    separator / lyrics selection via :func:`instantiate_group`).
    """
    for ep in importlib.metadata.entry_points(group=group):
        try:
            obj = ep.load()
        except Exception:  # noqa: BLE001 — a broken plugin must not kill boot
            logger.exception(
                "Failed to load plugin %r from group %r", ep.name, group
            )
            continue
        yield ep.name, obj


def instantiate_group(group: str) -> list[Tuple[str, Any]]:
    """Load + instantiate every plugin advertised in ``group``, highest
    ``priority`` first.

    Each entry point resolves to a zero-arg factory (see the per-group
    contracts in the module docstring); this calls the factory and collects the
    resulting objects. A factory — or its import — that raises is logged and
    skipped: one broken plugin never breaks selection or kills boot. A missing
    ``priority`` attribute sorts last.

    This is the shared accessor the transcriber / separator / lyrics
    consumers use for **additive** backend selection. Core ships **zero**
    entry points in every group, so with no plugin wheel installed this returns
    ``[]`` and every built-in dispatch path stays byte-for-byte unchanged — the
    additive-hook invariant.
    """
    instances: list[Tuple[str, Any, int]] = []
    for name, factory in iter_group(group):
        try:
            obj = factory()
        except Exception:  # noqa: BLE001 — one bad factory must not break selection
            logger.exception(
                "Plugin factory %r in group %r raised — skipping", name, group
            )
            continue
        try:
            priority = int(getattr(obj, "priority", 0))
        except (TypeError, ValueError):
            priority = 0
        instances.append((name, obj, priority))
    instances.sort(key=lambda item: item[2], reverse=True)
    return [(name, obj) for name, obj, _priority in instances]


#: Env var restricting which catalog providers load from entry points.
#: ``"none"`` disables discovery entirely; a comma-separated list restricts
#: to the named entry points. Unset (default) loads all.
PROVIDERS_ALLOWLIST_ENV = "KARAOKE_PROVIDERS"


def _provider_allowlist() -> set[str] | None:
    """Parse KARAOKE_PROVIDERS. Returns None (load all), an empty set (load
    none), or a set of allowed entry-point names."""
    raw = os.getenv(PROVIDERS_ALLOWLIST_ENV, "").strip().lower()
    if not raw:
        return None
    if raw == "none":
        return set()
    return {s.strip() for s in raw.split(",") if s.strip()}


def _load_catalog_entry_points() -> None:
    """Source 1: register catalog providers advertised via entry points.

    Each entry point is a zero-arg factory returning a ``CatalogProvider``;
    the result is handed to the frozen registry ``register()``. Core declares
    zero catalog entry points by design, so this is a no-op until a premium
    wheel is installed.

    Honors ``KARAOKE_PROVIDERS``: ``"none"`` disables discovery, a comma list
    restricts it to the named entry points.
    """
    allowlist = _provider_allowlist()
    if allowlist is not None and len(allowlist) == 0:
        logger.debug("KARAOKE_PROVIDERS=none — skipping catalog entry-point discovery")
        return

    from karaoke_backend.api.providers import register

    for name, factory in iter_group(GROUP_CATALOG_PROVIDERS):
        if allowlist is not None and name not in allowlist:
            logger.debug("KARAOKE_PROVIDERS allowlist skips %r", name)
            continue
        try:
            provider = factory()
        except Exception:  # noqa: BLE001 — one bad factory must not kill boot
            logger.exception(
                "Catalog provider factory %r raised — skipping", name
            )
            continue
        provider_name = getattr(provider, "name", None)
        if provider_name != name:
            logger.warning(
                "Catalog entry point %r registers a provider named %r "
                "(name mismatch)",
                name,
                provider_name,
            )
        register(provider)


def _load_providers_dir() -> None:
    """Source 2: import each ``*.py`` in ``KARAOKE_PROVIDERS_DIR`` (an arbitrary
    external directory) under a synthetic module name.

    This is the permanent self-hoster extension point. Modules load via
    ``spec_from_file_location`` under ``karaoke_backend._local_providers.<stem>``
    so they never collide with the real package namespace, and no file is
    written into the external directory.
    """
    raw = os.getenv(PROVIDERS_DIR_ENV, "").strip()
    if not raw:
        return
    ext_dir = Path(raw).expanduser()
    if not ext_dir.is_dir():
        logger.warning(
            "%s=%s is not a directory — skipping", PROVIDERS_DIR_ENV, raw
        )
        return
    # Suppress bytecode caching for this load so no ``__pycache__`` is written
    # into the user-supplied provider directory — no loader writes into any
    # provider directory. Startup is single-threaded here (pre-serving), and
    # the flag is restored in ``finally``.
    _prev_dont_write = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        for py in sorted(ext_dir.glob("*.py")):
            stem = py.stem
            if stem.startswith("_"):
                continue
            mod_name = f"{_EXTERNAL_NS}.{stem}"
            try:
                spec = importlib.util.spec_from_file_location(mod_name, py)
                if spec is None or spec.loader is None:
                    logger.warning("Could not build an import spec for %s", py)
                    continue
                module = importlib.util.module_from_spec(spec)
                sys.modules[mod_name] = module
                spec.loader.exec_module(module)
            except Exception:  # noqa: BLE001 — one bad module must not kill boot
                logger.exception("Failed to load external provider module %s", py)
                sys.modules.pop(mod_name, None)
    finally:
        sys.dont_write_bytecode = _prev_dont_write


def load_all() -> None:
    """Idempotent one-shot plugin load, invoked ONCE from the app lifespan
    (never at import time).

    Runs the two sources in order (entry points -> ``KARAOKE_PROVIDERS_DIR``).
    A second call is a no-op. No file is ever written into any source or
    provider directory.

    The interim package-adjacent ``local/`` scan (the transition carrier
    for the then-gitignored provider) was deliberately removed: the
    provider is tracked in an out-of-repo package and arrives via entry
    points, and a stale ``local/`` copy would silently REPLACE it (later
    source wins the registry). ``KARAOKE_PROVIDERS_DIR`` remains the
    permanent no-install extension point.
    """
    global _loaded
    if _loaded:
        return
    _load_catalog_entry_points()
    _load_providers_dir()
    _loaded = True
