# SPDX-License-Identifier: AGPL-3.0-only
"""Independent worker-admission checks for release-pinned uv installations."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('desktop_backend', Path(__file__).parents[1] / 'backend.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


class RecipeAdmissionTests(unittest.TestCase):
    def fixture(self, root, directory_alias=False, extra_path=None, write_extra=True):
        body = {'schema': 2, 'kind': 'processing', 'platform': 'linux',
                'python': 'env/bin/python', 'recipe': {'files': [
                    {'path': 'env/bin/python', 'size': 6, 'sha256': digest(b'python'), 'executable': True},
                    {'path': 'env/pyvenv.cfg', 'size': len(b'home = @SINGHOUSE_RUNTIME_ROOT@/python/bin\n'),
                     'sha256': digest(b'home = @SINGHOUSE_RUNTIME_ROOT@/python/bin\n'),
                     'kind': 'uv-path-text', 'executable': False}]}}
        if extra_path is not None:
            body['recipe']['files'].append(dict(path=extra_path, size=4, sha256=digest(b'data'), executable=False))
        if directory_alias:
            body['recipe']['files'].append({'path': 'env/lib64', 'target': 'bin'})
        lock = {**body, 'schema': 2, 'kind': 'processing-input', 'sourceCommit': 'a' * 40, 'packages': []}
        lock_text = encoded(lock).decode()
        lock_id = digest(lock_text.encode())
        manifest = {**body, 'provenance': {'inputLock': lock_text, 'lockSha256': lock_id,
                                         'sourceCommit': 'a' * 40, 'packages': []}}
        recipe_id = digest(encoded(manifest))
        nonce = 'b' * 32
        instance = digest(encoded({'recipeId': recipe_id, 'nonce': nonce}))
        directory = root / 'envs' / instance[:16]
        (directory / 'env/bin').mkdir(parents=True)
        if directory_alias:
            (directory / 'env/lib64').symlink_to('bin', target_is_directory=True)
        if extra_path is not None and write_extra:
            (directory / extra_path).parent.mkdir(parents=True, exist_ok=True)
            (directory / extra_path).write_bytes(b'data')
            (directory / extra_path).chmod(0o600)
        (directory / 'env/bin/python').write_bytes(b'python')
        (directory / 'env/bin/python').chmod(0o700)
        (directory / 'env/pyvenv.cfg').write_text(f'home = {directory}/python/bin\n')
        (directory / 'env/pyvenv.cfg').chmod(0o600)
        (directory / 'manifest.json').write_bytes(encoded(manifest))
        receipt = {'schema': 1, 'kind': 'processing-installation', 'id': instance,
                   'recipeId': recipe_id, 'nonce': nonce, 'directory': str(directory)}
        (directory / 'receipt.json').write_bytes(encoded(receipt))
        return directory, instance, [lock_id]

    def test_upstream_wheel_names_and_unsafe_inventory_paths(self):
        for name in ['env/lib/Transparent Busy.ani', 'env/lib/script (dev).tmpl']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                directory, identifier, locks = self.fixture(root, extra_path=name)
                self.assertEqual(len(backend.verify_processing_recipe(directory, identifier, root, locks)['files']), 3)
        for name in ['', '/absolute', '../escape', 'a/../b', 'a\\b', 'a/ leading', 'a/trailing ', 'a/end.', 'a/CON', 'a/aux.txt', 'a/line\nfeed', 'a/' + 'x' * 510]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                directory, identifier, locks = self.fixture(root, extra_path=name, write_extra=False)
                with self.assertRaisesRegex(RuntimeError, 'file path'):
                    backend.verify_processing_recipe(directory, identifier, root, locks)

    @unittest.skipIf(os.name == 'nt', 'native Windows fixture exercises target symlinks')
    def test_trusted_contained_directory_alias_is_not_recursively_inventoried(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary)
            directory, instance, locks = self.fixture(store, directory_alias=True)
            result = backend.verify_processing_recipe(directory, instance, store, locks)
            self.assertEqual(result['files'][-1], {'path': 'env/lib64', 'target': 'bin'})

    def test_verify_at_different_root_lengths_and_preserve_interpreter_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            for name in ['short', 'a much longer installation root']:
                store = Path(temporary) / name
                directory, instance, locks = self.fixture(store)
                result = backend.verify_processing_recipe(directory, instance, store, locks)
                self.assertEqual(result['files'][0]['sha256'], digest(b'python'))

    def test_modified_payload_cannot_be_authorized_by_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary)
            directory, instance, locks = self.fixture(store)
            (directory / 'env/bin/python').write_bytes(b'attack')
            receipt = json.loads((directory / 'receipt.json').read_text())
            receipt['files'] = [{'path': 'env/bin/python', 'sha256': digest(b'attack')}]
            (directory / 'receipt.json').write_bytes(encoded(receipt))
            with self.assertRaises(RuntimeError):
                backend.verify_processing_recipe(directory, instance, store, locks)
            del receipt['files']
            (directory / 'receipt.json').write_bytes(encoded(receipt))
            with self.assertRaisesRegex(RuntimeError, 'file verification'):
                backend.verify_processing_recipe(directory, instance, store, locks)

    def test_untrusted_recipe_and_additional_executable_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary)
            directory, instance, locks = self.fixture(store)
            with self.assertRaisesRegex(RuntimeError, 'not trusted'):
                backend.verify_processing_recipe(directory, instance, store, [])
            (directory / 'env/bin/unlisted').write_bytes(b'attack')
            with self.assertRaisesRegex(RuntimeError, 'inventory'):
                backend.verify_processing_recipe(directory, instance, store, locks)

    def test_moved_environment_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary) / 'old'
            directory, instance, locks = self.fixture(store)
            destination = Path(temporary) / 'new'
            store.rename(destination)
            with self.assertRaisesRegex(RuntimeError, 'stable path'):
                backend.verify_processing_recipe(destination / 'envs' / instance[:16], instance, destination, locks)

    def test_pre_normalized_configuration_cannot_impersonate_real_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary)
            directory, instance, locks = self.fixture(store)
            (directory / 'env/pyvenv.cfg').write_text('home = @SINGHOUSE_RUNTIME_ROOT@/python/bin\n')
            with self.assertRaisesRegex(RuntimeError, 'configuration'):
                backend.verify_processing_recipe(directory, instance, store, locks)


class ResourceAdmissionTests(unittest.TestCase):
    def fixture(self):
        manifest = {"platform": "linux", "arch": "x64", "accelerator": "cpu", "provenance": {"lockSha256": "a" * 64}}
        variant = {"id": "cpu-standard", "status": "qualified", "platform": "linux", "arch": "x64",
                   "accelerator": "cpu", "settings": {}, "evidence": {
                       "runtimeLockSha256": "a" * 64, "scope": "full", "headroomFraction": 0.5,
                       "pipeline": {"separation": True, "transcription": True, "alignment": True},
                       "qualityComparison": "fixture comparison", "peakRamBytes": 100, "workingDiskBytes": 200,
                       "unifiedMemory": False}}
        return manifest, {"schema": 1, "variants": [variant]}

    def test_qualified_limits_are_bound_to_runtime(self):
        manifest, policy = self.fixture()
        result = backend.processing_resource_policy(manifest, 'b' * 64, 'cpu-standard', policy)
        self.assertEqual(result['runtimeManifestId'], 'b' * 64)
        self.assertEqual(result['requirements'], {'ramBytes': 150, 'vramBytes': None,
                                                 'unifiedMemory': False, 'workingDiskBytes': 200})

    def test_stale_wrong_device_unqualified_or_unsupported_settings_fail_closed(self):
        for changes in [{'status': 'unqualified'}, {'accelerator': 'cuda'}, {'settings': {'batch': 1}}, {'arch': 'arm64'}]:
            manifest, policy = self.fixture()
            policy['variants'][0].update(changes)
            with self.assertRaises(RuntimeError):
                backend.processing_resource_policy(manifest, 'b' * 64, 'cpu-standard', policy)
        manifest, policy = self.fixture()
        policy['variants'][0]['evidence']['runtimeLockSha256'] = 'c' * 64
        with self.assertRaises(RuntimeError):
            backend.processing_resource_policy(manifest, 'b' * 64, 'cpu-standard', policy)

    def test_private_smoke_evidence_only_admitted_in_private_test_channel(self):
        manifest, policy = self.fixture()
        policy['variants'][0]['evidence']['scope'] = 'private-smoke'
        with self.assertRaises(RuntimeError):
            backend.processing_resource_policy(manifest, 'b' * 64, 'cpu-standard', policy)
        self.assertEqual(backend.processing_resource_policy(manifest, 'b' * 64, 'cpu-standard', policy,
                                                            'private-test')['variantId'], 'cpu-standard')


if __name__ == '__main__':
    unittest.main()
