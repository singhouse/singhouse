# SPDX-License-Identifier: AGPL-3.0-only
"""Modal contracts exercised without the SDK, models, GPU, or network."""
import ast
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

from karaoke_backend.workers import modal_offload


def wav_bytes(rate=44100, frames=20):
    import io
    import wave
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\0" * frames * 4)
    return buffer.getvalue()


@pytest.fixture
def remote_namespace():
    # Execute the actual function bodies without Modal's deployment decorators.
    source = Path(__file__).parents[1] / 'modal_app.py'
    tree = ast.parse(source.read_text())
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    for node in functions:
        node.decorator_list = []
    namespace = {'KARAOKE_MODEL': 'default', 'AS_MODEL_DIR': '/unused', 'HEART_DIR': '/unused'}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), namespace)
    return namespace


@pytest.mark.parametrize('bad', [None, {}, {'ok': False}, {'ok': True, 'pass2': 'fallback'},
                                  {'ok': True, 'pass2': 'ok'}])
def test_client_rejects_incomplete_before_touching_stems(tmp_path, monkeypatch, bad):
    audio = tmp_path / 'input.wav'
    audio.write_bytes(b'audio')
    stems = tmp_path / 'stems'
    stems.mkdir()
    (stems / 'lead_vocals.wav').write_bytes(b'old')
    monkeypatch.setattr(modal_offload, '_lookup', lambda _: SimpleNamespace(remote=lambda *a, **k: bad))
    with pytest.raises(RuntimeError):
        modal_offload.modal_separate(audio, stems, demucs_model='mdx_extra')
    assert (stems / 'lead_vocals.wav').read_bytes() == b'old'
    assert list(stems.iterdir()) == [stems / 'lead_vocals.wav']


@pytest.mark.parametrize('missing', ['drums', 'bass', 'other', 'lead_vocals', 'backing_vocals'])
def test_client_requires_each_stem(tmp_path, monkeypatch, missing):
    result = dict(ok=True, pass2='ok', **{n: b'wav' for n in
                  ['drums', 'bass', 'other', 'lead_vocals', 'backing_vocals']})
    result[missing] = b''
    monkeypatch.setattr(modal_offload, '_lookup', lambda _: SimpleNamespace(remote=lambda *a, **k: result))
    audio = tmp_path / 'input.wav'
    audio.write_bytes(b'audio')
    with pytest.raises(RuntimeError, match=missing):
        modal_offload.modal_separate(audio, tmp_path / 'out', demucs_model='mdx_extra')
    assert not (tmp_path / 'out').exists()


def test_client_complete_response(tmp_path, monkeypatch):
    names = ['drums', 'bass', 'other', 'lead_vocals', 'backing_vocals']
    result = dict(ok=True, pass2='ok', **{n: wav_bytes() for n in names})
    monkeypatch.setattr(modal_offload, '_lookup', lambda _: SimpleNamespace(remote=lambda *a, **k: result))
    audio = tmp_path / 'input.wav'
    audio.write_bytes(b'audio')
    out = tmp_path / 'out'
    paths = modal_offload.modal_separate(audio, out, demucs_model='mdx_extra')
    assert {n: p.read_bytes() for n, p in paths.items()} == {n: wav_bytes() for n in names[:3]}
    assert (out / 'lead_vocals.wav').read_bytes() == wav_bytes()
    assert (out / 'backing_vocals.wav').read_bytes() == wav_bytes()
    assert not list(out.glob('.modal-*'))


@pytest.mark.parametrize('outputs,raises,missing,ok', [
    (['x_(Vocals).wav', 'x_(Instrumental).wav'], False, None, True),
    (['demucs_vocals_(Vocals)_mel_band_roformer_karaoke_aufr33_viperx_sdr_10.wav',
      'demucs_vocals_(Instrumental)_mel_band_roformer_karaoke_aufr33_viperx_sdr_10.wav'],
     False, None, True),
    (['demucs_instrumental_(Vocals)_model.wav', 'demucs_vocals_(Instrumental)_model.wav'],
     False, None, True),
    (['demucs_vocals_(Vocals)_(Instrumental)_model.wav'], False, None, False),
    ([], True, None, False),
    (['a.wav', 'b.wav'], False, None, False),
    (['x_(Vocals).wav'], False, None, False),
    (['x_(Vocals).wav', 'y_(Vocals).wav', 'x_(Instrumental).wav'], False, None, False),
    (['x_(Vocals)_(Instrumental).wav'], False, None, False),
    (['x_(Vocals).wav', 'x_(Instrumental).wav'], False, 'bass', False),
])
def test_remote_requires_unambiguous_complete_split(remote_namespace, monkeypatch, outputs, raises, missing, ok):
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)))
    workdirs = []
    def demucs(audio, model, device, work):
        workdirs.append(work)
        assert audio != work / 'source.wav'
        stems = {}
        for name in ['vocals', 'drums', 'bass', 'other']:
            if name != missing:
                stems[name] = work / (name + '.wav')
                stems[name].write_bytes(name.encode())
        return stems
    remote_namespace['_run_demucs'] = demucs
    def run(args, **kwargs):
        assert args[args.index('-i') + 1] != args[-1]
    monkeypatch.setattr('subprocess.run', run)
    class Separator:
        def __init__(self, **kwargs):
            self.out = Path(kwargs['output_dir'])
        def load_model(self, **kwargs):
            pass
        def separate(self, source):
            if raises:
                raise RuntimeError('failed')
            for name in outputs:
                (self.out / name).write_bytes(name.encode())
    monkeypatch.setitem(sys.modules, 'audio_separator.separator', SimpleNamespace(Separator=Separator))
    result = remote_namespace['separate_remote'](b'audio', 'input.wav')
    assert result['ok'] is ok
    if ok:
        assert result['lead_vocals'] == outputs[0].encode()
        assert result['backing_vocals'] == outputs[1].encode()
    if not ok:
        assert 'lead_vocals' not in result
        assert 'backing_vocals' not in result
    assert all(not p.exists() for p in workdirs)


def test_empty_vad_never_loads_model(remote_namespace, monkeypatch):
    monkeypatch.setitem(sys.modules, 'torch', None)
    result = remote_namespace['transcribe_remote'](b'audio', 'input.wav', [], 'fr')
    assert result == dict(segments=[], language='fr', transcriber='heart', full_text='')


def test_heart_segment_token_budget_and_timestamps(remote_namespace, monkeypatch):
    import numpy as np
    calls = []
    def pipe(audio, **kwargs):
        calls.append(kwargs['generate_kwargs'])
        return {'text': 'word', 'chunks': [{'text': 'word', 'timestamp': (0.0, 0.5)}]}
    factory = SimpleNamespace(from_pretrained=lambda *a, **k: SimpleNamespace(tokenizer=None, feature_extractor=None))
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), float32='f32'))
    monkeypatch.setitem(sys.modules, 'transformers', SimpleNamespace(WhisperForConditionalGeneration=factory,
        WhisperProcessor=factory, pipeline=lambda *a, **k: pipe))
    monkeypatch.setitem(sys.modules, 'librosa', SimpleNamespace(load=lambda *a, **k: (np.zeros(16000 * 100), 16000)))
    result = remote_namespace['transcribe_remote'](b'audio', 'input.wav', [[2, 3], [5, 55]], 'en')
    assert [c['max_new_tokens'] for c in calls] == [20, 440]
    assert all(c['temperature'] == 0.0 for c in calls)
    assert [s['start'] for s in result['segments']] == [2.0, 5.0]


@pytest.mark.parametrize("broken", [b"garbage", wav_bytes()[:-1], wav_bytes(rate=16000), wav_bytes(frames=10)])
def test_client_rejects_corrupt_or_unaligned_audio(tmp_path, monkeypatch, broken):
    result = dict(ok=True, pass2='ok', **{n: wav_bytes() for n in
                  ['drums', 'bass', 'other', 'lead_vocals', 'backing_vocals']})
    result['other'] = broken
    monkeypatch.setattr(modal_offload, '_lookup', lambda _: SimpleNamespace(remote=lambda *a, **k: result))
    audio = tmp_path / 'input.wav'
    audio.write_bytes(b'audio')
    with pytest.raises(RuntimeError):
        modal_offload.modal_separate(audio, tmp_path / 'out', demucs_model='mdx_extra')
    assert not (tmp_path / 'out').exists()


def test_explicit_model_is_never_silently_substituted(tmp_path, monkeypatch):
    calls = []
    def remote(*args, **kwargs):
        calls.append(kwargs)
        raise TypeError('unsupported model argument')
    monkeypatch.setattr(modal_offload, '_lookup', lambda _: SimpleNamespace(remote=remote))
    audio = tmp_path / 'input.wav'
    audio.write_bytes(b'audio')
    with pytest.raises(TypeError):
        modal_offload.modal_separate(audio, tmp_path / 'out', demucs_model='mdx_extra', karaoke_model='selected')
    assert calls == [{'karaoke_model': 'selected'}]


def test_client_rolls_back_later_publication_failure(tmp_path, monkeypatch):
    names = ['lead_vocals', 'backing_vocals', 'drums', 'bass', 'other']
    result = dict(ok=True, pass2='ok', **{n: wav_bytes() for n in names})
    monkeypatch.setattr(modal_offload, '_lookup', lambda _: SimpleNamespace(remote=lambda *a, **k: result))
    audio = tmp_path / 'input.wav'
    audio.write_bytes(b'audio')
    out = tmp_path / 'out'
    (out / '_remote_raw').mkdir(parents=True)
    targets = {n: (out if 'vocals' in n else out / '_remote_raw') / f'{n}.wav' for n in names}
    for p in targets.values():
        p.write_bytes(b'previous')
    original = Path.replace
    def replace(self, target):
        if self.name == 'bass.wav':
            raise OSError('injected publication failure')
        return original(self, target)
    monkeypatch.setattr(Path, 'replace', replace)
    with pytest.raises(OSError):
        modal_offload.modal_separate(audio, out, demucs_model='mdx_extra')
    assert all(p.read_bytes() == b'previous' for p in targets.values())


@pytest.mark.parametrize('codec,extensible', [(1, False), (3, False), (1, True), (3, True)])
def test_wav_formats(codec, extensible):
    import struct
    fmt = struct.pack('<HHIIHH', 0xFFFE if extensible else codec, 2, 44100, 352800, 8, 32)
    if extensible:
        fmt += struct.pack('<HHI', 22, 32, 3) + struct.pack('<I', codec) + bytes.fromhex('00001000800000aa00389b71')
    body = b'WAVEfmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', 80) + b'\0' * 80
    data = b'RIFF' + struct.pack('<I', len(body)) + body
    assert modal_offload._wav_layout(data) == (44100, 2, 10)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['missing', 'instrumental', 'karaoke'])
async def test_finalizer_never_announces_success_after_failure(tmp_path, monkeypatch, failure):
    from karaoke_backend.workers import modal_worker
    for name in ['drums', 'bass', 'other', 'lead_vocals', 'backing_vocals', 'instrumental', 'karaoke']:
        (tmp_path / f'{name}.wav').write_bytes(wav_bytes())
    if failure == 'missing':
        (tmp_path / 'bass.wav').unlink()
    monkeypatch.setattr(modal_worker, '_ensure_s16', lambda _: None)
    async def run(cmd, timeout):
        return SimpleNamespace(
            returncode=1 if failure == 'instrumental' else 0, stderr='injected failure')
    monkeypatch.setattr(modal_worker, '_await_subprocess', run)
    async def mix(*args):
        return False
    monkeypatch.setattr(modal_worker, 'mix_karaoke', mix)
    events = []
    async def progress(*args):
        events.append(args)
    with pytest.raises(modal_worker.StemSeparationError):
        await modal_worker._mix_and_finalize(tmp_path, *(tmp_path / f'{n}.wav' for n in ['drums', 'bass', 'other']), progress)
    assert not any(e[0] == 'done' for e in events)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["probe", "conversion", "empty"])
async def test_finalizer_propagates_normalization_failure(tmp_path, monkeypatch, failure):
    from karaoke_backend.workers import modal_worker
    for name in ['drums', 'bass', 'other', 'lead_vocals', 'backing_vocals']:
        (tmp_path / f'{name}.wav').write_bytes(wav_bytes())
    async def run(cmd, timeout):
        if cmd[0] == 'ffprobe':
            return SimpleNamespace(returncode=1 if failure == 'probe' else 0, stdout='flt', stderr='failed')
        Path(cmd[-1]).write_bytes(b'' if failure == 'empty' else b'partial')
        return SimpleNamespace(returncode=1 if failure == 'conversion' else 0, stderr='failed')
    monkeypatch.setattr(modal_worker, '_await_subprocess', run)
    events = []
    async def progress(*args):
        events.append(args)
    with pytest.raises(modal_worker.StemSeparationError):
        await modal_worker._mix_and_finalize(tmp_path, *(tmp_path / f'{n}.wav' for n in ['drums', 'bass', 'other']), progress)
    assert events == []
    assert (tmp_path / 'lead_vocals.wav').read_bytes() == wav_bytes()
    assert not (tmp_path / 'lead_vocals.s16.wav').exists()
