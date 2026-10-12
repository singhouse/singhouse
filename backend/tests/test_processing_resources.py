# SPDX-License-Identifier: AGPL-3.0-only
import json
import subprocess
import sys

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
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Linux')
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


def test_windows_cuda_probe_uses_system_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    system_root = tmp_path / 'windows'
    monkeypatch.setenv('SYSTEMROOT', str(system_root))
    calls = []
    monkeypatch.setattr(resources, '_windows_program_files', lambda: r'C:\Program Files')
    monkeypatch.setattr(resources, '_run', lambda command, **kwargs: calls.append(command) or '1024\n')
    assert resources.available_vram() == 1024 * 1024 * 1024
    assert calls[0][0] == str(system_root / 'System32' / 'nvidia-smi.exe')


def test_optional_physical_memory_is_rechecked_independently(resource_policy):
    policy, save = resource_policy
    policy['requirements']['totalRamBytes'] = 1600
    save()
    samples = iter([1600, 800, None, 1600])
    def execute():
        resources.enforce_resources({'runtimeManifestId': 'runtime', 'accelerator': 'cpu'},
                                    ram_probe=lambda: 100, disk_probe=lambda: 50,
                                    total_ram_probe=lambda: next(samples))
    execute()
    with pytest.raises(InvalidAttestation, match='physical system memory.*below'):
        execute()
    with pytest.raises(InvalidAttestation, match='physical system memory.*could not be measured'):
        execute()
    execute()
    with pytest.raises(InvalidAttestation, match='system memory.*below'):
        resources.enforce_resources({'runtimeManifestId': 'runtime', 'accelerator': 'cpu'},
                                    ram_probe=lambda: 99, disk_probe=lambda: 50,
                                    total_ram_probe=lambda: 1600)


@pytest.mark.parametrize('total', [None, 0, -1, True, 1.5, 99, 2**53, '1600'])
def test_invalid_physical_floor_rejected(resource_policy, total):
    policy, save = resource_policy
    policy['requirements']['totalRamBytes'] = total
    save()
    with pytest.raises(InvalidAttestation, match='physical memory requirement'):
        check()


def test_unknown_requirement_rejected_and_legacy_does_not_probe_physical_ram(resource_policy):
    policy, save = resource_policy
    resources.enforce_resources({'runtimeManifestId': 'runtime', 'accelerator': 'cpu'},
                                ram_probe=lambda: 100, disk_probe=lambda: 50,
                                total_ram_probe=lambda: pytest.fail('No physical floor was specified'))
    policy['requirements']['unknown'] = 100
    save()
    with pytest.raises(InvalidAttestation, match='incomplete'):
        check()


def test_darwin_physical_ram_probe_uses_bounded_fixed_command(monkeypatch):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Darwin')
    commands = []
    monkeypatch.setattr(resources, '_run', lambda command: commands.append(command) or '17179869184\n')
    assert resources.total_ram() == 16 * 1024**3
    assert commands == [['/usr/sbin/sysctl', '-n', 'hw.memsize']]
    for text in ('N/A', '-1', '0', '16 GB', '1\n2', str(2**53), '17179869184\nnoise'):
        monkeypatch.setattr(resources, '_run', lambda command: text)
        assert resources.total_ram() is None
    def timeout(command):
        raise subprocess.TimeoutExpired(command, 2)
    monkeypatch.setattr(resources, '_run', timeout)
    assert resources.total_ram() is None


def test_linux_physical_ram_probe_does_not_confuse_available_ram(monkeypatch):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(resources.Path, 'read_text', lambda self: 'MemTotal: 1600 kB\nMemAvailable: 500 kB\n')
    assert resources.total_ram() == 1600 * 1024
    assert resources.available_ram() == 500 * 1024


@pytest.mark.parametrize('text', [
    'MemTotal: 1600 kB\nMemTotal: 800 kB\n',
    'MemTotal: 1600 kB\nMemTotal: 1600 kB\n',
    'MemTotal: 1600 kB\nMemTotal: unknown kB\n',
    'MemTotal: 9007199254740992 kB\n',
    'MemTotal: 8796093022208 kB\n',
    'MemTotal: 0 kB\n', 'MemTotal: -1 kB\n', 'MemTotal: 1600 kB noise\n',
    'MemAvailable: 500 kB\n',
])
def test_linux_physical_ram_rejects_duplicate_malformed_and_overflow_fields(monkeypatch, text):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(resources.Path, 'read_text', lambda self: text)
    assert resources.total_ram() is None


def test_windows_memory_probes_use_distinct_status_fields(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(resources, '_windows_memory_status', lambda: SimpleNamespace(total=1600, available=500))
    assert resources.total_ram() == 1600
    assert resources.available_ram() == 500
    monkeypatch.setattr(resources, '_windows_memory_status', lambda: None)
    assert resources.total_ram() is None
    assert resources.available_ram() is None


@pytest.mark.parametrize('total', [0, -1, True, 1.5, '1600', 2**53, None])
def test_windows_physical_memory_rejects_invalid_status_field(monkeypatch, total):
    from types import SimpleNamespace
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(resources, '_windows_memory_status', lambda: SimpleNamespace(total=total))
    assert resources.total_ram() is None


@pytest.mark.parametrize('observed', [0, -1, True, 1.5, '1600', 2**53, None])
def test_physical_memory_callback_observation_fails_closed(resource_policy, observed):
    policy, save = resource_policy
    policy['requirements']['totalRamBytes'] = 1600
    save()
    with pytest.raises(InvalidAttestation, match='physical system memory.*could not be measured'):
        resources.enforce_resources({'runtimeManifestId': 'runtime', 'accelerator': 'cpu'},
                                    ram_probe=lambda: 100, disk_probe=lambda: 50,
                                    total_ram_probe=lambda: observed)


def known_folder_api(monkeypatch, *, path=r'C:\Program Files', result=0, null=False):
    """Emulate the Win64 API allocation while checking the real ctypes call shape."""
    import ctypes
    from types import SimpleNamespace
    import uuid

    allocation = ctypes.create_unicode_buffer(path)
    freed = []

    class Resolve:
        def __call__(self, folder, flags, token, output):
            assert ctypes.string_at(folder, 16) == uuid.UUID('905e63b6-c1bf-494e-b29c-65b732d3d21a').bytes_le
            assert flags == 0 and token is None
            assert self.restype is ctypes.c_int32
            assert len(self.argtypes) == 4
            assert self.argtypes[1:3] == [ctypes.c_uint32, ctypes.c_void_p]
            if not null:
                ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(allocation)
            return result

    class Free:
        def __call__(self, pointer):
            assert self.argtypes == [ctypes.c_void_p] and self.restype is None
            freed.append(pointer.value)

    shell = SimpleNamespace(SHGetKnownFolderPath=Resolve())
    ole = SimpleNamespace(CoTaskMemFree=Free())
    def load(name, **kwargs):
        assert kwargs == {'use_last_error': True}
        return {'shell32.dll': shell, 'ole32.dll': ole}[name]
    monkeypatch.setattr(ctypes, 'WinDLL', load, raising=False)
    return freed, ctypes.addressof(allocation)


@pytest.mark.parametrize('inherited', [
    {},
    {'ProgramFiles': r'Z:\hostile', 'ProgramW6432': r'Z:\hostile64',
     'PROGRAMFILES': r'Z:\duplicate', 'programw6432': r'Z:\duplicate64'},
])
def test_windows_cuda_probe_supplies_os_resolved_nvml_environment_only_to_child(monkeypatch, inherited, tmp_path):
    from types import SimpleNamespace
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    system_root = tmp_path / 'windows'
    original = {'SYSTEMROOT': str(system_root), 'PATH': '/app/native/audio', **inherited}
    monkeypatch.setattr(resources.os, 'environ', original)
    freed, address = known_folder_api(monkeypatch, path=r'D:\Installed Programs')
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        assert kwargs['env'] == {'SYSTEMROOT': str(system_root), 'PATH': '/app/native/audio',
                                 'ProgramFiles': r'D:\Installed Programs',
                                 'ProgramW6432': r'D:\Installed Programs'}
        assert kwargs['timeout'] == 2 and kwargs['shell'] is False and kwargs['check'] is True
        assert kwargs['capture_output'] is True and kwargs['text'] is True
        return SimpleNamespace(stdout='11264\n')
    monkeypatch.setattr(resources.subprocess, 'run', run)
    assert resources.available_vram() == 11264 * 1024**2
    assert calls == [[str(system_root / 'System32' / 'nvidia-smi.exe'), '--query-gpu=memory.free',
                      '--format=csv,noheader,nounits']]
    assert original == {'SYSTEMROOT': str(system_root), 'PATH': '/app/native/audio', **inherited}
    assert freed == [address]


@pytest.mark.parametrize(('path', 'result', 'null'), [
    (r'C:\Program Files', -2147467259, False),
    (r'C:\Program Files', -2147467259, True),
    (r'C:\Program Files', 0, True),
    ('relative', 0, False),
    (r'C:relative', 0, False),
    (r'\\server\share\Program Files', 0, False),
    ('', 0, False),
])
def test_windows_cuda_probe_fails_closed_and_frees_failed_known_folder_allocation(monkeypatch, path, result, null, tmp_path):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    monkeypatch.setenv('SYSTEMROOT', str(tmp_path / 'windows'))
    # Hostile variables must never provide a fallback when the OS lookup fails.
    monkeypatch.setenv('ProgramFiles', r'Z:\hostile')
    monkeypatch.setenv('ProgramW6432', r'Z:\hostile64')
    freed, address = known_folder_api(monkeypatch, path=path, result=result, null=null)
    monkeypatch.setattr(resources, '_run', lambda *args, **kwargs: pytest.fail('Unresolved probe must not run'))
    assert resources.available_vram() is None
    assert freed == ([] if null else [address])


@pytest.mark.parametrize('failure', [OSError('DLL unavailable'), AttributeError('API unavailable')])
def test_windows_cuda_probe_fails_closed_when_known_folder_api_unavailable(monkeypatch, failure):
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    def load(*args, **kwargs):
        raise failure
    monkeypatch.setattr(resources.ctypes, 'WinDLL', load, raising=False)
    monkeypatch.setattr(resources, '_run', lambda *args, **kwargs: pytest.fail('Unresolved probe must not run'))
    assert resources.available_vram() is None


@pytest.mark.skipif(sys.platform != 'win32', reason='Requires the native Windows known-folder API')
def test_native_windows_known_folder_resolves_in_minimal_environment(monkeypatch):
    system_root = resources.os.environ['SYSTEMROOT']
    for key in list(resources.os.environ):
        if key.upper() != 'SYSTEMROOT':
            monkeypatch.delenv(key)
    directory = resources._windows_program_files()
    assert resources.Path(directory).is_absolute()
    assert resources.Path(directory).is_dir()
    env = resources._windows_driver_environment()
    assert env == {'SYSTEMROOT': system_root, 'ProgramFiles': directory, 'ProgramW6432': directory}
    assert dict(resources.os.environ) == {'SYSTEMROOT': system_root}
