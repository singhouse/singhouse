# SPDX-License-Identifier: AGPL-3.0-only
import json
import subprocess

import pytest

from karaoke_backend.workers import processing_resources as resources
from karaoke_backend.workers.managed_processing import InvalidAttestation


@pytest.fixture
def resource_policy(monkeypatch):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Linux')
    value = {'schema': 1, 'runtimeManifestId': 'runtime', 'variantId': 'cpu-original',
             'requirements': {'ramBytes': 100, 'vramBytes': None, 'unifiedMemory': False, 'workingDiskBytes': 50},
             'settings': {}}
    def save():
        monkeypatch.setenv('KARAOKE_DESKTOP_RESOURCE_POLICY_JSON', json.dumps(value))
    save()
    return value, save


def check(**kwargs):
    resources.enforce_resources({'runtimeManifestId': 'runtime', 'accelerator': 'cpu'},
                                ram_probe=kwargs.get('ram_probe', lambda: 100),
                                disk_probe=kwargs.get('disk_probe', lambda: 50))


def test_absent_policy_preserves_legacy(monkeypatch):
    monkeypatch.delenv('KARAOKE_DESKTOP_RESOURCE_POLICY_JSON', raising=False)
    check(ram_probe=lambda: pytest.fail('legacy should not probe'))


def test_fresh_ram_every_execution_and_recovery(resource_policy):
    samples = iter([100, 99, 100])
    probe = lambda: next(samples)
    check(ram_probe=probe)
    with pytest.raises(InvalidAttestation, match='system memory.*below.*Review local setup'):
        check(ram_probe=probe)
    check(ram_probe=probe)


@pytest.mark.parametrize('observed', [None, -1, True, 1.5])
def test_unknown_memory_fails_closed(resource_policy, observed):
    with pytest.raises(InvalidAttestation, match='could not be measured'):
        check(ram_probe=lambda: observed)


def test_low_disk_blocks(resource_policy):
    with pytest.raises(InvalidAttestation, match='storage.*below'):
        check(disk_probe=lambda: 49)


@pytest.mark.parametrize('mutation', [
    lambda p: p.update(runtimeManifestId='other'),
    lambda p: p.update(settings={'precision': 'int8'}),
    lambda p: p.update(settings=[]),
    lambda p: p['requirements'].update(ramBytes=True),
    lambda p: p['requirements'].update(unifiedMemory=True),
    lambda p: p['requirements'].update(vramBytes=100),
])
def test_policy_binding_and_unsupported_settings(resource_policy, mutation):
    policy, save = resource_policy
    mutation(policy)
    save()
    with pytest.raises(InvalidAttestation):
        check()


def test_cuda_requires_current_free_dedicated_memory(resource_policy):
    policy, save = resource_policy
    policy['requirements']['vramBytes'] = 100
    save()
    for free in (None, 99):
        with pytest.raises(InvalidAttestation, match='CUDA memory'):
            resources.enforce_resources({'runtimeManifestId': 'runtime', 'accelerator': 'cuda'},
                                        ram_probe=lambda: 100, disk_probe=lambda: 50, vram_probe=lambda: free)
    resources.enforce_resources({'runtimeManifestId': 'runtime', 'accelerator': 'cuda'},
                                ram_probe=lambda: 100, disk_probe=lambda: 50, vram_probe=lambda: 100)


def test_nvidia_probe_rejects_ambiguous_devices_and_timeout(monkeypatch):
    for output in ('100\n200\n', 'N/A\n', ''):
        monkeypatch.setattr(resources, '_run', lambda args: output)
        assert resources.available_vram() is None
    monkeypatch.setattr(resources, '_run', lambda args: '100\n')
    assert resources.available_vram() == 100 * 1024 * 1024
    def timeout(args):
        raise subprocess.TimeoutExpired(args, 2)
    monkeypatch.setattr(resources, '_run', timeout)
    assert resources.available_vram() is None


def test_accelerator_device_enforces_resources_after_runtime_validation(monkeypatch):
    from karaoke_backend.workers import managed_processing
    runtime = {'runtimeManifestId': 'runtime', 'accelerator': 'cpu', 'pythonPath': '/verified/python',
               'capabilitiesReady': True, 'verifiedCapabilities': ['separation']}
    monkeypatch.setattr(managed_processing, 'validated_attestation', lambda: runtime)
    monkeypatch.setattr(managed_processing, 'model_set_ready', lambda capability, value: True)
    monkeypatch.setenv('KARAOKE_PROCESSING_ACCELERATOR', 'cpu')
    monkeypatch.setenv('KARAOKE_PROCESSING_PYTHON', '/verified/python')
    calls = []
    def refuse(value):
        calls.append(value)
        raise InvalidAttestation('Close other applications and retry')
    monkeypatch.setattr(resources, 'enforce_resources', refuse)
    with pytest.raises(InvalidAttestation, match='Close other applications'):
        managed_processing.accelerator_device(capability='separation')
    assert calls == [runtime]


def test_cuda_probe_uses_os_driver_path_with_managed_audio_only_path(monkeypatch):
    monkeypatch.setenv('PATH', '/app/native/ffmpeg/bin')
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Linux')
    calls = []
    def run(command):
        calls.append(command)
        return '2048\n'
    monkeypatch.setattr(resources, '_run', run)
    assert resources.available_vram() == 2048 * 1024 * 1024
    assert calls == [['/usr/bin/nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits']]


def test_windows_cuda_probe_uses_system_directory(monkeypatch):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    # Posix absolute fixture works on any CI host; Windows supplies an absolute
    # drive path through SYSTEMROOT on the actual target.
    monkeypatch.setenv('SYSTEMROOT', '/windows')
    calls = []
    monkeypatch.setattr(resources, '_run', lambda command: calls.append(command) or '1024\n')
    assert resources.available_vram() == 1024 * 1024 * 1024
    assert str(calls[0][0]).replace('\\', '/') == '/windows/System32/nvidia-smi.exe'
