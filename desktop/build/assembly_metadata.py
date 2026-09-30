# SPDX-License-Identifier: AGPL-3.0-only
"""Normalize installation bookkeeping before the complete native inventory."""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
import zipfile

# ZIP's earliest representable timestamp; independent of checkout/build time.
WHEEL_EPOCH = 315532800


def truly_absent(path: Path) -> bool:
    """An omitted file must be absent, not hidden behind a filesystem link."""
    if path.is_symlink() or Path(os.path.abspath(path)) != path.resolve():
        raise ValueError(f"Linked omitted-bytecode path: {path}")
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    return False


def upstream_record_omissions(destination: Path) -> dict:
    """Snapshot stripped-bytecode rows immediately after verified Python unpack.

    This is not called on the installed application environment: later missing
    files never become admissible simply because they have a .pyc suffix.
    """
    omissions = {}
    for record in sorted(destination.glob('*.dist-info/RECORD')):
        original = record.read_bytes()
        rows = list(csv.reader(io.StringIO(original.decode())))
        listed = {row[0] for row in rows if len(row) == 3}
        missing = []
        for row in rows:
            if len(row) != 3:
                raise ValueError("Malformed upstream RECORD")
            name, checksum, size = row
            path = destination / name
            if path.exists():
                continue
            if not truly_absent(path):
                raise ValueError(f"Unexpected upstream RECORD file type: {name}")
            match = re.fullmatch(r'(.+)/__pycache__/([^/]+)\.cpython-[0-9]+(?:\.opt-[0-9]+)?\.pyc', name)
            source = f'{match[1]}/{match[2]}.py' if match else ''
            if (not match or checksum or size or '\\' in name or
                    any(part in ('', '.', '..') for part in name.split('/')) or
                    source not in listed or not (destination / source).is_file()):
                raise ValueError(f"Unexpected missing upstream RECORD file: {name}")
            missing.append(name)
        if missing:
            omissions[record.relative_to(destination).as_posix()] = {
                'recordSha256': hashlib.sha256(original).hexdigest(),
                'absentBytecode': sorted(missing),
            }
    return omissions


def relocatable_script(data: bytes, host_python: Path, relative_python: str) -> bytes:
    """Replace only a recognized uv Python launcher, preserving its Python body."""
    executable = str(host_python)
    headers = [("#!" + executable + "\n").encode()]
    for quoted in (shlex.quote(executable), '"' + executable.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$').replace('`', '\\`') + '"'):
        headers.append(("#!/bin/sh\n'''exec' " + quoted + ' "$0" "$@"\n' + "' '''\n").encode())
    header = next((prefix for prefix in headers if data.startswith(prefix)), None)
    if header is None:
        raise ValueError("Unrecognized installed Python launcher; refusing to rewrite it")
    # This is both a shell launcher and a Python triple-quoted string. Resolve
    # from the installed script, never PATH or the deleted build interpreter.
    prefix = ("#!/bin/sh\n'''exec' /bin/sh -c '"
              'case "$0" in */*) script_dir=${0%/*};; *) script_dir=.;; esac; '
              'script_dir=$(CDPATH= cd -- "$script_dir" && pwd) || exit 127; '
              'exec "$script_dir/' + relative_python + '" "$0" "$@"'
              "' \"$0\" \"$@\"\n' '''\n")
    return prefix.encode() + data[len(header):]


def normalize_installation(output: Path, destination: Path, host_python: Path,
                           target: str, artifacts: list[Path], upstream_omissions=None,
                           windows_launcher_base: Path | None = None) -> dict:
    """Plan/validate all edits, then update files and their owning RECORDs.

    Source commit and exact local-wheel hashes remain in provenance.json.
    """
    if target.startswith("win32-"):
        from windows_launcher import WindowsResourceAPI
        if target != "win32-x64" or windows_launcher_base is None:
            raise ValueError("Windows normalization requires the pinned x64 console base")
        WindowsResourceAPI()  # Fail before planning or applying installation edits.
    output = output.resolve()
    destination = destination.resolve()
    if target.startswith("win32-") and destination != output / "python/Lib/site-packages":
        raise ValueError("Unexpected Windows site-packages layout for relative launcher")
    changes: dict[Path, bytes | None] = {}
    local_origins = {}
    for artifact in artifacts:
        with zipfile.ZipFile(artifact) as archive:
            metadata = [name for name in archive.namelist()
                        if name.count('/') == 1 and name.endswith('.dist-info/METADATA')]
            if len(metadata) != 1:
                raise ValueError("Local wheel must have exactly one distribution metadata record")
            directory = metadata[0].split('/')[0]
        if directory in local_origins:
            raise ValueError("Duplicate local wheel distribution")
        local_origins[directory] = artifact.resolve().as_uri()

    def checked_path(name: str) -> Path:
        if not name or '\\' in name or Path(name).is_absolute():
            raise ValueError("Invalid installed RECORD path")
        path = destination / name
        resolved = path.resolve()
        if not resolved.is_relative_to(output) or path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing or escaping installed RECORD file: {name}")
        # A symlinked ancestor would make rewrites affect a different location.
        if Path(os.path.abspath(path)) != resolved:
            raise ValueError(f"Linked installed RECORD path: {name}")
        return resolved

    records = []
    owned = set()
    omitted = {}
    for directory in sorted(destination.glob('*.dist-info')):
        record = directory / 'RECORD'
        original = record.read_bytes()
        rows = list(csv.reader(io.StringIO(original.decode())))
        if any(len(row) != 3 for row in rows) or len({row[0] for row in rows}) != len(rows):
            raise ValueError("Malformed or duplicate installed RECORD entries")
        relative_record = record.relative_to(destination).as_posix()
        prior = (upstream_omissions or {}).get(relative_record)
        if prior:
            if hashlib.sha256(original).hexdigest() != prior['recordSha256']:
                raise ValueError("Upstream RECORD changed after bytecode-omission snapshot")
            removed = []
            kept = []
            for row in rows:
                if row[0] in prior['absentBytecode'] and truly_absent(destination / row[0]):
                    if row[1:] != ['', '']:
                        raise ValueError("Upstream omitted bytecode has unexpected integrity metadata")
                    removed.append(row[0])
                else:
                    kept.append(row)
            rows = kept
            omitted[relative_record] = {'recordSha256': prior['recordSha256'], 'absentBytecode': sorted(removed)}
        paths = [(row[0], checked_path(row[0])) for row in rows]
        if record.resolve() not in {path for _, path in paths}:
            raise ValueError("Installed RECORD must list itself")
        owned.update(path for _, path in paths)
        for name in ('uv_cache.json', 'direct_url.json'):
            path = directory / name
            if not path.exists():
                continue
            if path.resolve() not in {item for _, item in paths}:
                raise ValueError("Installer metadata is missing from RECORD")
            if name == 'direct_url.json':
                if directory.name not in local_origins:
                    continue  # Preserve all upstream origin metadata unchanged.
                if json.loads(path.read_text()).get('url') != local_origins[directory.name]:
                    raise ValueError("Local wheel origin does not match the installed artifact")
            changes[path.resolve()] = None
        records.append((record.resolve(), paths))

    windows_provenance = None
    if target.startswith('win32-'):
        from windows_launcher import (BASE_SHA256, UV_COMMIT, digest, expected_body,
                                      relocate_launcher)
        entries = {}
        # The helper publishes separate validated outputs; all installed files
        # remain untouched until every launcher and complete RECORD plan passes.
        with tempfile.TemporaryDirectory(prefix='normalized-launchers-') as temporary:
            for script in sorted((destination / 'bin').glob('*')):
                path = checked_path(script.relative_to(destination).as_posix())
                if path not in owned:
                    raise ValueError("Installed launcher is missing from RECORD")
                transformed = Path(temporary) / script.name
                details = relocate_launcher(site_packages=destination, name=script.name,
                                            installing_python=str(host_python),
                                            base_path=windows_launcher_base, output=transformed)
                changes[path] = transformed.read_bytes()
                # Original PE hashes include disposable interpreter paths. The
                # preserved callable body, pinned base and exact input wheels
                # provide stable source provenance instead of those temp bytes.
                entries[script.relative_to(destination).as_posix()] = {
                    key: details[key] for key in ('entrypoint', 'record', 'outputSha256', 'python')}
                entries[script.relative_to(destination).as_posix()]['bodySha256'] = digest(
                    expected_body(details['entrypoint']))
        windows_provenance = {'normalizer': 'uv-0.12.8-win64-console-v1',
                              'uvCommit': UV_COMMIT, 'baseSha256': BASE_SHA256,
                              'count': len(entries), 'entries': entries}
    else:
        bundled_python = output / 'python/bin/python3'
        for script in sorted((destination / 'bin').glob('*')):
            path = checked_path(script.relative_to(destination).as_posix())
            if path not in owned:
                raise ValueError("Installed launcher is missing from RECORD")
            relative = os.path.relpath(bundled_python, script.parent).replace(os.sep, '/')
            changes[path] = relocatable_script(path.read_bytes(), host_python, relative)

    for record, paths in records:
        stream = io.StringIO(newline='')
        writer = csv.writer(stream, lineterminator='\n')
        for name, path in sorted(paths):
            data = changes.get(path, b'')
            if data is None:
                continue
            if path == record:
                writer.writerow([name, '', ''])
            else:
                data = changes[path] if path in changes else path.read_bytes()
                checksum = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
                writer.writerow([name, 'sha256=' + checksum, len(data)])
        changes[record] = stream.getvalue().encode()

    for path, data in changes.items():
        if data is None:
            path.unlink()
        else:
            path.write_bytes(data)  # Existing executable modes are preserved.
    return {'schema': 1, 'localWheelEpoch': WHEEL_EPOCH,
            'upstreamOmittedBytecode': omitted,
            'localWheelOrigins': 'sourceCommit and wheels in provenance.json',
            'installerCacheMetadata': 'removed; RECORD updated',
            'consoleLaunchers': windows_provenance if windows_provenance is not None else 'relative-bundled-python'}
