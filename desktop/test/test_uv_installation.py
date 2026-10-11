# SPDX-License-Identifier: AGPL-3.0-only
"""Native installer integration with tiny wheels; never a processing qualification.

Prefetch the locked native artifacts separately, then set
UV_INSTALLER_TEST_ASSETS to run without network. No model weights are used.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'desktop/build'))
from assemble import unpack_uv
from processing_recipe import install_baseline


def target():
    machine = platform.machine().lower()
    return f"{sys.platform}-{'arm64' if machine in {'arm64', 'aarch64'} else 'x64'}"


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prefetch(directory):
    directory.mkdir(parents=True, exist_ok=True)
    lock = json.loads((ROOT / 'desktop/locks/native.json').read_text())['targets'][target()]
    for name in ('python', 'uv'):
        record, destination = lock[name], directory / f'{name}.archive'
        if destination.is_file() and digest(destination) == record['sha256']:
            continue
        temporary = destination.with_suffix('.partial')
        with urllib.request.urlopen(record['url'], timeout=120) as source, temporary.open('wb') as output:
            shutil.copyfileobj(source, output)
        if digest(temporary) != record['sha256']:
            temporary.unlink()
            raise ValueError(f'Pinned {name} artifact hash mismatch')
        temporary.replace(destination)


@unittest.skipUnless(os.environ.get('UV_INSTALLER_TEST_ASSETS'), 'requires separately prefetched pinned uv/Python archives')
class NativeInstallerTests(unittest.TestCase):
    def test_native_install_reproducibility_and_recovery(self):
        assets = Path(os.environ['UV_INSTALLER_TEST_ASSETS']).resolve()
        native = json.loads((ROOT / 'desktop/locks/native.json').read_text())
        inputs = native['targets'][target()]
        for name in ('python', 'uv'):
            self.assertEqual(digest(assets / f'{name}.archive'), inputs[name]['sha256'])
        with tempfile.TemporaryDirectory(prefix='singhouse-uv-native-') as temporary:
            root = Path(temporary).resolve()
            uv = root / ('uv.exe' if sys.platform == 'win32' else 'uv')
            unpack_uv(assets / 'uv.archive', inputs['uv'], uv)
            wheel = root / 'fixture_113-1.0-py3-none-any.whl'
            with zipfile.ZipFile(wheel, 'w') as archive:
                entries = {
                    'fixture_113.py': 'VALUE = 113\n',
                    'fixture_113-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: fixture-113\nVersion: 1.0\nLicense: MIT\n',
                    'fixture_113-1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
                }
                for name, text in entries.items():
                    archive.writestr(name, text)
                record = 'fixture_113-1.0.dist-info/RECORD'
                archive.writestr(record, ''.join(f'{name},,\n' for name in [*entries, record]))
            payload = root / 'payload'
            notice = payload / 'notices/fixture-113/000.txt'
            notice.parent.mkdir(parents=True)
            notice.write_text('MIT fixture notice\n')
            inventories = []
            for name in ('baseline-one', 'baseline-two-with-a-longer-path'):
                work = root / (name + '-work')
                work.mkdir()
                env = {key: value for key, value in os.environ.items() if key.upper() in {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'}}
                env.update(PATH=str(uv.parent), UV_NO_CONFIG='1', UV_PYTHON_DOWNLOADS='never',
                           UV_CACHE_DIR=str(work / 'uv-cache'), PYTHONDONTWRITEBYTECODE='1')
                inventories.append(install_baseline(root / name, assets / 'python.archive', uv,
                                    [(wheel, dict(name='fixture-113', version='1.0'))], payload, work, env, target()))
            self.assertEqual(inventories[0], inventories[1], 'Only pyvenv.cfg roots may differ between equivalent installations')
            shutil.copyfile(assets / 'python.archive', root / 'runtime-python.archive')
            config = dict(root=str(root), uv=str(uv), pythonArchive=str(root / 'runtime-python.archive'),
                          wheel=str(wheel), notice=str(notice), files=inventories[0],
                          uvVersion=native['uvVersion'], pythonVersion=native['pythonVersion'],
                          nativeLockSha256=digest(ROOT / 'desktop/locks/native.json'), ffmpegRelease=native['ffmpegRelease'],
                          lockPython=sys.executable, target=target())
            config_path = root / 'config.json'
            config_path.write_text(json.dumps(config))
            subprocess.run(['node', str(ROOT / 'desktop/test/uv-installation.mjs'), str(config_path)], check=True, cwd=ROOT)
            evidence = json.loads((root / 'evidence.json').read_text())
            self.assertEqual(evidence['qualification'], 'native-installer-fixture-only')
            output = os.environ.get('UV_INSTALLER_TEST_EVIDENCE')
            if output:
                Path(output).write_text(json.dumps(evidence, indent=2) + '\n')


if __name__ == '__main__':
    if '--verify-installed' in sys.argv:
        parser = argparse.ArgumentParser()
        parser.add_argument('--verify-installed', nargs=4, metavar=('DIRECTORY', 'ID', 'STORE', 'TRUSTED_LOCK'))
        directory, identifier, store, trusted_lock = parser.parse_args().verify_installed
        spec = importlib.util.spec_from_file_location('desktop_backend', ROOT / 'desktop/backend.py')
        backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(backend)
        directory, store = Path(directory), Path(store)
        if os.name == 'nt':
            directory, store = backend._windows_extended_path(directory), backend._windows_extended_path(store)
        verified = backend.verify_processing_recipe(directory, identifier, store, [trusted_lock])
        print(json.dumps(dict(backendAdmission=True, files=len(verified['files']))))
    elif '--prefetch' in sys.argv:
        parser = argparse.ArgumentParser()
        parser.add_argument('--prefetch', type=Path, required=True)
        prefetch(parser.parse_args().prefetch)
    else:
        unittest.main()
