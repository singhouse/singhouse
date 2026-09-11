# SPDX-License-Identifier: AGPL-3.0-only
"""Authentication identity seam shared by core and optional backends."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from fastapi import APIRouter, Request
from sqlalchemy.ext.asyncio import AsyncSession


SINGLE_HOST_ID = 1


@dataclass(frozen=True)
class Identity:
    """The identity shape consumed by core routes."""

    id: int
    name: str | None = None


class AuthBackend(Protocol):
    """Backend contract for resolving request identity and host scope."""

    async def current_identity(
        self, request: Request, db: AsyncSession
    ) -> Identity | None: ...

    async def resolve_host_id(
        self,
        request: Request,
        db: AsyncSession,
        identity: Identity | None,
    ) -> int:
        """Resolve this request to the tenant whose data it may touch.

        The backend reads whatever credential it recognises off ``request``.
        There is deliberately no caller-supplied host parameter: a value the
        caller picks is a routing hint, not an authenticator, and one arriving
        through this signature was indistinguishable from one that had been
        proven. A request that cannot be attributed has no host scope, and
        every implementation must fail closed rather than choose a default.
        """
        ...

    def is_host_request(self, request: Request) -> bool: ...

    def describe(self) -> dict: ...


class JoinCredentialBackend(Protocol):
    """Add-on protocol for backends that issue guest join credentials.

    Kept off ``AuthBackend`` deliberately. ``Protocol`` has no notion of an
    optional member, so declaring it there would make every backend that
    predates it fail a structural check — and a body falling through to
    ``None`` would silently hand any explicit subclass a "no credential"
    implementation indistinguishable from a backend that never heard of the
    hook, which is a failure mode that reads as correct everywhere it surfaces.
    """

    async def join_credential(self, db: AsyncSession, host_id: int) -> str | None:
        """The credential a guest must present to reach ``host_id``'s surface.

        ``None`` means this backend has no credential concept: a single-tenant
        deployment has no second party to admit, so a join URL carries nothing.
        """
        ...


_backend: AuthBackend | None = None


def set_auth_backend(backend: AuthBackend) -> None:
    global _backend
    _backend = backend


def get_auth_backend() -> AuthBackend:
    if _backend is None:
        raise RuntimeError("auth backend has not been configured")
    return _backend


async def join_credential_for(db: AsyncSession, host_id: int) -> str | None:
    """Read the active backend's join credential, tolerating older backends.

    Optional capabilities are read through ``getattr`` throughout this codebase
    (``api.catalog`` reads a provider's ``capabilities`` the same way), so a
    backend written before this hook existed keeps working and simply
    contributes nothing to the join URL.

    Exceptions are deliberately NOT swallowed. A backend that has the hook and
    raises from it is a bug worth surfacing, and this value only ever decorates
    a join URL — failing loudly here cannot widen access.
    """
    hook = getattr(get_auth_backend(), "join_credential", None)
    if hook is None:
        return None
    return await hook(db, host_id)


config_router = APIRouter(prefix="/api/auth", tags=["auth"])


@config_router.get("/config", summary="Describe the active authentication mode")
async def auth_config() -> dict:
    return get_auth_backend().describe()
