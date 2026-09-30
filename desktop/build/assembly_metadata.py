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
import shlex
import zipfile

# ZIP's earliest representable timestamp; independent of checkout/build time.
WHEEL_EPOCH = 315532800


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
                           target: str, artifacts: list[Path]) -> dict:
    """Plan/validate all edits, then update files and their owning RECORDs.

    Windows launchers are deliberately unchanged pending native qualification.
    Source commit and exact local-wheel hashes remain in provenance.json.
    """
    output = output.resolve()
    destination = destination.resolve()
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
    for directory in sorted(destination.glob('*.dist-info')):
        record = directory / 'RECORD'
        rows = list(csv.reader(io.StringIO(record.read_text())))
        if any(len(row) != 3 for row in rows) or len({row[0] for row in rows}) != len(rows):
            raise ValueError("Malformed or duplicate installed RECORD entries")
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

    if not target.startswith('win32-'):
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
            'localWheelOrigins': 'sourceCommit and wheels in provenance.json',
            'installerCacheMetadata': 'removed; RECORD updated',
            'consoleLaunchers': 'unchanged-windows' if target.startswith('win32-') else 'relative-bundled-python'}
