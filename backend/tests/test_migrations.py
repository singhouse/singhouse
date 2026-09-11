# SPDX-License-Identifier: AGPL-3.0-only
"""The alembic chain: drift gate, adoption, refusal, and destructive-op scan.

These are the tests that let the fast ``create_all`` fixtures in conftest stay
fast. Test 1 is the load-bearing one: it proves a freshly-migrated database is
indistinguishable from ``Base.metadata``, so "model change without a matching
revision" is caught here rather than on someone's first upgrade.
"""

import ast
import sqlite3
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text

from karaoke_backend.db import bootstrap, migrate
from karaoke_backend.models import history as _history  # noqa: F401  (registers play_history)
from karaoke_backend.models import queue as _queue  # noqa: F401  (registers queue_entries)
from karaoke_backend.models import settings as _settings  # noqa: F401  (registers app_settings)
from karaoke_backend.models.song import Base

FIXTURE = Path(__file__).parent / "fixtures" / "deployed_schema_2026-07.sql"
VERSIONS_DIR = migrate.MIGRATIONS_DIR / "versions"


def _url(db_path: Path) -> str:
    return f"sqlite:///{db_path}"


def _revision(db_path: Path) -> str | None:
    engine = create_engine(_url(db_path))
    try:
        with engine.connect() as conn:
            return MigrationContext.configure(conn).get_current_revision()
    finally:
        engine.dispose()


def _seed_deployed(db_path: Path) -> None:
    """A deployed-shape DB: real DDL capture, synthetic rows.

    Includes one legacy-shape song (``word_sync_json`` set, no ``lyrics_sets``
    row) so c0003 has something to port, and one already-ported song so its
    idempotence guard is exercised too.
    """
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(FIXTURE.read_text())
        conn.execute(
            "INSERT INTO users (id, email, password_hash, is_admin) VALUES (1, ?, ?, 1)",
            ("host@example.test", "x"),
        )
        conn.execute(
            "INSERT INTO songs (id, artist, title, filename, status, lyrics_synced, "
            "word_sync_json, owner_id) VALUES (1, ?, ?, ?, 'ready', 0, ?, 1)",
            ("Legacy Artist", "Legacy Title", "legacy.mp3", '[{"w": "la", "s": 0.0, "e": 0.5}]'),
        )
        conn.execute(
            "INSERT INTO songs (id, artist, title, filename, status, lyrics_synced, "
            "custom_lyrics, owner_id) VALUES (2, ?, ?, ?, 'ready', 0, ?, 1)",
            ("Custom Artist", "Custom Title", "custom.mp3", "[00:01.00]a timed line"),
        )
        # already migrated: has a lyrics_sets row, so c0003 must skip it
        conn.execute(
            "INSERT INTO songs (id, artist, title, filename, status, lyrics_synced, "
            "word_sync_json, owner_id) VALUES (3, ?, ?, ?, 'ready', 0, ?, 1)",
            ("Done Artist", "Done Title", "done.mp3", '[{"w": "x", "s": 0.0, "e": 0.1}]'),
        )
        conn.execute(
            "INSERT INTO lyrics_sets (id, song_id, source, is_verified, owner_id) "
            "VALUES (77, 3, 'manual', 0, 1)"
        )
        conn.commit()
    finally:
        conn.close()


def test_fresh_upgrade_matches_metadata(tmp_path):
    """THE drift gate: migrated schema == ORM metadata, with no diff at all."""
    db_path = tmp_path / "fresh.db"
    bootstrap.ensure_schema(_url(db_path))

    engine = create_engine(_url(db_path))
    try:
        with engine.connect() as conn:
            context = MigrationContext.configure(
                conn,
                opts={
                    "compare_type": True,
                    "include_object": lambda obj, name, type_, reflected, compare_to: (
                        name in Base.metadata.tables if type_ == "table" else True
                    ),
                },
            )
            diff = compare_metadata(context, Base.metadata)
    finally:
        engine.dispose()

    assert diff == [], f"schema drift between migrations and models: {diff}"


def test_adopt_deployed_db(tmp_path):
    """A real deployed database is stamped, upgraded, and left otherwise intact."""
    db_path = tmp_path / "deployed.db"
    _seed_deployed(db_path)

    bootstrap.ensure_schema(_url(db_path))

    assert _revision(db_path) == "c0007"

    conn = sqlite3.connect(str(db_path))
    try:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        assert "queue_entries" in tables
        # premium tables untouched by the core chain
        assert {"users", "invites", "shows", "singers", "singer_songs"} <= tables

        # pre-existing rows survive, premium columns included
        assert conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0] == 3
        assert conn.execute("SELECT owner_id FROM songs WHERE id=1").fetchone()[0] == 1
        assert conn.execute("SELECT email FROM users WHERE id=1").fetchone()[0] == "host@example.test"

        # c0003 ported the legacy song and adopted the set as active…
        ported = conn.execute(
            "SELECT source, label, word_sync_json, owner_id FROM lyrics_sets WHERE song_id=1"
        ).fetchall()
        assert len(ported) == 1
        assert ported[0][0] == "transcription"
        assert ported[0][1] == "legacy import"
        assert ported[0][3] is None, "core chain must not write owner_id (premium p0002 sweeps it)"
        assert conn.execute("SELECT active_lyrics_id FROM songs WHERE id=1").fetchone()[0] is not None

        # …detected the custom lyrics as LRC…
        custom = conn.execute(
            "SELECT source, plain_lyrics, synced_lyrics FROM lyrics_sets WHERE song_id=2"
        ).fetchone()
        assert custom[0] == "manual"
        assert custom[1] is None
        assert custom[2] == "[00:01.00]a timed line"

        # …and skipped the song that already had a set
        assert conn.execute(
            "SELECT COUNT(*) FROM lyrics_sets WHERE song_id=3"
        ).fetchone()[0] == 1
    finally:
        conn.close()


def test_adopt_refuses_unknown_schema(tmp_path):
    """A songs-bearing DB that isn't the baseline is refused, and NOT touched."""
    db_path = tmp_path / "unknown.db"
    conn = sqlite3.connect(str(db_path))
    try:
        # songs exists (so this is the adopt path) but lyrics_sets does not
        conn.execute("CREATE TABLE songs (id INTEGER PRIMARY KEY, artist TEXT)")
        conn.commit()
        before = conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY name"
        ).fetchall()
    finally:
        conn.close()

    with pytest.raises(bootstrap.SchemaAdoptionError) as exc:
        bootstrap.ensure_schema(_url(db_path))

    assert "lyrics_sets" in str(exc.value)

    conn = sqlite3.connect(str(db_path))
    try:
        after = conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY name"
        ).fetchall()
    finally:
        conn.close()
    assert after == before, "refusal must not mutate the database"


def _source_outside_downgrade(path: Path) -> str:
    """Whole module source with the ``downgrade`` body removed.

    Scanning the ``upgrade`` function body alone is not enough: c0003
    establishes the idiom of hoisting SQL into module-level ``sa.text(...)``
    constants, which live outside every function. A scan that only looked
    inside ``upgrade`` would wave a module-level ``DROP TABLE`` straight
    through — verified by review, 2026-07-26.
    """
    source = path.read_text()
    lines = source.splitlines(keepends=True)
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "downgrade":
            start = node.lineno - 1
            end = node.end_lineno
            for i in range(start, end):
                lines[i] = ""
    return "".join(lines)


def test_no_destructive_ops_in_upgrades():
    """Nothing outside ``downgrade`` may destroy schema or data.

    ``downgrade`` is exempt because it legitimately drops what its own upgrade
    created, and downgrades are a development affordance — the live path only
    ever moves forward (the upgrade safety proof enumerates every statement an
    existing DB can execute, and none is destructive).
    """
    banned_calls = {"drop_table", "drop_column", "drop_index", "drop_constraint"}
    banned_sql = ("DROP TABLE", "DROP COLUMN", "DROP INDEX", "DELETE FROM", "TRUNCATE")
    offenders = []

    for path in sorted(VERSIONS_DIR.glob("*.py")):
        scanned = _source_outside_downgrade(path)

        for node in ast.walk(ast.parse(scanned)):
            if isinstance(node, ast.Call):
                fn = node.func
                name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
                if name in banned_calls:
                    offenders.append(f"{path.name}: {name}()")

        upper = scanned.upper()
        for keyword in banned_sql:
            if keyword in upper:
                offenders.append(f"{path.name}: raw {keyword}")

    assert offenders == [], f"destructive operations in upgrade path: {offenders}"


def test_batch_operations_only_touch_tables_created_in_the_same_revision():
    """Batch (table-rebuild) ops are safe ONLY on a table the revision just made.

    Reflection on SQLite does not recover FK ``ON DELETE`` clauses
    (SQLAlchemy 2.0.36 returns ``options: {}``), so rebuilding a PRE-EXISTING
    table silently downgrades ``ON DELETE SET NULL`` / ``CASCADE`` to a bare
    reference — with or without ``copy_from``. This is not theoretical: the
    deployed ``jobs.status`` is ``VARCHAR(20)`` against the model's
    ``String(32)``, so autogenerate WILL propose exactly such a batch op.
    Rebuilding a table the same revision created is fine — there is no live
    data or DB-side constraint to lose.
    """
    offenders = []
    for path in sorted(VERSIONS_DIR.glob("*.py")):
        tree = ast.parse(_source_outside_downgrade(path))
        created = set()
        batched = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
            if name in ("create_table", "batch_alter_table") and node.args:
                first = node.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    (created if name == "create_table" else batched).add(first.value)
        for table in sorted(batched - created):
            offenders.append(f"{path.name}: batch_alter_table('{table}') on a pre-existing table")

    assert offenders == [], (
        "batch_alter_table rebuilds the table and loses FK ON DELETE clauses that "
        f"SQLite reflection cannot see: {offenders}"
    )


def test_versions_contain_no_premium_tables():
    """The public revision graph must never name a premium table.

    ``env.py`` targets an explicit core-only metadata copy so autogenerate
    cannot emit these, and the subprocess purity test guards the import graph.
    This is the third leg: whatever the generator did, what actually SHIPPED in
    ``versions/`` is premium-free.
    """
    premium_tables = ("users", "invites", "shows", "singers", "singer_songs")
    offenders = []
    for path in sorted(VERSIONS_DIR.glob("*.py")):
        source = path.read_text()
        for table in premium_tables:
            if f"'{table}'" in source or f'"{table}"' in source:
                offenders.append(f"{path.name}: {table}")
    assert offenders == [], f"premium tables leaked into the core chain: {offenders}"


def test_no_copy_from_in_batch_operations():
    """``copy_from`` would make a batch rebuild drop DB-side columns core doesn't map."""
    offenders = [
        path.name
        for path in sorted(VERSIONS_DIR.glob("*.py"))
        if "copy_from" in path.read_text()
    ]
    assert offenders == [], (
        "batch_alter_table must never pass copy_from — with it alembic uses the "
        f"supplied metadata instead of reflecting the live table: {offenders}"
    )


def test_c0003_guard_prevents_reporting(tmp_path):
    """c0003 re-executed against an already-ported DB must not duplicate rows.

    ``test_double_run_idempotent`` cannot prove this: alembic's version table
    means a second ``ensure_schema`` never reaches c0003 at all. So this test
    winds the revision back and makes it run again for real — which is what the
    ``NOT EXISTS`` guard actually defends against.
    """
    db_path = tmp_path / "reported.db"
    _seed_deployed(db_path)
    bootstrap.ensure_schema(_url(db_path))

    engine = create_engine(_url(db_path))
    try:
        with engine.begin() as conn:
            conn.execute(text("UPDATE alembic_version SET version_num = 'c0002'"))
    finally:
        engine.dispose()

    before = _lyrics_rows(db_path)
    bootstrap.ensure_schema(_url(db_path))
    assert _lyrics_rows(db_path) == before, "c0003 re-ported rows on a second execution"


def _lyrics_rows(db_path: Path) -> list:
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(
            "SELECT id, song_id, source, label FROM lyrics_sets ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


def test_queue_entries_already_present_is_not_fatal(tmp_path):
    """A DB that already has queue_entries must still adopt.

    Any database booted on this branch between the addition of the QueueEntry
    model and the removal of the boot create_all has the table already, and adoption
    stamps c0001 without inspecting it — so c0002 has to tolerate it or that DB
    can never boot again.
    """
    db_path = tmp_path / "hasqueue.db"
    _seed_deployed(db_path)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "CREATE TABLE queue_entries (id INTEGER PRIMARY KEY, song_id INTEGER NOT NULL, "
            "singer_name VARCHAR(80), position INTEGER NOT NULL, created_at DATETIME)"
        )
        conn.execute(
            "INSERT INTO queue_entries (id, song_id, singer_name, position) VALUES (1, 1, 'Ada', 0)"
        )
        conn.commit()
    finally:
        conn.close()

    bootstrap.ensure_schema(_url(db_path))

    assert _revision(db_path) == "c0007"
    conn = sqlite3.connect(str(db_path))
    try:
        assert conn.execute("SELECT singer_name FROM queue_entries").fetchone()[0] == "Ada"
    finally:
        conn.close()


def test_adoption_creates_missing_owner_id_indexes(tmp_path):
    """c0004 closes the fresh-vs-adopted divergence c0001's stamp leaves behind."""
    db_path = tmp_path / "indexes.db"
    _seed_deployed(db_path)

    conn = sqlite3.connect(str(db_path))
    try:
        before = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        )}
    finally:
        conn.close()
    assert "ix_songs_owner_id" not in before, "fixture should reproduce the deployed gap"

    bootstrap.ensure_schema(_url(db_path))

    conn = sqlite3.connect(str(db_path))
    try:
        after = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        )}
    finally:
        conn.close()
    assert {"ix_songs_owner_id", "ix_jobs_owner_id", "ix_lyrics_sets_owner_id"} <= after


def test_baseline_column_snapshot_matches_c0001(tmp_path):
    """The frozen verification snapshot must describe what c0001 actually builds.

    If they drift, adoption either rejects healthy databases or accepts ones
    that are missing columns the code requires.

    Migrated to c0001 EXACTLY, not to head. Later revisions legitimately add
    columns — c0005 puts the durable queue's claim/lease columns on ``jobs`` —
    and this test is about the BASELINE an adopted database is measured
    against, which is frozen at c0001 by construction and has to stay that way.
    Measuring head against the frozen snapshot would forbid every future
    column, which is not what `_C0001_COLUMNS` means.
    """
    from alembic import command

    db_path = tmp_path / "baseline.db"
    engine = bootstrap.make_sync_engine(_url(db_path))
    try:
        with engine.begin() as conn:
            command.upgrade(migrate.make_config(connection=conn), "c0001")
        with engine.connect() as conn:
            for table, expected in bootstrap._C0001_COLUMNS.items():
                actual = {c["name"] for c in inspect(conn).get_columns(table)}
                assert actual == set(expected), (
                    f"{table}: snapshot {sorted(expected)} != built {sorted(actual)}"
                )
    finally:
        engine.dispose()


def test_in_memory_database_is_refused():
    """NullPool + :memory: would give every connection its own empty database."""
    with pytest.raises(bootstrap.SchemaAdoptionError) as exc:
        bootstrap.ensure_schema("sqlite:///:memory:")
    assert "in-memory" in str(exc.value)


def test_auto_migrate_disabled_refuses_and_mutates_nothing(tmp_path, monkeypatch):
    db_path = tmp_path / "optout.db"
    _seed_deployed(db_path)
    before = _schema_snapshot(db_path)

    monkeypatch.setenv("KARAOKE_DB_AUTO_MIGRATE", "false")
    with pytest.raises(bootstrap.SchemaAdoptionError) as exc:
        bootstrap.ensure_schema(_url(db_path))
    assert "not head" in str(exc.value)
    assert _schema_snapshot(db_path) == before

    # …but an explicitly confirmed CLI upgrade still works (force=True).
    bootstrap.ensure_schema(_url(db_path), force=True)
    assert _revision(db_path) == "c0007"


def _schema_snapshot(db_path: Path) -> list:
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
        ).fetchall()
    finally:
        conn.close()


def test_cli_status_is_read_only_and_reports_the_plan(tmp_path, monkeypatch, capsys):
    from karaoke_backend import cli

    db_path = tmp_path / "cli.db"
    _seed_deployed(db_path)
    monkeypatch.setattr(migrate, "sync_url", lambda *a, **k: _url(db_path))
    before = _schema_snapshot(db_path)

    assert cli.main(["status"]) == 0
    out = capsys.readouterr().out
    assert str(db_path) in out
    assert "stamp c0001" in out
    assert _schema_snapshot(db_path) == before, "status must not mutate"


def test_cli_mutating_verbs_require_yes(tmp_path, monkeypatch, capsys):
    from karaoke_backend import cli

    db_path = tmp_path / "cli_noyes.db"
    _seed_deployed(db_path)
    monkeypatch.setattr(migrate, "sync_url", lambda *a, **k: _url(db_path))
    before = _schema_snapshot(db_path)

    for verb in ("upgrade", "stamp-baseline", "repair"):
        assert cli.main([verb]) == 2, f"{verb} ran without --yes"
        capsys.readouterr()
    assert _schema_snapshot(db_path) == before


def test_cli_stamp_baseline_refuses_a_managed_database(tmp_path, monkeypatch, capsys):
    """Re-stamping a working install would replay revisions against live objects."""
    from karaoke_backend import cli

    db_path = tmp_path / "managed.db"
    _seed_deployed(db_path)
    monkeypatch.setattr(migrate, "sync_url", lambda *a, **k: _url(db_path))
    bootstrap.ensure_schema(_url(db_path))
    capsys.readouterr()

    assert cli.main(["stamp-baseline", "--yes"]) == 1
    assert "already managed" in capsys.readouterr().err
    assert _revision(db_path) == "c0007", "revision must be untouched"


def test_repair_restores_the_historical_songs_columns(tmp_path):
    """repair() must reproduce the boot ALTER it replaces, FK clause included."""
    db_path = tmp_path / "straggler.db"
    conn = sqlite3.connect(str(db_path))
    try:
        # a pre-ALTER shape: songs without custom_lyrics / active_lyrics_id
        conn.executescript(FIXTURE.read_text())
        conn.execute("ALTER TABLE songs DROP COLUMN custom_lyrics")
        conn.execute("ALTER TABLE songs DROP COLUMN active_lyrics_id")
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(bootstrap.SchemaAdoptionError):
        bootstrap.ensure_schema(_url(db_path))

    applied = bootstrap.repair(_url(db_path))
    assert len(applied) == 2

    conn = sqlite3.connect(str(db_path))
    try:
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='songs'"
        ).fetchone()[0]
        assert "ON DELETE SET NULL" in sql, "repair must not drop the FK behaviour"
    finally:
        conn.close()

    bootstrap.ensure_schema(_url(db_path))
    assert _revision(db_path) == "c0007"


def test_double_run_idempotent(tmp_path):
    """A second ensure_schema is a no-op, schema and data alike."""
    db_path = tmp_path / "twice.db"
    _seed_deployed(db_path)

    bootstrap.ensure_schema(_url(db_path))
    conn = sqlite3.connect(str(db_path))
    try:
        schema_first = conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
        ).fetchall()
        sets_first = conn.execute(
            "SELECT id, song_id, source, label FROM lyrics_sets ORDER BY id"
        ).fetchall()
    finally:
        conn.close()

    bootstrap.ensure_schema(_url(db_path))
    conn = sqlite3.connect(str(db_path))
    try:
        schema_second = conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
        ).fetchall()
        sets_second = conn.execute(
            "SELECT id, song_id, source, label FROM lyrics_sets ORDER BY id"
        ).fetchall()
    finally:
        conn.close()

    assert schema_second == schema_first
    assert sets_second == sets_first, "c0003 must not re-port on a second run"


def test_owner_id_survives_core_migrations(tmp_path):
    """Ex-premium data must come through the core chain unharmed.

    This is the regression guard for the never-``copy_from`` rule: if a future
    batch operation reflected the wrong table shape, owner_id values are what
    would silently vanish.
    """
    db_path = tmp_path / "expremium.db"
    _seed_deployed(db_path)

    bootstrap.ensure_schema(_url(db_path))

    engine = create_engine(_url(db_path))
    try:
        with engine.connect() as conn:
            for table in ("songs", "jobs", "lyrics_sets"):
                columns = {c["name"] for c in inspect(conn).get_columns(table)}
                assert "owner_id" in columns, f"{table}.owner_id was dropped"
            owners = conn.execute(text("SELECT DISTINCT owner_id FROM songs")).scalars().all()
            assert owners == [1]
    finally:
        engine.dispose()
