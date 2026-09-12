# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


DESKTOP = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("inventory_heart", DESKTOP / "build/inventory_heart.py")
heart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(heart)


class HeartInventoryTests(unittest.TestCase):
    def fixture(self):
        data = b"configuration"
        blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        siblings = [{"rfilename": name, "size": len(data), "blobId": blob} for name in heart.FILES]
        weights = next(record for record in siblings if record["rfilename"] == "model.safetensors")
        weights.update(size=3_055_544_304, lfs={"size": 3_055_544_304, "sha256": "a" * 64})
        metadata = {"sha": heart.REVISION, "siblings": siblings}
        calls = []

        def fetch(url):
            calls.append(url)
            if "/api/models/" in url:
                return json.dumps(metadata).encode()
            self.assertFalse(url.endswith(".safetensors"), "Inventory must never fetch weights")
            return data
        return metadata, fetch, calls

    def test_inventory_fetches_only_small_configs_and_uses_lfs_weight_digest(self):
        _, fetch, calls = self.fixture()
        model = heart.inventory(fetch)
        weight = next(file for file in model["files"] if file["path"].endswith(".safetensors"))
        self.assertEqual(weight["sha256"], "a" * 64)
        self.assertEqual(len(calls), len(heart.FILES))
        self.assertTrue(all(heart.REVISION in url for url in calls))

    def test_rejects_revision_drift(self):
        metadata, fetch, _ = self.fixture()
        metadata["sha"] = "b" * 40
        with self.assertRaisesRegex(ValueError, "revision"):
            heart.inventory(fetch)

    def test_rejects_config_corruption(self):
        metadata, fetch, _ = self.fixture()
        metadata["siblings"][0]["blobId"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "Git blob"):
            heart.inventory(fetch)

    def test_rejects_inconsistent_weight_metadata(self):
        metadata, fetch, _ = self.fixture()
        next(record for record in metadata["siblings"] if "lfs" in record)["lfs"]["size"] = 1
        with self.assertRaisesRegex(ValueError, "weight metadata"):
            heart.inventory(fetch)

    def test_policy_has_complete_offline_processor_and_weights(self):
        policy = json.loads((DESKTOP / "models.json").read_text())
        model = next(model for model in policy["models"] if model["id"] == "heart-transcriptor")
        self.assertEqual(model["directory"], heart.DIRECTORY)
        self.assertEqual({Path(file["path"]).name for file in model["files"]}, set(heart.FILES))
        self.assertEqual(sum(file["size"] for file in model["files"]), 3_059_916_381)
        for file in model["files"]:
            self.assertEqual(str(Path(file["path"]).parent), heart.DIRECTORY)
            self.assertEqual(file["revision"], heart.REVISION)
            self.assertEqual(file["url"], f"https://huggingface.co/{heart.REPOSITORY}/resolve/{heart.REVISION}/{Path(file['path']).name}")


if __name__ == "__main__":
    unittest.main()
