# SPDX-License-Identifier: AGPL-3.0-only
"""
External-catalog integration — protocol + provider discovery.

Core ships the CatalogProvider protocol, the DTOs providers return, and a
single discovery endpoint (``GET /api/catalog/providers``). Search, info,
and import routes are premium extensions mounted via the
``karaoke_backend.api_routers`` entry-point group (core ships zero
providers by design; the UI hides catalog widgets when ``/providers`` returns
``[]``).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Optional, Protocol, runtime_checkable

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from karaoke_backend.api.auth import Principal, require_user_or_guest
from karaoke_backend.api.providers import enabled_providers

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/catalog", tags=["catalog"])


# ---------------------------------------------------------------------------
# Guest import gate
# ---------------------------------------------------------------------------

GUEST_IMPORT_CAPABILITY = "guest-import"

# Only these subtract. Anything else — "on", "yes", a typo, an empty string —
# is not a grant, because there must exist no environment value that turns
# guest import ON for a provider that did not declare it. Otherwise a
# misspelled variable becomes a spend authorization on someone's account.
_OFF_VALUES = frozenset({"off", "0", "false", "no", "disabled"})


def _is_off(raw: str | None) -> bool:
    return (raw or "").strip().lower() in _OFF_VALUES


def guest_import_env_key(provider_name: str) -> str:
    """The per-provider kill switch name for ``provider_name``.

    Non-alphanumerics collapse to underscores: provider names are url-safe
    identifiers, and environment variable names are a narrower alphabet.
    """
    slug = re.sub(r"[^A-Z0-9]+", "_", (provider_name or "").upper())
    return f"KARAOKE_GUEST_IMPORT_{slug}"


def guest_import_allowed(provider) -> bool:
    """Whether a guest may spend the operator's credentials at ``provider``.

    Fails closed at every step:

    1. The provider must declare ``guest-import`` in ``capabilities``. Read
       through ``getattr`` with an empty default, so every provider that exists
       today — and every older-shaped one that never heard of this flag — is
       host-only without being touched.
    2. ``KARAOKE_GUEST_IMPORT=off`` disables it everywhere.
    3. ``KARAOKE_GUEST_IMPORT_<NAME>=off`` disables one.

    Environment can only ever *subtract*. There is deliberately no value that
    grants the capability: what is being granted is the ability for someone who
    walked into the room to spend money on the operator's account, and that
    should require editing a provider, not editing a config file.
    """
    capabilities = getattr(provider, "capabilities", frozenset()) or frozenset()
    if GUEST_IMPORT_CAPABILITY not in capabilities:
        return False
    if _is_off(os.getenv("KARAOKE_GUEST_IMPORT")):
        return False
    if _is_off(os.getenv(guest_import_env_key(getattr(provider, "name", "")))):
        return False
    return True


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


class ProviderHit(BaseModel):
    """Search hit returned by a provider implementation."""

    external_id: str
    title: str
    artist: str
    year: Optional[str] = None
    length: Optional[int] = None
    free: bool = False
    kind: str = "song"
    extra: dict[str, Any] = Field(default_factory=dict)


class ProviderInfo(BaseModel):
    """Metadata for a single item returned by a provider implementation."""

    external_id: str
    title: str
    artist: str
    year: Optional[str] = None
    length: Optional[int] = None
    free: bool = False
    explicit: bool = False
    extra: dict[str, Any] = Field(default_factory=dict)


class ProviderMeta(BaseModel):
    name: str
    label: str
    icon: str = ""
    capabilities: list[str] = Field(default_factory=list)
    guest_import: bool = Field(
        False,
        description=(
            "Whether a guest (not the account holder) may import from this "
            "provider. A UI hint for hiding an affordance that would 403; the "
            "server enforces it independently and does not trust this."
        ),
    )


# ---------------------------------------------------------------------------
# Provider protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class CatalogProvider(Protocol):
    name: str       # url-safe identifier
    label: str      # display name
    icon: str       # short glyph / emoji

    @property
    def available(self) -> bool:
        """Whether the provider is configured + ready to serve requests."""

    def filename_for(self, external_id: str) -> str:
        """Filename convention used to mark Songs imported from this provider.
        Used to dedupe hits + short-circuit reimports."""

    async def search(
        self, q: str, *, offset: int = 0, hydrate: bool = True
    ) -> list[ProviderHit]: ...

    async def info(self, external_id: str) -> Optional[ProviderInfo]: ...

    async def run_import(
        self, *, job_id: str, song_id: int, owner_id: int, external_id: str
    ) -> None:
        """Background job: retrieve the item via the user's own provider
        account/credentials and adopt the resulting stems into their library,
        then mark the Song ready (or failed). ``owner_id`` is the host who
        triggered the import; rows the provider creates (LyricsSet etc.) must
        inherit it.

        **Job-row ownership (durable queue).** From the moment this is
        called until it returns, the provider owns the `jobs` row. It may
        write `phase`, `message` and `progress` freely, and it MAY write a
        terminal `status` (`done` / `failed`) — the worker will not overwrite
        a terminal state it finds, only supply one if the provider left none.

        Intermediate `status` strings ("downloading", "adopting", …) are
        TOLERATED for backward compatibility: providers predating the queue
        used `status` as their only progress channel. The queue's lease
        predicates are therefore written as "claimed and NOT terminal", so
        such a row keeps its heartbeat and stays visible to the expiry sweep
        if the process dies. New providers should put progress in `phase` and
        leave `status` alone until they finish — `status` is the queue's
        lifecycle column, and a value that is neither `running` nor terminal
        is only ever interpreted correctly by accommodation."""

    # --- v2 members (read via getattr with safe defaults so v1-shaped
    #     providers degrade instead of crashing boot) ---

    capabilities: frozenset[str]
    # wire values: subset of {"search", "import", "source-doc", "reparse"}

    def routers(self) -> list:
        """Provider-owned route contribution."""

    def parse_legacy_metadata(self, md: dict) -> tuple[str, str, int | None] | None:
        """Recognize legacy persisted metadata this provider owns.
        Returns (provider_name, external_id, format_version) or None."""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/providers", response_model=list[ProviderMeta])
async def list_providers(
    principal: Principal = Depends(require_user_or_guest),
) -> list[ProviderMeta]:
    """Enabled providers — the frontend uses this to render the catalog UI.

    Behind an admission check, not open: which integrations an operator has
    configured is part of their private deployment posture, and an open
    discovery route lets anyone on the internet enumerate the installed
    providers and their capabilities.

    Guest discovery includes only providers they may import from, so their
    search picker does not offer sources whose results they cannot use.
    "Guest" here means
    someone holding a token this deployment issued against a code the host
    displayed — not, as the earlier query-parameter scheme allowed, anyone who
    wrote a tenant id in a query string.

    Note this tracks whatever the active auth backend counts as a user, so it
    is only a real restriction where identity is: in single-host mode with no
    gate password configured, every caller is the Host by definition and this
    dependency admits everyone. That is the documented LAN posture, not a hole
    in this route.
    """
    return [
        ProviderMeta(
            name=p.name,
            label=p.label,
            icon=p.icon,
            capabilities=sorted(getattr(p, "capabilities", frozenset())),
            guest_import=guest_import_allowed(p),
        )
        for p in enabled_providers()
        if not principal.is_guest or guest_import_allowed(p)
    ]
