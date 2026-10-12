# SPDX-License-Identifier: AGPL-3.0-only
"""Acceptance packaging consumes the real recipe generator's schema and trust."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import io

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from processing_recipe import generate
from windows_acceptance import validate_recipe, recipe_publication, recipe


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

    def test_release_asset_publication_is_bound_to_source_and_accelerator(self):
        source = 'b' * 40
        for accelerator in ('cpu', 'cuda'):
            self.assertEqual(recipe_publication(source, accelerator, release_assets=True),
                             ('flat', f'https://github.com/singhouse/processing-packs/releases/download/rc-{source}-win-{accelerator}/'))
        self.assertEqual(recipe_publication(source, 'cpu', artifact_base_url='https://example.com/bundle/'),
                         ('directory', 'https://example.com/bundle/'))
        for commit, accelerator, options in [('b' * 7, 'cpu', dict(release_assets=True)),
                                              (source, 'metal', dict(release_assets=True)),
                                              (source, 'cpu', dict(release_assets=True, artifact_base_url='https://other.test/')),
                                              (source, 'cpu', {})]:
            with self.subTest(commit=commit, accelerator=accelerator, options=options), self.assertRaises(ValueError):
                recipe_publication(commit, accelerator, **options)

    def test_recipe_builder_exports_selected_layout_and_manifest_evidence(self):
        root = Path(self.temporary.name)
        for release_assets in (False, True):
            with self.subTest(release_assets=release_assets):
                work = root / ('flat-build' if release_assets else 'bundle-build')
                recipe_dir = work / 'build/recipe'
                recipe_dir.mkdir(parents=True)
                manifest = recipe_dir / 'manifest.json'
                manifest.write_text(json.dumps(self.manifest))
                args = SimpleNamespace(work=work, accelerator='cpu', release_assets=release_assets,
                                       artifact_base_url=None if release_assets else 'https://example.com/bundle/')
                with patch('windows_acceptance.prepare', return_value=(root / 'python', {}, root / 'cache')), \
                        patch('windows_acceptance.subprocess.check_output', return_value='b' * 40 + '\n'), \
                        patch('windows_acceptance.subprocess.run') as run, patch('sys.stdout', new_callable=io.StringIO):
                    recipe(args)
                command = run.call_args.args[0]
                self.assertEqual(command[command.index('--artifact-layout') + 1], 'flat' if release_assets else 'directory')
                expected_url = recipe_publication('b' * 40, 'cpu', release_assets=release_assets, artifact_base_url=args.artifact_base_url)[1]
                self.assertEqual(command[command.index('--artifact-base-url') + 1], expected_url)
                evidence = json.loads((recipe_dir / 'build-evidence.json').read_text())
                self.assertEqual(evidence['sourceCommit'], 'b' * 40)
                self.assertEqual(evidence['manifestSha256'], hashlib.sha256(manifest.read_bytes()).hexdigest())
                self.assertEqual(evidence['lockSha256'], self.lock)
                self.assertEqual(evidence['artifactBaseUrl'], expected_url)
                self.assertIn('no models, GPU probe, or song qualification', evidence['qualification'])

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
