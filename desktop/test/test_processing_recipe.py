# SPDX-License-Identifier: AGPL-3.0-only
"""Recipe publication/inventory fixtures; no network or target toolchain needed."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import io
import tarfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from processing_recipe import artifact, generate, installed_inventory, wheel_records
from assemble import unpack_uv


class RecipeTests(unittest.TestCase):
    def test_only_local_wheels_are_republished_and_notices_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            upstream = root / 'a-1-py3-none-any.whl'
            upstream.write_bytes(b'upstream wheel')
            built = root / 'b-1-py3-none-any.whl'
            built.write_bytes(b'built wheel')
            notice = root / 'notices/a/000.txt'
            notice.parent.mkdir(parents=True)
            notice.write_text('License text')
            records = [(upstream, dict(url='https://example.test/a.whl', sha256=hashlib.sha256(upstream.read_bytes()).hexdigest())),
                       (built, dict(url='https://example.test/b.tar.gz', sha256='b' * 64))]
            packages = [dict(name=name, version='1', license='MIT', notices=['notices/a/000.txt']) for name in ('a', 'b')]
            result = wheel_records(records, packages, root, root / 'recipe', 'https://example.test/artifacts/')
            self.assertEqual(result[0]['url'], records[0][1]['url'])
            self.assertEqual(result[1]['sourceSha256'], 'b' * 64)
            self.assertIn('/artifacts/', result[1]['url'])
            self.assertEqual(result[1]['notices'][0]['filename'], '000.txt')
            self.assertEqual(len(list((root / 'recipe').rglob('*.whl'))), 1)

    def test_bundled_uv_checks_extracted_executable_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'uv.tar.gz'
            data = b'pinned uv binary'
            with tarfile.open(archive, 'w:gz') as output:
                member = tarfile.TarInfo('uv-target/uv')
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
            record = dict(archive='tar.gz', member='uv-target/uv', executableSha256=hashlib.sha256(data).hexdigest())
            unpack_uv(archive, record, root / 'bin/uv')
            self.assertEqual((root / 'bin/uv').read_bytes(), data)
            record['executableSha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                unpack_uv(archive, record, root / 'bin/uv')
            self.assertFalse((root / 'bin/uv').exists())

    def test_publication_requires_https_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'a.whl'
            path.write_bytes(b'wheel')
            for url in ('http://example.test/', 'https://example.test/no-slash', 'https://example.test/?x=1'):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    artifact(path, path.parent / 'out', url)

    def test_inventory_normalizes_only_cfg_and_contained_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            results = []
            for name in ('first', 'second-longer-path'):
                root = Path(temporary) / name
                (root / 'env/bin').mkdir(parents=True)
                (root / 'python/bin').mkdir(parents=True)
                (root / 'python/bin/python3').write_bytes(b'executable')
                (root / 'env/pyvenv.cfg').write_text(f'home = {root}/python/bin\n')
                (root / 'env/bin/python').symlink_to(root / 'python/bin/python3')
                results.append(installed_inventory(root))
            self.assertEqual(results[0], results[1])
            self.assertEqual(next(r for r in results[0] if r['path'] == 'env/bin/python')['target'], '../../python/bin/python3')
            (root / 'evil').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError, 'escapes'):
                installed_inventory(root)

    def test_recipe_binds_inventory_and_exact_binary_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            python = root / 'python.tar.gz'
            python.write_bytes(b'pinned interpreter')
            lock = dict(appVersion='1', backendVersion='1', lyricsyncVersion='1', pythonVersion='3.12.14',
                        platform='linux', arch='x64', accelerator='cpu', capabilities=['transcription'],
                        models=[], modelCapabilities={}, excludedPackages={}, probe={'schema': 2},
                        sourceCommit='a' * 40, packages=[], nativeLockSha256='d' * 64, ffmpegRelease='b6.1.1')
            files = [dict(path='env/bin/python', target='../../python/bin/python3'),
                     dict(path='python/bin/python3', size=10, sha256='c' * 64, executable=True)]
            manifest = generate(lock, [dict(filename='a-1-py3-none-any.whl')],
                                dict(url='https://example.test/python.tar.gz', sha256=hashlib.sha256(python.read_bytes()).hexdigest()),
                                python, dict(executableSha256='b' * 64), '0.12.8', root / 'recipe', files)
            self.assertEqual(manifest['recipe']['files'], files)
            self.assertEqual(manifest['recipe']['installedSize'], 10)
            self.assertEqual(manifest['provenance']['lockSha256'], hashlib.sha256(manifest['provenance']['inputLock'].encode()).hexdigest())
            bound = json.loads(manifest['provenance']['inputLock'])
            self.assertEqual(bound['recipe'], manifest['recipe'])
            self.assertEqual(bound['kind'], 'processing-input')


if __name__ == '__main__':
    unittest.main()
