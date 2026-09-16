# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest

spec = importlib.util.spec_from_file_location("assemble_processing", Path(__file__).parents[1] / "build/assemble_processing.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ProcessingPackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = self.root / "payload"
        (self.payload / "python/bin").mkdir(parents=True)
        (self.payload / "python/bin/python3").write_bytes(b"fixture")
        (self.payload / "NOTICE.fixture").write_bytes(b"MIT notice")
        self.lock = {"schema": 1, "kind": "processing-input", "appVersion": "0.1.0", "backendVersion": "0.1.0", "lyricsyncVersion": "0.1.0",
                     "pythonVersion": "3.12.14", "platform": "linux", "arch": "x64", "accelerator": "cpu", "python": "python/bin/python3",
                     "sourceCommit": "a" * 40, "capabilities": ["transcription"], "models": ["whisper"], "modelCapabilities": {"whisper": "transcription"},
                     "excludedPackages": builder.EXCLUDED_PACKAGES,
                     "packages": [{"name": "fixture", "version": "1", "license": "MIT", "sourceUrl": "https://example.org/fixture.whl", "sha256": "b" * 64, "notices": ["NOTICE.fixture"]}],
                     "files": [{"path": "python/bin/python3", "size": 7, "sha256": hashlib.sha256(b"fixture").hexdigest(), "executable": True},
                               {"path": "NOTICE.fixture", "size": 10, "sha256": hashlib.sha256(b"MIT notice").hexdigest(), "executable": False}]}
        self.lock_path = self.root / "lock.json"

    def assemble(self):
        self.lock_path.write_text(json.dumps(self.lock))
        return builder.assemble(self.payload, self.lock_path, self.root / "output")

    def test_fixture_pack_is_locked_and_has_local_artifacts(self):
        manifest = self.assemble()
        self.assertEqual(manifest["kind"], "processing")
        self.assertTrue(manifest["files"][0]["url"].startswith("file:"))
        self.assertEqual(manifest["provenance"]["lockSha256"], builder.digest(self.lock_path))
        self.assertEqual(json.loads(manifest["provenance"]["inputLock"]), self.lock)
        self.assertIn("lyricsync.transcription.heart", manifest["probe"]["modules"])

    def test_assembled_manifest_is_accepted_by_runtime_consumer(self):
        manifest = self.assemble()
        module = (Path(__file__).parents[1] / "runtime_manager.mjs").as_uri()
        script = """import fs from 'node:fs';
const {validateProcessingManifest}=await import(process.argv[1]);
const value=JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
validateProcessingManifest(value, {appVersion:'0.1.0',backendVersion:'0.1.0',lyricsyncVersion:'0.1.0',platform:'linux',arch:'x64'}, [value.provenance.lockSha256]);
"""
        subprocess.run(["node", "--input-type=module", "-e", script, module,
                        str(self.root / "output/manifest.json")], check=True)
        for record in manifest["files"]:
            self.assertEqual(builder.digest(self.root / "output/blobs" / record["sha256"]), record["sha256"])
        self.assertIn("UNTESTED", manifest["provenance"]["qualification"])

    def test_rejects_changed_and_unlisted_files(self):
        (self.payload / "extra").write_text("untracked")
        with self.assertRaisesRegex(ValueError, "entire payload"):
            self.assemble()
        (self.payload / "extra").unlink()
        (self.payload / "python/bin/python3").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "lock"):
            self.assemble()

    def test_rejects_symlinks_and_missing_package_provenance(self):
        (self.payload / "link").symlink_to(self.payload / "python/bin/python3")
        with self.assertRaisesRegex(ValueError, "symbolic"):
            self.assemble()
        (self.payload / "link").unlink()
        self.lock["packages"][0].pop("license")
        with self.assertRaisesRegex(ValueError, "provenance"):
            self.assemble()

    def test_rejects_missing_notice_and_incomplete_model_binding(self):
        self.lock["packages"][0]["notices"] = ["MISSING"]
        with self.assertRaisesRegex(ValueError, "notices"):
            self.assemble()
        self.lock["packages"][0]["notices"] = ["NOTICE.fixture"]
        self.lock["modelCapabilities"] = {}
        with self.assertRaisesRegex(ValueError, "Every model"):
            self.assemble()

    def test_rejects_diffq_provenance_code_metadata_and_notices(self):
        for name in ("diffq", "diffq-fixed"):
            self.lock["packages"][0]["name"] = name
            with self.assertRaisesRegex(ValueError, "Excluded non-commercial"):
                self.assemble()
        self.lock["packages"][0]["name"] = "fixture"
        self.lock["excludedPackages"] = {}
        with self.assertRaisesRegex(ValueError, "exact diffq exclusion"):
            self.assemble()
        self.lock["excludedPackages"] = builder.EXCLUDED_PACKAGES
        path = self.payload / "python/lib/python3.12/site-packages/diffq/__init__.py"
        path.parent.mkdir(parents=True)
        path.write_text("excluded")
        data = path.read_bytes()
        self.lock["files"].append({"path": path.relative_to(self.payload).as_posix(), "size": len(data),
                                   "sha256": hashlib.sha256(data).hexdigest(), "executable": False})
        with self.assertRaisesRegex(ValueError, "excluded diffq"):
            self.assemble()


if __name__ == "__main__":
    unittest.main()
