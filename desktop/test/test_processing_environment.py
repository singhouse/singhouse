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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import _windows_extended_path, processing_environment


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
        identifier = hashlib.sha256(raw).hexdigest()
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

    def admit(self, **changes):
        return processing_environment(self.runtime, self.identity, self.processing, None,
                                      {**self.probe, **changes}, trusted_locks=[self.lock_hash])

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

    def test_changed_attestation_path_does_not_admit_workers(self):
        env = self.admit(pythonPath=str(self.processing / "other.exe"))
        self.assertEqual(env["KARAOKE_PROCESSING_PYTHON"], "")
        self.assertFalse(json.loads(env["KARAOKE_DESKTOP_PROCESSING_JSON"])["capabilitiesReady"])

    def test_long_inventory_hash_and_parent_containment_remain_enforced(self):
        self.native(self.processing / self.relative).write_bytes(b"changed source")
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


if __name__ == "__main__":
    unittest.main()
