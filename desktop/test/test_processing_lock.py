# SPDX-License-Identifier: AGPL-3.0-only
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('lock_processing', Path(__file__).parents[1] / 'build' / 'lock_processing.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def wheel(filename):
    return {'url': 'https://example.org/' + filename, 'hashes': {'sha256': 'a' * 64}}


class ProcessingLockTests(unittest.TestCase):
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
            self.assertEqual(output['capabilities'], ['transcription'])
            self.assertEqual(output, MODULE.generate(path, metadata=lambda _: {'license': 'MIT'}))
            with self.assertRaisesRegex(ValueError, 'target/accelerator'):
                MODULE.generate(path, target='linux-x64', accelerator='metal')


if __name__ == '__main__':
    unittest.main()
