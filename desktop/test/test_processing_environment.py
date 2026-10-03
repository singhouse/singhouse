# SPDX-License-Identifier: AGPL-3.0-only
"""Admission protocol fixtures; these do not qualify a real processing runtime."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import _windows_extended_path, isolated_environment, persistent_directory, processing_environment, processing_memory_policy


class ProcessingEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(lambda: shutil.rmtree(self.native(self.root)))
        self.runtime = self.root / "backend"
        self.identity = dict(appVersion="0.1.0", backendVersion="0.1.0",
                             lyricsyncVersion="0.1.0", platform=sys.platform, arch="x64")
        self.relative = "/".join(["deep-" + "x" * 50] * 5 + ["module.py"])
        payloads = {"python/python.exe": b"inert interpreter fixture", self.relative: b"fixture source"}
        modules = sorted(["faster_whisper", "lyricsync.transcription.heart",
                          "karaoke_backend.workers.heart_transcriptor"])
        manifest = dict(schema=1, kind="processing", **self.identity,
                        pythonVersion="3.12.14", accelerator="cpu", python="python/python.exe",
                        capabilities=["transcription"], models=[], modelCapabilities={},
                        probe={"schema": 2, "type": "python-functional-v1", "modules": modules},
                        files=[dict(path=path, size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                                    executable=path == "python/python.exe")
                               for path, data in payloads.items()])
        lock = {**manifest, "kind": "processing-input", "packages": [], "sourceCommit": "a" * 40}
        raw_lock = json.dumps(lock)
        self.lock_hash = hashlib.sha256(raw_lock.encode()).hexdigest()
        manifest["provenance"] = dict(inputLock=raw_lock, lockSha256=self.lock_hash,
                                      packages=[], sourceCommit="a" * 40)
        raw = json.dumps(manifest).encode()
        identifier = self.identifier = hashlib.sha256(raw).hexdigest()
        self.processing = self.root / "processing" / "packs" / identifier
        for relative, data in {**payloads, "manifest.json": raw}.items():
            path = self.native(self.processing / relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        # Synthetic protocol evidence exercises admission checks only. No fixture
        # interpreter is executed and no actual dependency probe is claimed.
        self.probe = dict(runtimeManifestId=identifier,
                          pythonPath=str(self.native(self.processing / manifest["python"])),
                          pythonSha256=manifest["files"][0]["sha256"], probePassed=True,
                          accelerator="cpu", verifiedCapabilities=["transcription"],
                          capabilitiesReady=True, probeSchema=2,
                          checks=dict(deviceTensor=True, nativeAudio=True, transcription=True),
                          components={module: "fixture" for module in modules})

    @staticmethod
    def native(path):
        return _windows_extended_path(path) if os.name == "nt" else path

    def admit(self, processing_id=None, **changes):
        return processing_environment(self.runtime, self.identity, self.processing, None,
                                      {**self.probe, **changes}, trusted_locks=[self.lock_hash],
                                      processing_id=processing_id or self.identifier)

    def rename_pack(self, name):
        moved = self.processing.with_name(name)
        self.native(self.processing).rename(self.native(moved))
        self.processing = moved
        self.probe["pythonPath"] = str(self.native(moved / "python/python.exe"))

    def test_memory_policy_is_bound_to_exact_runtime_and_cannot_break_playback(self):
        policy = dict(schema=1, runtimeLockSha256=self.lock_hash,
                      evidenceReference="synthetic-test-only", models={})
        with patch.object(Path, "read_text", return_value=json.dumps(policy)):
            self.assertEqual(json.loads(processing_memory_policy(self.lock_hash)), policy)
            self.assertEqual(processing_memory_policy("other-runtime"), "")
        for invalid in ("{", "null", "[]", json.dumps({**policy, "schema": True})):
            with patch.object(Path, "read_text", return_value=invalid):
                self.assertEqual(processing_memory_policy(self.lock_hash), "")
        with patch.object(Path, "read_text", side_effect=FileNotFoundError):
            self.assertEqual(processing_memory_policy(self.lock_hash), "")

    def test_memory_policy_only_forwarded_after_runtime_attestation(self):
        with patch("backend.processing_memory_policy", return_value="measured-policy") as load:
            self.assertEqual(self.admit()["KARAOKE_PROCESSING_MEMORY_JSON"], "measured-policy")
            load.assert_called_once_with(self.lock_hash)
        with patch("backend.processing_memory_policy") as load:
            self.assertEqual(self.admit(pythonPath="changed")["KARAOKE_PROCESSING_MEMORY_JSON"], "")
            load.assert_not_called()

    def test_long_inventory_and_exact_worker_attestation(self):
        self.assertGreater(len(str(self.processing / self.relative)), 300)
        env = self.admit()
        self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], self.probe["pythonPath"])
        self.assertEqual(env["KARAOKE_DEMUCS_PYTHON"], self.probe["pythonPath"])
        self.assertEqual(json.loads(env["KARAOKE_DESKTOP_PROCESSING_JSON"])["pythonPath"],
                         env["KARAOKE_PROCESSING_PYTHON"])
        # This is the operation both backend workers apply before spawning.
        self.assertEqual(os.path.abspath(env["KARAOKE_PROCESSING_PYTHON"]), self.probe["pythonPath"])
        if os.name == "nt":
            self.assertTrue(env["KARAOKE_PROCESSING_PYTHON"].startswith("\\\\?\\"))

    def test_production_cache_is_app_owned_without_ambient_username(self):
        with persistent_directory(self.runtime), patch.dict(os.environ, {"TORCHINDUCTOR_CACHE_DIR": str(self.root / "hostile-cache"),
                                     "USERNAME": "ambient-user"}):
            env = isolated_environment(self.runtime, "http://127.0.0.1:1234", "fixture",
                                       disposable=False)
            env.update(self.admit())
        expected = self.native(self.runtime) / "cache/torchinductor"
        self.assertEqual(env["TORCHINDUCTOR_CACHE_DIR"], str(expected))
        self.assertNotIn("USERNAME", env)
        if os.name == "nt":
            self.assertTrue(env["TORCHINDUCTOR_CACHE_DIR"].startswith("\\\\?\\"))

    def test_changed_attestation_path_does_not_admit_workers(self):
        env = self.admit(pythonPath=str(self.processing / "other.exe"))
        self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], "")
        self.assertFalse(json.loads(env["KARAOKE_DESKTOP_PROCESSING_JSON"])["capabilitiesReady"])

    def test_long_inventory_size_and_parent_containment_remain_enforced(self):
        # Launch admission is structural; full installation/activation hashes
        # remain covered by runtime_manager.test.mjs's same-size corruption test.
        payload = self.native(self.processing / self.relative)
        payload.write_bytes(b"changed source")  # same length as the fixture
        self.assertEqual(self.admit()["KARAOKE_PROCESSING_PYTHON"], self.probe["pythonPath"])
        payload.write_bytes(b"changed source with a different size")
        with self.assertRaisesRegex(RuntimeError, "file verification failed"):
            self.admit()
        self.runtime = self.root / "other" / "backend"
        with self.assertRaisesRegex(RuntimeError, "Invalid managed processing path"):
            self.admit()

    @unittest.skipIf(os.name == "nt", "ordinary Windows users cannot create symlinks")
    def test_inventory_symlink_is_rejected(self):
        payload = self.processing / self.relative
        payload.unlink()
        target = self.root / "outside"
        target.write_bytes(b"fixture source")
        payload.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, "symbolic links"):
            self.admit()

    def test_short_directory_name_is_admitted_under_the_full_identity(self):
        self.rename_pack(self.identifier[:16])
        env = self.admit()
        self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], self.probe["pythonPath"])
        self.assertEqual(json.loads(env["KARAOKE_DESKTOP_PROCESSING_JSON"])["runtimeManifestId"], self.identifier)
        self.assertEqual(json.loads(env["KARAOKE_DESKTOP_MODEL_SETS_JSON"])["runtimeManifestId"], self.identifier)
        # Evidence naming the directory instead of the identity is not accepted.
        self.assertEqual(self.admit(runtimeManifestId=self.identifier[:16])["KARAOKE_PROCESSING_PYTHON"], "")

    def test_full_length_directory_name_is_still_admitted(self):
        env = self.admit()
        self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], self.probe["pythonPath"])
        self.assertEqual(json.loads(env["KARAOKE_DESKTOP_MODEL_SETS_JSON"])["runtimeManifestId"], self.identifier)

    def test_manifest_must_hash_to_the_full_identity(self):
        # Same 16-character name, different full identity: a shortened-name collision.
        self.rename_pack(self.identifier[:16])
        other = self.identifier[:16] + ("0" if self.identifier[16] != "0" else "1") + self.identifier[17:]
        with self.assertRaisesRegex(RuntimeError, "manifest was modified"):
            self.admit(processing_id=other)
        manifest = self.native(self.processing / "manifest.json")
        manifest.write_bytes(manifest.read_bytes() + b" ")
        with self.assertRaisesRegex(RuntimeError, "manifest was modified"):
            self.admit()

    def test_directory_name_must_be_the_identity_or_its_first_16_characters(self):
        other = hashlib.sha256(b"another runtime").hexdigest()
        for name in (self.identifier[:15], self.identifier[:17], self.identifier[:32],
                     self.identifier[1:17], other[:16], other):
            with self.subTest(name=name):
                self.rename_pack(name)
                with self.assertRaisesRegex(RuntimeError, "Invalid managed processing path"):
                    self.admit()

    def test_missing_or_malformed_identity_is_rejected(self):
        for name in (self.identifier, self.identifier[:16]):
            self.rename_pack(name)
            for identifier in (None, "", self.identifier[:16], self.identifier.upper(), 7):
                with self.subTest(name=name, identifier=identifier):
                    with self.assertRaisesRegex(RuntimeError, "Invalid managed processing path"):
                        processing_environment(self.runtime, self.identity, self.processing, None, self.probe,
                                               trusted_locks=[self.lock_hash], processing_id=identifier)


if __name__ == "__main__":
    unittest.main()
