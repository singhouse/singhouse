# SPDX-License-Identifier: AGPL-3.0-only
"""Core single-host gate: open access, optional shared password, constant owner.

These run under the core (single_host) assembly from conftest. The gate password
is env-configured and lazily read, so each test flips it with monkeypatch.setenv
without reassembling the app.
"""

import types

import pytest
from httpx import AsyncClient

from karaoke_backend.api.auth import hash_password
from karaoke_backend.api.gate import SingleHostBackend
from karaoke_backend.api.identity import SINGLE_HOST_ID
from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.models.song import Job, Song

GATE_PW = "correct horse"


@pytest.fixture(autouse=True)
def _fresh_gate_window(monkeypatch):
    """Isolate each test's gate rate-limit state from every other test."""
    from karaoke_backend import ratelimit
    from karaoke_backend.ratelimit import _SlidingWindow

    monkeypatch.setattr(
        ratelimit, "_gate_window", _SlidingWindow(5, 60, "gate")
    )


async def _seed_song(owner_id: int, artist: str, title: str = "Song") -> None:
    async with AsyncSessionLocal() as db:
        db.add(Song(
            owner_id=owner_id,
            artist=artist,
            title=title,
            filename=f"{artist}.mp3",
            status="ready",
        ))
        await db.commit()


async def _seed_failed_job(job_id: str, owner_id: int, error_message: str) -> None:
    async with AsyncSessionLocal() as db:
        db.add(Job(
            id=job_id,
            owner_id=owner_id,
            status="failed",
            error_message=error_message,
        ))
        await db.commit()


# --- gate disabled (default): everything open -------------------------------

@pytest.mark.asyncio
async def test_gate_off_open_access(client: AsyncClient):
    assert (await client.get("/api/songs")).status_code == 200

    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json() == {"id": SINGLE_HOST_ID, "name": "Host", "gate_enabled": False}

    cfg = await client.get("/api/auth/config")
    assert cfg.json() == {"mode": "single_host", "password_required": False}


# --- gate enabled: locked surface -------------------------------------------

@pytest.mark.asyncio
async def test_gated_blocks_songs_and_me(client: AsyncClient, monkeypatch):
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)

    assert (await client.get("/api/songs")).status_code == 401
    assert (await client.get("/api/auth/me")).status_code == 401

    # /config stays open in both modes — it is the mode-introspection endpoint.
    cfg = await client.get("/api/auth/config")
    assert cfg.status_code == 200
    assert cfg.json() == {"mode": "single_host", "password_required": True}


@pytest.mark.asyncio
async def test_wrong_password_401(client: AsyncClient, monkeypatch):
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)
    resp = await client.post("/api/auth/gate", json={"password": "nope"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_unlock_grants_access(client: AsyncClient, monkeypatch):
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)

    unlock = await client.post("/api/auth/gate", json={"password": GATE_PW})
    assert unlock.status_code == 200
    assert unlock.json() == {"id": SINGLE_HOST_ID, "name": "Host", "gate_enabled": True}

    # The session cookie now carries gate_ok — locked routes open up.
    assert (await client.get("/api/songs")).status_code == 200
    assert (await client.get("/api/auth/me")).status_code == 200


@pytest.mark.asyncio
async def test_lock_revokes_access(client: AsyncClient, monkeypatch):
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)

    await client.post("/api/auth/gate", json={"password": GATE_PW})
    assert (await client.get("/api/auth/me")).status_code == 200

    locked = await client.post("/api/auth/lock")
    assert locked.status_code == 200
    assert locked.json() == {"ok": True}

    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.get("/api/songs")).status_code == 401


@pytest.mark.asyncio
async def test_hash_variant_wins(client: AsyncClient, monkeypatch):
    # A bcrypt hash is honored (and takes precedence over any plaintext var).
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD_HASH", hash_password(GATE_PW))
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", "ignored-plaintext")

    assert (await client.post("/api/auth/gate", json={"password": "ignored-plaintext"})).status_code == 401

    ok = await client.post("/api/auth/gate", json={"password": GATE_PW})
    assert ok.status_code == 200
    assert (await client.get("/api/auth/me")).status_code == 200


@pytest.mark.asyncio
async def test_gate_rate_limited(client: AsyncClient, monkeypatch):
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)
    from karaoke_backend import ratelimit
    from karaoke_backend.ratelimit import _SlidingWindow

    monkeypatch.setattr(ratelimit, "_gate_window", _SlidingWindow(3, 60, "gate"))

    statuses = []
    for _ in range(5):
        r = await client.post("/api/auth/gate", json={"password": "wrong"})
        statuses.append(r.status_code)

    assert statuses[:3] == [401, 401, 401]
    assert statuses[3:] == [429, 429]


# --- constant owner scoping (single-tenant) ---------------------------------

@pytest.mark.asyncio
async def test_constant_scoping_direct_insert(client: AsyncClient):
    # Seed rows for two owners straight into the DB; single-host mode is
    # scoped to owner_id == SINGLE_HOST_ID, so only owner-1's row is visible.
    await _seed_song(owner_id=SINGLE_HOST_ID, artist="OwnerOne")
    await _seed_song(owner_id=2, artist="OwnerTwo")

    resp = await client.get("/api/songs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert [s["artist"] for s in body["songs"]] == ["OwnerOne"]


@pytest.mark.asyncio
async def test_no_route_declares_a_host_query_parameter(client: AsyncClient):
    """``?host=`` is not merely ignored — nothing declares it.

    This replaces a test that sent ``?host=2`` and asserted core still scoped
    to the Host. That assertion can no longer fail for the reason it names:
    the parameter is undeclared, so Starlette drops it before any code sees
    it, and the test had become a duplicate of the one above. Asserting on the
    served schema is the version that can still catch a regression — and the
    schema is also what a client author reads, so a parameter still advertised
    there would keep being written into new callers that silently do nothing.
    """
    await _seed_song(owner_id=SINGLE_HOST_ID, artist="OwnerOne")
    await _seed_song(owner_id=2, artist="OwnerTwo")

    schema = (await client.get("/openapi.json")).json()
    offenders = [
        f"{method.upper()} {path}"
        for path, ops in schema["paths"].items()
        for method, op in ops.items()
        if isinstance(op, dict)
        for param in op.get("parameters", [])
        if param.get("name") == "host" and param.get("in") == "query"
    ]
    assert offenders == [], f"?host= is still declared on: {offenders}"

    # And behaviourally: a stale bookmark scopes nothing.
    resp = await client.get("/api/songs", params={"host": 2})
    assert resp.status_code == 200
    assert [s["artist"] for s in resp.json()["songs"]] == ["OwnerOne"]


# --- separate.py:528 error redaction ----------------------------------------

@pytest.mark.asyncio
async def test_job_error_visible_to_host(client: AsyncClient):
    # Gate off → every caller is the Host → is_host_request True → sees the
    # raw error_message (which can carry internal paths).
    secret = "internal: /srv/secret/path exploded"
    await _seed_failed_job("job-boom", SINGLE_HOST_ID, secret)

    resp = await client.get("/api/jobs/job-boom")
    assert resp.status_code == 200
    assert resp.json()["error"] == secret


def test_is_host_request_both_truth_values():
    """Both branches of the separate.py:528 redaction expression.

    At the HTTP layer a gate-locked caller is failed closed by get_host_id
    before reaching :528 (stronger than redaction), so the ``"Import failed"``
    branch is exercised here at the unit level: is_host_request is the predicate
    that selects raw error vs. the redacted string.
    """
    backend = SingleHostBackend()
    open_req = types.SimpleNamespace(session={})
    unlocked_req = types.SimpleNamespace(session={"gate_ok": True})
    locked_req = types.SimpleNamespace(session={})

    import os

    # Gate disabled: any request is the Host.
    os.environ.pop("KARAOKE_GATE_PASSWORD", None)
    os.environ.pop("KARAOKE_GATE_PASSWORD_HASH", None)
    assert backend.is_host_request(open_req) is True

    # Gate enabled: unlocked session is Host, locked session is not.
    os.environ["KARAOKE_GATE_PASSWORD"] = GATE_PW
    try:
        assert backend.is_host_request(unlocked_req) is True
        assert backend.is_host_request(locked_req) is False
    finally:
        os.environ.pop("KARAOKE_GATE_PASSWORD", None)
