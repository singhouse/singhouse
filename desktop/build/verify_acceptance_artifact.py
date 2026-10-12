# SPDX-License-Identifier: AGPL-3.0-only
"""Verify an acceptance artifact after delivery against its assembled inventory."""
import argparse
import hashlib
from pathlib import Path, PurePosixPath
import re


def verify_bundle(bundle, checksums):
    expected = checksums.read_bytes()
    if (bundle / 'SHA256SUMS').read_bytes() != expected:
        raise ValueError('Delivered SHA256SUMS differs from the assembled inventory')
    entries = {}
    for line in expected.decode('utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not match:
            raise ValueError('Invalid checksum inventory entry')
        checksum, name = match.groups()
        relative = PurePosixPath(name)
        if (relative.is_absolute() or '..' in relative.parts or '\\' in name or ':' in name
                or relative.as_posix() != name or name == 'SHA256SUMS' or name in entries):
            raise ValueError(f'Invalid or duplicate checksum path: {name}')
        entries[name] = checksum
    if not entries:
        raise ValueError('Empty checksum inventory')
    actual = set()
    for path in bundle.rglob('*'):
        if path.is_symlink():
            raise ValueError(f'Unexpected symbolic link: {path.relative_to(bundle)}')
        if path.is_file():
            actual.add(path.relative_to(bundle).as_posix())
    missing = entries.keys() - actual
    extra = actual - entries.keys() - {'SHA256SUMS'}
    if missing or extra:
        raise ValueError(f'Delivered file inventory mismatch: missing={sorted(missing)}, extra={sorted(extra)}')
    for name, checksum in entries.items():
        with (bundle / name).open('rb') as stream:
            actual_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual_hash != checksum:
            raise ValueError(f'Delivered checksum mismatch: {name}')
    return len(entries)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--checksums', type=Path, required=True)
    args = parser.parse_args()
    count = verify_bundle(args.bundle, args.checksums)
    print(f'Verified {count} delivered files against assembled SHA256SUMS')
