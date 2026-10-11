# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic admission tests, not functional processing or measured qualification."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('measurement_backend', Path(__file__).parents[1] / 'backend.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PrivateResourceMeasurementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.native = self.root / 'native'
        self.native.mkdir()
        (self.root / 'release.json').write_text(json.dumps({'schema': 1, 'channel': 'private-test'}))
        self.identity = dict(appVersion='1', backendVersion='1', lyricsyncVersion='1', platform=sys.platform, arch='x64')
        model_ids = ['heart-transcriptor', 'demucs-mdx-extra', 'karaoke-roformer']
        modules = sorted(['faster_whisper', 'lyricsync.transcription.heart', 'karaoke_backend.workers.heart_transcriptor',
                          'demucs.separate', 'audio_separator.separator'])
        payload = b'inert protocol interpreter'
        python = 'env/python.exe'
        record = dict(path=python, size=len(payload), sha256=sha(payload), executable=True)
        body = dict(schema=2, kind='processing', **self.identity, pythonVersion='3.12.14', accelerator='cpu', python=python,
                    capabilities=['transcription', 'separation'], models=model_ids,
                    modelCapabilities={name: 'transcription' if name == 'heart-transcriptor' else 'separation' for name in model_ids},
                    probe=dict(schema=2, type='python-functional-v1', modules=modules),
                    recipe=dict(files=[record], nativeTools=dict(nativeLockSha256='c' * 64, ffmpegRelease='fixture')))
        lock = {**body, 'kind': 'processing-input', 'sourceCommit': 'a' * 40, 'packages': []}
        raw_lock = encoded(lock).decode()
        self.lock_id = sha(raw_lock.encode())
        manifest = {**body, 'provenance': dict(inputLock=raw_lock, lockSha256=self.lock_id, sourceCommit='a' * 40, packages=[])}
        recipe_id = sha(encoded(manifest))
        nonce = 'b' * 32
        self.processing_id = sha(encoded(dict(recipeId=recipe_id, nonce=nonce)))
        self.processing = self.root / 'processing/envs' / self.processing_id[:16]
        (self.processing / 'env').mkdir(parents=True)
        (self.processing / python).write_bytes(payload)
        (self.processing / python).chmod(0o700)
        (self.processing / 'manifest.json').write_bytes(encoded(manifest))
        (self.processing / 'receipt.json').write_bytes(encoded(dict(schema=1, kind='processing-installation',
            id=self.processing_id, recipeId=recipe_id, nonce=nonce, directory=str(self.processing))))
        model_files = []
        policy_models = []
        for name in model_ids:
            path = f'{name}/weights.bin'
            contents = name.encode()
            checksum = sha(contents)
            item = dict(path=path, size=len(contents), sha256=checksum, executable=False,
                        revision=checksum, url=f'https://example.org/{checksum}/weights.bin')
            model_files.append(item)
            policy_models.append(dict(id=name, files=[item]))
        model_manifest = dict(schema=1, kind='models', models=model_ids, files=model_files)
        raw_models = encoded(model_manifest)
        self.models_id = sha(raw_models)
        self.models = self.root / 'model-cache/packs' / self.models_id
        for name in model_ids:
            path = self.models / name / 'weights.bin'
            path.parent.mkdir(parents=True)
            path.write_bytes(name.encode())
        (self.models / 'manifest.json').write_bytes(raw_models)
        self.policy = dict(schema=1, allowedHosts=['example.org'], models=policy_models)
        self.runtime = self.root / 'backend'
        python_path = self.processing / python
        if os.name == 'nt':
            python_path = backend._windows_extended_path(python_path)
        self.probe = dict(runtimeManifestId=self.processing_id, pythonPath=str(python_path), pythonSha256=sha(payload),
                          probePassed=True, accelerator='cpu', verifiedCapabilities=body['capabilities'], capabilitiesReady=True,
                          probeSchema=2, checks=dict(deviceTensor=True, nativeAudio=True, transcription=True, separation=True),
                          components={name: 'synthetic-protocol-fixture' for name in modules})

    def context(self, **changes):
        values = dict(native=self.native, root=None, demo=False, runtime=self.runtime, processing=self.processing,
                      models=self.models, probe=self.probe, processing_id=self.processing_id,
                      models_id=self.models_id, resource_variant=None)
        values.update(changes)
        return backend.validate_private_measurement_context(**values)

    def admit(self, **changes):
        values = dict(runtime=self.runtime, identity=self.identity, processing=self.processing, models=self.models,
                      probe=self.probe, model_policy=self.policy, trusted_locks=[self.lock_id],
                      processing_id=self.processing_id, models_id=self.models_id,
                      native_lock_sha256='c' * 64, release_channel='private-test',
                      hardware_policy=dict(schema=1, variants=[]), private_test_resource_measurement=True)
        values.update(changes)
        return backend.processing_environment(**values)

    def test_explicit_context_and_marker_never_claim_qualification(self):
        self.context()
        self.assertEqual(backend.private_measurement_marker(False), {})
        marker = backend.private_measurement_marker(True)['resourceMeasurement']
        self.assertEqual(marker, dict(mode='private-test', qualified=False, recommendationsEnabled=False))

    def test_normal_admission_remains_closed_without_qualified_variant(self):
        with self.assertRaisesRegex(RuntimeError, 'qualified processing option'):
            self.admit(private_test_resource_measurement=False)
        env = self.admit()
        self.assertNotIn('KARAOKE_DESKTOP_RESOURCE_POLICY_JSON', env)
        self.assertEqual(env['KARAOKE_PROCESSING_PYTHON'], self.probe['pythonPath'])
        self.assertTrue(json.loads(env['KARAOKE_DESKTOP_PROCESSING_JSON'])['capabilitiesReady'])

    def test_source_demo_missing_identity_and_variant_contexts_rejected(self):
        for changes in [dict(native=None), dict(root=self.root), dict(demo=True), dict(runtime=None),
                        dict(models=None), dict(processing=None), dict(probe=None), dict(processing_id='a' * 16),
                        dict(models_id=None), dict(resource_variant='cpu-standard')]:
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                self.context(**changes)
        (self.root / 'release.json').write_text(json.dumps({'schema': 1, 'channel': 'stable'}))
        with self.assertRaisesRegex(RuntimeError, 'private-test release'):
            self.context()

    def test_context_does_not_relax_inventory_native_lock_or_probe_checks(self):
        for changes in [dict(trusted_locks=[]), dict(native_lock_sha256='d' * 64),
                        dict(probe={**self.probe, 'pythonSha256': 'f' * 64}),
                        dict(probe={**self.probe, 'probePassed': False}), dict(release_channel='stable'),
                        dict(resource_variant='cpu-standard')]:
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                self.admit(**changes)
        (self.models / 'heart-transcriptor/weights.bin').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'verification'):
            self.admit()

    def test_runtime_tampering_is_not_admitted_in_measurement_mode(self):
        (self.processing / 'env/python.exe').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'verification'):
            self.admit()


if __name__ == '__main__':
    unittest.main()
