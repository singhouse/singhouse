# SPDX-License-Identifier: AGPL-3.0-only
"""Behavior-neutral tests for the authentication backend registry."""

import pytest
from httpx import AsyncClient

from karaoke_backend.api import identity as identity_module
from karaoke_backend.api.identity import Identity, get_auth_backend, set_auth_backend


class _FakeBackend:
    async def current_identity(self, request, db):
        return Identity(id=42, name="Test")

    async def resolve_host_id(self, request, db, identity):
        # Fails closed for an anonymous caller, like every real backend must.
        # The old four-argument version returned `host_query` here — i.e. the
        # hole guest admission removed, preserved in a fixture where it read as
        # documentation.
        if identity is None:
            raise AssertionError("fake backend has no anonymous scope")
        return identity.id

    def is_host_request(self, request):
        return True

    def describe(self):
        return {"mode": "fake", "password_required": False}


def test_registry_raises_when_unset(monkeypatch):
    monkeypatch.setattr(identity_module, "_backend", None)
    with pytest.raises(RuntimeError, match="has not been configured"):
        get_auth_backend()


def test_registry_backend_swap_round_trip():
    original = get_auth_backend()
    fake = _FakeBackend()
    try:
        set_auth_backend(fake)
        assert get_auth_backend() is fake
    finally:
        set_auth_backend(original)


@pytest.mark.asyncio
async def test_auth_config_describes_single_host(client: AsyncClient):
    # The core suite assembles single-host; premium's suite covers the
    # multi_user describe() shape. Gate is disabled in tests → not required.
    response = await client.get("/api/auth/config")
    assert response.status_code == 200
    assert response.json() == {
        "mode": "single_host",
        "password_required": False,
    }
