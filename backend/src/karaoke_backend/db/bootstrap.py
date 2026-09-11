# SPDX-License-Identifier: AGPL-3.0-only
"""Schema bootstrap — the startup replacement for the old ``init_db``.

Three cases, decided by looking at the database rather than by configuration:

* **fresh** (no ``alembic_version``, no ``songs``) → upgrade to head;
* **adopt** (``songs`` exists, no ``alembic_version``) → verify the DB really is
  the c0001 shape, WARN, stamp c0001, then upgrade to head. Every deployed
  install takes this path exactly once;
* **managed** (``alembic_version`` present) → upgrade to head.

Two policies are deliberate:

**Never repair, never stamp blind.** If verification fails, startup raises
``SchemaAdoptionError`` naming what is missing and pointing at ``kb-db repair``
or a restore. The known fleet is all current-shape, so an auto-repair path
would only ever execute against an *unknown* database — precisely where a
human belongs. This is the inversion of the old except-passed boot ALTERs,
which hid schema problems until they surfaced as runtime 500s.

**Auto-migrate is ON by default.** ``docker compose up`` must work on first run
and after every image upgrade; a mandatory manual migrate step is the top
support generator for self-hosted software. It is race-safe here (single
uvicorn process, SQLite single-writer, runs before the first request is
served) and fails fast rather than serving on a schema it does not understand.
Operators who want the control can set ``KARAOKE_DB_AUTO_MIGRATE=false``, which
mutates nothing and refuses to start unless the DB is already at head.
"""

import logging
import os
from typing import Optional

from alembic import command
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

from karaoke_backend.database import DATABASE_URL
from karaoke_backend.db import migrate
from karaoke_backend.db.sqlite import install_sqlite_pragmas

logger = logging.getLogger(__name__)

BASELINE_REVISION = "c0001"

# The c0001 column sets, FROZEN. Verification compares a candidate DB against
# this snapshot and NOT against live ORM metadata — otherwise every future
# model change would silently redefine what counts as an adoptable database.
# Extra columns are allowed (premium's tenancy columns, old experiments); only
# absence is disqualifying.
_C0001_COLUMNS: dict[str, frozenset[str]] = {
    "songs": frozenset({
        "id", "owner_id", "artist", "title", "filename", "duration", "status",
        "created_at", "updated_at", "stems_path", "job_id", "active_lyrics_id",
        "error_message", "word_sync_json", "custom_lyrics", "lyrics_synced",
    }),
    "jobs": frozenset({
        "id", "owner_id", "song_id", "status", "progress", "message",
        "created_at", "updated_at", "stems", "error_message",
    }),
    "lyrics_sets": frozenset({
        "id", "owner_id", "song_id", "source", "label", "is_verified",
        "plain_lyrics", "synced_lyrics", "word_sync_json", "metadata_json",
        "created_at", "updated_at",
    }),
}

# Columns a historical straggler could be missing that `kb-db repair` knows how
# to add (both were once added by the since-deleted boot ALTERs). Anything else
# missing is a human's problem, by design.
# The REFERENCES clause matters: the boot ALTER this replaces created
# active_lyrics_id WITH it, and SQLite only accepts it on ADD COLUMN while the
# default is NULL. Without it a repaired DB would pass name-only verification
# while permanently lacking ON DELETE SET NULL.
REPAIRABLE_COLUMNS: dict[str, dict[str, str]] = {
    "songs": {
        "custom_lyrics": "TEXT",
        "active_lyrics_id": "INTEGER REFERENCES lyrics_sets(id) ON DELETE SET NULL",
    },
}


class SchemaAdoptionError(RuntimeError):
    """An existing database does not match the baseline and was left untouched."""


def _flag(name: str, default: str = "true") -> bool:
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


def safe_url(url: Optional[str] = None) -> str:
    """The URL with any password masked — this is what gets logged/printed."""
    return make_url(migrate.sync_url(url)).render_as_string(hide_password=True)


def make_sync_engine(url: Optional[str] = None):
    """Short-lived sync engine for migration work.

    FK enforcement is turned off at CONNECT time rather than inside the
    migration: SQLite ignores ``PRAGMA foreign_keys`` while a transaction is
    open, and batch (table-rebuild) operations need it off to avoid re-pointing
    child rows at the temporary table.

    In-memory SQLite is REFUSED rather than quietly mishandled: with NullPool
    every connection is a *different* empty database, so a stamp, an upgrade
    and a row count would each touch their own — the whole run would report
    success having migrated nothing.
    """
    resolved = migrate.sync_url(url)
    if ":memory:" in resolved or "mode=memory" in resolved:
        raise SchemaAdoptionError(
            "ensure_schema cannot manage an in-memory SQLite database "
            f"({safe_url(url)}): each connection would see a separate empty "
            "database. Point DATABASE_URL at a file, or use create_all "
            "directly in tests."
        )

    engine = create_engine(resolved, poolclass=NullPool)
    install_sqlite_pragmas(engine, foreign_keys=False)

    return engine


def verify_core_schema(connection) -> list[str]:
    """Return a list of human-readable problems; empty means adoptable."""
    problems: list[str] = []
    inspector = inspect(connection)
    present = set(inspector.get_table_names())

    for table, required in _C0001_COLUMNS.items():
        if table not in present:
            problems.append(f"missing table '{table}'")
            continue
        actual = {col["name"] for col in inspector.get_columns(table)}
        for column in sorted(required - actual):
            problems.append(f"'{table}' is missing column '{column}'")

    return problems


def _current_revision(connection) -> Optional[str]:
    return MigrationContext.configure(connection).get_current_revision()


def _head_revision() -> str:
    # from_config (not a bare ScriptDirectory) so any future version_locations
    # or script.py.mako settings are honoured rather than bypassed.
    return ScriptDirectory.from_config(migrate.make_config()).get_current_head()


def _log_row_counts(connection) -> None:
    """INFO-log the row count of every core table.

    An accidental boot against an empty or wrong database file is otherwise
    invisible until a user notices their library is gone.
    """
    inspector = inspect(connection)
    present = set(inspector.get_table_names())
    counts = []
    for table in ("songs", "jobs", "lyrics_sets", "queue_entries"):
        if table in present:
            n = connection.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar_one()
            counts.append(f"{table}={n}")
    if counts:
        logger.info("Schema ready: %s", ", ".join(counts))


def ensure_schema(url: Optional[str] = None, force: bool = False) -> None:
    """Bring the database to head, or fail fast. Synchronous by design.

    Called from the app lifespan via ``asyncio.to_thread`` and directly by the
    CLI, so both paths execute exactly the same code.

    ``force`` overrides the ``KARAOKE_DB_AUTO_MIGRATE=false`` opt-out. Only the
    CLI passes it, and only for an explicitly ``--yes``-confirmed verb: the flag
    exists to keep STARTUP from migrating unattended, not to lock the operator
    out of the tool they reach for once startup has refused.
    """
    logger.info("Database URL: %s", safe_url(url))
    engine = make_sync_engine(url)

    try:
        with engine.connect() as conn:
            current = _current_revision(conn)
            songs_present = "songs" in set(inspect(conn).get_table_names())

        head = _head_revision()

        if not force and not _flag("KARAOKE_DB_AUTO_MIGRATE"):
            # Opt-out: mutate nothing, and refuse to serve on a stale schema.
            if current != head:
                raise SchemaAdoptionError(
                    "KARAOKE_DB_AUTO_MIGRATE is disabled and the database is at "
                    f"revision {current or 'none'}, not head ({head}). "
                    "Run `kb-db upgrade --yes` or re-enable auto-migrate."
                )
            logger.info("Auto-migrate disabled; database already at head (%s).", head)
            with engine.connect() as conn:
                _log_row_counts(conn)
            return

        if current is None and songs_present:
            # An existing deployment meeting alembic for the first time.
            with engine.connect() as conn:
                problems = verify_core_schema(conn)
            if problems:
                raise SchemaAdoptionError(
                    "this database has a 'songs' table but does not match the "
                    "c0001 baseline, so it was NOT modified:\n  - "
                    + "\n  - ".join(problems)
                    + "\nRun `kb-db status` to inspect, `kb-db repair --yes` if "
                    "these are the historical songs columns, or restore from a "
                    "backup."
                )
            logger.warning(
                "Existing database detected with no migration history — "
                "stamping baseline %s and upgrading to %s. No data is modified.",
                BASELINE_REVISION,
                head,
            )

        # Stamp and upgrade share ONE transaction so adoption is all-or-nothing.
        # Split across two, a failure part-way through the chain would leave the
        # database permanently stamped at the baseline with some revisions
        # applied — and every later boot would re-run the same failing revision.
        with engine.begin() as conn:
            cfg = migrate.make_config(connection=conn)
            if current is None and songs_present:
                command.stamp(cfg, BASELINE_REVISION)
            command.upgrade(cfg, "head")

        with engine.connect() as conn:
            logger.info("Database at revision %s.", _current_revision(conn))
            _log_row_counts(conn)
    finally:
        engine.dispose()


def repair(url: Optional[str] = None) -> list[str]:
    """Add back the two historical ``songs`` columns, if and only if missing.

    The operator path for a theoretical pre-ALTER straggler — deliberately the
    ONLY DDL outside a migration, deliberately additive, and deliberately not
    reachable from startup. Returns the list of applied statements.
    """
    engine = make_sync_engine(url)
    applied: list[str] = []
    try:
        with engine.begin() as conn:
            inspector = inspect(conn)
            present = set(inspector.get_table_names())
            for table, columns in REPAIRABLE_COLUMNS.items():
                if table not in present:
                    continue
                actual = {col["name"] for col in inspector.get_columns(table)}
                for column, sqltype in columns.items():
                    if column not in actual:
                        stmt = f"ALTER TABLE {table} ADD COLUMN {column} {sqltype}"
                        conn.execute(text(stmt))
                        applied.append(stmt)
        with engine.connect() as conn:
            remaining = verify_core_schema(conn)
        if remaining:
            raise SchemaAdoptionError(
                "repair could not make this database adoptable:\n  - "
                + "\n  - ".join(remaining)
            )
    finally:
        engine.dispose()
    return applied
