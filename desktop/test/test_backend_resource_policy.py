# SPDX-License-Identifier: AGPL-3.0-only
"""Private acceptance admission retains resource limits without qualification claims."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('desktop_resource_backend', Path(__file__).parents[1] / 'backend.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class CandidateResourceAdmissionTests(unittest.TestCase):
    def fixture(self, platform='linux', arch='x64', accelerator='cpu'):
        manifest = {'platform': platform, 'arch': arch, 'accelerator': accelerator,
                    'provenance': {'lockSha256': 'a' * 64}}
        variant = {'id': 'acceptance-candidate', 'status': 'candidate', 'settings': {},
                   'platform': platform, 'arch': arch, 'accelerator': accelerator,
                   'admission': {'runtimeLockSha256': 'a' * 64,
                                 'reference': 'Private installer acceptance envelope',
                                 'basisReferences': ['Existing resource evidence'],
                                 'ramBytes': 100, 'vramBytes': 50 if accelerator == 'cuda' else None,
                                 'workingDiskBytes': 200, 'downloadBytes': 300, 'installedBytes': 400,
                                 'unifiedMemory': platform == 'darwin' and arch == 'arm64'}}
        return manifest, {'schema': 1, 'variants': [variant]}

    def admit(self, manifest, policy, channel='private-test'):
        return backend.processing_resource_policy(manifest, 'b' * 64, 'acceptance-candidate', policy, channel)

    def test_direct_budgets_retain_strict_worker_contract_for_each_target(self):
        for target in [('linux', 'x64', 'cpu'), ('win32', 'x64', 'cuda'), ('darwin', 'arm64', 'metal')]:
            with self.subTest(target=target):
                manifest, policy = self.fixture(*target)
                result = self.admit(manifest, policy)
                self.assertEqual(set(result), {'schema', 'runtimeManifestId', 'variantId', 'requirements', 'settings'})
                self.assertEqual(result['runtimeManifestId'], 'b' * 64)
                self.assertEqual(result['requirements'], {'ramBytes': 100,
                                 'vramBytes': 50 if target[2] == 'cuda' else None,
                                 'workingDiskBytes': 200, 'unifiedMemory': target[0] == 'darwin'})
                self.assertEqual(result['settings'], {})
                self.assertNotIn('evidence', policy['variants'][0])

    def test_candidate_never_admitted_in_public_channels_even_with_forged_qualification(self):
        for channel in ('', None, 'stable', 'beta', 'private-test-forged'):
            manifest, policy = self.fixture()
            with self.subTest(channel=channel), self.assertRaises(RuntimeError):
                self.admit(manifest, policy, channel)
            policy['variants'][0]['evidence'] = {'scope': 'full', 'runtimeLockSha256': 'a' * 64,
                    'pipeline': {'separation': True, 'transcription': True, 'alignment': True},
                    'qualityComparison': 'forged', 'headroomFraction': 0,
                    'peakRamBytes': 100, 'workingDiskBytes': 200, 'unifiedMemory': False}
            with self.subTest(forged_channel=channel), self.assertRaises(RuntimeError):
                self.admit(manifest, policy, channel)

    def test_exact_lock_target_settings_and_candidate_identity_required(self):
        mutations = [lambda v: v.update(platform='win32'), lambda v: v.update(arch='arm64'),
                     lambda v: v.update(accelerator='cuda'), lambda v: v.update(settings={'batch': 1}),
                     lambda v: v.update(status='pending'), lambda v: v.update(id='other'),
                     lambda v: v['admission'].update(runtimeLockSha256='c' * 64),
                     lambda v: v.update(evidence={})]
        for mutate in mutations:
            manifest, policy = self.fixture()
            mutate(policy['variants'][0])
            with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                self.admit(manifest, policy)
        manifest, policy = self.fixture()
        policy['variants'].append(policy['variants'][0].copy())
        with self.assertRaises(RuntimeError):
            self.admit(manifest, policy)

    def test_every_budget_and_reference_must_be_complete(self):
        for key in ('ramBytes', 'workingDiskBytes', 'downloadBytes', 'installedBytes'):
            for value in (None, 0, -1, True, 1.5, 2**53, '100'):
                manifest, policy = self.fixture()
                policy['variants'][0]['admission'][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                    self.admit(manifest, policy)
        for change in ({'reference': ''}, {'reference': '  '}, {'basisReferences': []},
                       {'basisReferences': [' ']}, {'basisReferences': ['same', 'same']},
                       {'basisReferences': [1]}, {'headroomFraction': 0}, {'unifiedMemory': True}):
            manifest, policy = self.fixture()
            policy['variants'][0]['admission'].update(change)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.admit(manifest, policy)
        manifest, policy = self.fixture()
        del policy['variants'][0]['admission']['installedBytes']
        with self.assertRaises(RuntimeError):
            self.admit(manifest, policy)

    def test_memory_architecture_and_cuda_budget_are_mandatory(self):
        for target, value in [(('linux', 'x64', 'cpu'), 50), (('win32', 'x64', 'cuda'), None),
                              (('win32', 'x64', 'cuda'), True), (('win32', 'x64', 'cuda'), 0),
                              (('win32', 'x64', 'cuda'), 2**53)]:
            manifest, policy = self.fixture(*target)
            policy['variants'][0]['admission']['vramBytes'] = value
            with self.subTest(target=target, value=value), self.assertRaises(RuntimeError):
                self.admit(manifest, policy)
        manifest, policy = self.fixture('darwin', 'arm64', 'metal')
        policy['variants'][0]['admission']['unifiedMemory'] = False
        with self.assertRaises(RuntimeError):
            self.admit(manifest, policy)

    def test_malformed_policy_or_admission_is_rejected(self):
        manifest, _ = self.fixture()
        for policy in (None, [], {'schema': True, 'variants': []}, {'schema': 1, 'variants': None},
                       {'schema': 1, 'variants': [None]}):
            with self.subTest(policy=policy), self.assertRaises(RuntimeError):
                self.admit(manifest, policy)
        for admission in (None, [], {}, 'forged'):
            manifest, policy = self.fixture()
            policy['variants'][0]['admission'] = admission
            with self.subTest(admission=admission), self.assertRaises(RuntimeError):
                self.admit(manifest, policy)

    def test_native_channel_is_owned_by_bundled_release_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release = root / 'release.json'
            native = root / 'backend'
            for channel in ('stable', 'beta', 'private-test'):
                release.write_text(json.dumps({'schema': 1, 'channel': channel}))
                self.assertEqual(backend.native_release_channel(native), channel)
                self.assertEqual(backend.native_release_channel(native, channel), channel)
                with self.assertRaises(RuntimeError):
                    backend.native_release_channel(native, 'forged')
                if channel != 'private-test':
                    with self.assertRaises(RuntimeError):
                        backend.native_release_channel(native, 'private-test')

    def test_candidate_worker_rechecks_all_capacity_on_each_job(self):
        # The backend worker suite supplies these dependencies in its isolated environment.
        from karaoke_backend.workers import processing_resources as resources
        from karaoke_backend.workers.managed_processing import InvalidAttestation
        manifest, policy = self.fixture('win32', 'x64', 'cuda')
        emitted = self.admit(manifest, policy)
        runtime = {'runtimeManifestId': 'b' * 64, 'accelerator': 'cuda'}
        with patch.dict(os.environ, {'KARAOKE_DESKTOP_RESOURCE_POLICY_JSON': json.dumps(emitted)}), \
                patch.object(resources.platform, 'system', return_value='Windows'):
            def check(ram=100, disk=200, vram=50):
                resources.enforce_resources(runtime, ram_probe=lambda: ram,
                                            disk_probe=lambda: disk, vram_probe=lambda: vram)
            check()
            for capacities in ({'ram': 99}, {'disk': 199}, {'vram': 49}, {'ram': None}, {'vram': None}):
                with self.subTest(capacities=capacities), self.assertRaises(InvalidAttestation):
                    check(**capacities)
            check()

    def test_candidate_physical_memory_floor_is_preserved_and_checked_separately(self):
        from karaoke_backend.workers import processing_resources as resources
        from karaoke_backend.workers.managed_processing import InvalidAttestation
        gib = 1024**3
        manifest, policy = self.fixture('darwin', 'arm64', 'metal')
        admission = policy['variants'][0]['admission']
        admission.update(ramBytes=4*gib, totalRamBytes=16*gib)
        emitted = self.admit(manifest, policy)
        self.assertEqual(emitted['requirements']['totalRamBytes'], 16*gib)
        runtime = {'runtimeManifestId': 'b' * 64, 'accelerator': 'metal'}
        with patch.dict(os.environ, {'KARAOKE_DESKTOP_RESOURCE_POLICY_JSON': json.dumps(emitted)}), \
                patch.object(resources.platform, 'system', return_value='Darwin'), \
                patch.object(resources.platform, 'machine', return_value='arm64'):
            def check(total=16*gib, available=5*gib):
                resources.enforce_resources(runtime, ram_probe=lambda: available, disk_probe=lambda: 200,
                                            total_ram_probe=lambda: total)
            check()
            with self.assertRaisesRegex(InvalidAttestation, 'physical system memory.*below'):
                check(total=8*gib)
            with self.assertRaisesRegex(InvalidAttestation, 'system memory.*below'):
                check(available=3*gib)
            check()
        for total in (None, 0, -1, True, 3*gib, 2**53):
            admission['totalRamBytes'] = total
            with self.subTest(total=total), self.assertRaises(RuntimeError):
                self.admit(manifest, policy)


if __name__ == '__main__':
    unittest.main()
