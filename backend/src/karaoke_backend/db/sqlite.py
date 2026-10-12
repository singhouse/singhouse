# SPDX-License-Identifier: AGPL-3.0-only
"""Shared SQLite connection initialization.

SQLite PRAGMAs are connection-local (except the persisted journal mode), so
every engine that can open the product database installs the same connect
hook. Runtime and migration engines intentionally differ only on foreign-key
enforcement: runtime keeps it on; Alembic batch rebuilds require it off.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine, URL, make_url

from karaoke_backend.search import normalized_search


def is_file_backed_sqlite(url: str | URL) -> bool:
    """Return whether ``url`` names a file-backed SQLite database."""
    parsed = make_url(url) if isinstance(url, str) else url
    if parsed.get_backend_name() != "sqlite":
        return False
    if not parsed.database or parsed.database == ":memory:":
        return False
    return parsed.query.get("mode") != "memory"


def configure_sqlite_connection(
    dbapi_conn: Any,
    *,
    foreign_keys: bool,
    wal: bool,
) -> None:
    """Apply the connection-local SQLite policy used by runtime and migrations."""
    dbapi_conn.create_function("normalized_search", -1, normalized_search, deterministic=True)
    cursor = dbapi_conn.cursor()
    try:
        cursor.execute(f"PRAGMA foreign_keys={'ON' if foreign_keys else 'OFF'}")
        cursor.execute("PRAGMA busy_timeout=5000")
        if wal:
            cursor.execute("PRAGMA journal_mode=WAL")
    finally:
        cursor.close()


def install_sqlite_pragmas(engine: Engine, *, foreign_keys: bool) -> None:
    """Install the product's PRAGMA policy on each connection from ``engine``."""
    if engine.dialect.name != "sqlite":
        return

    wal = is_file_backed_sqlite(engine.url)

    @event.listens_for(engine, "connect")
    def _configure(dbapi_conn, _record) -> None:
        configure_sqlite_connection(
            dbapi_conn,
            foreign_keys=foreign_keys,
            wal=wal,
        )
