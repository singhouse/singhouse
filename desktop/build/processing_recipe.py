# SPDX-License-Identifier: AGPL-3.0-only
"""Emit a small, hash-bound runtime recipe and only locally built artifacts.

Upstream wheels and standalone Python retain their original URLs. Source-only
packages are built by build_processing.py, never by the installed application.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
from urllib.parse import quote, urlparse


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def artifact(path, directory, base_url=None):
    """Keep the original wheel filename below its content-addressed directory."""
    if base_url is not None and (urlparse(base_url).scheme != 'https' or not base_url.endswith('/')
                                 or urlparse(base_url).query or urlparse(base_url).fragment):
        raise ValueError('Recipe artifact publication requires an HTTPS directory URL ending in /')
    checksum = digest(path)
    destination = directory / 'artifacts' / checksum / path.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, destination)
    relative = f'{checksum}/{quote(path.name)}'
    return dict(filename=path.name, url=base_url + relative if base_url else destination.resolve().as_uri(),
                size=path.stat().st_size, sha256=checksum)


def wheel_records(records, packages, payload, directory, base_url=None):
    """Export built wheels and notices, preserving original upstream wheel URLs."""
    result = []
    for (wheel, source), package in zip(records, packages, strict=True):
        wheel_hash = digest(wheel)
        if source['url'].endswith('.whl'):
            if wheel_hash != source['sha256']:
                raise ValueError('Upstream wheel changed while generating recipe')
            delivery = dict(filename=wheel.name, url=source['url'], size=wheel.stat().st_size, sha256=wheel_hash)
        else:
            delivery = artifact(wheel, directory, base_url)
        notices = [artifact(payload / name, directory, base_url) for name in package['notices']]
        result.append(dict(name=package['name'], version=package['version'], **delivery,
                           sourceUrl=source['url'], sourceSha256=source['sha256'],
                           license=package['license'], notices=notices))
    return result


def generate(input_lock, wheels, python_input, python_archive, uv_input, uv_version, directory, files):
    """Bind all executable inputs and model policy in the application allowlist ID."""
    if not re.fullmatch(r'[0-9a-f]{64}', uv_input.get('executableSha256', '')):
        raise ValueError('Recipe requires the pinned bundled uv executable digest')
    if not wheels or any(not wheel['filename'].endswith('.whl') for wheel in wheels):
        raise ValueError('Recipe installation accepts only prebuilt wheels')
    if digest(python_archive) != python_input['sha256']:
        raise ValueError('Python archive does not match native lock')
    win = input_lock['platform'] == 'win32'
    keys = ('appVersion', 'backendVersion', 'lyricsyncVersion', 'pythonVersion', 'platform', 'arch',
            'accelerator', 'capabilities', 'models', 'modelCapabilities', 'excludedPackages', 'probe')
    manifest = {key: input_lock[key] for key in keys}
    manifest.update(schema=2, kind='processing', python='env/Scripts/python.exe' if win else 'env/bin/python',
                    recipe=dict(schema=1,
                                nativeTools=dict(nativeLockSha256=input_lock['nativeLockSha256'],
                                                 ffmpegRelease=input_lock['ffmpegRelease']),
                                python=dict(version=input_lock['pythonVersion'], url=python_input['url'],
                                            size=python_archive.stat().st_size, sha256=python_input['sha256'],
                                            archive='tar.gz', member='python/python.exe' if win else 'python/bin/python3'),
                                uv=dict(version=uv_version, sha256=uv_input['executableSha256']),
                                wheels=wheels, files=files, installedSize=sum(record.get('size', 0) for record in files)))
    packages = [dict(package) for package in input_lock['packages']]
    for package in packages:
        if package['name'] == 'cpython':
            package['notices'] = sorted(record['path'] for record in files
                                        if record['path'].startswith('python/') and
                                        Path(record['path']).name.startswith(('LICENSE', 'COPYING')))
            if not package['notices']:
                raise ValueError('Standalone Python recipe must retain upstream notices')
    lock = dict(manifest, kind='processing-input', sourceCommit=input_lock['sourceCommit'], packages=packages)
    text = json.dumps(lock, indent=2, sort_keys=True) + '\n'
    manifest['provenance'] = dict(sourceCommit=input_lock['sourceCommit'], inputLock=text,
                                  lockSha256=hashlib.sha256(text.encode()).hexdigest(),
                                  packages=packages,
                                  qualification='UNTESTED: native installation and hardware qualification required')
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    (directory / 'processing-input.json').write_text(text)
    return manifest


def installed_inventory(root):
    """Only pyvenv.cfg may contain a normalized installation path."""
    import os
    files = []
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(root):
                raise ValueError('Installed symlink escapes runtime')
            destination = os.path.relpath(target, path.parent)
            path.unlink()
            path.symlink_to(destination, target_is_directory=target.is_dir())
            files.append(dict(path=relative, target=destination.replace(os.sep, '/')))
        elif path.is_file():
            data = path.read_bytes()
            record = dict(path=relative, executable=bool(path.stat().st_mode & 0o111))
            if relative == 'env/pyvenv.cfg':
                data = data.decode('utf-8').replace(str(root), '@SINGHOUSE_RUNTIME_ROOT@').encode('utf-8')
                record['kind'] = 'uv-path-text'
            record.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
            files.append(record)
    return files


def install_baseline(root, python_archive, uv, records, payload, work, env, target):
    """Build the same stable-layout environment the runtime installer creates."""
    import subprocess
    import tarfile
    root.mkdir()
    with tarfile.open(python_archive, 'r:gz') as archive:
        archive.extractall(root, filter='data')
    win = target.startswith('win32-')
    python = root / ('python/python.exe' if win else 'python/bin/python3')
    environment_python = root / ('env/Scripts/python.exe' if win else 'env/bin/python')
    wheels = work / 'recipe-wheels'
    wheels.mkdir()
    lines = []
    for wheel, record in records:
        shutil.copyfile(wheel, wheels / wheel.name)
        lines.append(f"{record['name']}=={record['version']} --hash=sha256:{digest(wheel)}")
    requirements = work / 'recipe-requirements.txt'
    requirements.write_text('\n'.join(lines) + '\n')
    def run(*args):
        subprocess.run([str(uv), *map(str, args)], env=env, check=True)
    run('venv', '--no-project', '--no-config', '--offline', '--no-python-downloads',
        '--python', python, '--prompt', 'singhouse', root / 'env')
    run('pip', 'install', '--no-config', '--offline', '--no-python-downloads', '--python', environment_python,
        '--no-index', '--find-links', wheels, '--no-deps', '--no-build', '--require-hashes', '--link-mode', 'clone',
        '--requirements', requirements)
    scripts = root / ('env/Scripts' if win else 'env/bin')
    for path in scripts.iterdir():
        if not re.fullmatch(r'python(?:\d+(?:\.\d+)?)?(?:w)?(?:\.exe)?', path.name):
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    for path in list((root / 'env').rglob('*')):
        if path.is_file() and (path.suffix == '.pyc' or
                              (path.parent.name.endswith('.dist-info') and path.name in {'RECORD', 'direct_url.json', 'uv_cache.json'})):
            path.unlink()
    for path in list((root / 'env').rglob('__pycache__')):
        if path.is_dir():
            shutil.rmtree(path)
    shutil.copytree(payload / 'notices', root / 'notices')
    # uv clone mode may fall back to hardlinks. Cache mutation must never alter
    # a qualified environment, including the builder's baseline instance.
    for path in root.rglob('*'):
        if path.is_file() and not path.is_symlink() and path.stat().st_nlink > 1:
            temporary = path.with_name(path.name + '.detaching')
            shutil.copyfile(path, temporary)
            shutil.copymode(path, temporary)
            temporary.replace(path)
    return installed_inventory(root)
