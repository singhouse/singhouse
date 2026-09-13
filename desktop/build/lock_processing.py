# SPDX-License-Identifier: AGPL-3.0-only
"""Select exact processing artifacts from an already resolved, target-specific pylock.

Requires Python 3.11+ and packaging. This does not resolve dependencies, download
models, or qualify a runtime. License metadata comes from version-scoped PyPI;
the pack builder must also retain actual upstream license/notice files.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import re
import tomllib
import tarfile
from urllib.parse import quote, unquote, urlparse
from urllib.request import urlopen
import zipfile

from packaging.markers import Marker
from packaging.specifiers import SpecifierSet
from packaging.tags import compatible_tags, cpython_tags, mac_platforms
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version


TARGETS = {'linux-x64': ('Linux', 'linux', 'x86_64', {'cpu', 'cuda'}),
           'linux-arm64': ('Linux', 'linux', 'aarch64', {'cpu'}),
           'darwin-arm64': ('Darwin', 'darwin', 'arm64', {'cpu', 'metal'}),
           'win32-x64': ('Windows', 'win32', 'AMD64', {'cpu', 'cuda'})}


def target_tags(python_version, glibc_minor, target='linux-x64'):
    if target.startswith('linux-'):
        arch = TARGETS[target][2]
        minimum = 5 if arch == 'x86_64' else 17
        platforms = [f'manylinux_2_{minor}_{arch}' for minor in range(glibc_minor, minimum - 1, -1)]
        platforms += [f'manylinux2014_{arch}']
        if arch == 'x86_64':
            platforms += ['manylinux2010_x86_64', 'manylinux1_x86_64']
        platforms += [f'linux_{arch}']
    elif target == 'darwin-arm64':
        platforms = list(mac_platforms((14, 0), arch='arm64'))
    elif target == 'win32-x64':
        platforms = ['win_amd64']
    else:
        raise ValueError(f'Unsupported processing target: {target}')
    version = tuple(map(int, python_version.split('.')[:2]))
    interpreter = f'cp{version[0]}{version[1]}'
    tags = [*cpython_tags(version, abis=[interpreter], platforms=platforms),
            *compatible_tags(version, interpreter=interpreter, platforms=platforms)]
    return {tag: index for index, tag in reversed(list(enumerate(tags)))}


def artifact(package, ranks):
    candidates = []
    for wheel in package.get('wheels', []):
        filename = unquote(Path(urlparse(wheel['url']).path).name)
        name, version, _, tags = parse_wheel_filename(filename)
        if canonicalize_name(package['name']) != name or Version(package['version']) != version:
            raise ValueError(f'Wheel identity differs from package: {filename}')
        scores = [ranks[tag] for tag in tags if tag in ranks]
        if scores:
            candidates.append((min(scores), wheel['url'], wheel))
    selected = min(candidates, key=lambda item: item[:2])[2] if candidates else package.get('sdist')
    if not selected:
        raise ValueError(f'No compatible wheel or locked source archive: {package["name"]}')
    url, digest = selected['url'], selected.get('hashes', {}).get('sha256', '')
    if urlparse(url).scheme != 'https' or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError(f'Artifact needs HTTPS and exact SHA-256: {package["name"]}')
    return {'url': url, 'sha256': digest}


def license_metadata(package):
    version = Version(package['version'])
    # PyTorch publishes accelerator-local wheels itself; PyPI carries the
    # corresponding public release's metadata, not a different artifact pin.
    if version.local:
        if package['name'] not in {'torch', 'torchaudio', 'torchvision'}:
            raise ValueError('Local versions need explicit upstream license provenance')
        metadata_version = version.public
    else:
        metadata_version = package['version']
    url = f'https://pypi.org/pypi/{quote(package["name"], safe="")}/{quote(metadata_version, safe="")}/json'
    with urlopen(url, timeout=60) as response:
        raw = response.read()
    info = json.loads(raw)['info']
    if canonicalize_name(info['name']) != canonicalize_name(package['name']) or Version(info['version']) != Version(metadata_version):
        raise ValueError('PyPI metadata identity mismatch')
    classifiers = sorted(value for value in info.get('classifiers', []) if value.startswith('License ::') and value != 'License :: OSI Approved')
    license_text = info.get('license_expression') or '; '.join(classifiers) or info.get('license')
    if not isinstance(license_text, str) or not license_text.strip() or license_text.strip().upper() == 'UNKNOWN':
        # Some projects publish license files without populating the PyPI
        # metadata fields. Preserve their actual text, without guessing SPDX.
        with urlopen(package['url'], timeout=60) as response:
            artifact_bytes = response.read(16 * 1024 * 1024 + 1)
        if len(artifact_bytes) > 16 * 1024 * 1024 or hashlib.sha256(artifact_bytes).hexdigest() != package['sha256']:
            raise ValueError(f'License artifact exceeds bound or hash mismatch: {package["name"]}')
        stream = io.BytesIO(artifact_bytes)
        if zipfile.is_zipfile(stream):
            with zipfile.ZipFile(stream) as archive:
                notices = [(name, archive.read(name)) for name in sorted(archive.namelist())
                           if re.match(r'(?i)^(license|licence|copying)([._-]|$)', Path(name).name) and not name.endswith('/')]
        else:
            with tarfile.open(fileobj=stream) as archive:
                notices = [(member.name, archive.extractfile(member).read()) for member in sorted(archive.getmembers(), key=lambda member: member.name)
                           if member.isfile() and re.match(r'(?i)^(license|licence|copying)([._-]|$)', Path(member.name).name)]
        if not notices:
            raise ValueError(f'No declared license or license file: {package["name"]}=={package["version"]}')
        license_text = '\n\n'.join(f'{name}\n{text.decode("utf-8")}' for name, text in notices)
        url = package['url']
    return {'license': license_text.strip(), 'licenseSource': url}


def generate(path, python_version='3.12.14', glibc_minor=39, metadata=license_metadata,
             target='linux-x64', accelerator='cpu'):
    raw = path.read_bytes()
    lock = tomllib.loads(raw.decode())
    if lock.get('lock-version') != '1.0':
        raise ValueError('Expected pylock version 1.0')
    if not SpecifierSet(lock.get('requires-python', '')).contains(python_version):
        raise ValueError('Target Python does not satisfy the resolved lock')
    if target not in TARGETS or accelerator not in TARGETS[target][3]:
        raise ValueError('Unsupported target/accelerator combination')
    system, sys_platform, machine, _ = TARGETS[target]
    ranks = target_tags(python_version, glibc_minor, target)
    marker_env = {'implementation_name': 'cpython', 'implementation_version': python_version,
                  'os_name': 'nt' if sys_platform == 'win32' else 'posix', 'platform_machine': machine, 'platform_release': '',
                  'platform_system': system, 'platform_version': '',
                  'platform_python_implementation': 'CPython', 'python_full_version': python_version,
                  'python_version': '.'.join(python_version.split('.')[:2]), 'sys_platform': sys_platform, 'extra': ''}
    packages = []
    seen = set()
    for package in sorted(lock['packages'], key=lambda item: item['name']):
        if package.get('marker') and not Marker(package['marker']).evaluate(marker_env):
            continue
        name = canonicalize_name(package['name'])
        if name in seen or name in {'karaoke-backend', 'lyricsync'}:
            raise ValueError(f'Duplicate or application package in dependency lock: {name}')
        seen.add(name)
        if name in {'torch', 'torchaudio', 'torchvision'}:
            local_version = Version(package['version']).local or ''
            if (accelerator == 'cuda' and local_version == 'cpu') or (accelerator != 'cuda' and local_version.startswith('cu')):
                raise ValueError('Locked PyTorch wheel accelerator does not match requested pack')
        packages.append({'name': name, 'version': package['version'], **artifact(package, ranks)})
    with ThreadPoolExecutor(max_workers=8) as executor:
        licenses = list(executor.map(metadata, packages))
    for package, license_info in zip(packages, licenses):
        package.update(license_info)
    return {'schema': 1, 'kind': 'processing-requirements', 'target': target, 'accelerator': accelerator,
            'pythonVersion': python_version,
            **({'glibcMinimum': f'2.{glibc_minor}'} if target.startswith('linux-') else {}),
            **({'macosMinimum': '14.0'} if target == 'darwin-arm64' else {}),
            'resolutionSha256': hashlib.sha256(raw).hexdigest(),
            'capabilities': ['transcription'], 'models': ['heart-transcriptor'],
            'modelCapabilities': {'heart-transcriptor': 'transcription'}, 'packages': packages}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pylock', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--python-version', default='3.12.14')
    parser.add_argument('--glibc-minor', type=int, default=39)
    parser.add_argument('--target', choices=sorted(TARGETS), default='linux-x64')
    parser.add_argument('--accelerator', choices=['cpu', 'cuda', 'metal'], default='cpu')
    args = parser.parse_args()
    result = generate(args.pylock, args.python_version, args.glibc_minor,
                      target=args.target, accelerator=args.accelerator)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(args.output)


if __name__ == '__main__':
    main()
