# SPDX-License-Identifier: AGPL-3.0-only
"""Artifact delivery must preserve every checksummed file, including dotfiles."""
import hashlib
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from verify_acceptance_artifact import verify_bundle


class AcceptanceArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        source = root / 'assembled'
        self.bundle = root / 'delivered'
        self.hidden = [
            'app/resources/native/python/Lib/site-packages/.lock',
            'app/resources/native/python/Lib/site-packages/numpy/f2py/tests/src/assumed_shape/.f2py_f2cmap',
            'app/resources/native/python/Lib/site-packages/numpy/f2py/tests/src/f2cmap/.f2py_f2cmap',
            'app/resources/native/python/Scripts/.empty',
            'app/resources/native/python/.runtime-state/metadata.json',
        ]
        inventory = []
        for name in ['app/Singhouse.exe', 'tools/file with spaces.mjs', *self.hidden]:
            content = b'' if name.endswith('.empty') else name.encode()
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            inventory.append(f'{hashlib.sha256(content).hexdigest()}  {name}\n')
        self.checksums = source / 'SHA256SUMS'
        self.checksums.write_text(''.join(inventory), encoding='utf-8')
        archive = root / 'artifact.zip'
        with zipfile.ZipFile(archive, 'w') as stream:
            for path in source.rglob('*'):
                if path.is_file():
                    stream.write(path, path.relative_to(source).as_posix())
        with zipfile.ZipFile(archive) as stream:
            stream.extractall(self.bundle)

    def test_zip_roundtrip_preserves_all_checksums_and_hidden_files(self):
        self.assertEqual(verify_bundle(self.bundle, self.checksums), 7)

    def test_each_missing_hidden_file_is_rejected(self):
        for name in self.hidden:
            with self.subTest(name=name):
                path = self.bundle / name
                path.unlink()
                with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
                    verify_bundle(self.bundle, self.checksums)
                shutil.copyfile(self.checksums.parent / name, path)

    def test_modified_file_is_rejected(self):
        (self.bundle / self.hidden[0]).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            verify_bundle(self.bundle, self.checksums)

    def test_modified_delivered_inventory_is_rejected(self):
        (self.bundle / 'SHA256SUMS').write_text('')
        with self.assertRaisesRegex(ValueError, 'differs from the assembled inventory'):
            verify_bundle(self.bundle, self.checksums)

    def test_unexpected_file_is_rejected(self):
        (self.bundle / '.extra').write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            verify_bundle(self.bundle, self.checksums)

    def test_symbolic_link_is_rejected(self):
        link = self.bundle / '.linked-file'
        try:
            link.symlink_to(self.bundle / self.hidden[0])
        except OSError as error:
            self.skipTest(f'Symbolic links are unavailable: {error}')
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            verify_bundle(self.bundle, self.checksums)

    def test_empty_or_malformed_inventory_is_rejected(self):
        for content in ['', 'invalid entry\n']:
            with self.subTest(content=content):
                self.checksums.write_text(content)
                (self.bundle / 'SHA256SUMS').write_text(content)
                with self.assertRaisesRegex(ValueError, 'checksum inventory'):
                    verify_bundle(self.bundle, self.checksums)

    def test_unsafe_or_duplicate_inventory_paths_are_rejected(self):
        for name in ['../outside', '/absolute', 'C:/absolute', 'app\\file', './app/file', 'SHA256SUMS', 'app/file']:
            with self.subTest(name=name):
                content = f'{"a" * 64}  {name}\n'
                if name == 'app/file':
                    content += content
                self.checksums.write_text(content)
                (self.bundle / 'SHA256SUMS').write_text(content)
                with self.assertRaisesRegex(ValueError, 'checksum path'):
                    verify_bundle(self.bundle, self.checksums)


if __name__ == '__main__':
    unittest.main()
