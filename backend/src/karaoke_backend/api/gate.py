# SPDX-License-Identifier: AGPL-3.0-only
"""Core single-host authentication: an optional shared gate password.

Public module. In single-host mode there is exactly one identity — the
Host (``owner_id == SINGLE_HOST_ID``) — and no user accounts, signup, invites,
or per-tenant scoping. An optional shared password (env-configured) gates the
host-scoped surface — every route behind ``require_user`` or ``get_host_id``
fails closed until the session unlocks. ``GET /api/lyrics`` was the notable
exception, left open pending the lrclib opt-in work; that work has landed
and the route now sits behind ``require_user`` with the rest. With no password
set everything is open, matching the LAN-party posture and current local-dev
reality.

The gate flag lives under the session key ``gate_ok``, deliberately disjoint
from premium's ``uid`` key so a cross-mode cookie fails closed: a DB or code
tree downgraded from multi-user to single-host carries stale ``uid`` keys
harmlessly, and vice versa.

Env (all lazy-read, so tests can flip them per-test without app reassembly):
  KARAOKE_GATE_PASSWORD_HASH  bcrypt hash (wins if set; verified via api.auth)
  KARAOKE_GATE_PASSWORD       plaintext (constant-time compared)
  both unset                  gate disabled — everything open
"""

from __future__ import annotations

import os
import secrets

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import verify_password
from karaoke_backend.api.identity import SINGLE_HOST_ID, Identity, set_auth_backend
from karaoke_backend.ratelimit import gate_limiter

# Session key for a passed gate. Intentionally NOT "uid" (premium's key) so
# cookies never cross modes with authority — see module docstring.
_GATE_OK = "gate_ok"


def _password_hash() -> str | None:
    val = os.getenv("KARAOKE_GATE_PASSWORD_HASH", "").strip()
    return val or None


def _password_plain() -> str | None:
    val = os.getenv("KARAOKE_GATE_PASSWORD")
    return val if val else None


def gate_enabled() -> bool:
    """True when a shared password is configured (hash wins over plaintext)."""
    return _password_hash() is not None or _password_plain() is not None


def _check_password(candidate: str) -> bool:
    """Verify a candidate against the configured secret (hash preferred)."""
    hashed = _password_hash()
    if hashed is not None:
        return verify_password(candidate, hashed)
    plain = _password_plain()
    if plain is not None:
        return secrets.compare_digest(candidate, plain)
    return False  # gate disabled — callers gate on gate_enabled() before here


def _gate_passed(request: Request) -> bool:
    """Whether this request may act as the Host: gate disabled, or unlocked."""
    if not gate_enabled():
        return True
    return bool(request.session.get(_GATE_OK))


class SingleHostBackend:
    """Single-tenant auth backend: one constant Host, an optional gate.

    There is only one tenant, so there is nothing for a caller to scope by.
    When a gate password is configured, host-scoped access fails closed until
    the session unlocks — identically to how the multi-user backend fails
    closed for a caller carrying no credential.
    """

    async def current_identity(self, request: Request, db) -> Identity | None:
        if _gate_passed(request):
            return Identity(SINGLE_HOST_ID, "Host")
        return None

    async def resolve_host_id(self, request, db, identity) -> int:
        # Single-tenant: the owner is always the Host.
        # A gated-but-locked request must not resolve a host scope — otherwise
        # get_host_id-only routes (e.g. GET /api/songs) would stay open behind
        # a locked gate. Fail closed exactly like require_user.
        if not _gate_passed(request):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="locked",
            )
        return SINGLE_HOST_ID

    def is_host_request(self, request: Request) -> bool:
        return _gate_passed(request)

    async def join_credential(self, db: AsyncSession, host_id: int) -> str | None:
        # Single-tenant: there is no second party to admit, so a join URL has
        # nothing to carry. Stated explicitly rather than left to the getattr
        # fallback so core's own backend documents the answer.
        return None

    def describe(self) -> dict:
        return {"mode": "single_host", "password_required": gate_enabled()}


router = APIRouter(prefix="/api/auth", tags=["auth"])


class GateRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


class MeResponse(BaseModel):
    id: int
    name: str | None = None
    gate_enabled: bool


def _me() -> MeResponse:
    return MeResponse(id=SINGLE_HOST_ID, name="Host", gate_enabled=gate_enabled())


@router.post("/gate", response_model=MeResponse, summary="Unlock the single-host gate")
async def unlock(
    body: GateRequest,
    request: Request,
    _ratelimit: None = Depends(gate_limiter),
) -> MeResponse:
    """Exchange the shared password for an unlocked session.

    A no-op success when no gate is configured (nothing to unlock).
    """
    if not gate_enabled():
        return _me()
    if not _check_password(body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid password",
        )
    request.session[_GATE_OK] = True
    return _me()


@router.post("/lock", summary="Re-lock the single-host gate")
async def lock(request: Request) -> dict:
    request.session.pop(_GATE_OK, None)
    return {"ok": True}


@router.get("/me", response_model=MeResponse, summary="Return the single-host identity")
async def me(request: Request) -> MeResponse:
    if not _gate_passed(request):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="locked",
        )
    return _me()


def install(app: FastAPI) -> None:
    """Register the single-host backend and mount its auth router."""
    set_auth_backend(SingleHostBackend())
    app.include_router(router)
