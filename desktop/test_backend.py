# SPDX-License-Identifier: AGPL-3.0-only
"""Isolation boundary tests; run with python -m unittest discover -s desktop."""

import asyncio
import importlib.util
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import ctypes
import errno
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, Mock
import wave

spec = importlib.util.spec_from_file_location("desktop_backend", Path(__file__).with_name("backend.py"))
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class IsolationTests(unittest.TestCase):
    def test_windows_durable_replace_uses_write_through_and_metadata_flush(self):
        kernel = types.SimpleNamespace(CreateFileW=Mock(return_value=10), FlushFileBuffers=Mock(return_value=True),
                                       CloseHandle=Mock(), MoveFileExW=Mock(return_value=True))
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        backend.windows_durable_replace(source, destination, [source.parent, destination.parent], kernel)
        kernel.MoveFileExW.assert_called_once_with(str(source), str(destination), 0x9)
        self.assertEqual(kernel.FlushFileBuffers.call_count, 4)
        self.assertEqual(kernel.CloseHandle.call_count, 2)

    def test_windows_durable_replace_falls_back_to_volume_or_refuses_before_rename(self):
        invalid = ctypes.c_void_p(-1).value
        kernel = types.SimpleNamespace(CreateFileW=Mock(side_effect=lambda name, *args: 20 if name.startswith("\\\\.\\") else invalid),
                                       FlushFileBuffers=Mock(return_value=True), CloseHandle=Mock(), MoveFileExW=Mock(return_value=True))
        source, destination = PureWindowsPath("C:/staging/pack"), PureWindowsPath("C:/packs/pack")
        backend.windows_durable_replace(source, destination, [source.parent], kernel)
        self.assertTrue(any(call.args[0] == "\\\\.\\C:" for call in kernel.CreateFileW.call_args_list))
        kernel.MoveFileExW.assert_called_once()
        kernel.MoveFileExW.reset_mock()
        kernel.CreateFileW.side_effect = None
        kernel.CreateFileW.return_value = invalid
        with self.assertRaisesRegex(RuntimeError, "denied both"):
            backend.windows_durable_replace(source, destination, [source.parent], kernel)
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
                    backend.processing_environment(root / "backend", identity, invalid_pack, None)
            missing_probe = backend.processing_environment(root / "backend", identity, pack, None)
            self.assertEqual(missing_probe["KARAOKE_PROCESSING_PYTHON"], "")
            probe = {"runtimeManifestId": pack.name, "pythonPath": str(pack / "python/bin/python3"),
                     "pythonSha256": manifest["files"][0]["sha256"], "probePassed": True,
                     "accelerator": "cpu", "components": {"faster_whisper": "1.2.3"},
                     "verifiedCapabilities": [], "capabilitiesReady": False}
            env = backend.processing_environment(root / "backend", identity, pack, None, probe)
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
                rejected = backend.processing_environment(root / "backend", identity, pack, None, bad_probe)
                self.assertEqual(rejected["KARAOKE_PROCESSING_PYTHON"], "")
                self.assertFalse(json.loads(rejected["KARAOKE_DESKTOP_PROCESSING_JSON"])["probePassed"])
            (pack / "unlisted.pth").write_text("unexpected")
            with self.assertRaisesRegex(RuntimeError, "inventory"):
                backend.processing_environment(root / "backend", identity, pack, None, probe)
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
            ready = json.loads(backend.processing_environment(root / "backend", identity, pack, model_pack, probe, policy)["KARAOKE_DESKTOP_PROCESSING_JSON"])
            self.assertFalse(ready["capabilitiesReady"])
            self.assertEqual(set(ready), {"runtimeManifestId", "pythonPath", "pythonSha256",
                                         "probePassed", "accelerator", "components",
                                         "verifiedCapabilities", "capabilitiesReady"})
            with self.assertRaisesRegex(RuntimeError, "not defined"):
                backend.processing_environment(root / "backend", identity, pack, model_pack, probe)
            wrong_policy = json.loads(json.dumps(policy))
            wrong_policy["models"][0]["files"][0]["size"] = 6
            with self.assertRaisesRegex(RuntimeError, "immutable application policy"):
                backend.processing_environment(root / "backend", identity, pack, model_pack, probe, wrong_policy)
            (pack / "python/bin/python3").write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "verification"):
                backend.processing_environment(root / "backend", identity, pack, None)

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
            selected = backend.processing_environment(root / "backend", identity, pack, None, probe, trusted_locks=[lock_hash])
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
                                                          {**probe, **changes}, trusted_locks=[lock_hash])
                self.assertEqual(rejected["KARAOKE_PROCESSING_PYTHON"], "")
                self.assertFalse(json.loads(rejected["KARAOKE_DESKTOP_PROCESSING_JSON"])["capabilitiesReady"])
            with self.assertRaisesRegex(RuntimeError, "not trusted"):
                backend.processing_environment(root / "backend", identity, pack, None, probe, trusted_locks=[])
            changed = json.loads(json.dumps(manifest))
            changed["probe"]["modules"] = ["faster_whisper"]
            with self.assertRaisesRegex(RuntimeError, "differs from its input lock"):
                backend.processing_environment(root / "backend", identity, write_pack(changed), None, probe, trusted_locks=[lock_hash])

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
                    backend.processing_environment(root / "backend", identity, pack, None)
                else:
                    with self.assertRaisesRegex(RuntimeError, "Duplicate"):
                        backend.processing_environment(root / "backend", identity, pack, None)

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
                env = backend.processing_environment(root / "backend", {"appVersion": app_version}, None, pack, model_policy=policy)
                self.assertEqual(env["KARAOKE_HEART_CKPT"], str(pack / directory))
                self.assertEqual(json.loads(env["KARAOKE_HEART_MODEL_STATUS_JSON"]),
                                 {"installed": True, "modelId": "heart-transcriptor", "revision": revision})
                self.assertEqual(env["HF_HUB_OFFLINE"], "1")
                self.assertEqual(env["PYTORCH_ENABLE_MPS_FALLBACK"], "0")
                self.assertEqual(env["TRANSFORMERS_OFFLINE"], "1")
                self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], "")
            (pack / directory / "model.safetensors").write_bytes(b"corrupt")
            with self.assertRaisesRegex(RuntimeError, "verification failed"):
                backend.processing_environment(root / "backend", {}, None, pack, model_policy=policy)

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
