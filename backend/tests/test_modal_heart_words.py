# SPDX-License-Identifier: AGPL-3.0-only
"""Offline adapter regression; never invokes the real Modal SDK/network."""
import sys
from types import SimpleNamespace

from karaoke_backend.workers import modal_offload


def test_modal_preserves_decoder_spacing_and_normalizes_timed_words(tmp_path, monkeypatch):
    parts = ["東京", "で", "I", "＇", "m", "안녕"]
    payload = {
        "segments": [{"start": 0, "end": .6, "text": "東京でI＇m。안녕", "words": [
            {"word": text, "start": i * .1, "end": (i + 1) * .1}
            for i, text in enumerate(parts)
        ]}],
        "full_text": "東京でI＇m。안녕",
        "language": "en",
    }
    calls = []

    def remote(*args):
        calls.append(args)
        return payload

    def from_name(app, name):
        assert name == "transcribe_remote"
        return SimpleNamespace(remote=remote)

    monkeypatch.setitem(sys.modules, "modal", SimpleNamespace(
        Function=SimpleNamespace(from_name=from_name),
    ))
    monkeypatch.setattr(modal_offload, "_DESKTOP", None)
    audio = tmp_path / 'synthetic.wav'
    audio.write_bytes(b'synthetic fixture')
    result = modal_offload.ModalHeartTranscriber(use_vad=False).transcribe(str(audio), 'en')
    assert calls == [(b'synthetic fixture', 'synthetic.wav', None, 'en', False)]
    assert result.segments[0].text == "東京でI'm。안녕"
    assert result.full_text == "東京でI'm。안녕"
    assert [w.text for w in result.segments[0].words] == ["東京", "で", "I'm", "안녕"]
    merged = result.segments[0].words[2]
    assert (merged.start, merged.end) == (.2, .5)
