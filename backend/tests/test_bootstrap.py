# SPDX-License-Identifier: AGPL-3.0-only
"""Boot-path safety net — now pinned against the alembic bootstrap.

Originally written to pin ``init_db``'s schema behaviour so the stepwise
DDL removal could be proven schema-neutral. A later step deleted ``init_db``
and moved the boot path onto ``db.bootstrap.ensure_schema``; the assertions
carry over unchanged in spirit and are now the net for the MIGRATION path:

* booting against a deployed-shape DB must PRESERVE every existing object
  byte-for-byte — adoption stamps and adds, it never rewrites; the only
  additions permitted are ``alembic_version`` and the net-new ``queue_entries``
  (c0002), and
* a fresh empty DB must get exactly the core tables.

The DROP loop (``rotation_entries``/``wishlist_songs``) is covered only
implicitly: those tables are absent from the real ``.schema`` capture this
fixture was built from, which is *why* the loop is already dead code on every
deployed DB. The net proves the loop doesn't re-create or disturb anything;
it can't prove a no-op on a DB that still carried them (none does).

These run core-mode (single_host): ``Base.metadata`` holds only the core tables
(songs, jobs, lyrics_sets, queue_entries), so the core chain never creates the
fixture's premium tables. The multi-user boot is exercised by the (unchanged)
premium suite; the data-level adoption assertions (stamping, row survival,
legacy lyric porting) live in ``test_migrations.py``.

NOTE: ``ensure_schema`` takes the database URL as an argument, so these tests
point it at a temp file directly — no monkeypatching of module globals.
"""

import sqlite3
from pathlib import Path

from karaoke_backend.db import bootstrap

FIXTURE = Path(__file__).parent / "fixtures" / "deployed_schema_2026-07.sql"

CORE_TABLES = {
    "songs", "jobs", "lyrics_sets", "queue_entries",
    "play_history", "app_settings",
}
DEPLOYED_TABLES = {
    "songs", "jobs", "lyrics_sets",
    "shows", "singers", "singer_songs", "users", "invites",
}


def _schema_objects(db_path: Path) -> list:
    """Stable (type, name, tbl_name, sql) rows from sqlite_master."""
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).fetchall()
    finally:
        conn.close()


def _table_names(db_path: Path) -> set:
    return {r[1] for r in _schema_objects(db_path) if r[0] == "table"}


def _seed_deployed(db_path: Path) -> None:
    """Build a deployed-shape DB: fixture DDL + a few synthetic rows so the
    checkfirst ``create_all`` runs against realistically-populated tables.

    Historical note: these rows once exercised ``init_db``'s boot-time
    ``_migrate_legacy_lyrics``/``_backfill_owner_ids`` DML (the legacy song had
    ``word_sync_json`` but no lyrics_sets row; the ``users`` row was the FK
    target for the migrated set's ``owner_id``). All boot DML was removed, so
    those rows are now inert — retained only so the neutrality assertion is made
    against a non-empty DB, which is the realistic case. The schema-neutrality
    check (``before == after`` on ``sqlite_master``) is what this test pins and
    is unaffected by the DML removal."""
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(FIXTURE.read_text())
        conn.execute(
            "INSERT INTO users (id, email, password_hash, is_admin) VALUES (1, ?, ?, 1)",
            ("host@example.test", "x"),
        )
        # a legacy-shape song (word_sync_json, no lyrics_sets row); inert now
        # (boot no longer migrates it), kept so the DB is realistically populated
        conn.execute(
            "INSERT INTO songs (id, artist, title, filename, status, lyrics_synced, "
            "word_sync_json, owner_id) VALUES (1, ?, ?, ?, 'ready', 0, ?, 1)",
            ("Synth Artist", "Synth Title", "synth.mp3", '[{"w": "la", "s": 0.0, "e": 0.5}]'),
        )
        conn.commit()
    finally:
        conn.close()


def _boot_against(db_path: Path) -> None:
    """Run the real startup schema path against db_path."""
    bootstrap.ensure_schema(f"sqlite:///{db_path}")


def test_fresh_empty_core_boot_creates_core_tables(tmp_path):
    db_path = tmp_path / "fresh.db"
    _boot_against(db_path)
    assert _table_names(db_path) == CORE_TABLES | {"alembic_version"}


def test_deployed_fixture_core_boot_preserves_existing_and_adds_queue(tmp_path):
    db_path = tmp_path / "deployed.db"
    _seed_deployed(db_path)
    before = _schema_objects(db_path)

    _boot_against(db_path)

    after = _schema_objects(db_path)

    before_by_key = {(r[0], r[1]): r[3] for r in before}
    after_by_key = {(r[0], r[1]): r[3] for r in after}

    # Every pre-existing object is preserved byte-for-byte — adoption never
    # rewrites — with two sanctioned exceptions: c0005 appends the durable
    # queue's columns to `jobs`, and c0007 appends `video_filename` to `songs`.
    # Both are additive ADD COLUMNs, which SQLite records by appending to the
    # stored CREATE TABLE text; neither is the table rebuild this test exists
    # to catch. Those two tables are checked as strict EXTENSIONS instead:
    # nothing removed, nothing reordered, FK clause intact.
    extended = {("table", "jobs"), ("table", "songs")}
    for key, sql in before_by_key.items():
        if key in extended:
            continue
        assert after_by_key.get(key) == sql, f"adoption mutated existing object {key}"

    for _type, name in sorted(extended):
        table_before = before_by_key[(_type, name)]
        table_after = after_by_key[(_type, name)]
        for fragment in _column_fragments(table_before):
            assert fragment in table_after, f"adoption lost `{name}` column: {fragment}"

    jobs_after = after_by_key[("table", "jobs")]
    songs_after = after_by_key[("table", "songs")]
    assert "ON DELETE CASCADE" in jobs_after, (
        "adoption dropped the jobs.song_id FK behaviour — the batch-rebuild failure"
    )
    assert "ON DELETE SET NULL" in songs_after, (
        "adoption dropped the songs.active_lyrics_id FK behaviour — the "
        "batch-rebuild failure"
    )
    assert "kind VARCHAR(32)" in jobs_after, "c0005 did not add its columns"
    assert "video_filename VARCHAR(512)" in songs_after, "c0007 did not add its column"

    # The ONLY additions permitted: the version table (stamp), the net-new
    # queue_entries table + its indexes (c0002), the three owner_id indexes
    # c0004 creates because a stamped DB never runs the c0001 that declares
    # them, c0005's claim/lease index, and c0006's net-new play_history +
    # app_settings tables (+ play_history's indexes). All CREATE.
    allowed_indexes = {
        "ix_songs_owner_id", "ix_jobs_owner_id", "ix_lyrics_sets_owner_id",
        "ix_jobs_status_lease",
        "ix_play_history_song_id", "ix_play_history_played_at",
    }
    added = [r for r in after if (r[0], r[1]) not in before_by_key]
    assert added, "expected adoption to add alembic_version and queue_entries"
    assert all(
        r[1] == "alembic_version"
        or r[2] in ("queue_entries", "play_history", "app_settings")
        or r[1] in allowed_indexes
        for r in added
    ), f"unexpected additions: {added}"
    assert _table_names(db_path) == DEPLOYED_TABLES | {
        "queue_entries", "play_history", "app_settings", "alembic_version"
    }


def _column_fragments(create_sql: str) -> list[str]:
    """The comma-separated column definitions inside a CREATE TABLE body."""
    body = create_sql[create_sql.index("(") + 1 : create_sql.rindex(")")]
    return [part.strip() for part in body.split(",") if part.strip()]
