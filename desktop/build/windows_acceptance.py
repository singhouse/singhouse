# SPDX-License-Identifier: AGPL-3.0-only
"""Build native Windows acceptance inputs; never publish models or qualify hardware."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

from assemble import ROOT, LOCKS, digest, fetch, host_target, unpack_uv


def prepare(work):
    if host_target() != 'win32-x64':
        raise ValueError('Windows acceptance builds require native Windows x64')
    work.mkdir(parents=True, exist_ok=False)
    native = json.loads((LOCKS / 'native.json').read_text())
    target = native['targets']['win32-x64']
    cache = work / 'cache'
    cache.mkdir()
    uv = work / 'tools/uv.exe'
    unpack_uv(fetch(target['uv'], cache), target['uv'], uv)
    python_root = work / 'bootstrap'
    python_root.mkdir()
    with tarfile.open(fetch(target['python'], cache), 'r:gz') as archive:
        archive.extractall(python_root, filter='data')
    python = python_root / 'python/python.exe'
    env = dict(os.environ, PATH=str(uv.parent) + os.pathsep + os.environ.get('PATH', ''),
               UV_NO_CONFIG='1', UV_PYTHON_DOWNLOADS='never', UV_CACHE_DIR=str(cache / 'uv'),
               PYTHONDONTWRITEBYTECODE='1')
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '--require-hashes',
                    '--no-deps', '--only-binary', ':all:', '-r', str(LOCKS / 'build.txt')],
                   cwd=ROOT, env=env, check=True)
    return python, env, cache


def recipe(args):
    work = args.work.resolve()
    python, env, cache = prepare(work)
    subprocess.run([str(python), str(ROOT / 'desktop/build/build_processing.py'),
                    '--requirements', str(LOCKS / f'processing-win32-x64-{args.accelerator}.json'),
                    '--build-requirements', str(LOCKS / 'processing-build.txt'),
                    '--target', 'win32-x64', '--accelerator', args.accelerator,
                    '--output', str(work / 'build'), '--cache', str(cache),
                    '--artifact-base-url', args.artifact_base_url], cwd=ROOT, env=env, check=True)
    manifest_path = work / 'build/recipe/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    evidence = dict(schema=1, target='win32-x64', accelerator=args.accelerator,
                    sourceCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                    manifestSha256=digest(manifest_path), lockSha256=manifest['provenance']['lockSha256'],
                    qualification='Dependency inventory only; no models, GPU probe, or song qualification')
    (work / 'build/recipe/build-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['recipe'])
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--accelerator', choices=['cpu', 'cuda'], required=True)
    parser.add_argument('--artifact-base-url', required=True)
    recipe(parser.parse_args())
