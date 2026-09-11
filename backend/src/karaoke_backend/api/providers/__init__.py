# SPDX-License-Identifier: AGPL-3.0-only
"""
Catalog-provider registry.

This module is the **frozen seam** other code targets: a provider
module self-registers via ``register(...)`` (called at its own import time),
and callers resolve providers via ``get_provider`` / ``all_providers`` /
``enabled_providers``. The functions below are the whole public surface.

Provider *discovery* (which modules get imported so they self-register) is NOT
done here anymore. It lives in :mod:`karaoke_backend.plugins`, whose
``load_all()`` the app lifespan calls once at startup — entry points, then
``KARAOKE_PROVIDERS_DIR`` (the interim ``local/`` scan was removed).
The old
import-time autoloader (which wrote a ``local/__init__.py`` into the source
tree) is gone; nothing here runs at import time, and no file is ever written
into a provider directory. Provider modules can still be excluded from remote
git via .gitignore — the abstraction is committed; implementations ship
per-host.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter

if TYPE_CHECKING:
    from karaoke_backend.api.catalog import CatalogProvider

logger = logging.getLogger(__name__)

_REGISTRY: dict[str, CatalogProvider] = {}


def register(provider: CatalogProvider) -> None:
    if provider.name in _REGISTRY:
        logger.warning("catalog provider %r already registered — replacing", provider.name)
    _REGISTRY[provider.name] = provider
    logger.info("Registered catalog provider: %s (%s)", provider.label, provider.name)


def get_provider(name: str) -> Optional[CatalogProvider]:
    return _REGISTRY.get(name)


def all_providers() -> list[CatalogProvider]:
    return list(_REGISTRY.values())


def enabled_providers() -> list[CatalogProvider]:
    """Subset of registered providers that report themselves available."""
    return [p for p in _REGISTRY.values() if p.available]


def provider_routers() -> list[APIRouter]:
    """Collect provider-owned routers via the v2 ``routers()`` hook.

    Providers that lack the hook (v1-shaped) contribute nothing.
    """
    out: list[APIRouter] = []
    for p in _REGISTRY.values():
        routers_fn = getattr(p, "routers", None)
        if routers_fn is not None:
            try:
                out.extend(routers_fn())
            except Exception:  # noqa: BLE001
                logger.exception("Provider %r routers() raised — skipping", p.name)
    return out


def extension_routers() -> list[APIRouter]:
    """Load suite-level routers from the ``karaoke_backend.api_routers``
    entry-point group (premium catalog search/import, rotation, etc.)."""
    from karaoke_backend.plugins import GROUP_API_ROUTERS, iter_group

    out: list[APIRouter] = []
    for name, factory in iter_group(GROUP_API_ROUTERS):
        try:
            router = factory()
            if isinstance(router, APIRouter):
                out.append(router)
            else:
                logger.warning("api_routers entry %r returned non-APIRouter — skipping", name)
        except Exception:  # noqa: BLE001
            logger.exception("api_routers factory %r raised — skipping", name)
    return out


def resolve_legacy_metadata(md: dict) -> tuple[str, str, int | None] | None:
    """Iterate registered providers' ``parse_legacy_metadata`` hooks.

    Returns ``(provider_name, external_id, format_version)`` from the first
    provider that recognizes the metadata dict, or None.
    """
    for p in _REGISTRY.values():
        hook = getattr(p, "parse_legacy_metadata", None)
        if hook is None:
            continue
        try:
            result = hook(md)
        except Exception:  # noqa: BLE001
            logger.exception("Provider %r parse_legacy_metadata raised", p.name)
            continue
        if result is not None:
            return result
    return None
