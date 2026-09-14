# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import os
from pathlib import Path, PureWindowsPath
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import Mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import (backup_sqlite_database, desktop_database_backup,
                     desktop_database_plan, desktop_database_restore, desktop_database_unowned,
                     durable_replace, persistent_directory, restore_sqlite_database, sqlite_database_plan,
                     windows_durable_replace)


class DatabaseRecoveryTests(unittest.TestCase):
    def make_database(self, path, value="before"):
        with sqlite3.connect(path) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE state(value TEXT NOT NULL)")
            connection.execute("INSERT INTO state VALUES (?)", (value,))
            connection.commit()

    def test_windows_durability_never_opens_a_raw_volume_or_renames_after_flush_failure(self):
        invalid = __import__("ctypes").c_void_p(-1).value
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=invalid),
                                       FlushFileBuffers=Mock(return_value=True),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=True))
        source = PureWindowsPath("C:/Users/person/AppData/Roaming/Singhouse/pending")
        destination = PureWindowsPath("C:/Users/person/AppData/Roaming/Singhouse/active")
        with self.assertRaisesRegex(RuntimeError, "application-owned directory metadata"):
            windows_durable_replace(source, destination, [source.parent], kernel)
        self.assertFalse(any(str(call.args[0]).startswith("\\\\.\\")
                             for call in kernel.CreateFileW.call_args_list))
        kernel.MoveFileExW.assert_not_called()

    def test_windows_durability_uses_only_supplied_application_subtree_handles(self):
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10),
                                       FlushFileBuffers=Mock(return_value=True),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=True))
        source = PureWindowsPath("C:/Users/person/AppData/Roaming/Singhouse/staged/pending")
        destination = PureWindowsPath("C:/Users/person/AppData/Roaming/Singhouse/releases/release")
        owned = [source.parent, destination.parent,
                 PureWindowsPath("C:/Users/person/AppData/Roaming/Singhouse")]
        windows_durable_replace(source, destination, owned, kernel)
        self.assertEqual([call.args[0] for call in kernel.CreateFileW.call_args_list],
                         [str(path) for path in owned])
        kernel.MoveFileExW.assert_called_once_with(str(source), str(destination), 0x9)

    @unittest.skipIf(os.name == "nt", "ordinary Windows test users cannot create symlinks")
    def test_application_durability_allows_only_internal_bundle_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, destination = root / "source", root / "destination"
            (source / "Versions" / "A").mkdir(parents=True)
            (source / "Versions" / "A" / "binary").write_bytes(b"app")
            (source / "Current").symlink_to("Versions/A")
            with self.assertRaisesRegex(RuntimeError, "symbolic"):
                durable_replace(source, destination)
            durable_replace(source, destination, allow_internal_symlinks=True)
            self.assertEqual((destination / "Current" / "binary").read_bytes(), b"app")

            outside, unsafe = root / "outside", root / "unsafe"
            outside.write_bytes(b"outside")
            unsafe.mkdir()
            (unsafe / "escape").symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, "stay inside|escapes"):
                durable_replace(unsafe, root / "not-installed", allow_internal_symlinks=True)

    def test_backup_folds_wal_and_restore_replaces_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            database, backup = root / "desktop.db", root / "recovery.sqlite3"
            writer = sqlite3.connect(database)
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE state(value TEXT NOT NULL)")
            writer.execute("INSERT INTO state VALUES ('from-wal')")
            writer.commit()
            plan = sqlite_database_plan(database)
            self.assertGreaterEqual(plan["requiredBytes"], database.stat().st_size)
            self.assertIn("desktop.db-wal", [record["path"] for record in plan["files"]])

            result = backup_sqlite_database(database, backup)
            self.assertEqual(result["sha256"], hashlib.sha256(backup.read_bytes()).hexdigest())
            writer.close()
            database.unlink()
            self.make_database(database, "wrong")
            restore_sqlite_database(backup, database)
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT value FROM state").fetchall(), [("from-wal",)])
                self.assertEqual(connection.execute("PRAGMA quick_check").fetchone(), ("ok",))

    def test_desktop_restore_rejects_a_library_with_a_live_owner_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            data, backup = root / "backend", root / "recovery.sqlite3"
            data.mkdir()
            self.make_database(data / "desktop.db", "current")
            self.make_database(backup, "recovered")
            with persistent_directory(data):
                with self.assertRaisesRegex(RuntimeError, "already open"):
                    desktop_database_unowned(data)
                with self.assertRaisesRegex(RuntimeError, "already open"):
                    desktop_database_restore(backup, data)
            restored = desktop_database_restore(backup, data)
            self.assertTrue(restored["restored"])

    def test_rejects_database_backup_and_sidecar_symlinks(self):
        if os.name == "nt":
            self.skipTest("symlink creation is not generally available to Windows users")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            real, link, backup = root / "real.db", root / "link.db", root / "backup.db"
            self.make_database(real)
            link.symlink_to(real)
            with self.assertRaisesRegex(RuntimeError, "symbolic"):
                sqlite_database_plan(link)
            backup_sqlite_database(real, backup)
            destination = root / "destination.db"
            Path(str(destination) + "-wal").symlink_to(real)
            with self.assertRaisesRegex(RuntimeError, "symbolic"):
                restore_sqlite_database(backup, destination)

    def test_corrupt_sources_do_not_replace_existing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            database, backup, corrupt = root / "desktop.db", root / "backup.db", root / "corrupt.db"
            self.make_database(database)
            backup.write_bytes(b"existing-backup")
            corrupt.write_bytes(b"not sqlite")
            with self.assertRaises((RuntimeError, sqlite3.DatabaseError)):
                backup_sqlite_database(corrupt, backup)
            self.assertEqual(backup.read_bytes(), b"existing-backup")
            original = database.read_bytes()
            with self.assertRaises((RuntimeError, sqlite3.DatabaseError)):
                restore_sqlite_database(corrupt, database)
            self.assertEqual(database.read_bytes(), original)

    def test_desktop_helper_contract_reports_total_bytes_and_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary).resolve() / "data"
            data.mkdir()
            database, backup = data / "desktop.db", Path(temporary).resolve() / "backup.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE alembic_version(version_num TEXT NOT NULL)")
                connection.execute("INSERT INTO alembic_version VALUES ('revision-7')")
                connection.commit()
            plan = desktop_database_plan(data)
            self.assertTrue(plan["exists"])
            self.assertEqual(plan["revision"], "revision-7")
            self.assertGreaterEqual(plan["size"], plan["databaseSize"])
            result = desktop_database_backup(data, backup)
            self.assertEqual((result["backed_up"], result["quickCheck"], result["revision"]),
                             (True, "ok", "revision-7"))
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE alembic_version SET version_num='wrong'")
                connection.commit()
            restored = desktop_database_restore(backup, data)
            self.assertEqual((restored["restored"], restored["quickCheck"], restored["revision"]),
                             (True, "ok", "revision-7"))


if __name__ == "__main__":
    unittest.main()
