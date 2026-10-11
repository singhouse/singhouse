# SPDX-License-Identifier: AGPL-3.0-only
"""Isolation boundary tests; run with python -m unittest discover -s desktop."""

import asyncio
import importlib.util
import hashlib
import json
import os
import shutil
from pathlib import Path, PureWindowsPath
import ctypes
import errno
import stat
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch, Mock
import wave

spec = importlib.util.spec_from_file_location("desktop_backend", Path(__file__).with_name("backend.py"))
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class IsolationTests(unittest.TestCase):
    def test_activation_helper_serializes_bootstraps_until_holder_stdin_closes(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            command = [sys.executable, "-I", "-B", str(Path(__file__).with_name("backend.py")),
                       "--activation-lock", str(state)]
            first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
            second = None
            try:
                self.assertEqual(first.stdout.readline().strip(), "READY")
                second = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True)
                acquired = threading.Event()
                line = []
                reader = threading.Thread(target=lambda: (line.append(second.stdout.readline().strip()), acquired.set()))
                reader.start()
                self.assertFalse(acquired.wait(0.05))
                first.stdin.close()
                first.wait(timeout=5)
                self.assertTrue(acquired.wait(5))
                self.assertEqual(line, ["READY"])
                second.stdin.close()
                second.wait(timeout=5)
                reader.join(1)
                self.assertEqual(first.returncode, 0)
                self.assertEqual(second.returncode, 0)
            finally:
                for process in (first, second):
                    if process is not None and process.poll() is None:
                        process.kill(); process.wait(timeout=5)
                for process in (first, second):
                    if process is not None:
                        process.stdout.close(); process.stderr.close()

    def test_paired_recovery_owner_lock_wait_is_bounded_and_acquires_after_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            started = threading.Event()
            acquired = threading.Event()

            def contender():
                started.set()
                with backend.persistent_directory(data, wait_seconds=1):
                    acquired.set()

            with backend.persistent_directory(data):
                worker = threading.Thread(target=contender)
                worker.start()
                self.assertTrue(started.wait(1))
                self.assertFalse(acquired.wait(0.05))
            worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertTrue(acquired.is_set())

    def test_paired_recovery_holds_owner_for_every_mutation_then_launches(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"; data.mkdir()
            source = root / "kit-runtime"; (source / "resources").mkdir(parents=True)
            destination = root / "releases/prior"; destination.mkdir(parents=True)
            (destination / "Singhouse").write_bytes(b"damaged")
            application = {"schema": 1, "releaseId": "prior", "platform": "linux",
                           "arch": "x64", "payloadSha256": "a" * 64,
                           "manifestSha256": "b" * 64, "entrypoint": "Singhouse"}
            files = {"Singhouse": b"recovered executable", "resources/app.asar": b"recovered asar",
                     "installed.json": json.dumps(application).encode()}
            for relative, contents in files.items():
                path = source / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(contents)
                path.chmod(0o600)
            (source / "resources").chmod(0o700)
            inventory = [{"path": "resources", "type": "directory", "mode": 0o700}]
            inventory += [{"path": name, "type": "file", "size": len(contents),
                           "sha256": hashlib.sha256(contents).hexdigest(), "mode": 0o600}
                          for name, contents in files.items()]
            database = root / "database.sqlite3"
            with backend.sqlite3.connect(database) as connection:
                connection.execute("create table recovered(value text)")
                connection.execute("insert into recovered values ('yes')")
            active = root / "state/active.json"; transaction = root / "state/recovery-transaction.json"
            plan = {"schema": 1, "dataDirectory": str(data), "databaseSource": str(database),
                    "applicationSource": str(source), "applicationDestination": str(destination),
                    "applicationInventory": inventory, "application": application,
                    "activePath": str(active), "transactionPath": str(transaction),
                    "transaction": {"schema": 1, "kind": "recovery-transaction", "state": "in-progress"}}
            plan_path = root / "plan.json"; plan_path.write_text(json.dumps(plan))
            boundaries = []

            def assert_competing_launch_blocked(name):
                boundaries.append(name)
                with self.assertRaisesRegex(RuntimeError, "already open"):
                    with backend.persistent_directory(data):
                        pass

            launched = []
            owner_waits = []
            def launch(entrypoint):
                # Ownership is released only after every durable mutation, so
                # the recovered backend can acquire it during startup.
                with backend.persistent_directory(data):
                    launched.append(entrypoint)

            native_lock = backend.persistent_directory
            @backend.contextmanager
            def observed_lock(path, wait_seconds=0):
                owner_waits.append((Path(path), wait_seconds))
                with native_lock(path, wait_seconds=wait_seconds) as owned:
                    yield owned

            with patch.object(backend, "persistent_directory", observed_lock):
                result = backend.paired_recovery(plan_path, launch=launch,
                                                 boundary=assert_competing_launch_blocked)
            self.assertEqual(boundaries, ["application-replaced", "database-restored", "selection-committed"])
            self.assertEqual(owner_waits[0], (data, backend.RECOVERY_OWNER_LOCK_WAIT_SECONDS))
            self.assertGreaterEqual(owner_waits[0][1], 30)
            self.assertGreater(owner_waits[0][1], backend.BACKEND_PARENT_WATCHDOG_SECONDS)
            self.assertEqual(launched, [destination / "Singhouse"])
            self.assertTrue(result["recovered"])
            self.assertEqual(json.loads(active.read_text()), application)
            self.assertEqual(json.loads(transaction.read_text())["state"], "completed")
            with backend.sqlite3.connect(data / "desktop.db") as connection:
                self.assertEqual(connection.execute("select value from recovered").fetchone(), ("yes",))

            with patch.dict(os.environ, {"ELECTRON_RUN_AS_NODE": "1",
                                         "SINGHOUSE_RECOVERY_KIT": "1"}):
                with patch.object(backend.subprocess, "Popen") as popen:
                    backend.paired_recovery(plan_path)
            arguments, options = popen.call_args
            self.assertEqual(arguments[0], [str(destination / "Singhouse")])
            self.assertNotIn("ELECTRON_RUN_AS_NODE", options["env"])
            self.assertNotIn("SINGHOUSE_RECOVERY_KIT", options["env"])

    def test_paired_recovery_rejects_missing_or_corrupt_retained_application(self):
        # Inventory verification is the native boundary; neither case may be
        # repaired from a damaged external managed slot.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source = root / "runtime"; source.mkdir()
            executable = source / "Singhouse"; executable.write_bytes(b"good")
            executable.chmod(0o700)
            record = [{"path": "Singhouse", "type": "file", "size": 4,
                       "sha256": hashlib.sha256(b"good").hexdigest(), "mode": 0o700}]
            executable.write_bytes(b"bad!")
            with self.assertRaisesRegex(RuntimeError, "digest"):
                backend._recovery_inventory(source, record)
            executable.unlink()
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                backend._recovery_inventory(source, record)

    def test_windows_durable_replace_uses_write_through_and_metadata_flush(self):
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10), FlushFileBuffers=Mock(return_value=True),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=True))
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        backend.windows_durable_replace(source, destination, [source.parent, destination.parent], kernel)
        kernel.MoveFileExW.assert_called_once_with(str(source), str(destination), 0x9)
        self.assertEqual(kernel.FlushFileBuffers.call_count, 4)
        self.assertEqual(kernel.CloseHandle.call_count, 2)

    def test_windows_durable_replace_closes_source_tree_before_move_and_postflushes_parents(self):
        source, destination = PureWindowsPath("C:/cache/staging/pack"), PureWindowsPath("C:/cache/packs/pack")
        directories = [source / "nested", source, source.parent, destination.parent, source.parent.parent]
        events = []
        handles = iter(range(10, 15))

        def create(path, *_args):
            handle = next(handles)
            events.append(("open", path, handle))
            return handle

        def flush(handle):
            events.append(("flush", handle))
            return True

        def close(handle):
            events.append(("close", handle))

        def move(*_args):
            events.append(("move",))
            closed = {event[1] for event in events if event[0] == "close"}
            self.assertTrue({10, 11}.issubset(closed))
            self.assertTrue({12, 13, 14}.isdisjoint(closed))
            return True

        kernel = types.SimpleNamespace(CreateFileW=Mock(side_effect=create), FlushFileBuffers=Mock(side_effect=flush),
                                       CloseHandle=Mock(side_effect=close), MoveFileExW=Mock(side_effect=move))
        backend.windows_durable_replace(source, destination, directories, kernel)
        move_index = events.index(("move",))
        for handle in (12, 13, 14):
            self.assertIn(("flush", handle), events[move_index + 1:])
        self.assertEqual({event[1] for event in events if event[0] == "close"}, {10, 11, 12, 13, 14})

    def test_windows_durable_replace_source_preflush_failure_prevents_move(self):
        source, destination = PureWindowsPath("C:/cache/staging/pack"), PureWindowsPath("C:/cache/packs/pack")
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10), FlushFileBuffers=Mock(return_value=False),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=True))
        with self.assertRaisesRegex(RuntimeError, "activation was not performed"):
            backend.windows_durable_replace(source, destination, [source / "nested", source.parent], kernel)
        kernel.MoveFileExW.assert_not_called()
        kernel.CloseHandle.assert_called_once_with(10)

    def test_windows_durable_replace_retries_each_transient_lock_error(self):
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        for error_code in (5, 32, 33):
            with self.subTest(error_code=error_code):
                kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10), FlushFileBuffers=Mock(return_value=True),
                                               CloseHandle=Mock(), MoveFileExW=Mock(side_effect=[False, True]))
                sleep = Mock()
                backend.windows_durable_replace(source, destination, [source.parent, destination.parent], kernel,
                                                sleep=sleep, get_last_error=lambda: error_code)
                self.assertEqual(kernel.MoveFileExW.call_count, 2)
                sleep.assert_called_once_with(0.25)

    def test_windows_durable_replace_stops_when_retry_finds_nontransient_error(self):
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10), FlushFileBuffers=Mock(return_value=True),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=False))
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        errors = iter([32, 3])
        sleep = Mock()
        with self.assertRaisesRegex(RuntimeError, r"error 3: path not found"):
            backend.windows_durable_replace(source, destination, [source.parent, destination.parent], kernel,
                                            sleep=sleep, get_last_error=lambda: next(errors),
                                            format_error=lambda code: "path not found")
        self.assertEqual(kernel.MoveFileExW.call_count, 2)
        sleep.assert_called_once_with(0.25)

    def test_windows_durable_replace_exhausts_bounded_transient_retries(self):
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10), FlushFileBuffers=Mock(return_value=True),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=False))
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        sleep = Mock()
        with self.assertRaisesRegex(RuntimeError, r"error 32: sharing violation"):
            backend.windows_durable_replace(source, destination, [source.parent, destination.parent], kernel,
                                            sleep=sleep, get_last_error=lambda: 32,
                                            format_error=lambda code: "sharing violation")
        self.assertEqual(kernel.MoveFileExW.call_count, 8)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.25, 0.5, 1, 2, 4, 8, 8])

    def test_windows_durable_replace_reports_nontransient_system_error(self):
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10), FlushFileBuffers=Mock(return_value=True),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=False))
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        with self.assertRaisesRegex(RuntimeError, r"error 3: path not found"):
            backend.windows_durable_replace(source, destination, [source.parent, destination.parent], kernel,
                                            sleep=Mock(), get_last_error=lambda: 3,
                                            format_error=lambda code: "path not found")
        kernel.MoveFileExW.assert_called_once()

    def test_windows_durable_replace_refuses_without_raw_volume_fallback(self):
        invalid = ctypes.c_void_p(-1).value
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=invalid),
                                       FlushFileBuffers=Mock(return_value=True), CloseHandle=Mock(), MoveFileExW=Mock(return_value=True))
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        with self.assertRaisesRegex(RuntimeError, "application-owned directory metadata"):
            backend.windows_durable_replace(source, destination, [source.parent], kernel)
        self.assertFalse(any(str(call.args[0]).startswith("\\\\.\\") for call in kernel.CreateFileW.call_args_list))
        kernel.MoveFileExW.assert_not_called()

    @unittest.skipIf(os.name == "nt", "POSIX directory fsync contract")
    def test_durable_replace_refuses_unsyncable_directory_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "pending", root / "active"
            source.write_bytes(b"new")
            destination.write_bytes(b"known-good")
            original_sync = os.fsync
            def sync(descriptor):
                if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    raise OSError(errno.ENOTSUP, "directory metadata sync unavailable")
                return original_sync(descriptor)
            with patch.object(backend.os, "fsync", side_effect=sync):
                with self.assertRaises(OSError):
                    backend.durable_replace(source, destination)
            self.assertEqual(destination.read_bytes(), b"known-good")
            self.assertEqual(source.read_bytes(), b"new")

    def test_processing_selection_is_verified_and_offline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = {"appVersion": "1", "backendVersion": "1", "lyricsyncVersion": "1", "platform": "linux", "arch": "x64"}
            manifest = {"schema": 1, "kind": "processing", **identity,
                        "accelerator": "cpu", "python": "python/bin/python3",
                        "models": ["whisper"], "capabilities": ["transcription"],
                        "probe": {"schema": 1, "type": "python-imports-v1", "modules": ["faster_whisper"]},
                        "files": [{"path": "python/bin/python3", "size": 7,
                                   "sha256": hashlib.sha256(b"fixture").hexdigest(), "executable": True}]}
            dependency_names = ["setuptools/script (dev).tmpl", "setuptools/launcher manifest.xml",
                                "setuptools/_vendor/jaraco/text/Lorem ipsum.txt", "scipy/io/tests/data/Transparent Busy.ani"]
            for name in dependency_names:
                manifest["files"].append({**manifest["files"][0], "path": name, "executable": False})
            raw = json.dumps(manifest, separators=(",", ":")).encode()
            pack = root / "processing/packs" / hashlib.sha256(raw).hexdigest()
            (pack / "python/bin").mkdir(parents=True)
            (pack / "manifest.json").write_bytes(raw)
            (pack / "python/bin/python3").write_bytes(b"fixture")
            (pack / "python/bin/python3").chmod(0o755)
            for name in dependency_names:
                (pack / name).parent.mkdir(parents=True, exist_ok=True)
                (pack / name).write_bytes(b"fixture")
            for invalid_path in ("../escape", "dir/../escape", "dir/ file", "dir/file ", "dir/file.", "dir/CON", "dir/nul.txt"):
                invalid = {**manifest, "files": [{**manifest["files"][0], "path": invalid_path}]}
                invalid_raw = json.dumps(invalid, separators=(",", ":")).encode()
                invalid_pack = root / "processing/packs" / hashlib.sha256(invalid_raw).hexdigest()
                invalid_pack.mkdir()
                (invalid_pack / "manifest.json").write_bytes(invalid_raw)
                with self.assertRaisesRegex(RuntimeError, "file path"):
                    backend.processing_environment(root / "backend", identity, invalid_pack, None, processing_id=invalid_pack.name)
            missing_probe = backend.processing_environment(root / "backend", identity, pack, None, processing_id=pack.name)
            self.assertEqual(missing_probe["KARAOKE_PROCESSING_PYTHON"], "")
            probe = {"runtimeManifestId": pack.name, "pythonPath": str(pack / "python/bin/python3"),
                     "pythonSha256": manifest["files"][0]["sha256"], "probePassed": True,
                     "accelerator": "cpu", "components": {"faster_whisper": "1.2.3"},
                     "verifiedCapabilities": [], "capabilitiesReady": False}
            env = backend.processing_environment(root / "backend", identity, pack, None, probe, processing_id=pack.name)
            self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], "")
            self.assertEqual(env["KARAOKE_PROCESSING_ACCELERATOR"], "")
            self.assertEqual(env["KARAOKE_AUDIO_SEPARATOR_DEVICE"], "")
            self.assertEqual(env["HF_HUB_OFFLINE"], "1")
            self.assertEqual(env["PYTORCH_ENABLE_MPS_FALLBACK"], "0")
            attested = json.loads(env["KARAOKE_DESKTOP_PROCESSING_JSON"])
            self.assertTrue(attested["probePassed"])
            self.assertEqual(attested["runtimeManifestId"], pack.name)
            self.assertEqual(attested["pythonSha256"], probe["pythonSha256"])
            self.assertEqual(attested["verifiedCapabilities"], [])
            self.assertFalse(attested["capabilitiesReady"])
            managed_spec = importlib.util.spec_from_file_location(
                "managed_processing",
                Path(__file__).parents[1] / "backend/src/karaoke_backend/workers/managed_processing.py",
            )
            managed_processing = importlib.util.module_from_spec(managed_spec)
            managed_spec.loader.exec_module(managed_processing)
            with patch.dict(os.environ, env, clear=False):
                self.assertEqual(managed_processing.validated_attestation(), attested)
            for bad_probe in ({**probe, "pythonPath": "/wrong/python"},
                              {**probe, "components": {}},
                              {**probe, "accelerator": "cuda"},
                              {**probe, "unexpected": True}):
                rejected = backend.processing_environment(root / "backend", identity, pack, None, bad_probe, processing_id=pack.name)
                self.assertEqual(rejected["KARAOKE_PROCESSING_PYTHON"], "")
                self.assertFalse(json.loads(rejected["KARAOKE_DESKTOP_PROCESSING_JSON"])["probePassed"])
            (pack / "unlisted.pth").write_text("unexpected")
            with self.assertRaisesRegex(RuntimeError, "inventory"):
                backend.processing_environment(root / "backend", identity, pack, None, probe, processing_id=pack.name)
            (pack / "unlisted.pth").unlink()

            revision = "a" * 40
            model_file = {"path": "huggingface/model.bin", "size": 5,
                          "sha256": hashlib.sha256(b"model").hexdigest(), "executable": False,
                          "revision": revision, "url": f"https://huggingface.co/fixture/resolve/{revision}/model.bin"}
            model_manifest = {"schema": 1, "kind": "models", "models": ["whisper"], "files": [model_file]}
            model_raw = json.dumps(model_manifest, separators=(",", ":")).encode()
            model_pack = root / "model-cache/packs" / hashlib.sha256(model_raw).hexdigest()
            (model_pack / "huggingface").mkdir(parents=True)
            (model_pack / "manifest.json").write_bytes(model_raw)
            (model_pack / "huggingface/model.bin").write_bytes(b"model")
            policy = {"schema": 1, "allowedHosts": ["huggingface.co"],
                      "models": [{"id": "whisper", "files": [model_file]}]}
            ready = json.loads(backend.processing_environment(root / "backend", identity, pack, model_pack, probe, policy, processing_id=pack.name, models_id=model_pack.name)["KARAOKE_DESKTOP_PROCESSING_JSON"])
            self.assertFalse(ready["capabilitiesReady"])
            self.assertEqual(set(ready), {"runtimeManifestId", "pythonPath", "pythonSha256",
                                         "probePassed", "accelerator", "components",
                                         "verifiedCapabilities", "capabilitiesReady"})
            with self.assertRaisesRegex(RuntimeError, "not defined"):
                backend.processing_environment(root / "backend", identity, pack, model_pack, probe, processing_id=pack.name, models_id=model_pack.name)
            wrong_policy = json.loads(json.dumps(policy))
            wrong_policy["models"][0]["files"][0]["size"] = 6
            with self.assertRaisesRegex(RuntimeError, "immutable application policy"):
                backend.processing_environment(root / "backend", identity, pack, model_pack, probe, wrong_policy, processing_id=pack.name, models_id=model_pack.name)
            (pack / "python/bin/python3").write_bytes(b"changed size")
            with self.assertRaisesRegex(RuntimeError, "verification"):
                backend.processing_environment(root / "backend", identity, pack, None, processing_id=pack.name)

    def test_functional_processing_admission_requires_trust_and_exact_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = {"appVersion": "1", "backendVersion": "1", "lyricsyncVersion": "1", "platform": "linux", "arch": "x64"}
            modules = ["faster_whisper", "karaoke_backend.workers.heart_transcriptor", "lyricsync.transcription.heart"]
            manifest = {"schema": 1, "kind": "processing", **identity, "pythonVersion": "3.13.12",
                        "accelerator": "cpu", "python": "python/bin/python3",
                        "models": ["heart-transcriptor"], "capabilities": ["transcription"],
                        "modelCapabilities": {"heart-transcriptor": "transcription"},
                        "probe": {"schema": 2, "type": "python-functional-v1", "modules": modules},
                        "files": [{"path": "python/bin/python3", "size": 7,
                                   "sha256": hashlib.sha256(b"fixture").hexdigest(), "executable": True}]}
            input_lock = {**manifest, "kind": "processing-input", "packages": [], "sourceCommit": "a" * 40}
            raw_lock = json.dumps(input_lock, separators=(",", ":"))
            lock_hash = hashlib.sha256(raw_lock.encode()).hexdigest()
            manifest["provenance"] = {"inputLock": raw_lock, "lockSha256": lock_hash,
                                      "packages": [], "sourceCommit": "a" * 40}

            def write_pack(value):
                raw = json.dumps(value, separators=(",", ":")).encode()
                pack = root / "processing/packs" / hashlib.sha256(raw).hexdigest()
                (pack / "python/bin").mkdir(parents=True, exist_ok=True)
                (pack / "manifest.json").write_bytes(raw)
                (pack / "python/bin/python3").write_bytes(b"fixture")
                return pack

            pack = write_pack(manifest)
            probe = {"runtimeManifestId": pack.name, "pythonPath": str(pack / "python/bin/python3"),
                     "pythonSha256": manifest["files"][0]["sha256"], "probePassed": True,
                     "accelerator": "cpu", "components": {module: "1.0" for module in modules},
                     "verifiedCapabilities": ["transcription"], "capabilitiesReady": True,
                     "probeSchema": 2, "checks": {"deviceTensor": True, "nativeAudio": True, "transcription": True}}
            selected = backend.processing_environment(root / "backend", identity, pack, None, probe, trusted_locks=[lock_hash], processing_id=pack.name)
            self.assertEqual(selected["KARAOKE_PROCESSING_PYTHON"], str(pack / "python/bin/python3"))
            self.assertEqual(selected["KARAOKE_PROCESSING_ACCELERATOR"], "cpu")
            attestation = json.loads(selected["KARAOKE_DESKTOP_PROCESSING_JSON"])
            self.assertTrue(attestation["capabilitiesReady"])
            self.assertEqual(attestation["verifiedCapabilities"], ["transcription"])
            self.assertNotIn("checks", attestation)
            self.assertNotIn("probeSchema", attestation)
            self.assertFalse(json.loads(selected["KARAOKE_HEART_MODEL_STATUS_JSON"])["installed"])
            model_sets = json.loads(selected["KARAOKE_DESKTOP_MODEL_SETS_JSON"])
            self.assertEqual(model_sets, {"schema": 1, "runtimeManifestId": pack.name,
                                         "modelManifestId": None, "verifiedModelIds": [],
                                         "requiredModels": {"transcription": ["heart-transcriptor"], "separation": []}})
            for changes in ({"checks": {"deviceTensor": True, "nativeAudio": True}},
                            {"checks": {**probe["checks"], "transcription": 1}},
                            {"checks": {**probe["checks"], "transcription": False}},
                            {"verifiedCapabilities": ["transcription", "separation"]},
                            {"capabilitiesReady": 1}, {"probePassed": 1}, {"probeSchema": 2.0},
                            {"pythonPath": "/unmanaged/python"}, {"components": {}}, {"extra": True}):
                rejected = backend.processing_environment(root / "backend", identity, pack, None,
                                                          {**probe, **changes}, trusted_locks=[lock_hash], processing_id=pack.name)
                self.assertEqual(rejected["KARAOKE_PROCESSING_PYTHON"], "")
                self.assertFalse(json.loads(rejected["KARAOKE_DESKTOP_PROCESSING_JSON"])["capabilitiesReady"])
            with self.assertRaisesRegex(RuntimeError, "not trusted"):
                backend.processing_environment(root / "backend", identity, pack, None, probe, trusted_locks=[], processing_id=pack.name)
            changed = json.loads(json.dumps(manifest))
            changed["probe"]["modules"] = ["faster_whisper"]
            changed_pack = write_pack(changed)
            with self.assertRaisesRegex(RuntimeError, "differs from its input lock"):
                backend.processing_environment(root / "backend", identity, changed_pack, None, probe, trusted_locks=[lock_hash], processing_id=changed_pack.name)

    def test_backend_start_checks_pack_structure_without_reading_payload_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = {"appVersion": "1", "backendVersion": "1", "lyricsyncVersion": "1", "platform": "linux", "arch": "x64"}
            manifest = {"schema": 1, "kind": "processing", **identity,
                        "accelerator": "cpu", "python": "python/bin/python3",
                        "models": ["whisper"], "capabilities": ["transcription"],
                        "probe": {"schema": 1, "type": "python-imports-v1", "modules": ["faster_whisper"]},
                        "files": [{"path": "python/bin/python3", "size": 7,
                                   "sha256": hashlib.sha256(b"fixture").hexdigest(), "executable": True},
                                  {"path": "lib/data.txt", "size": 4,
                                   "sha256": hashlib.sha256(b"data").hexdigest(), "executable": False}]}
            raw = json.dumps(manifest, separators=(",", ":")).encode()
            pack = root / "processing/packs" / hashlib.sha256(raw).hexdigest()[:16]
            identifier = hashlib.sha256(raw).hexdigest()

            def build():
                if pack.exists():
                    shutil.rmtree(pack)
                (pack / "python/bin").mkdir(parents=True)
                (pack / "lib").mkdir()
                (pack / "manifest.json").write_bytes(raw)
                (pack / "python/bin/python3").write_bytes(b"fixture")
                (pack / "lib/data.txt").write_bytes(b"data")

            def select():
                return backend.processing_environment(root / "backend", identity, pack, None, processing_id=identifier)

            build()
            # Payload bytes are never hashed at backend start: same-size content
            # passes here (installation and activation hash every file).
            (pack / "lib/data.txt").write_bytes(b"DATA")
            with patch.object(backend.hashlib, "file_digest", side_effect=AssertionError("payload bytes were hashed")):
                select()
            for damage, message in (
                    (lambda: (pack / "lib/data.txt").write_bytes(b"longer"), "verification failed"),
                    (lambda: (pack / "lib/data.txt").unlink(), "No such file|verification|inventory"),
                    (lambda: (pack / "lib/extra.txt").write_bytes(b"data"), "inventory"),
                    (lambda: ((pack / "lib/data.txt").unlink(), (pack / "lib/data.txt").symlink_to(pack / "python/bin/python3")), "symbolic links"),
                    (lambda: ((pack / "lib/data.txt").unlink(), (pack / "lib/data.txt").mkdir()), "verification failed"),
                    *([(lambda: ((pack / "lib/data.txt").unlink(), os.mkfifo(pack / "lib/data.txt")), "verification failed"),
                       (lambda: os.mkfifo(pack / "lib/unlisted.pipe"), "inventory"),
                       (lambda: (pack / "manifest.json").unlink() or os.mkfifo(pack / "manifest.json"), "regular file")]
                      if hasattr(os, "mkfifo") else []),
                    (lambda: (shutil.move(pack / "lib", root / "moved-lib"), (pack / "lib").symlink_to(root / "moved-lib")), "symbolic links"),
                    (lambda: ((pack / "python/bin/extra").mkdir(), (pack / "python/bin/extra/link").symlink_to(pack / "lib/data.txt")), "symbolic links"),
                    (lambda: (pack / "manifest.json").write_bytes(raw.replace(b'"size":4', b'"size":5')), "manifest was modified")):
                build()
                shutil.rmtree(root / "moved-lib", ignore_errors=True)
                damage()
                with self.assertRaisesRegex((RuntimeError, OSError), message):
                    select()

    def test_backend_start_rejects_junctions_and_reparse_points(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = {"appVersion": "1", "backendVersion": "1", "lyricsyncVersion": "1", "platform": "linux", "arch": "x64"}
            manifest = {"schema": 1, "kind": "processing", **identity,
                        "accelerator": "cpu", "python": "python/bin/python3",
                        "models": ["whisper"], "capabilities": ["transcription"],
                        "probe": {"schema": 1, "type": "python-imports-v1", "modules": ["faster_whisper"]},
                        "files": [{"path": "python/bin/python3", "size": 7,
                                   "sha256": hashlib.sha256(b"fixture").hexdigest(), "executable": True},
                                  {"path": "lib/data.txt", "size": 4,
                                   "sha256": hashlib.sha256(b"data").hexdigest(), "executable": False}]}
            raw = json.dumps(manifest, separators=(",", ":")).encode()
            identifier = hashlib.sha256(raw).hexdigest()
            pack = root / "processing/packs" / identifier[:16]
            (pack / "python/bin").mkdir(parents=True)
            (pack / "lib").mkdir()
            (pack / "manifest.json").write_bytes(raw)
            (pack / "python/bin/python3").write_bytes(b"fixture")
            (pack / "lib/data.txt").write_bytes(b"data")

            def select():
                return backend.processing_environment(root / "backend", identity, pack, None, processing_id=identifier)

            select()

            class Entry:
                """A listing entry reported as a junction or reparse point."""
                def __init__(self, entry, junction, attributes):
                    self._entry, self._junction, self._attributes = entry, junction, attributes
                    self.name, self.path = entry.name, entry.path

                def __getattr__(self, name):
                    return getattr(self._entry, name)

                def is_junction(self):
                    return self._junction

                def stat(self, *, follow_symlinks=True):
                    info = self._entry.stat(follow_symlinks=follow_symlinks)
                    return types.SimpleNamespace(st_mode=info.st_mode, st_size=info.st_size,
                                                 st_file_attributes=self._attributes)

            native_scandir = os.scandir

            def scandir_marking(name, junction, attributes=0):
                class Listing:
                    def __init__(self, path):
                        self._listing = native_scandir(path)

                    def __enter__(self):
                        return (Entry(entry, junction, attributes) if entry.name == name else entry
                                for entry in self._listing.__enter__())

                    def __exit__(self, *details):
                        return self._listing.__exit__(*details)
                return Listing

            # A junction is a directory to is_dir(follow_symlinks=False) and not
            # a symbolic link, yet it must never be descended.
            with patch.object(backend.os, "scandir", scandir_marking("lib", True)):
                with self.assertRaisesRegex(RuntimeError, "symbolic links or junctions"):
                    select()
            with patch.object(backend.os, "scandir", scandir_marking("data.txt", True)):
                with self.assertRaisesRegex(RuntimeError, "symbolic links or junctions"):
                    select()

            # Without is_junction (Python before 3.12), Windows reparse-point
            # attributes are checked instead.
            entry = types.SimpleNamespace(is_symlink=lambda: False,
                                          stat=lambda follow_symlinks: types.SimpleNamespace(
                                              st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT))
            self.assertTrue(backend._is_link_entry(entry, windows=True))
            self.assertFalse(backend._is_link_entry(entry, windows=False))
            entry.stat = lambda follow_symlinks: types.SimpleNamespace(st_file_attributes=stat.FILE_ATTRIBUTE_DIRECTORY)
            self.assertFalse(backend._is_link_entry(entry, windows=True))
            entry.is_junction = lambda: True
            self.assertTrue(backend._is_link_entry(entry, windows=False))
            select()

            # The pack directory and its store ancestors get the same check.
            for ancestor in (pack.parent.parent, pack.parent, pack):
                with patch.object(type(pack), "is_junction", lambda self, marked=ancestor: self == marked, create=True):
                    with self.assertRaisesRegex(RuntimeError, "directories must not be symbolic links or junctions"):
                        select()
            select()
            native_lstat = os.lstat

            def reparse_lstat(path, *args, **kwargs):
                info = native_lstat(path, *args, **kwargs)
                return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)

            with patch.object(backend.os, "lstat", reparse_lstat):
                self.assertTrue(backend._is_link_path(pack, windows=True))
                self.assertFalse(backend._is_link_path(pack, windows=False))
            self.assertFalse(backend._is_link_path(pack / "missing", windows=True))

    def test_processing_path_case_collisions_follow_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for platform in ("linux", "darwin", "win32"):
                identity = {"appVersion": "1", "backendVersion": "1", "lyricsyncVersion": "1", "platform": platform, "arch": "x64"}
                manifest = {"schema": 1, "kind": "processing", **identity, "models": [], "capabilities": [],
                            "accelerator": "cpu", "python": "2621A",
                            "probe": {"schema": 1, "type": "python-imports-v1", "modules": []},
                            "files": [{"path": name, "size": 7, "executable": True,
                                       "sha256": hashlib.sha256(b"fixture").hexdigest()} for name in ("2621A", "2621a")]}
                raw = json.dumps(manifest, separators=(",", ":")).encode()
                pack = root / "processing/packs" / hashlib.sha256(raw).hexdigest()
                pack.mkdir(parents=True)
                (pack / "manifest.json").write_bytes(raw)
                for name in ("2621A", "2621a"):
                    (pack / name).write_bytes(b"fixture")
                if platform == "linux":
                    backend.processing_environment(root / "backend", identity, pack, None, processing_id=pack.name)
                else:
                    with self.assertRaisesRegex(RuntimeError, "Duplicate"):
                        backend.processing_environment(root / "backend", identity, pack, None, processing_id=pack.name)

    def test_missing_processing_preserves_playback_environment(self):
        env = backend.processing_environment(Path("/app/backend"), {}, None, None)
        self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], "")
        self.assertNotIn("KARAOKE_DESKTOP_PROCESSING_JSON", env)
        self.assertFalse(json.loads(env["KARAOKE_HEART_MODEL_STATUS_JSON"])["installed"])

    def test_heart_checkpoint_survives_application_replacement_and_is_verified_offline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            revision = "a" * 40
            directory = f"huggingface/heart/{revision}"
            files = [{"path": f"{directory}/{name}", "size": len(data),
                      "sha256": hashlib.sha256(data).hexdigest(), "executable": False,
                      "revision": revision,
                      "url": f"https://huggingface.co/fixture/resolve/{revision}/{name}"}
                     for name, data in [("config.json", b"{}"), ("model.safetensors", b"fixture")]]
            policy = {"schema": 1, "allowedHosts": ["huggingface.co"],
                      "models": [{"id": "heart-transcriptor", "files": files}]}
            manifest = {"schema": 1, "kind": "models", "models": ["heart-transcriptor"], "files": files}
            raw = json.dumps(manifest).encode()
            pack = root / "model-cache/packs" / hashlib.sha256(raw).hexdigest()
            (pack / directory).mkdir(parents=True)
            (pack / "manifest.json").write_bytes(raw)
            (pack / directory / "config.json").write_bytes(b"{}")
            (pack / directory / "model.safetensors").write_bytes(b"fixture")
            for app_version in ("1", "2"):
                env = backend.processing_environment(root / "backend", {"appVersion": app_version}, None, pack, model_policy=policy, models_id=pack.name)
                self.assertEqual(env["KARAOKE_HEART_CKPT"], str(pack / directory))
                self.assertEqual(json.loads(env["KARAOKE_HEART_MODEL_STATUS_JSON"]),
                                 {"installed": True, "modelId": "heart-transcriptor", "revision": revision})
                self.assertEqual(env["HF_HUB_OFFLINE"], "1")
                self.assertEqual(env["PYTORCH_ENABLE_MPS_FALLBACK"], "0")
                self.assertEqual(env["TRANSFORMERS_OFFLINE"], "1")
                self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], "")
            # The identity comes from the parent, never from the directory name.
            for models_id in (None, pack.name[:16], "0" * 64):
                with self.assertRaisesRegex(RuntimeError, "Invalid managed processing path"):
                    backend.processing_environment(root / "backend", {}, None, pack, model_policy=policy, models_id=models_id)
            (pack / directory / "model.safetensors").write_bytes(b"corrupted")
            with self.assertRaisesRegex(RuntimeError, "verification failed"):
                backend.processing_environment(root / "backend", {}, None, pack, model_policy=policy, models_id=pack.name)

    @unittest.skipIf(os.name == "nt", "POSIX session ownership; Windows needs native job-object validation")
    def test_owned_tree_kill_closes_descendant_pipe(self):
        script = """
import importlib.util, subprocess, sys
spec = importlib.util.spec_from_file_location("launcher", sys.argv[1])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
launcher.own_process_tree()
# Descendant inherits stdout. communicate cannot finish while it survives.
subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
print("spawned", flush=True)
launcher.kill_owned_tree()
"""
        process = subprocess.Popen([sys.executable, "-I", "-B", "-c", script,
            str(Path(__file__).with_name("backend.py"))], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, err = process.communicate(timeout=5)
            self.assertEqual(out, b"spawned\n")
            self.assertEqual(process.returncode, -9)
        finally:
            if process.poll() is None:
                import signal
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()

    def test_persistent_settings_survive_relaunch_without_inheriting_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "library"
            with backend.persistent_directory(runtime):
                first = backend.persistent_environment(runtime, "http://127.0.0.1:1234", "gate-one", Path("/native"))
                (runtime / "desktop.db").write_text("keep-library")
            with backend.persistent_directory(runtime):
                second = backend.persistent_environment(runtime, "http://127.0.0.1:5678", "gate-two", Path("/native"))
                self.assertEqual((runtime / "desktop.db").read_text(), "keep-library")
            self.assertEqual(first["SESSION_SECRET"], second["SESSION_SECRET"])
            self.assertNotEqual(first["KARAOKE_GATE_PASSWORD"], second["KARAOKE_GATE_PASSWORD"])
            self.assertNotIn("HOME", second)
            self.assertNotIn("USERPROFILE", second)
            self.assertEqual(second["PATH"], "/native/ffmpeg/bin")

    def test_owner_lock_rejects_second_process_and_recovers_after_crash(self):
        script = """
import importlib.util, pathlib, sys, time
spec = importlib.util.spec_from_file_location("launcher", sys.argv[1])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
with launcher.persistent_directory(pathlib.Path(sys.argv[2])):
    print("locked", flush=True)
    time.sleep(30)
"""
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "library"
            process = subprocess.Popen([sys.executable, "-I", "-B", "-c", script,
                str(Path(__file__).with_name("backend.py")), str(runtime)], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(process.stdout.readline().strip(), "locked")
                with self.assertRaisesRegex(RuntimeError, "already open"):
                    with backend.persistent_directory(runtime):
                        self.fail("Second owner accepted")
            finally:
                process.kill()
                process.wait(timeout=5)
                process.stdout.close()
            with backend.persistent_directory(runtime):
                self.assertTrue((runtime / "owner.lock").exists())

    def test_recovery_owner_lock_can_succeed_after_watchdog_without_real_delay(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "library"
            elapsed = [0.0]
            attempts = []

            def acquire(_lock):
                attempts.append(elapsed[0])
                if elapsed[0] <= backend.BACKEND_PARENT_WATCHDOG_SECONDS:
                    raise OSError("still held")

            with backend.persistent_directory(runtime,
                    wait_seconds=backend.RECOVERY_OWNER_LOCK_WAIT_SECONDS,
                    clock=lambda: elapsed[0], sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds),
                    lock_attempt=acquire):
                self.assertGreater(elapsed[0], backend.BACKEND_PARENT_WATCHDOG_SECONDS)
                self.assertLess(elapsed[0], backend.RECOVERY_OWNER_LOCK_WAIT_SECONDS)
            self.assertGreater(len(attempts), 1)

    def test_native_recovery_anchor_rejects_corrupt_runtime_before_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "kit"
            (root / "runtime").mkdir(parents=True)
            (root / "tools").mkdir()
            runtime = root / "runtime" / "Singhouse"
            cli = root / "tools" / "recovery_cli.mjs"
            runtime.write_bytes(b"trusted runtime")
            cli.write_bytes(b"trusted cli")
            (root / "runtime").chmod(0o700); (root / "tools").chmod(0o700)
            runtime.chmod(0o600); cli.chmod(0o600)
            records = []
            for path in (root / "runtime", runtime, root / "tools", cli):
                relative = path.relative_to(root).as_posix()
                if path.is_dir():
                    records.append({"path": relative, "type": "directory", "mode": 0o700})
                else:
                    payload = path.read_bytes()
                    records.append({"path": relative, "type": "file", "size": len(payload),
                                    "sha256": hashlib.sha256(payload).hexdigest(), "mode": 0o600})
            manifest = {"schema": 2, "kind": "recovery-kit",
                        "target": {"platform": "linux", "arch": "x64"},
                        "binding": {"schema": 1}, "runtimeEntrypoint": "runtime/Singhouse",
                        "files": sorted(records, key=lambda record: record["path"].encode())}
            (root / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n")
            manifest_hash = hashlib.sha256(json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
            runtime.write_bytes(b"corrupt runtime")
            executed = []
            with self.assertRaisesRegex(RuntimeError, "digest"):
                backend.launch_recovery_kit(root, manifest_hash, "linux", "x64", ["state", "point-1", "data"],
                                            launch=lambda command, environment: executed.append(command) or 0)
            self.assertEqual(executed, [])

    def test_invalid_persistent_settings_are_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            settings = runtime / "settings.json"
            settings.write_text('{"schema":1,"sessionSecret":"short"}')
            with self.assertRaisesRegex(RuntimeError, "Invalid desktop settings"):
                backend.persistent_environment(runtime, "http://127.0.0.1:1234", "gate", Path("/native"))
            self.assertIn("short", settings.read_text())

    def test_demo_has_player_segments_and_consistent_stage_lines(self):
        payload = backend.demo_word_sync()
        # The player accepts initial timed lyrics only when segments exists;
        # the stage then prefers lines. Keep both representations consistent.
        self.assertTrue(payload["segments"])
        self.assertEqual(len(payload["segments"]), len(payload["lines"]))
        for segment, line in zip(payload["segments"], payload["lines"]):
            self.assertEqual(segment["words"], line)
            self.assertEqual(segment["text"], " ".join(word["text"] for word in line))
            self.assertEqual(segment["start"], line[0]["start"])
            self.assertEqual(segment["end"], line[-1]["end"])
            self.assertGreaterEqual(segment["start"], 0)
            self.assertLessEqual(segment["end"], 60)
            for word in line:
                self.assertLess(word["start"], word["end"])

    def test_supplied_runtime_cleanup_and_rejection_of_existing_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir(mode=0o700)
            with backend.runtime_directory(runtime) as active:
                (active / "desktop.db").write_text("disposable")
            self.assertFalse(runtime.exists())
            runtime.mkdir(mode=0o700)
            marker = runtime / "existing.db"
            marker.write_text("keep")
            with self.assertRaisesRegex(RuntimeError, "empty"):
                with backend.runtime_directory(runtime):
                    self.fail("Nonempty runtime accepted")
            self.assertEqual(marker.read_text(), "keep")
            link = root / "link"
            link.symlink_to(runtime)
            with self.assertRaisesRegex(RuntimeError, "symbolic link"):
                with backend.runtime_directory(link):
                    self.fail("Symlink runtime accepted")

    def test_parent_pipe_eof_exits_child_and_cleans_runtime(self):
        script = '''
import importlib.util, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("launcher", sys.argv[1])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
with tempfile.TemporaryDirectory(prefix="desktop-watch-test-") as temporary:
    print(temporary, flush=True)
    parent_closed = launcher.watch_parent(sys.stdin.fileno())
    if not parent_closed.wait(10):
        raise SystemExit(2)
'''
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", script, str(Path(__file__).with_name("backend.py"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            runtime = Path(process.stdout.readline().strip())
            self.assertTrue(runtime.is_dir())
            process.stdin.write("still alive\n")
            process.stdin.flush()
            self.assertIsNone(process.poll())
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertFalse(runtime.exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            process.stderr.close()
            if not process.stdin.closed:
                process.stdin.close()

    def test_parent_watch_keeps_crt_descriptor_available_until_eof(self):
        script = '''
import os, runpy, sys, time
launcher = runpy.run_path(sys.argv[1])
closed = launcher["watch_parent"](sys.stdin.fileno())
time.sleep(0.2)
# Native extensions may duplicate CRT streams during module initialization.
# This blocks on Windows if the watcher holds stdin's CRT descriptor lock.
duplicate = os.dup(sys.stdin.fileno())
os.close(duplicate)
print("READY", flush=True)
if not closed.wait(10):
    raise SystemExit(2)
'''
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", script, str(Path(__file__).with_name("backend.py"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready = threading.Event()
        lines = []

        def read_ready():
            lines.append(process.stdout.readline().strip())
            ready.set()

        reader = threading.Thread(target=read_ready, daemon=True)
        reader.start()
        try:
            self.assertTrue(ready.wait(5), "Parent watcher blocked CRT descriptor access")
            self.assertEqual(lines, ["READY"])
            self.assertIsNone(process.poll())
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            reader.join(5)
            process.stdout.close()
            process.stderr.close()
            if not process.stdin.closed:
                process.stdin.close()

    def test_inherited_credentials_and_service_settings_are_removed(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://production",
                                   "KARAOKE_PROVIDERS_DIR": "/private",
                                   "KARAOKE_REMOTE_HOST": "live",
                                   "KARAOKE_GATE_PASSWORD_HASH": "old",
                                   "KARAOKE_LLM_API_KEY": "secret",
                                   "PYTHONPATH": "/private"}):
            env = backend.isolated_environment(Path("/tmp/disposable"), "http://127.0.0.1:1234", "fresh")
        self.assertEqual(env["DATABASE_URL"], "sqlite+aiosqlite:////tmp/disposable/desktop.db")
        self.assertEqual(env["KARAOKE_PROVIDERS_DIR"], "")
        self.assertEqual(env["KARAOKE_GATE_PASSWORD"], "fresh")
        for key in ("KARAOKE_REMOTE_HOST", "KARAOKE_GATE_PASSWORD_HASH", "KARAOKE_LLM_API_KEY", "PYTHONPATH"):
            self.assertNotIn(key, env)

    def test_plugin_metadata_rejected_without_loading_plugin(self):
        distribution = types.SimpleNamespace(entry_points=[types.SimpleNamespace(group="karaoke_backend.future_plugin")])
        with patch.object(backend.importlib.metadata, "distributions", return_value=[distribution]):
            with self.assertRaisesRegex(RuntimeError, "without backend plugins"):
                backend.reject_plugins()

    def test_host_origin_boundary_and_duplicate_headers(self):
        async def request(headers):
            messages = []
            async def inner(scope, receive, send):
                await send({"type": "http.response.start", "status": 204})
            async def send(message):
                messages.append(message)
            await backend.LoopbackOnly(inner, "http://127.0.0.1:1234")(
                {"type": "http", "headers": headers}, None, send)
            return messages[0]["status"]
        host = (b"host", b"127.0.0.1:1234")
        self.assertEqual(asyncio.run(request([host])), 204)
        self.assertEqual(asyncio.run(request([host, (b"origin", b"http://127.0.0.1:1234")])), 204)
        for headers in ([], [host, host], [(b"host", b"rebind.example:1234")],
                        [host, (b"origin", b"null")], [host, (b"origin", b"https://evil.example")]):
            self.assertEqual(asyncio.run(request(headers)), 403)

    def test_demo_audio_is_quiet_and_sixty_seconds(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "tone.wav"
            backend.write_tone(path, 220.0)
            with wave.open(str(path)) as audio:
                self.assertEqual(audio.getnframes() / audio.getframerate(), 60)
                self.assertEqual(audio.getnchannels(), 1)
                data = audio.readframes(audio.getframerate())
            import struct
            samples = struct.unpack("<" + "h" * (len(data) // 2), data)
            self.assertGreater(max(samples), 0)
            self.assertLessEqual(max(abs(value) for value in samples), 500)

    def test_frontend_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ("backend/src/karaoke_backend/__init__.py",
                             "lyricsync/src/lyricsync/__init__.py", "frontend/dist/index.html"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("")
            self.assertEqual(backend.validate_root(root), root)
            (root / "frontend/dist/private").symlink_to(root / "backend")
            with self.assertRaisesRegex(RuntimeError, "symbolic links"):
                backend.validate_root(root)


if __name__ == "__main__":
    unittest.main()
