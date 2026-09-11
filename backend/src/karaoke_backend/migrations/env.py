# SPDX-License-Identifier: AGPL-3.0-only
"""Alembic environment for the CORE chain.

**Synchronous by design.** The app engine is async (aiosqlite), but migrations
run through a short-lived *sync* engine derived from the same URL. One code
path then serves the CLI, the test suite and application startup (which calls
``ensure_schema`` inside ``asyncio.to_thread``), which eliminates the
"asyncio.run() inside a running event loop" failure class outright rather than
dodging it. A second short-lived connection is harmless: SQLite is
single-writer and startup migrations run before uvicorn serves a request.

**Two independent chains.** Core owns the default ``alembic_version`` table.
The premium package owns ``alembic_version_premium`` and its own versions
directory. They are never merged into one graph: a shared version table would
record premium revision ids that a core-only public install cannot resolve
("Can't locate revision p0002"), which is the classic open-core failure.

**Standing rule — batch operations must NEVER pass ``copy_from``.** With
``copy_from`` alembic uses the supplied metadata instead of reflecting the live
table, so a rebuild would silently drop DB-side columns that core does not map
(premium's tables on an adopted DB). ``test_migrations.py`` enforces this.
"""

from alembic import context
from sqlalchemy import MetaData, create_engine, pool

from karaoke_backend.db import migrate
from karaoke_backend.db.sqlite import install_sqlite_pragmas
from karaoke_backend.models import queue as _queue  # noqa: F401  (registers queue_entries)
from karaoke_backend.models.song import Base

config = context.config

# --- The core chain's world: exactly these four tables, always ---------------
# `Base` is SHARED with the premium package (premium models register onto it in
# multi-user builds, by design), so `Base.metadata` at runtime
# is NOT a safe autogenerate target: running this env in a premium-composed
# process would otherwise offer to add users/shows/singers to a CORE revision.
#
# So the core chain never targets live metadata — it targets an explicit
# core-only copy. An unknown table cannot enter the public revision graph even
# if the whole premium package is loaded in the same interpreter.
#
# The complementary guarantee (that the core IMPORT GRAPH itself stays
# premium-free) is enforced where it can actually be observed: the subprocess
# test in `test_core_metadata_purity.py`, which imports the core models alone.
# Asserting it here instead would fail in every legitimate premium boot.
CORE_TABLES = ("songs", "jobs", "lyrics_sets", "queue_entries")

_missing = [name for name in CORE_TABLES if name not in Base.metadata.tables]
if _missing:
    raise RuntimeError(
        f"core model(s) not registered on Base.metadata: {', '.join(_missing)}. "
        "The migration environment cannot describe a schema it cannot see."
    )

# `owner_id` is deliberately NOT excluded: per the Option-A ruling (2026-07-23)
# it stays on the core models as a nullable, FK-less column and belongs in the
# baseline. Only premium TABLES are out of scope here.
target_metadata = MetaData()
for _name in CORE_TABLES:
    Base.metadata.tables[_name].to_metadata(target_metadata)


def include_object(obj, name, type_, reflected, compare_to):
    """Ignore anything that exists in the DB but not in core metadata.

    Second line of defence for autogenerate: running it against a
    premium-shaped development database must never emit drops of ``users``,
    ``shows``, or any other object core does not own.
    """
    if type_ == "table":
        return name in target_metadata.tables
    if reflected and compare_to is None:
        # DB-side column/index/constraint with no counterpart in core metadata.
        return False
    return True


def _configure_and_run(connection) -> None:
    if connection.dialect.name == "sqlite":
        # Batch (table-rebuild) operations require FK enforcement off, or
        # SQLite re-points child rows at the temporary table mid-rebuild.
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")

    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        compare_type=True,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_offline() -> None:
    """`--sql` mode: emit statements without a DBAPI connection."""
    context.configure(
        url=config.attributes.get("sync_url") or migrate.sync_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
        compare_type=True,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run against a live connection.

    An injected ``connection`` attribute wins (tests / ``ensure_schema``);
    otherwise a NullPool engine is built from the sync URL and disposed here.
    """
    injected = config.attributes.get("connection")
    if injected is not None:
        _configure_and_run(injected)
        return

    url = config.attributes.get("sync_url") or migrate.sync_url()
    engine = create_engine(url, poolclass=pool.NullPool)
    install_sqlite_pragmas(engine, foreign_keys=False)
    try:
        with engine.connect() as connection:
            _configure_and_run(connection)
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
