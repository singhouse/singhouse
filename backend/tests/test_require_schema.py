# SPDX-License-Identifier: AGPL-3.0-only
"""Unit coverage for the read-only ops-script schema guard.

`require_schema` must (a) exit non-zero when the schema is absent, (b) NOT mint
a stray DB file while doing so, and (c) return cleanly when the table is present.
"""

import sqlite3
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from karaoke_backend import database

FIXTURE = Path(__file__).parent / "fixtures" / "deployed_schema_2026-07.sql"


def _bind_file_engine(db_path: Path, monkeypatch):
    eng = create_async_engine(
        "sqlite+aiosqlite:///" + str(db_path),
        connect_args={"check_same_thread": False},
    )
    monkeypatch.setattr(database, "engine", eng)
    return eng


@pytest.mark.asyncio
async def test_missing_file_exits_and_mints_nothing(tmp_path, monkeypatch):
    db_path = tmp_path / "nope.db"
    eng = _bind_file_engine(db_path, monkeypatch)
    try:
        with pytest.raises(SystemExit) as ei:
            await database.require_schema("songs")
        assert ei.value.code == 1
        assert not db_path.exists()  # guard must not create a stray 0-byte file
    finally:
        await eng.dispose()


@pytest.mark.asyncio
async def test_schemaless_db_exits(tmp_path, monkeypatch):
    db_path = tmp_path / "empty.db"
    sqlite3.connect(str(db_path)).close()  # file exists, zero tables
    eng = _bind_file_engine(db_path, monkeypatch)
    try:
        with pytest.raises(SystemExit) as ei:
            await database.require_schema("songs")
        assert ei.value.code == 1
    finally:
        await eng.dispose()


@pytest.mark.asyncio
async def test_present_table_passes(tmp_path, monkeypatch):
    db_path = tmp_path / "ok.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(FIXTURE.read_text())
    conn.close()
    eng = _bind_file_engine(db_path, monkeypatch)
    try:
        await database.require_schema("songs")  # returns None (no rows, no raise)
        await database.require_schema("invites")
    finally:
        await eng.dispose()
