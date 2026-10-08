# SPDX-License-Identifier: MIT
"""CTC worker internals on tiny synthetic emissions. Skipped when torch is absent."""

import math

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from lyricsync.alignment import _ctc_worker as worker  # noqa: E402

# Toy character vocabulary in the torchaudio label layout: blank first, "|" separator.
LABELS = ["-", "|", "A", "B", "'"]
VOCAB = {c: i for i, c in enumerate(LABELS)}


def _char_model():
    m = worker.CtcModel.__new__(worker.CtcModel)
    m.kind = "hubl"
    m.dict = dict(VOCAB)
    m.blank = 0
    m.sep = "|"
    m.upper = True
    m.proc = None
    return m


def _emissions(frames, n_classes=5, hi=0.0, lo=-12.0):
    """Log-probs with one dominant class per frame (frames: list of class ids)."""
    em = torch.full((len(frames), n_classes), lo)
    for t, c in enumerate(frames):
        em[t, c] = hi
    return torch.log_softmax(em, -1)


def test_targets_char_model():
    m = _char_model()
    toks, owner = m.targets(["ab", "b’a", "42", "a"])
    # upper-cased, curly apostrophe normalised, out-of-vocab word contributes nothing,
    # separator only between words that produced tokens
    assert toks == [2, 3, 1, 3, 4, 2, 1, 2]
    assert owner == [0, 0, -1, 1, 1, 1, -1, 3]


def test_targets_hyphens_are_not_blank_tokens():
    m = _char_model()
    toks, owner = m.targets(["ab-", "a-b", "-", "b"])
    assert VOCAB["-"] == m.blank
    assert m.blank not in toks
    assert toks == [2, 3, 1, 2, 3, 1, 3]
    assert owner == [0, 0, -1, 1, 1, -1, 3]


def test_run_checkpoints_after_each_model(monkeypatch, tmp_path):
    class FakeModel:
        def __init__(self, kind, device):
            if kind == "w2v2l":
                raise RuntimeError("weights unavailable")
            self.kind = kind

        def emissions(self, y):
            return None, 0.02

        def free(self):
            pass

    monkeypatch.setattr(worker, "CtcModel", FakeModel)
    monkeypatch.setattr(worker, "load_audio", lambda paths: np.zeros(16000, np.float32))
    monkeypatch.setattr(worker, "pick_device", lambda allow: "cpu")
    monkeypatch.setattr(worker, "word_spans",
                        lambda em, spf, model, words: (np.array([0.1]), np.array([0.2])))
    monkeypatch.setattr(worker, "check_phonemizer", lambda: "no espeak")
    snaps = []
    out_path = tmp_path / "result.json"

    def checkpoint(o):
        worker.write_json_atomic(str(out_path), o)
        snaps.append((sorted(o["spans"]), list(o["models_pending"]), o["complete"]))

    out = worker.run({"words": ["a"], "audio_paths": ["x.wav"]}, {}, checkpoint)
    assert snaps == [
        (["hubl"], ["w2v2l", "hubxl", "phon"], False),
        (["hubl"], ["hubxl", "phon"], False),
        (["hubl", "hubxl"], ["phon"], False),
    ]
    assert out["complete"] is True and out["models_pending"] == []
    assert set(out["models_failed"]) == {"w2v2l", "phon"}
    import json
    assert json.loads(out_path.read_text())["models_pending"] == ["phon"]
    assert not (tmp_path / "result.json.tmp").exists()


def test_viterbi_spans_follow_the_dominant_path():
    B, S, A, Bc = 0, 1, 2, 3
    frames = [B] * 5 + [A] * 3 + [Bc] * 2 + [S] * 5 + [Bc] * 2 + [A] * 3 + [B] * 5
    em = _emissions(frames)
    toks = [A, Bc, S, Bc, A]
    owner = [0, 0, -1, 1, 1]
    spans, score = worker.ctc_viterbi(em, toks, owner, blank=0, garbage=1.0)
    assert math.isfinite(score)
    assert spans == [[5, 8], [8, 10], [10, 15], [15, 17], [17, 20]]


def test_garbage_state_absorbs_non_lyric_sound():
    B, A, Bc = 0, 2, 3
    # an extra, unscripted "B" burst at frames 8-11 between the two words
    frames = [B] * 3 + [A] * 3 + [B] * 2 + [Bc] * 4 + [B] * 2 + [A] * 3 + [B] * 3
    em = _emissions(frames)
    toks = [A, A]  # two one-letter words, no separator in this toy setup
    owner = [0, 1]
    spans, _ = worker.ctc_viterbi(em, toks, owner, blank=0, garbage=1.0)
    assert spans[0][0] == 3
    assert spans[1][0] == 14


def test_word_spans_seconds_and_fill():
    B, S, A, Bc = 0, 1, 2, 3
    frames = [B] * 5 + [A] * 3 + [Bc] * 2 + [S] * 5 + [Bc] * 2 + [A] * 3 + [B] * 5
    em = _emissions(frames)
    m = _char_model()
    st, en = worker.word_spans(em, 0.02, m, ["AB", "99", "BA"])
    assert st[0] == pytest.approx(0.10) and en[0] == pytest.approx(0.20)
    assert st[2] == pytest.approx(0.30) and en[2] == pytest.approx(0.40)
    # the untokenisable word is spread over the gap between its neighbours
    assert st[1] == pytest.approx(0.20) and en[1] == pytest.approx(0.30)


def test_fill_leading_and_trailing_runs():
    st = np.array([np.nan, 1.0, np.nan, np.nan])
    en = np.array([np.nan, 1.5, np.nan, np.nan])
    st, en = worker.fill(st, en)
    assert st[0] == pytest.approx(1.0) and en[0] == pytest.approx(1.0)
    assert st[2] == pytest.approx(1.5) and en[2] == pytest.approx(1.8)
    assert st[3] == pytest.approx(1.8) and en[3] == pytest.approx(2.1)


def test_word_spans_rejects_untokenisable_lyrics():
    em = _emissions([0] * 10)
    with pytest.raises(RuntimeError, match="no word produced"):
        worker.word_spans(em, 0.02, _char_model(), ["123", "456"])


def test_word_spans_rejects_audio_shorter_than_tokens():
    em = _emissions([0] * 3)
    with pytest.raises(RuntimeError, match="too short"):
        worker.word_spans(em, 0.02, _char_model(), ["ABABAB"])


def test_load_audio_sums_and_pads(tmp_path):
    sf = pytest.importorskip("soundfile")
    a = np.full(16000, 0.25, dtype=np.float32)
    b = np.full(8000, 0.5, dtype=np.float32)
    sf.write(tmp_path / "a.wav", a, 16000)
    sf.write(tmp_path / "b.wav", b, 16000)
    y = worker.load_audio([str(tmp_path / "a.wav"), str(tmp_path / "b.wav")])
    assert len(y) == 16000
    assert y[:8000] == pytest.approx(0.75, abs=1e-3)
    assert y[8000:] == pytest.approx(0.25, abs=1e-3)


def test_cpu_refused_without_permission(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(RuntimeError, match="CPU alignment was not allowed"):
        worker.pick_device(False)
    assert worker.pick_device(True) == "cpu"
