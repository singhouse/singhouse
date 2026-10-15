# SPDX-License-Identifier: AGPL-3.0-only
"""Build native Windows acceptance inputs; never publish models or qualify hardware."""
import argparse
import json
import shutil
import hashlib
import os
import re
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


def recipe_publication(source_commit, accelerator, *, release_assets=False, artifact_base_url=None):
    if not re.fullmatch(r'[0-9a-f]{40}', source_commit) or accelerator not in ('cpu', 'cuda'):
        raise ValueError('Recipe publication requires the full source commit and Windows accelerator')
    if release_assets:
        if artifact_base_url is not None:
            raise ValueError('Release asset mode uses its fixed publication directory')
        return 'flat', f'https://github.com/singhouse/processing-packs/releases/download/rc-{source_commit}-win-{accelerator}/'
    if not artifact_base_url:
        raise ValueError('Bundled recipe transport requires --artifact-base-url')
    return 'directory', artifact_base_url


def recipe(args):
    source_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    layout, base_url = recipe_publication(source_commit, args.accelerator,
                                          release_assets=args.release_assets, artifact_base_url=args.artifact_base_url)
    work = args.work.resolve()
    python, env, cache = prepare(work)
    subprocess.run([str(python), str(ROOT / 'desktop/build/build_processing.py'),
                    '--requirements', str(LOCKS / f'processing-win32-x64-{args.accelerator}.json'),
                    '--build-requirements', str(LOCKS / 'processing-build.txt'),
                    '--target', 'win32-x64', '--accelerator', args.accelerator,
                    '--output', str(work / 'build'), '--cache', str(cache),
                    '--artifact-base-url', base_url, '--artifact-layout', layout], cwd=ROOT, env=env, check=True)
    manifest_path = work / 'build/recipe/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    evidence = dict(schema=1, target='win32-x64', accelerator=args.accelerator,
                    sourceCommit=source_commit,
                    manifestSha256=digest(manifest_path), lockSha256=manifest['provenance']['lockSha256'],
                    artifactLayout=layout, artifactBaseUrl=base_url,
                    qualification='Dependency inventory only; no models, GPU probe, or song qualification')
    (work / 'build/recipe/build-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


def validate_recipe(manifest, trust, accelerator, native_lock_sha256):
    lock_hash = manifest['provenance']['lockSha256']
    # Acceptance bundles are private-test builds, which trust every committed
    # lock: a release candidate (private-test only) or an accepted recipe.
    if not isinstance(trust.get('lockSha256'), list) or lock_hash not in trust['lockSha256']:
        raise ValueError('Recipe must be independently pinned in the committed processing trust policy')
    if hashlib.sha256(manifest['provenance']['inputLock'].encode()).hexdigest() != lock_hash:
        raise ValueError('Recipe input lock hash mismatch')
    if (manifest['platform'], manifest['arch'], manifest['accelerator']) != ('win32', 'x64', accelerator):
        raise ValueError('Recipe target mismatch')
    if manifest['recipe']['nativeTools']['nativeLockSha256'] != native_lock_sha256:
        raise ValueError('Recipe native tool identity mismatch')
    return lock_hash


def package(args):
    recipe_dir = args.recipe.resolve()
    manifest = json.loads((recipe_dir / 'manifest.json').read_text())
    trust = json.loads((ROOT / 'desktop/processing-locks.json').read_text())
    lock_hash = validate_recipe(manifest, trust, args.accelerator, digest(LOCKS / 'native.json'))
    policy = json.loads((ROOT / 'desktop/release.json').read_text())
    if policy['channel'] != 'private-test':
        raise ValueError('Acceptance bundles require the private-test channel')
    work = args.work.resolve()
    python, env, cache = prepare(work)
    native = work / 'native'
    subprocess.run([str(python), str(ROOT / 'desktop/build/assemble.py'), '--target', 'win32-x64',
                    '--output', str(native), '--cache', str(cache)], cwd=ROOT, env=env, check=True)
    subprocess.run(['npm.cmd', 'ci'], cwd=ROOT / 'desktop', env=env, check=True)
    env['KARAOKE_NATIVE_PAYLOAD'] = str(native)
    subprocess.run(['node', str(ROOT / 'desktop/build/package.mjs'), '--playback-only'],
                   cwd=ROOT / 'desktop', env=env, check=True)
    output = ROOT / 'desktop/artifacts'
    receipts = list(output.glob('*.shapp.receipt.json'))
    if len(receipts) != 1:
        raise ValueError('Expected exactly one portable application receipt')
    bundle = work / 'bundle'
    shutil.copytree(output / 'win-unpacked', bundle / 'app')
    shutil.copyfile(receipts[0], bundle / 'app/resources/release-receipt.json')
    shutil.copytree(recipe_dir, bundle / 'recipe')
    tools = bundle / 'tools/desktop'
    tools.mkdir(parents=True)
    for source in (ROOT / 'desktop').glob('*.mjs'):
        shutil.copyfile(source, tools / source.name)
    shutil.copyfile(ROOT / 'desktop/processing_probe.py', tools / 'processing_probe.py')
    shutil.copytree(ROOT / 'desktop/acceptance', tools / 'acceptance')
    launcher = f'Start-{args.accelerator.upper()}.cmd'
    shutil.copyfile(tools / 'acceptance' / launcher, bundle / launcher)
    readme = tools / 'acceptance/README.md'
    if readme.is_file():
        shutil.copyfile(readme, bundle / 'README.md')
    node_env = dict(env, ELECTRON_RUN_AS_NODE='1')
    command = [str(bundle / 'app/Singhouse.exe'), str(tools / 'acceptance/windows-bootstrap.mjs'),
               '--bundle', str(bundle), '--profile', str(work / 'test-profile'), '--accelerator', args.accelerator]
    subprocess.run([*command, '--check-only'], cwd=bundle, env=node_env, check=True)
    # Exercise the shipped PowerShell launcher, its NTFS/ACL checks, and bundled
    # Electron/Python/uv. No models are downloaded and no ready marker is written.
    if args.accelerator == 'cpu':
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                        '-File', str(tools / 'acceptance/start-windows.ps1'),
                        '-Accelerator', 'cpu', '-DependenciesOnly'], cwd=bundle, env=env, check=True)
    evidence = dict(schema=1, target='win32-x64', accelerator=args.accelerator,
                    sourceCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                    recipeLockSha256=lock_hash, recipeManifestSha256=digest(recipe_dir / 'manifest.json'),
                    bundledElectronBootstrapChecked=True, dependencyProbePassed=args.accelerator == 'cpu',
                    songProcessingQualified=False, signed=False)
    (bundle / 'build-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    with (bundle / 'SHA256SUMS').open('w', encoding='utf-8', newline='\n') as stream:
        for path in sorted(bundle.rglob('*')):
            if path.is_file() and path.name != 'SHA256SUMS':
                stream.write(f'{digest(path)}  {path.relative_to(bundle).as_posix()}\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='phase', required=True)
    for phase in ('recipe', 'package'):
        command = commands.add_parser(phase)
        command.add_argument('--work', type=Path, required=True)
        command.add_argument('--accelerator', choices=['cpu', 'cuda'], required=True)
        if phase == 'recipe':
            publication = command.add_mutually_exclusive_group(required=True)
            publication.add_argument('--artifact-base-url')
            publication.add_argument('--release-assets', action='store_true',
                                     help='Export flat assets for the fixed source-bound processing-packs release URL')
        else:
            command.add_argument('--recipe', type=Path, required=True)
    args = parser.parse_args()
    (recipe if args.phase == 'recipe' else package)(args)
