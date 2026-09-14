# SPDX-License-Identifier: AGPL-3.0-only
"""Verify supplied separation caches and print their pinned model policy entries.

Checkpoint hashes identify the audited local bytes, not an independently fetched
upstream checkpoint. Optional upstream checks read release metadata and the small
file inventory only; this tool never downloads weights or writes the cache.
"""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

DEMUCS_ORIGIN = 'https://dl.fbaipublicfiles.com/demucs/mdx_final/'
RELEASE = 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/'
CHECKS_REVISION = '8a65b784b5f075e46c43537cb0f3de3a802d00a9'
CHECKS_URL = f'https://raw.githubusercontent.com/TRvlvr/application_data/{CHECKS_REVISION}/filelists/download_checks.json'
ROFORMER = 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956'
DEMUCS = [
    ('e51eebcc-c1b80bdd.th', 167399275, 'c1b80bdd6de58274abf359e66822a76f49ce2b9f086fc5dc917ac14598e6bebf'),
    ('a1d90b5c-ae9d2452.th', 167391595, 'ae9d245283bf24b552913ee233a1101dcd0aeaed59b1c0a2da0e1f6eda15101b'),
    ('5d2d6c55-db83574e.th', 167391595, 'db83574e05b2308f76e2764819da673f2d16d437b9e619f5fcb72f275fc0e24f'),
    ('cfa93e08-61801ae1.th', 167399275, '61801ae1567d606c97a9c3469e943ae306d0a873eeb60d623ae7cfc7042b3f68'),
]
KARAOKE = [
    (ROFORMER + '.ckpt', 913096801, '1de20d459332fe8869aeb01327a31df0032262706e1365114e852dc271779813', 192841139),
    (ROFORMER + '_config.yaml', 1726, 'b35077d94861f068097cce1a5e54633c055e7dcc2613eade4e4dc7c7c9c3f48b', 192850484),
    ('download_checks.json', 28267, 'd3622e1fa19c161d3cf704927711b453d593a3f1eb0f2e0838c3136907935151', None),
]


def entries():
    models = []
    for model_id, directory, records in [('demucs-mdx-extra', 'torch/hub/checkpoints', DEMUCS),
                                         ('karaoke-roformer', 'audio-separator', KARAOKE)]:
        files = []
        for name, size, sha256, *_ in records:
            is_checks = name == 'download_checks.json'
            origin = DEMUCS_ORIGIN if model_id == 'demucs-mdx-extra' else RELEASE
            files.append({'path': f'{directory}/{name}', 'revision': CHECKS_REVISION if is_checks else sha256,
                          'sha256': sha256, 'size': size, 'url': CHECKS_URL if is_checks else origin + name,
                          'executable': False})
        models.append({'id': model_id, 'directory': directory, 'files': files})
    return models


def fetch_small(url):
    request = Request(url, headers={'User-Agent': 'Singhouse-model-inventory/0.1'})
    with urlopen(request, timeout=60) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError('Upstream metadata exceeds limit')
    return data


def verify_upstream(fetch=fetch_small):
    for name, size, sha256, asset_id in KARAOKE:
        if asset_id is None:
            data = fetch(CHECKS_URL)
            if len(data) != size or hashlib.sha256(data).hexdigest() != sha256:
                raise ValueError('Upstream file inventory differs from pin')
            continue
        record = json.loads(fetch(f'https://api.github.com/repos/nomadkaraoke/python-audio-separator/releases/assets/{asset_id}'))
        if record.get('id') != asset_id or record.get('name') != name or record.get('size') != size or record.get('browser_download_url') != RELEASE + name:
            raise ValueError('Release asset identity differs from pin')
        if record.get('digest') and record['digest'] != 'sha256:' + sha256:
            raise ValueError('Release asset digest differs from local pin')


def inventory(demucs_directory, karaoke_directory):
    models = entries()
    for model, directory in zip(models, [demucs_directory, karaoke_directory]):
        for record in model['files']:
            source = directory / Path(record['path']).name
            if not source.is_file() or source.stat().st_size != record['size']:
                raise ValueError(f'Local model size differs from pin: {source.name}')
            with source.open('rb') as stream:
                sha256 = hashlib.file_digest(stream, 'sha256').hexdigest()
            if sha256 != record['sha256']:
                raise ValueError(f'Local model hash differs from pin: {source.name}')
    return models


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--demucs-directory', type=Path, required=True)
    parser.add_argument('--karaoke-directory', type=Path, required=True)
    parser.add_argument('--verify-upstream', action='store_true')
    args = parser.parse_args()
    result = inventory(args.demucs_directory, args.karaoke_directory)
    if args.verify_upstream:
        verify_upstream()
    print(json.dumps(result, indent=2))
