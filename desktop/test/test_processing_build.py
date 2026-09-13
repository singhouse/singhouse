# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import patch
import sys
import tempfile
import tarfile
import unittest
import zipfile

BUILD = Path(__file__).parents[1] / 'build'
sys.path.insert(0, str(BUILD))
spec = importlib.util.spec_from_file_location('build_processing', BUILD / 'build_processing.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ProcessingBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_materializes_internal_file_alias_and_rejects_escape(self):
        payload = self.root / 'payload'
        payload.mkdir()
        binary = payload / 'python3.12'
        binary.write_bytes(b'python fixture')
        binary.chmod(0o755)
        (payload / 'python3').symlink_to('python3.12')
        builder.materialize_links(payload)
        files = builder.inventory(payload)
        self.assertEqual(len(files), 2)
        self.assertEqual(files[0]['sha256'], files[1]['sha256'])
        self.assertTrue(all(f['executable'] for f in files))
        (self.root / 'secret').write_bytes(b'outside')
        (payload / 'escape').symlink_to('../secret')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            builder.materialize_links(payload)

    def test_directory_alias_rejected_without_recursive_expansion(self):
        (self.root / 'loop').symlink_to('.', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'directory'):
            builder.materialize_links(self.root)

    def test_locked_wheel_notices_and_metadata_normalization(self):
        wheel = self.root / 'fixture-1-py3-none-any.whl'
        with zipfile.ZipFile(wheel, 'w') as archive:
            archive.writestr('fixture-1.dist-info/METADATA', 'Name: fixture\nVersion: 1\nLicense-Expression: MIT\n')
            archive.writestr('fixture-1.dist-info/licenses/LICENSE', 'MIT fixture terms')
        payload = self.root / 'payload'
        payload.mkdir()
        record = dict(name='fixture', version='1', url='https://example.org/fixture.whl', sha256=builder.digest(wheel))
        notices = builder.retain_notices(wheel, record, payload, self.root)
        self.assertEqual((payload / notices[0]).read_text(), 'MIT fixture terms')
        site = payload / 'site-packages'
        with zipfile.ZipFile(wheel) as archive:
            archive.extractall(site)
        dist = site / 'fixture-1.dist-info'
        (dist / 'direct_url.json').write_text('{"url":"file:///tmp/private-source"}')
        (dist / 'RECORD').write_text('fixture-1.dist-info/direct_url.json,,\nfixture-1.dist-info/RECORD,,\n')
        builder.normalize_installer_metadata(site, [(wheel, record)])
        direct = json.loads((dist / 'direct_url.json').read_text())
        self.assertEqual(direct['url'], record['url'])
        self.assertEqual(direct['archive_info']['hashes']['sha256'], builder.digest(wheel))
        self.assertNotIn('/tmp/', (dist / 'RECORD').read_text())
        self.assertIn('sha256=', (dist / 'RECORD').read_text())

    def test_missing_notices_and_unlocked_artifacts_fail(self):
        wheel = self.root / 'empty.whl'
        with zipfile.ZipFile(wheel, 'w'):
            pass
        with self.assertRaisesRegex(ValueError, 'notices'):
            builder.retain_notices(wheel, {'name': 'empty'}, self.root, self.root)
        lock = dict(schema=1, kind='processing-requirements', target='linux-x64', accelerator='cpu', capabilities=['transcription'],
                    packages=[dict(name='fixture', version='1', url='https://example.org/f.whl', sha256='a'*64)])
        builder.validate_requirements(lock, 'linux-x64', 'cpu')
        lock['packages'].append(dict(lock['packages'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            builder.validate_requirements(lock, 'linux-x64', 'cpu')

    def test_vendored_metadata_does_not_replace_wheel_identity_or_lose_notices(self):
        wheel = self.root / 'fixture-1-py3-none-any.whl'
        with zipfile.ZipFile(wheel, 'w') as archive:
            archive.writestr('fixture-1.dist-info/METADATA', 'Name: fixture\nVersion: 1\n')
            archive.writestr('fixture-1.dist-info/licenses/LICENSE', 'Fixture license')
            archive.writestr('fixture/_vendor/nested-2.dist-info/METADATA', 'Name: nested\nVersion: 2\n')
            archive.writestr('fixture/_vendor/nested-2.dist-info/LICENSE', 'Vendored license')
        self.assertEqual(builder.wheel_metadata(wheel)['Name'], 'fixture')
        notices = builder.retain_notices(wheel, {'name': 'fixture'}, self.root, self.root)
        self.assertEqual({(self.root / p).read_text() for p in notices}, {'Fixture license', 'Vendored license'})
        with zipfile.ZipFile(wheel, 'a') as archive:
            archive.writestr('another-2.dist-info/METADATA', 'Name: another\nVersion: 2\n')
        with self.assertRaisesRegex(ValueError, 'fixture-1-py3-none-any.whl.*found 2'):
            builder.wheel_metadata(wheel)

    def test_retains_notice_omitted_by_source_wheel_builder(self):
        wheel = self.root / 'fixture.whl'
        with zipfile.ZipFile(wheel, 'w'):
            pass
        archive_path = self.root / 'source.tar.gz'
        with tarfile.open(archive_path, 'w:gz') as archive:
            data = b'Upstream source license terms'
            entry = tarfile.TarInfo('fixture-1/LICENSE')
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
        checksum = builder.digest(archive_path)
        archive_path.rename(self.root / checksum)
        notices = builder.retain_notices(wheel, {'name': 'fixture', 'sha256': checksum,
            'url': 'https://example.org/fixture.tar.gz'}, self.root, self.root)
        self.assertEqual((self.root / notices[0]).read_bytes(), data)

    def test_inventory_permits_real_dependency_names_but_rejects_unsafe_segments(self):
        for name in ['setuptools/script (dev).tmpl', 'launcher manifest.xml', 'Lorem ipsum.txt']:
            self.assertTrue(builder.relative(name), name)
        for name in ['../outside', 'one/../two', ' trailing', 'trailing ', 'trailing.', 'CON', 'aux.txt', 'LPT1.exe', 'a\\b', 'a;command']:
            self.assertFalse(builder.relative(name), name)

    def test_build_environment_drops_ambient_compiler_and_python_overrides(self):
        with patch.dict('os.environ', {'CC': 'untrusted', 'CFLAGS': '-march=native', 'PYTHONPATH': '/private', 'UV_INDEX_URL': 'https://private.invalid'}):
            env = builder.build_environment(self.root, 1234)
        for key in ('CC', 'CFLAGS', 'PYTHONPATH', 'UV_INDEX_URL'):
            self.assertNotIn(key, env)
        self.assertEqual(env['SOURCE_DATE_EPOCH'], '1234')
        self.assertEqual(env['LC_ALL'], 'C')

    def test_native_toolchain_rejects_changed_compiler_bytes(self):
        compiler = self.root / 'compiler'
        compiler.write_bytes(b'locked compiler fixture')
        record = {'path': str(compiler), 'sha256': builder.digest(compiler), 'version': 'gcc fixture\n'}
        lock = {'schema': 1, 'kind': 'processing-native-toolchain', 'host': builder.host_target(),
                'tools': {name: dict(record) for name in ('cc', 'cxx', 'ld', 'as')}}
        path = self.root / 'toolchain.json'
        path.write_text(json.dumps(lock))
        with patch.object(builder.subprocess, 'check_output', return_value='gcc fixture\n'):
            self.assertEqual(builder.validate_native_toolchain(path), lock)
            compiler.write_bytes(b'changed compiler fixture')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                builder.validate_native_toolchain(path)


if __name__ == '__main__':
    unittest.main()
