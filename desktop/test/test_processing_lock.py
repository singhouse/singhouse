# SPDX-License-Identifier: AGPL-3.0-only
import importlib.util
import hashlib
import io
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('lock_processing', Path(__file__).parents[1] / 'build' / 'lock_processing.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def wheel(filename):
    return {'url': 'https://example.org/' + filename, 'hashes': {'sha256': 'a' * 64}}


class ProcessingLockTests(unittest.TestCase):
    def test_streamed_cache_verifies_size_and_hash_and_reuses_complete_bytes(self):
        content = b'x' * (1024 * 1024 + 7)
        record = {'url': 'https://example.org/locked.whl', 'size': len(content),
                  'sha256': hashlib.sha256(content).hexdigest()}
        requested = []
        class Response(io.BytesIO):
            def read(self, size=-1):
                requested.append(size)
                return super().read(size)
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            output = MODULE.cached_artifact(record, cache, opener=lambda *a, **kw: Response(content))
            self.assertEqual(output.read_bytes(), content)
            self.assertLessEqual(max(requested), 1024 * 1024)
            self.assertEqual(MODULE.cached_artifact(record, cache, opener=lambda *a, **kw: self.fail('network on verified cache')), output)

    def test_stream_overflow_truncation_and_wrong_hash_never_activate(self):
        record = {'url': 'https://example.org/locked.whl', 'size': 3,
                  'sha256': hashlib.sha256(b'abc').hexdigest()}
        for data in [b'abcd', b'ab', b'xyz']:
            with self.subTest(data=data), tempfile.TemporaryDirectory() as directory:
                cache = Path(directory)
                with self.assertRaisesRegex(ValueError, 'locked size|size/hash'):
                    MODULE.cached_artifact(record, cache, opener=lambda *a, **kw: io.BytesIO(data))
                self.assertEqual(list(cache.iterdir()), [])

    def test_other_targets_select_native_wheels_without_host_tag_leakage(self):
        filenames = {
            'linux-arm64': 'sample-1.0-cp312-cp312-manylinux_2_28_aarch64.whl',
            'darwin-arm64': 'sample-1.0-cp312-cp312-macosx_11_0_arm64.whl',
            'win32-x64': 'sample-1.0-cp312-cp312-win_amd64.whl',
        }
        package = {'name': 'sample', 'version': '1.0', 'wheels': [wheel(name) for name in filenames.values()]}
        for target, expected in filenames.items():
            with self.subTest(target=target):
                self.assertTrue(MODULE.artifact(package, MODULE.target_tags('3.12.14', 39, target))['url'].endswith(expected))

    def test_target_selection_handles_abi3_and_rejects_other_platforms(self):
        package = {'name': 'sample', 'version': '1.0', 'wheels': [
            wheel('sample-1.0-cp313-cp313-manylinux_2_28_x86_64.whl'),
            wheel('sample-1.0-cp312-cp312-manylinux_2_40_x86_64.whl'),
            wheel('sample-1.0-cp312-cp312-macosx_11_0_arm64.whl'),
            wheel('sample-1.0-cp311-abi3-manylinux_2_28_x86_64.whl'),
            wheel('sample-1.0-py3-none-any.whl'),
        ]}
        chosen = MODULE.artifact(package, MODULE.target_tags('3.12.14', 39))
        self.assertIn('cp311-abi3-manylinux_2_28_x86_64', chosen['url'])

    def test_missing_target_uses_only_locked_source_and_requires_hash(self):
        package = {'name': 'sample', 'version': '1.0', 'wheels': [wheel('sample-1.0-cp313-cp313-win_amd64.whl')]}
        with self.assertRaisesRegex(ValueError, 'No compatible'):
            MODULE.artifact(package, MODULE.target_tags('3.12.14', 39))
        package['sdist'] = wheel('sample-1.0.tar.gz')
        self.assertTrue(MODULE.artifact(package, MODULE.target_tags('3.12.14', 39))['url'].endswith('.tar.gz'))
        package['sdist']['hashes'] = {}
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            MODULE.artifact(package, MODULE.target_tags('3.12.14', 39))

    def test_target_markers_are_independent_of_build_host(self):
        text = '''lock-version = "1.0"
[[packages]]
name = "windows-only"
version = "1"
marker = "sys_platform == 'win32'"
[[packages]]
name = "linux-only"
version = "1"
marker = "python_version == '3.12' and sys_platform == 'linux'"
wheels = [{url="https://example.org/linux_only-1-py3-none-any.whl",hashes={sha256="HASH"}}]
'''.replace('HASH', 'a' * 64)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'pylock.toml'
            path.write_text(text)
            output = MODULE.generate(path, metadata=lambda _: {'license': 'MIT'})
            self.assertEqual([p['name'] for p in output['packages']], ['linux-only'])
            self.assertEqual(output['capabilities'], ['transcription', 'separation'])
            self.assertEqual(output, MODULE.generate(path, metadata=lambda _: {'license': 'MIT'}))
            with self.assertRaisesRegex(ValueError, 'target/accelerator'):
                MODULE.generate(path, target='linux-x64', accelerator='metal')

    def test_noncommercial_quantizers_are_explicitly_excluded_on_every_target(self):
        text = '''lock-version = "1.0"
requires-python = ">=3.12"
[[packages]]
name = "diffq"
version = "0.2.4"
wheels = [{url="https://example.org/diffq-0.2.4-py3-none-any.whl",hashes={sha256="HASH"}}]
[[packages]]
name = "diffq-fixed"
version = "0.2.4"
marker = "sys_platform == 'win32'"
wheels = [{url="https://example.org/diffq_fixed-0.2.4-py3-none-any.whl",hashes={sha256="HASH"}}]
[[packages]]
name = "separation"
version = "1"
wheels = [{url="https://example.org/separation-1-py3-none-any.whl",hashes={sha256="HASH"}}]
'''.replace('HASH', 'a' * 64)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'pylock.toml'
            path.write_text(text)
            for target in ('linux-x64', 'win32-x64'):
                with self.subTest(target=target):
                    output = MODULE.generate(path, target=target, metadata=lambda _: {'license': 'MIT'})
                    self.assertEqual([package['name'] for package in output['packages']], ['separation'])
                    self.assertEqual(output['excludedPackages'], MODULE.EXCLUDED_PACKAGES)


if __name__ == '__main__':
    unittest.main()
