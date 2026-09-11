# SPDX-License-Identifier: AGPL-3.0-only
"""
Database setup: SQLAlchemy async engine + session factory.

SQLite is used via aiosqlite (async driver).
The database file path is controlled by the DATABASE_URL environment variable
(defaults to ./karaoke.db in the working directory).
"""

import logging
import os
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from karaoke_backend.db.sqlite import install_sqlite_pragmas

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Engine configuration
# ---------------------------------------------------------------------------

# Default: SQLite file in the current working directory (cwd=backend/ is
# invariant: systemd WorkingDirectory and dev docs both run from backend/)
_DEFAULT_DB = "sqlite+aiosqlite:///" + str(Path("karaoke.db").resolve())
DATABASE_URL = os.getenv("DATABASE_URL", _DEFAULT_DB)

# SQLite-specific kwargs (needed for in-memory SQLite in tests)
_CONNECT_ARGS: dict = {}
_POOL_KWARGS: dict = {}
if "sqlite" in DATABASE_URL:
    _CONNECT_ARGS = {"check_same_thread": False}
    if ":memory:" in DATABASE_URL:
        _POOL_KWARGS = {"poolclass": StaticPool}

engine = create_async_engine(
    DATABASE_URL,
    echo=os.getenv("SQL_ECHO", "false").lower() == "true",
    # Keep bound parameters out of exception text. SQLAlchemy renders them into
    # `str(exc)` AND into every traceback frame by default, so any handler that
    # logs an exception — including ones that have nothing to do with auth —
    # writes whatever was bound. On the join route the bound value is the
    # plaintext credential, so this is the difference between a database error
    # and a credential disclosure. Costs some debuggability; `SQL_ECHO=true`
    # is the deliberate, documented way to get it back.
    hide_parameters=True,
    connect_args=_CONNECT_ARGS,
    **_POOL_KWARGS,
)

# SQLite ships with FK enforcement off; turn it on per connection so that
# ON DELETE SET NULL / CASCADE clauses in our schema actually fire. File-backed
# databases also use WAL, and every SQLite connection waits up to five seconds
# for a busy writer before failing.
install_sqlite_pragmas(engine.sync_engine, foreign_keys=True)

def clamp_driver_logging() -> None:
    """Stop ``LOG_LEVEL=DEBUG`` from turning the driver into a credential log.

    The SQLite driver logs every statement together with its bound parameters
    at DEBUG. ``LOG_LEVEL=DEBUG`` is the first thing an operator reaches for
    when something misbehaves, and unclamped it writes every credential this
    process touches into the journal — session values, password hashes, and
    (since guest admission exists) the join credential this box issues plus
    every one a stranger guesses at the join route.

    The level that reads as "show me more detail" must not quietly also mean
    "log the secrets". Statement logging is still available deliberately, via
    ``SQL_ECHO=true``, which is documented as unsafe on a box serving guests.

    Called by ``main`` after it configures logging — the clamp is relative to
    the root level, so it has to run afterwards. Idempotent.
    """
    logging.getLogger("aiosqlite").setLevel(
        max(logging.getLogger().level, logging.INFO)
    )


AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------


async def get_db() -> AsyncSession:  # type: ignore[misc]
    """
    Yield a database session per request.
    Usage::

        @router.get("/example")
        async def example(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
#
# This module creates NOTHING. Schema is owned by alembic and applied by
# ``karaoke_backend.db.bootstrap.ensure_schema`` (startup, via the lifespan) or
# ``kb-db upgrade`` (operator). ``init_db`` was deleted with the last of
# the removed boot-time DDL. What remains here is the engine,
# the session factory, the request dependency, and the read-only guard below.


def _exit_no_schema(table: str) -> None:
    """Print the actionable 'no usable schema here' message and exit non-zero."""
    import sys

    sys.stderr.write(
        f"error: no '{table}' table at {DATABASE_URL}\n"
        "       run `kb-db status` to inspect, then `kb-db upgrade --yes` "
        "to initialise or migrate the database.\n"
    )
    raise SystemExit(1)


async def require_schema(table: str) -> None:
    """Read-only guard for ops/console-script entry points.

    Ops scripts must never create or migrate schema — that is the server's job
    (and ``kb-db upgrade``). This checks that ``table``
    exists and, if not, prints an actionable message and exits non-zero rather
    than proceeding against an uninitialised database. ``table`` is always an
    internal literal (never user input).

    A file-backed SQLite DB that does not exist yet is treated as 'no schema'
    WITHOUT opening a connection, so the probe never mints a stray 0-byte file
    at the resolved path. A genuine access error (locked / permissions / I/O) is
    surfaced honestly rather than dressed up as a missing-schema message — the
    'start the server once' remediation is shown ONLY when the schema is really
    the thing that is missing.
    """
    import sys

    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    url = engine.url
    db_file = url.database
    if url.get_backend_name() == "sqlite" and db_file and db_file != ":memory:":
        if not Path(db_file).exists():
            _exit_no_schema(table)

    try:
        async with engine.connect() as conn:
            await conn.execute(text(f"SELECT 1 FROM {table} LIMIT 1"))
    except OperationalError as exc:
        if "no such table" in str(exc).lower():
            _exit_no_schema(table)
        sys.stderr.write(f"error: cannot read the database at {DATABASE_URL}: {exc}\n")
        raise SystemExit(1)


def secret_dir() -> Path:
    """Directory for on-disk secret files that must outlive the code tree.

    The sqlite DB's own directory (so a secret survives a read-only or rebuilt
    code directory in docker), else the current working directory for
    non-sqlite URLs. Lives here rather than in ``main`` because more than one
    subsystem now persists a 0600 file next to the database — the session
    secret and the Plex token — and two copies of this rule would drift.

    Deliberately does NOT create the directory: callers that write decide when
    to ``mkdir``, and a pure read must not have a side effect on disk.
    """
    url = DATABASE_URL
    if url.startswith("sqlite") and ":memory:" not in url and ":///" in url:
        db_path = url.split(":///", 1)[1]
        if db_path:
            return Path(db_path).resolve().parent
    return Path.cwd()
