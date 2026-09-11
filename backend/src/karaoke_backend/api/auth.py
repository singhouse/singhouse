# SPDX-License-Identifier: AGPL-3.0-only
"""Stable authentication dependencies delegated to the active backend.

Core routes import this module's ``get_current_user``, ``require_user``, and
``get_host_id`` callables. Optional auth implementations install themselves
behind that seam without changing route dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import bcrypt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.identity import Identity, get_auth_backend
from karaoke_backend.database import get_db


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Optional[Identity]:
    """Resolve the request to an identity, or ``None`` when anonymous."""
    return await get_auth_backend().current_identity(request, db)


async def require_user(
    user: Optional[Identity] = Depends(get_current_user),
) -> Identity:
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        )
    return user


async def get_host_id(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: Optional[Identity] = Depends(get_current_user),
) -> int:
    """Resolve the host scope through the active auth backend.

    There is no ``host`` query parameter, and its absence is the point. There
    used to be one, and it *was* the guest mechanism: an anonymous caller
    wrote ``?host=<int>`` and received that tenant's scope. Host ids are small
    sequential integers, so in practice the credential was the number 1.

    Deleting the declaration is what ends it — the parameter stops being
    parsed, stops appearing in the OpenAPI schema, and a stale ``?host=1`` in
    a bookmark degrades to an ignored query string instead of an authorization
    decision. Guests now present a token this deployment issued; a backend
    with no guest concept simply fails closed for anyone anonymous.
    """
    return await get_auth_backend().resolve_host_id(
        request=request,
        db=db,
        identity=user,
    )


@dataclass(frozen=True)
class Principal:
    """Who a request is, for routes that serve both hosts and guests.

    ``host_id`` is the tenant scope: for a host their own id, for a guest the
    host who admitted them. ``identity`` is the *account*, and is ``None`` for
    a guest — a guest is authenticated (they hold a token this deployment
    issued) but is not the account holder, and the routes that spend the
    operator's credentials have to be able to tell those two apart.
    """

    host_id: int
    identity: Optional[Identity] = None

    @property
    def is_guest(self) -> bool:
        return self.identity is None


async def require_user_or_guest(
    host_id: int = Depends(get_host_id),
    user: Optional[Identity] = Depends(get_current_user),
) -> Principal:
    """Admit either the host or a guest holding a valid token.

    Everything this dependency promises rests on ``get_host_id`` failing
    closed, which became true one function above. Attached to a route while
    ``?host=`` still existed it would have admitted any anonymous caller as a
    "guest" of whichever tenant they named — which is why it was held out of
    the additive core step and lands here, with its premise true and its
    consumers in the same change.

    In single-host core there is no second party to admit, so this resolves to
    the Host or raises, and ``is_guest`` is never true.
    """
    return Principal(host_id=host_id, identity=user)
