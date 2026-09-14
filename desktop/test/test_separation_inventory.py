# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('inventory_separation', Path(__file__).parents[1] / 'build' / 'inventory_separation.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SeparationInventoryTests(unittest.TestCase):
    def test_shipped_inventory_matches_reproducible_entries(self):
        policy = json.loads((Path(__file__).parents[1] / 'models.json').read_text())
        selected = [entry for entry in policy['models'] if entry['id'] in {'demucs-mdx-extra', 'karaoke-roformer'}]
        self.assertEqual(selected, MODULE.entries())
        self.assertEqual([len(entry['files']) for entry in selected], [4, 3])

    def test_local_inventory_hashes_before_accepting_bytes(self):
        data = b'valid-model-fixture'
        entry = {'path': 'torch/hub/checkpoints/fixture.th', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, 'entries', return_value=[{'files': [entry]}]):
            root = Path(directory)
            (root / 'fixture.th').write_bytes(data)
            MODULE.inventory(root, root)
            (root / 'fixture.th').write_bytes(b'x' * len(data))
            with self.assertRaisesRegex(ValueError, 'hash differs'):
                MODULE.inventory(root, root)

    def test_upstream_metadata_check_never_fetches_checkpoint_and_rejects_identity_change(self):
        def fetch(url):
            self.assertIn('/releases/assets/', url)
            name, size, _, asset_id = MODULE.KARAOKE[0]
            return json.dumps({'id': asset_id, 'name': name, 'size': size + 1,
                               'browser_download_url': MODULE.RELEASE + name}).encode()
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            MODULE.verify_upstream(fetch)


if __name__ == '__main__':
    unittest.main()
