# SPDX-License-Identifier: AGPL-3.0-only
"""``kb-db`` — the schema operations CLI.

    kb-db status                 # read-only: what would happen, and where
    kb-db upgrade --yes          # bring the database to head
    kb-db stamp-baseline --yes   # record c0001 without running it
    kb-db repair --yes           # add back the two historical songs columns

Every invocation prints the RESOLVED absolute database path before doing
anything, because the most expensive mistake available here is operating on
the wrong file. Every mutating verb requires ``--yes``; ``status`` never
writes.

Naming note: the console script is ``kb-db``, matching the established
``kb-*`` console-script convention (``kb-seed-lyrics-reference``) rather than
a ``karaoke-backend db`` subcommand — there is no umbrella command to hang a
subcommand off.
"""

import argparse
import logging
import sys
from pathlib import Path

from alembic import command
from sqlalchemy import inspect
from sqlalchemy.exc import SQLAlchemyError

from karaoke_backend.db import bootstrap, migrate


def _resolved_db_path() -> str:
    url = migrate.sync_url()
    if url.startswith("sqlite:///"):
        return str(Path(url.removeprefix("sqlite:///")).resolve())
    return bootstrap.safe_url()  # non-SQLite: the URL itself, password masked


def _print_target() -> None:
    print(f"database: {_resolved_db_path()}")


def _cmd_status(_args: argparse.Namespace) -> int:
    engine = bootstrap.make_sync_engine()
    try:
        with engine.connect() as conn:
            tables = sorted(inspect(conn).get_table_names())
            current = bootstrap._current_revision(conn)
            head = bootstrap._head_revision()

            print(f"tables:   {', '.join(tables) if tables else '(none)'}")
            print(f"revision: {current or '(none)'}")
            print(f"head:     {head}")

            if current is None and "songs" in tables:
                problems = bootstrap.verify_core_schema(conn)
                if problems:
                    print("plan:     REFUSE — existing schema does not match the baseline:")
                    for problem in problems:
                        print(f"            - {problem}")
                    return 1
                print(f"plan:     legacy schema → stamp {bootstrap.BASELINE_REVISION}, then upgrade to {head}")
            elif current is None:
                print(f"plan:     fresh install → upgrade to {head}")
            elif current == head:
                print("plan:     nothing to do (at head)")
            else:
                print(f"plan:     upgrade {current} → {head}")
    finally:
        engine.dispose()
    return 0


def _cmd_upgrade(_args: argparse.Namespace) -> int:
    # force=True: KARAOKE_DB_AUTO_MIGRATE=false is there to stop STARTUP from
    # migrating unattended. Honouring it here too would make this command
    # refuse with a message telling the operator to run this command.
    bootstrap.ensure_schema(force=True)
    return 0


def _cmd_stamp_baseline(_args: argparse.Namespace) -> int:
    """Record the baseline on a database that has no migration history.

    Guarded twice, because an unguarded stamp is the one command here that can
    brick a working install: stamping an already-managed DB back to c0001 makes
    every later revision re-run against objects that already exist.
    """
    engine = bootstrap.make_sync_engine()
    try:
        with engine.connect() as conn:
            current = bootstrap._current_revision(conn)
            if current is not None:
                print(
                    f"refusing: this database is already managed (revision {current}). "
                    "Re-stamping would replay revisions against existing objects.",
                    file=sys.stderr,
                )
                return 1
            problems = bootstrap.verify_core_schema(conn)
        if problems:
            print("refusing: schema does not match the baseline:", file=sys.stderr)
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            return 1

        with engine.begin() as conn:
            command.stamp(migrate.make_config(connection=conn), bootstrap.BASELINE_REVISION)
    finally:
        engine.dispose()
    print(f"stamped {bootstrap.BASELINE_REVISION}")
    return 0


def _cmd_repair(_args: argparse.Namespace) -> int:
    applied = bootstrap.repair()
    if not applied:
        print("nothing to repair — schema already matches the baseline")
    else:
        for stmt in applied:
            print(f"applied: {stmt}")
    return 0


_MUTATING = {"upgrade", "stamp-baseline", "repair"}


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)-8s %(message)s")

    parser = argparse.ArgumentParser(prog="kb-db", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="verb", required=True)

    sub.add_parser("status", help="read-only: report schema state and the planned action")
    for verb, helptext in (
        ("upgrade", "bring the database to head (stamping the baseline first if needed)"),
        ("stamp-baseline", f"record {bootstrap.BASELINE_REVISION} without executing it"),
        ("repair", "add back the two historical songs columns if missing"),
    ):
        p = sub.add_parser(verb, help=helptext)
        p.add_argument("--yes", action="store_true", help="required: confirm this mutates the database")

    args = parser.parse_args(argv)

    _print_target()

    if args.verb in _MUTATING and not args.yes:
        print(f"refusing to run '{args.verb}' without --yes (it modifies the database above)", file=sys.stderr)
        return 2

    handler = {
        "status": _cmd_status,
        "upgrade": _cmd_upgrade,
        "stamp-baseline": _cmd_stamp_baseline,
        "repair": _cmd_repair,
    }[args.verb]

    try:
        return handler(args)
    except bootstrap.SchemaAdoptionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except SQLAlchemyError as exc:
        # A database-level failure (locked file, permissions, a revision hitting
        # an object that already exists) should read as an error, not as an
        # unhandled traceback out of a CLI.
        print(f"error: database operation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
