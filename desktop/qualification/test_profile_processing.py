# SPDX-License-Identifier: AGPL-3.0-only
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("profile_processing", Path(__file__).with_name("profile_processing.py"))
profile = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(profile)
ADMISSION_SPEC = importlib.util.spec_from_file_location("memory_admission", Path(__file__).resolve().parents[2]
    / "backend/src/karaoke_backend/workers/memory_admission.py")
admission = importlib.util.module_from_spec(ADMISSION_SPEC)
ADMISSION_SPEC.loader.exec_module(admission)


class ProfilingTests(unittest.TestCase):
    def test_heart_command_includes_managed_default_vad_inside_measured_child(self):
        args = SimpleNamespace(interpreter="python", model="heart-transcriptor", audio="input.wav",
                               model_dir="models", device="cuda", language="en")
        command = profile.worker_command(args, Path("outputs"))
        self.assertEqual(command[-2:], ["--managed-vad-config", "{}"])

    def test_candidate_does_not_allow_cuda_fallback(self):
        value = {"schema": 1, "executionProfile": "bounded-v1", "evidenceReference": "experiment-1", "models": {"heart-transcriptor": {
            "maxDurationSeconds": 30, "maxSampleRate": 48000, "maxChannels": 2,
            "devices": {"cpu": {"ramBytes": 100}, "cuda": {"ramBytes": 200, "vramBytes": 300}}}}}
        selected = profile.candidate_policy(value, "heart-transcriptor", "cuda")
        self.assertEqual(set(selected["models"]["heart-transcriptor"]["devices"]), {"cuda"})
        self.assertIn("cpu", value["models"]["heart-transcriptor"]["devices"])
        # Exercise the real consumer so profile/schema drift cannot silently
        # turn every proposed measurement into an admission refusal.
        with patch.dict(os.environ, {"KARAOKE_PROCESSING_MEMORY_JSON": json.dumps(selected)}):
            self.assertEqual(admission.policy_for("heart-transcriptor"), selected["models"]["heart-transcriptor"])
        for invalid in ({**value, "executionProfile": "future-v2"}, {**value, "futureProfileField": True},
                        {key: entry for key, entry in value.items() if key != "executionProfile"}):
            with self.assertRaises(ValueError):
                profile.candidate_policy(invalid, "heart-transcriptor", "cuda")

    def test_gpu_usage_only_counts_owned_pids_on_selected_gpu(self):
        rows = [["GPU-a", "10", "4"], ["GPU-a", "11", "9"], ["GPU-b", "10", "100"]]
        with patch.object(profile, "smi", return_value=rows):
            self.assertEqual(profile.gpu_memory("GPU-a", {10}), (4 * profile.MIB, 9 * profile.MIB))
        with patch.object(profile, "smi", return_value=[["GPU-a", "10", "N/A"]]):
            with self.assertRaises(ValueError):
                profile.gpu_memory("GPU-a", {10})

    @unittest.skipUnless(sys.platform == "linux", "Linux /proc monitor")
    def test_monitors_real_subprocess(self):
        with tempfile.TemporaryDirectory() as directory:
            result = profile.monitor([sys.executable, "-c", "import time; data=bytearray(8*1024*1024); time.sleep(.2)"],
                                     os.environ.copy(), Path(directory), 1, 3, .01)
            self.assertTrue(result["success"], result)
            self.assertGreater(result["sampledPeakRssBytes"], 8 * profile.MIB)
            self.assertGreater(result["samples"], 0)

    @unittest.skipUnless(sys.platform == "linux", "Linux process groups")
    def test_reserve_watchdog_kills_worker(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(profile, "available_ram", side_effect=[100, 10]):
            result = profile.monitor([sys.executable, "-c", "import time; time.sleep(30)"],
                                     os.environ.copy(), Path(directory), 50, 3, .01)
            self.assertFalse(result["success"])
            self.assertEqual(result["stopReason"], "host-reserve-threatened")
            self.assertLess(result["elapsedSeconds"], 3)

    @unittest.skipUnless(sys.platform == "linux", "Linux process groups")
    def test_monitor_error_kills_worker_and_records_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(profile, "gpu_memory", side_effect=ValueError("unknown")):
            result = profile.monitor([sys.executable, "-c", "import time; time.sleep(30)"],
                                     os.environ.copy(), Path(directory), 1, 3, .01, "GPU-a")
            self.assertFalse(result["success"])
            self.assertEqual(result["stopReason"], "monitor-failed:ValueError")

    def test_runtime_identity_rejects_modified_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = root / "python"
            python.write_bytes(b"runtime")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"platform": "linux", "accelerator": "cuda", "python": "python",
                "provenance": {"lockSha256": "a" * 64}, "files": [
                    {"path": "python", "size": 7, "sha256": profile.sha256(python)}]}))
            self.assertEqual(profile.verify_runtime(root, manifest, python)["verifiedFileCount"], 1)
            python.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                profile.verify_runtime(root, manifest, python)


if __name__ == "__main__":
    unittest.main()
