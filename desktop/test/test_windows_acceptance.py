# SPDX-License-Identifier: AGPL-3.0-only
"""Acceptance packaging consumes the real recipe generator's schema and trust."""
import copy
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from processing_recipe import generate
from windows_acceptance import validate_recipe


class WindowsAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        python = root / 'python.archive'
        python.write_bytes(b'fixture archive')
        checksum = hashlib.sha256(python.read_bytes()).hexdigest()
        self.native_hash = 'a' * 64
        source = dict(appVersion='0.1.0', backendVersion='0.1.0', lyricsyncVersion='0.1.0',
                      pythonVersion='3.12.14', platform='win32', arch='x64', accelerator='cpu',
                      capabilities=['transcription'], models=[], modelCapabilities={}, excludedPackages={},
                      probe={}, sourceCommit='b' * 40, nativeLockSha256=self.native_hash,
                      ffmpegRelease='fixture', packages=[])
        self.manifest = generate(source, [dict(filename='fixture-1-py3-none-any.whl')],
                                 dict(url='https://example.com/python.tar.gz', sha256=checksum), python,
                                 dict(executableSha256='c' * 64), '0.12.8', root / 'recipe', [])
        self.lock = self.manifest['provenance']['lockSha256']
        self.trust = dict(lockSha256=[self.lock], privateTestLockSha256=[self.lock])

    def test_generated_recipe_shape_is_accepted(self):
        self.assertEqual(validate_recipe(self.manifest, self.trust, 'cpu', self.native_hash), self.lock)

    def test_independent_private_trust_is_required(self):
        with self.assertRaisesRegex(ValueError, 'independently pinned'):
            validate_recipe(self.manifest, dict(lockSha256=[self.lock], privateTestLockSha256=[]), 'cpu', self.native_hash)

    def test_other_target_native_tools_and_tampered_lock_are_rejected(self):
        for accelerator, native in [('cuda', self.native_hash), ('cpu', 'd' * 64)]:
            with self.subTest(accelerator=accelerator, native=native), self.assertRaises(ValueError):
                validate_recipe(self.manifest, self.trust, accelerator, native)
        changed = copy.deepcopy(self.manifest)
        changed['provenance']['inputLock'] += ' '
        with self.assertRaisesRegex(ValueError, 'input lock hash'):
            validate_recipe(changed, self.trust, 'cpu', self.native_hash)


if __name__ == '__main__':
    unittest.main()
