# SPDX-License-Identifier: AGPL-3.0-only
"""
Pytest configuration and shared fixtures for the CORE (single-host) suite.

Core runs single-host: one constant Host identity (``owner_id == 1``), no user
accounts, no signup/invite flow. The default ``client`` is therefore a plain
client with the gate disabled — every request already acts as the Host, so the
existing tenant-scoped route tests exercise owner-1 rows without ceremony.

Multi-user auth (signup/login/invites/tenant isolation) lives in the premium
suite: ``AUTH_MODE=multi_user pytest premium/backend/tests``. This conftest
imports nothing from ``karaoke_premium`` so the core suite passes with the
premium package physically removed (the standalone deletion gate).
"""

import asyncio
import os
import tempfile
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# --- ENV BEFORE IMPORTS — LOAD-BEARING, do not reorder -----------------------
# The environment bindings below MUST stay physically above the
# karaoke_backend imports that follow: the database module builds its engine
# from DATABASE_URL at import time, and the API modules snapshot
# UPLOADS_DIR / STEMS_DIR the same way. An import-sorter that hoists those
# imports above these lines would silently rebind the whole suite to the
# on-disk dev database. tests/test_packaging_guards.py asserts the resulting
# in-memory engine binding.

# Point to an in-memory SQLite for tests
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

# Disable entry-point provider discovery so the core suite proves core-only
# mode even when karaoke-premium is pip-installed editable in the shared venv.
os.environ["KARAOKE_PROVIDERS"] = "none"

# Assemble core single-host mode. setdefault (not a hard set) lets a caller
# force multi via the environment, but bare `pytest tests` always gets core —
# and gets it even with the premium package present, where auto-detection
# would otherwise pick multi_user.
os.environ.setdefault("AUTH_MODE", "single_host")

# The acoustic word-timing stage defaults ON and would spawn the processing
# Python (GPU models) from any test that aligns with a lyrics reference. Its
# own tests switch it back on with a fake aligner.
os.environ["KARAOKE_ACOUSTIC_ALIGNMENT"] = "0"

_tmp_uploads = tempfile.mkdtemp()
_tmp_stems = tempfile.mkdtemp()
os.environ["UPLOADS_DIR"] = _tmp_uploads
os.environ["STEMS_DIR"] = _tmp_stems

# Deterministic session secret so importing main.py never writes a
# .session_secret file into the tree (see _load_session_secret) and cookies
# stay stable across the app instances a test may build.
os.environ["SESSION_SECRET"] = "test-session-secret-not-for-production"

# The Plex token file, for the same reason: the suite runs on an in-memory
# database, so the secret directory falls back to the CWD — which is the
# source tree. A settings test that stores a token must not leave a 0600 file
# in `backend/`. Pinned to a temp path, exactly as the two directories above.
_tmp_secrets = tempfile.mkdtemp()
os.environ["PLEX_TOKEN_FILE"] = os.path.join(_tmp_secrets, ".plex_token")

from karaoke_backend.api.identity import SINGLE_HOST_ID  # noqa: E402
from karaoke_backend.database import engine  # noqa: E402
from karaoke_backend.main import app  # noqa: E402
from karaoke_backend.models.song import Base  # noqa: E402


@pytest_asyncio.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    """Create fresh tables for each test, drop after."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    """Core test client — the single Host, gate disabled (everything open)."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest_asyncio.fixture
async def host_user() -> dict:
    """The constant single-host owner. Rows seeded with this id are visible."""
    return {"id": SINGLE_HOST_ID}
