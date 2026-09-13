# SPDX-License-Identifier: AGPL-3.0-only
"""Build a processing pack exclusively from exact, hash-locked artifacts.

Run on the target runner for native source wheels. This builds infrastructure;
model weights are never included and hardware/model qualification is separate.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
from email.parser import BytesParser
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
from urllib.parse import unquote, urlparse
import zipfile

from assemble import (ROOT, LOCKS, PLATFORMS, digest, fetch, host_target,
                      python_path, site_packages, run, metadata, source_provenance)
from assemble_processing import assemble, relative

MODULES = {
    'transcription': ['faster_whisper', 'lyricsync.transcription.heart', 'karaoke_backend.workers.heart_transcriptor'],
    'separation': ['demucs.separate', 'audio_separator.separator'],
}


def normalized(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def materialize_links(root):
    """Copy internal file/directory aliases, rejecting escapes and cycles."""
    root = root.resolve()
    while True:
        links = sorted(p for p in root.rglob('*') if p.is_symlink())
        if not links:
            return
        for link in links:
            target = link.resolve(strict=True)
            if not target.is_relative_to(root) or target.is_dir():
                # Directory links are unnecessary for standalone Python and can
                # recursively alias parents; do not silently expand them.
                raise ValueError(f'Unsafe or directory payload symlink: {link}')
            temporary = link.with_name(link.name + '.materializing')
            shutil.copy2(target, temporary)
            link.unlink()
            temporary.replace(link)


def inventory(root, target=None):
    result = []
    names = set()
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Payload contains a symlink')
        if not path.is_file():
            continue
        name = path.relative_to(root).as_posix()
        identity = name if (target or host_target()).startswith('linux-') else name.lower()
        if not relative(name) or identity in names:
            raise ValueError(f'Unsafe or duplicate payload path: {name}')
        names.add(identity)
        result.append(dict(path=name, size=path.stat().st_size, sha256=digest(path),
                           executable=bool(path.stat().st_mode & 0o111)))
    return result


def wheel_metadata(artifact):
    with zipfile.ZipFile(artifact) as wheel:
        # Vendored dependencies can carry their own nested dist-info trees
        # (setuptools does). Only the wheel's top-level metadata identifies
        # the installed distribution; nested licenses are retained separately.
        names = [n for n in wheel.namelist() if n.count('/') == 1 and n.endswith('.dist-info/METADATA')]
        if len(names) != 1:
            raise ValueError(f'Wheel {artifact.name} must contain exactly one top-level package metadata record; found {len(names)}')
        return BytesParser().parsebytes(wheel.read(names[0]))


def normalize_installer_metadata(destination, records):
    """Remove temporary paths and bind RECORD to normalized installed bytes."""
    sources = {normalized(record['name']): record for _, record in records}
    for directory in destination.glob('*.dist-info'):
        info = BytesParser().parsebytes((directory / 'METADATA').read_bytes())
        record = sources[normalized(info['Name'])]
        direct = directory / 'direct_url.json'
        direct.write_text(json.dumps({'url': record['url'], 'archive_info': {
            'hashes': {'sha256': record['sha256']}}}, sort_keys=True) + '\n')
        installed_record = directory / 'RECORD'
        with installed_record.open(newline='') as stream:
            rows = list(csv.reader(stream))
        paths = {row[0] for row in rows}
        paths.add(direct.relative_to(destination).as_posix())
        with installed_record.open('w', newline='') as stream:
            writer = csv.writer(stream, lineterminator='\n')
            for name in sorted(paths):
                path = destination / name
                if path == installed_record:
                    writer.writerow([name, '', ''])
                elif path.is_file():
                    encoded = base64.urlsafe_b64encode(bytes.fromhex(digest(path))).rstrip(b'=').decode()
                    writer.writerow([name, 'sha256=' + encoded, path.stat().st_size])


def retain_notices(artifact, record, payload, cache):
    name = normalized(record['name'])
    directory = payload / 'notices' / name
    directory.mkdir(parents=True)
    retained = []
    contents = set()

    def retain(data):
        checksum = hashlib.sha256(data).hexdigest()
        if checksum in contents:
            return
        contents.add(checksum)
        output = directory / f'{len(retained):03d}.txt'
        output.write_bytes(data)
        retained.append(output.relative_to(payload).as_posix())

    with zipfile.ZipFile(artifact) as wheel:
        for member in sorted(wheel.namelist()):
            base = Path(member).name
            if member.endswith('/') or not re.match(r'(?i)(license|licence|copying|notice|authors)', base):
                continue
            # Numbered names avoid wheel paths with spaces or case collisions.
            retain(wheel.read(member))
    # Some source builders omit upstream notices from their wheel. Retain
    # those directly from the same hash-locked source archive, without
    # extracting arbitrary archive members or substituting another release.
    original = cache / record.get('sha256', 'missing')
    if original.is_file() and not record.get('url', '').endswith('.whl'):
        if digest(original) != record['sha256']:
            raise ValueError('Cached source notice artifact checksum mismatch')
        if tarfile.is_tarfile(original):
            with tarfile.open(original) as archive:
                for member in sorted(archive.getmembers(), key=lambda entry: entry.name):
                    if member.isfile() and re.match(r'(?i)(license|licence|copying|notice|authors)', Path(member.name).name):
                        with archive.extractfile(member) as stream:
                            retain(stream.read())
        elif zipfile.is_zipfile(original):
            with zipfile.ZipFile(original) as archive:
                for member in sorted(archive.namelist()):
                    if not member.endswith('/') and re.match(r'(?i)(license|licence|copying|notice|authors)', Path(member).name):
                        retain(archive.read(member))
    for notice in record.get('notices', []):
        source = fetch(notice, cache)
        retain(source.read_bytes())
    if not retained or any((payload / p).stat().st_size == 0 for p in retained):
        raise ValueError(f'Package needs nonempty locked notices: {name}')
    return retained


def validate_requirements(lock, target, accelerator):
    if (lock.get('schema') != 1 or lock.get('kind') != 'processing-requirements'
            or lock.get('target') != target or lock.get('accelerator') != accelerator):
        raise ValueError('Requirements lock does not match target and accelerator')
    packages = lock.get('packages')
    if not isinstance(packages, list) or not packages:
        raise ValueError('An exact dependency artifact inventory is required')
    names = set()
    for record in packages:
        name = normalized(record.get('name', ''))
        filename = record.get('filename') or unquote(Path(urlparse(record.get('url', '')).path).name)
        if (not name or name in names or not record.get('version')
                or urlparse(record.get('url', '')).scheme != 'https'
                or not re.fullmatch('[0-9a-f]{64}', record.get('sha256', ''))
                or not relative(filename) or '/' in filename
                or not filename.endswith(('.whl', '.tar.gz', '.zip'))):
            raise ValueError('Invalid or duplicate locked dependency artifact')
        if name in {'karaoke-backend', 'lyricsync'}:
            raise ValueError('Application packages must come from the source tree')
        names.add(name)
    capabilities = lock.get('capabilities')
    if not capabilities or len(set(capabilities)) != len(capabilities) or not set(capabilities) <= set(MODULES):
        raise ValueError('Unsupported capability inventory')


def validate_native_toolchain(path):
    if path is None:
        return None
    lock = json.loads(path.read_text())
    if (lock.get('schema') != 1 or lock.get('kind') != 'processing-native-toolchain'
            or lock.get('host') != host_target() or set(lock.get('tools', {})) != {'cc', 'cxx', 'ld', 'as'}):
        raise ValueError('Native toolchain lock must identify this host and cc/cxx/ld/as')
    for name, record in lock['tools'].items():
        executable = Path(record['path'])
        if not executable.is_absolute() or digest(executable) != record.get('sha256'):
            raise ValueError(f'Native toolchain digest mismatch: {name}')
        version_args = record.get('versionArgs', ['--version'])
        if version_args not in (['--version'], ['-v']):
            raise ValueError('Unsupported native tool version arguments')
        version = subprocess.check_output([str(executable), *version_args], text=True,
                                          stderr=subprocess.STDOUT)
        if version != record.get('version'):
            raise ValueError(f'Native toolchain version mismatch: {name}')
        if name in {'cc', 'cxx'} and not any(marker in version.lower() for marker in ('gcc', 'clang', 'g++')):
            raise ValueError('Native source builds currently require GCC or Clang prefix-map support')
    for record in lock.get('inputs', []):
        path = Path(record['path'])
        if not path.is_absolute() or digest(path) != record.get('sha256'):
            raise ValueError('Native toolchain supporting input digest mismatch')
    return lock


def build_environment(cache, epoch):
    # Do not inherit CC/CFLAGS/PYTHONPATH, compiler search overrides, or uv
    # configuration from the invoking shell. Build inputs are explicit locks.
    allowed = ('HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'SSL_CERT_FILE',
               'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY')
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(PATH=os.pathsep.join([str(Path(shutil.which('uv')).parent), os.defpath]),
               UV_CACHE_DIR=str(cache / 'uv'), UV_PYTHON_DOWNLOADS='never', UV_NO_CONFIG='true',
               SOURCE_DATE_EPOCH=str(epoch), PYTHONHASHSEED='0', PYTHONDONTWRITEBYTECODE='1',
               LC_ALL='C', TZ='UTC')
    return env


def build_wheel(source, destination, host_python, env, toolchain=None):
    destination.mkdir()
    if source.is_file():
        unpacked = destination / 'source'
        unpacked.mkdir()
        if zipfile.is_zipfile(source):
            with zipfile.ZipFile(source) as archive:
                for member in archive.infolist():
                    target = (unpacked / member.filename).resolve()
                    if not target.is_relative_to(unpacked.resolve()):
                        raise ValueError('Unsafe source ZIP member')
                archive.extractall(unpacked)
        else:
            with tarfile.open(source) as archive:
                archive.extractall(unpacked, filter='data')
        roots = list(unpacked.iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            raise ValueError('Source archive must contain one package root')
        source = roots[0]
    build_env = dict(env)
    if toolchain is not None:
        mappings = [f'{flag}={path}=/build/{name}' for path, name in
                            ((source.resolve(), 'source'), (host_python.parents[2], 'toolchain'))
                            for flag in ('-ffile-prefix-map', '-fdebug-prefix-map')]
        cc, cxx = (toolchain['tools'][name]['path'] for name in ('cc', 'cxx'))
        build_env.update(CC=shlex.quote(cc), CXX=shlex.quote(cxx), LD=shlex.quote(toolchain['tools']['ld']['path']),
                         AS=shlex.quote(toolchain['tools']['as']['path']), CFLAGS=shlex.join(['-O2', '-g0', *mappings]),
                         CXXFLAGS=shlex.join(['-O2', '-g0', *mappings]), LDFLAGS='',
                         LDSHARED=shlex.join([cc, *(['-bundle', '-undefined', 'dynamic_lookup'] if toolchain['host'] == 'darwin-arm64' else ['-shared'])]))
    run('uv', 'build', '--wheel', '--no-build-isolation', '--no-sources', '--offline',
        '--python', host_python, '--out-dir', destination, source, env=build_env)
    wheels = list(destination.glob('*.whl'))
    if len(wheels) != 1:
        raise ValueError('Each source must build exactly one wheel')
    if not wheels[0].name.endswith('-none-any.whl') and toolchain is None:
        raise ValueError('Native source wheels require --native-toolchain with verified compiler identity')
    return wheels[0]


def build(requirements, target, accelerator, output, cache, build_requirements=None, native_toolchain=None):
    lock = json.loads(requirements.read_text())
    validate_requirements(lock, target, accelerator)
    toolchain = validate_native_toolchain(native_toolchain)
    native = json.loads((LOCKS / 'native.json').read_text())
    if subprocess.check_output(['uv', '--version'], text=True).split()[1] != native['uvVersion']:
        raise ValueError(f"Build requires uv {native['uvVersion']}")
    source = source_provenance()
    if source['sourceDirty']:
        raise ValueError('Processing artifacts require a clean committed source tree')
    if output.exists():
        raise ValueError('Output exists; choose a fresh directory')
    output = output.resolve()
    cache = cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True)
    payload = output / 'payload'
    payload.mkdir()
    epoch = subprocess.check_output(['git', 'show', '-s', '--format=%ct', source['sourceCommit']], cwd=ROOT, text=True).strip()
    env = build_environment(cache, epoch)
    if target == 'darwin-arm64':
        env['MACOSX_DEPLOYMENT_TARGET'] = '14.0'
    python_record = native['targets'][target]['python']
    with tarfile.open(fetch(python_record, cache), 'r:gz') as archive:
        archive.extractall(payload, filter='data')
    # Standalone archives seed pip; the processing environment's complete
    # dependency set comes only from its own artifact lock.
    seeded_site = site_packages(payload, target, native['pythonVersion'])
    if seeded_site.exists():
        shutil.rmtree(seeded_site)
    seeded_site.mkdir(parents=True)
    for script in python_path(payload, target).parent.glob('pip*'):
        if script.is_file():
            script.unlink()
    packages = []
    with tempfile.TemporaryDirectory(prefix='processing-build-', dir=cache) as temporary:
        work = Path(temporary)
        host_input = native['targets'][host_target()]['python']
        with tarfile.open(fetch(host_input, cache), 'r:gz') as archive:
            archive.extractall(work, filter='data')
        host_python = python_path(work, host_target())
        run('uv', 'pip', 'install', '--python', host_python, '--require-hashes',
            '--no-deps', '--only-binary', ':all:', '-r', LOCKS / 'build.txt', env=env)
        if build_requirements is not None:
            run('uv', 'pip', 'install', '--python', host_python, '--require-hashes',
                '--no-deps', '--only-binary', ':all:', '-r', build_requirements, env=env)
        wheels = []
        records = []
        for index, record in enumerate(lock['packages']):
            filename = record.get('filename') or unquote(Path(urlparse(record['url']).path).name)
            artifact = work / filename
            shutil.copyfile(fetch(record, cache), artifact)
            wheel = artifact if filename.endswith('.whl') else build_wheel(artifact, work / f'built-{index}', host_python, env, toolchain)
            if not filename.endswith('.whl') and not wheel.name.endswith('-none-any.whl') and target != host_target():
                raise ValueError('Native source wheels must be built on the target runner')
            info = wheel_metadata(wheel)
            if normalized(info['Name']) != normalized(record['name']) or info['Version'] != record['version']:
                raise ValueError('Built wheel metadata differs from dependency lock')
            wheels.append(wheel)
            records.append((wheel, record))
        for name in ('backend', 'lyricsync'):
            wheel = build_wheel(ROOT / name, work / f'app-{name}', host_python, env)
            if not wheel.name.endswith('-none-any.whl'):
                raise ValueError('Application wheels must be pure Python')
            with zipfile.ZipFile(wheel) as archive:
                if any('/remote_runtime/' in n or n.endswith('/workers/remote.py') for n in archive.namelist()):
                    raise ValueError('Application wheel contains excluded compute dispatcher')
            info = wheel_metadata(wheel)
            record = dict(name=info['Name'], version=info['Version'], sha256=digest(wheel),
                          url=f"https://github.com/singhouse/singhouse/tree/{source['sourceCommit']}/{name}",
                          license=info.get('License-Expression') or ('MIT' if name == 'lyricsync' else 'AGPL-3.0-only'))
            wheels.append(wheel)
            records.append((wheel, record))
        destination = site_packages(payload, target, native['pythonVersion'])
        run('uv', 'pip', 'install', '--python', host_python, '--target', destination,
            '--python-platform', PLATFORMS[target], '--python-version', native['pythonVersion'],
            '--no-deps', '--offline', '--link-mode', 'copy', *wheels, env=env)
        # Workers invoke modules through the managed Python. Generated console
        # scripts contain host interpreter paths (including Windows launchers)
        # and must never silently select a system interpreter after relocation.
        for name in ('bin', 'Scripts'):
            scripts = destination / name
            if scripts.exists():
                shutil.rmtree(scripts)
        normalize_installer_metadata(destination, records)
        for wheel, record in records:
            info = wheel_metadata(wheel)
            license_name = record.get('license') or info.get('License-Expression') or info.get('License')
            if not license_name:
                raise ValueError(f"Missing license assertion: {record['name']}")
            packages.append(dict(name=record['name'], version=record['version'], license=license_name,
                                 sourceUrl=record['url'], sha256=record['sha256'], wheelSha256=digest(wheel),
                                 notices=retain_notices(wheel, record, payload, cache)))
    # CPython's upstream license is included in its locked standalone archive.
    python_notices = sorted(p.relative_to(payload).as_posix() for p in (payload / 'python').rglob('*')
                            if p.is_file() and p.name.startswith(('LICENSE', 'COPYING')))
    if not python_notices:
        raise ValueError('Standalone Python must retain upstream notices')
    packages.append(dict(name='cpython', version=native['pythonVersion'], license='PSF-2.0',
                         sourceUrl=python_record['url'], sha256=python_record['sha256'], notices=python_notices))
    # Do not retain machine-specific installer bookkeeping or bytecode.
    for path in list(payload.rglob('*.pyc')):
        path.unlink()
    for path in list(payload.rglob('__pycache__')):
        if path.is_dir():
            shutil.rmtree(path)
    materialize_links(payload)
    installed = {normalized(k): v for k, v in metadata(site_packages(payload, target, native['pythonVersion'])).items()}
    expected = {normalized(p['name']): p['version'] for p in packages if p['name'] != 'cpython'}
    if installed != expected:
        raise ValueError('Installed dependency inventory differs from locked artifacts')
    if target == host_target():
        run('uv', 'pip', 'check', '--python', python_path(payload, target), env=env)
    provenance = dict(sourceCommit=source['sourceCommit'], sourceDateEpoch=epoch,
                      requirements=lock, requirementsSha256=digest(requirements),
                      nativeLockSha256=digest(LOCKS / 'native.json'), buildLockSha256=digest(LOCKS / 'build.txt'),
                      uvVersion=native['uvVersion'], buildHost=host_target(),
                      consoleEntrypoints='Removed; invoke modules through the managed Python')
    if build_requirements is not None:
        provenance['processingBuildRequirements'] = build_requirements.read_text()
        provenance['processingBuildRequirementsSha256'] = digest(build_requirements)
    if native_toolchain is not None:
        provenance['nativeToolchain'] = toolchain
        provenance['nativeToolchainSha256'] = digest(native_toolchain)
        provenance['nativeBuildReproducibility'] = 'Compiler and supporting input identity for same-host reconstruction; this is not a hermetic cross-host toolchain claim'
    (payload / 'build-provenance.json').write_text(json.dumps(provenance, indent=2, sort_keys=True) + '\n')
    input_lock = dict(schema=1, kind='processing-input',
                      appVersion=json.loads((ROOT / 'desktop/package.json').read_text())['version'],
                      backendVersion=installed['karaoke-backend'], lyricsyncVersion=installed['lyricsync'],
                      pythonVersion=native['pythonVersion'], platform=target.split('-')[0], arch=target.split('-')[1],
                      accelerator=accelerator, python=python_path(payload, target).relative_to(payload).as_posix(),
                      sourceCommit=source['sourceCommit'], packages=packages,
                      capabilities=lock['capabilities'], models=lock['models'], modelCapabilities=lock['modelCapabilities'],
                      probe=dict(schema=2, type='python-functional-v1', modules=sorted({m for c in lock['capabilities'] for m in MODULES[c]})),
                      files=inventory(payload, target))
    lock_path = output / 'processing-input.json'
    lock_path.write_text(json.dumps(input_lock, indent=2, sort_keys=True) + '\n')
    manifest = assemble(payload, lock_path, output / 'pack')
    print(json.dumps(dict(manifest=str(output / 'pack/manifest.json'), lockSha256=digest(lock_path),
                          packages=len(packages)), indent=2))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--requirements', type=Path, required=True)
    parser.add_argument('--target', choices=sorted(PLATFORMS), required=True)
    parser.add_argument('--accelerator', choices=['cpu', 'cuda', 'metal'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--build-requirements', type=Path, help='Additional exact hash-locked host build wheels (no dependency resolution)')
    parser.add_argument('--native-toolchain', type=Path, help='Exact host compiler executable/version and supporting input identity lock')
    args = parser.parse_args()
    build(args.requirements, args.target, args.accelerator, args.output, args.cache, args.build_requirements, args.native_toolchain)


if __name__ == '__main__':
    main()
