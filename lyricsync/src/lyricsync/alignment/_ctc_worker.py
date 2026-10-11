#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Standalone CTC forced-alignment worker for the acoustic re-timing stage.

Runs in a separate "processing" Python environment that has torch and
torchaudio (plus, optionally, transformers and phonemizer for the phoneme
voter). It must not import lyricsync: that environment may not have it.
Called as a subprocess by ``lyricsync.alignment.ctc_aligner.CtcFusionAligner``.

Usage:
    python _ctc_worker.py --input request.json --output result.json

Request JSON:
    {"audio_paths": ["lead.wav", "backing.wav"],   # summed sample-wise
     "words": ["word", ...],
     "models": ["hubl", "w2v2l", "hubxl", "phon"],  # optional, this order
     "allow_cpu": false}                             # optional

Result JSON (written to --output, atomically, after every model and at the end):
    {"engine": "ctc-worker-1", "device": "cuda",
     "models_run": ["hubl", ...],
     "models_failed": {"phon": "reason", ...},
     "spans": {"hubl": [[start, end] | [null, null], ...], ...},
     "models_pending": [],                 # not yet attempted (partial file only)
     "complete": true,                     # false while models are still pending
     "duration": 123.4}
On a fatal error the file also carries {"error": "..."} and the exit status is
non-zero; spans of models that finished before the failure are kept.

Each model is loaded, run over the whole song, and freed before the next one
is loaded, so peak GPU memory is that of the largest single model.
"""

import argparse
import json
import math
import sys
import time

ENGINE = "ctc-worker-1"
SR = 16000
DEFAULT_MODELS = ("hubl", "w2v2l", "hubxl", "phon")
CHAR_BUNDLES = {
    "hubl": "HUBERT_ASR_LARGE",
    "w2v2l": "WAV2VEC2_ASR_LARGE_LV60K_960H",
    "hubxl": "HUBERT_ASR_XLARGE",
}
PHON_REPO = "facebook/wav2vec2-lv-60-espeak-cv-ft"
# Cost of the filler state between words (non-lyric vocal sound or silence).
GARBAGE_COST = 1.0
CHUNK_SEC = 20.0
CONTEXT_SEC = 2.0


def log(msg):
    sys.stderr.write(f"ctc-worker: {msg}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- audio


def load_audio(paths):
    """Load each path at 16 kHz mono and sum them sample-wise (pad the shorter)."""
    import numpy as np

    total = None
    for p in paths:
        y = _load_one(p)
        if total is None:
            total = y
        else:
            if len(y) > len(total):
                total = np.pad(total, (0, len(y) - len(total)))
            elif len(y) < len(total):
                y = np.pad(y, (0, len(total) - len(y)))
            total = total + y
    return total.astype(np.float32)


def _load_one(path):
    try:
        import librosa
    except ImportError:
        librosa = None
    if librosa is not None:
        y, _ = librosa.load(path, sr=SR, mono=True)
        return y
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio.functional as AF

    data, sr = sf.read(path, dtype="float32", always_2d=True)
    y = data.mean(axis=1)
    if sr != SR:
        y = AF.resample(torch.from_numpy(y), sr, SR).numpy()
    return np.ascontiguousarray(y, dtype=np.float32)


# ---------------------------------------------------------------- models


class CtcModel:
    """One CTC acoustic model: emissions over the whole song and target tokens."""

    def __init__(self, kind, device):
        import torch  # noqa: F401
        import torchaudio

        self.kind = kind
        self.device = device
        self._phonemize = None  # built lazily from the tokenizer (phoneme model only)
        if kind in CHAR_BUNDLES:
            bundle = getattr(torchaudio.pipelines, CHAR_BUNDLES[kind])
            self.model = bundle.get_model().to(device).eval()
            self.hf = None
            self.proc = None
            self.dict = {c: i for i, c in enumerate(bundle.get_labels())}
            self.blank = 0
            self.sep = "|"
            self.upper = True
        elif kind == "phon":
            from transformers import AutoModelForCTC, AutoProcessor

            self.proc = AutoProcessor.from_pretrained(PHON_REPO)
            self.hf = AutoModelForCTC.from_pretrained(PHON_REPO).to(device).eval()
            self.model = None
            vocab = self.proc.tokenizer.get_vocab()
            self.dict = vocab
            self.blank = self.proc.tokenizer.pad_token_id
            self.sep = None
            self.upper = False
        else:
            raise ValueError(f"unknown model {kind!r}")

    def emissions(self, y, chunk=CHUNK_SEC, ctx=CONTEXT_SEC):
        """Log-probs for the whole song, computed in chunks with context on each side.

        Returns (emissions (T, C) on the device, seconds per frame).
        """
        import torch

        with torch.inference_mode():
            hop = int(chunk * SR)
            c = int(ctx * SR)
            outs = []
            for s in range(0, len(y), hop):
                a, b = max(0, s - c), min(len(y), s + hop + c)
                x = torch.from_numpy(y[a:b]).float()[None].to(self.device)
                if self.hf is not None:
                    x = (x - x.mean()) / (x.std() + 1e-7)
                    e = self.hf(x).logits[0]
                else:
                    e, _ = self.model(x)
                    e = e[0]
                e = torch.log_softmax(e.float(), -1)
                r = e.shape[0] / (b - a)  # frames per sample
                f0 = int(round((s - a) * r))
                f1 = f0 + int(round((min(s + hop, len(y)) - s) * r))
                outs.append(e[f0:f1])
            em = torch.cat(outs)
        return em, len(y) / em.shape[0] / SR

    def targets(self, words):
        """Token ids and their owning word index (-1 for the word separator)."""
        toks, owner = [], []
        if self.kind == "phon":
            if getattr(self, "_phonemize", None) is None:
                self._phonemize = make_phonemizer(self.proc.tokenizer)
            for i, w in enumerate(words):
                for p in self._phonemize(w).split():
                    if p in self.dict and self.dict[p] != self.blank:
                        toks.append(self.dict[p])
                        owner.append(i)
            return toks, owner
        for i, w in enumerate(words):
            w = w.upper() if self.upper else w.lower()
            w = w.replace("’", "'")
            # Never target the blank (torchaudio labels it "-", so hyphens would
            # otherwise become blank tokens) or the word separator.
            ids = [self.dict[ch] for ch in w
                   if ch in self.dict and ch != self.sep and self.dict[ch] != self.blank]
            if self.sep and toks and ids:
                toks.append(self.dict[self.sep])
                owner.append(-1)
            for t in ids:
                toks.append(t)
                owner.append(i)
        return toks, owner

    def free(self):
        self.model = None
        self.hf = None
        self.proc = None
        self._phonemize = None


def make_phonemizer(tk):
    """Return ``phonemize(word) -> str`` matching ``tk.phonemize(word)`` for a
    Wav2Vec2PhonemeCTCTokenizer ``tk``.

    The tokenizer's own method is not used: in transformers 5.x its base-class
    ``__init__`` overwrites the phonemizer backend that the subclass set up with
    a plain ``backend`` attribute, so ``tk.phonemize`` raises AttributeError.
    This builds the same backend and separator from the tokenizer's settings.
    """
    from phonemizer.backend import BACKENDS
    from phonemizer.separator import Separator

    backend = BACKENDS[getattr(tk, "phonemizer_backend", "espeak")](
        getattr(tk, "phonemizer_lang", "en-us"), language_switch="remove-flags"
    )
    wd = tk.word_delimiter_token
    sep = Separator(phone=tk.phone_delimiter_token,
                    word=(wd + " ") if wd is not None else "", syllable="")

    def phonemize(word):
        return backend.phonemize([word], separator=sep)[0].strip()

    return phonemize


def check_phonemizer():
    """Return None when the phoneme voter's text front-end works, else the reason."""
    try:
        import phonemizer  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return f"phonemizer not installed ({e})"
    try:
        from phonemizer.backend import EspeakBackend

        EspeakBackend("en-us")
    except Exception as e:  # noqa: BLE001
        return f"espeak-ng backend unavailable ({e})"
    return None


# ---------------------------------------------------------------- viterbi


def ctc_viterbi(em, tokens, owner, blank=0, in_word_blank=0.0, garbage=None):
    """CTC Viterbi over the target sequence with optional filler states between words.

    em: (T, C) log-probs. tokens: list[int]. owner: word index per token (-1 = separator).
    garbage: when set, every between-word blank state (and the leading/trailing one)
    also accepts any non-lyric vocal sound at this per-frame cost.
    in_word_blank: per-frame cost of a blank between two tokens of the same word.

    Returns (per-token [start_frame, end_frame) spans, best path score).
    """
    import torch

    dev = em.device
    T = em.shape[0]
    L = len(tokens)
    S = 2 * L + 1
    lab = torch.full((S,), blank, dtype=torch.long, device=dev)
    lab[1::2] = torch.tensor(tokens, dtype=torch.long, device=dev)
    if garbage is not None:
        nb = torch.cat([em[:, :blank], em[:, blank + 1:]], 1).max(1).values
        g = torch.logaddexp(em[:, blank], nb - garbage)
        em = torch.cat([em, g[:, None]], 1)
        G = em.shape[1] - 1
        inter = [0, S - 1] + [
            2 * k + 2 for k in range(L - 1)
            if not (owner[k] >= 0 and owner[k] == owner[k + 1])
        ]
        lab[torch.tensor(inter, device=dev)] = G
    extra = torch.zeros(S, device=dev)
    if in_word_blank:
        for k in range(L - 1):
            if owner[k] >= 0 and owner[k] == owner[k + 1]:
                extra[2 * k + 2] = -in_word_blank
    # skip transition s-2 -> s for non-blank s whose label differs from s-2's label
    skip = torch.zeros(S, dtype=torch.bool, device=dev)
    skip[3::2] = lab[3::2] != lab[1:-2:2]
    NEG = torch.tensor(-1e30, device=dev)
    dp = torch.full((S,), -1e30, device=dev)
    e0 = em[0, lab] + extra
    dp[0], dp[1] = e0[0], e0[1]
    bp = torch.zeros((T, S), dtype=torch.int8, device=dev)
    for t in range(1, T):
        stay = dp
        step = torch.cat([NEG[None], dp[:-1]])
        jump = torch.cat([NEG[None].expand(2), dp[:-2]])
        jump = torch.where(skip, jump, NEG)
        best, arg = torch.stack([stay, step, jump]).max(0)
        bp[t] = arg.to(torch.int8)
        dp = best + em[t, lab] + extra
    s = S - 1 if dp[S - 1] >= dp[S - 2] else S - 2
    score = float(dp[s])
    bp = bp.cpu()
    path = [0] * T
    for t in range(T - 1, -1, -1):
        path[t] = s
        s = s - int(bp[t, s])
    spans = [[None, None] for _ in range(L)]
    for t, s in enumerate(path):
        if s % 2 == 1:
            k = s // 2
            if spans[k][0] is None:
                spans[k][0] = t
            spans[k][1] = t + 1
    return spans, score


def fill(st, en):
    """Words with no aligned token: spread evenly across the gap between aligned neighbours."""
    import numpy as np

    n = len(st)
    i = 0
    while i < n:
        if not np.isnan(st[i]):
            i += 1
            continue
        j = i
        while j < n and np.isnan(st[j]):
            j += 1
        a = en[i - 1] if i > 0 else (st[j] if j < n else 0.0)
        b = st[j] if j < n else a + 0.3 * (j - i)
        step = (b - a) / (j - i)
        for k in range(i, j):
            st[k], en[k] = a + step * (k - i), a + step * (k - i + 1)
        i = j
    return st, en


def word_spans(em, spf, model, words):
    """Per-word (start, end) seconds for one model; raises when nothing can be aligned."""
    import numpy as np

    toks, owner = model.targets(words)
    if not any(o >= 0 for o in owner):
        raise RuntimeError("no word produced any target token")
    if em.shape[0] < len(toks):
        raise RuntimeError(
            f"audio too short for the lyrics ({em.shape[0]} frames, {len(toks)} tokens)"
        )
    raw, score = ctc_viterbi(em, toks, owner, blank=model.blank, in_word_blank=0.0,
                             garbage=GARBAGE_COST)
    if not math.isfinite(score) or score <= -1e29:
        raise RuntimeError("no feasible alignment path")
    st = np.full(len(words), np.nan)
    en = np.full(len(words), np.nan)
    for k, o in enumerate(owner):
        a, b = raw[k]
        if o < 0 or a is None:
            continue
        if np.isnan(st[o]):
            st[o] = a * spf
        en[o] = b * spf
    st, en = fill(st, en)
    return st, en


# ---------------------------------------------------------------- main


def pick_device(allow_cpu):
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if allow_cpu:
        return "cpu"
    raise RuntimeError("CUDA is not available and CPU alignment was not allowed")


def _json_span(a, b):
    if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
        return [None, None]
    return [float(a), float(b)]


def write_json_atomic(path, obj):
    """Write ``obj`` as JSON so a reader never sees a half-written file."""
    import os

    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def run(req, out=None, checkpoint=None):
    """Align every requested model. ``out`` is filled in place; ``checkpoint(out)``
    is called after each model so a partial result survives a later crash or kill."""
    import torch

    words = [str(w) for w in req["words"]]
    paths = [str(p) for p in req["audio_paths"]]
    models = list(req.get("models") or DEFAULT_MODELS)
    if not words:
        raise RuntimeError("empty word list")
    if not paths:
        raise RuntimeError("no audio paths")
    device = pick_device(bool(req.get("allow_cpu", False)))
    t0 = time.monotonic()
    y = load_audio(paths)
    if y is None or len(y) == 0:
        raise RuntimeError("audio is empty")
    log(f"device={device} audio={len(y) / SR:.1f}s words={len(words)} models={models}")

    if out is None:
        out = {}
    out.update({"engine": ENGINE, "device": device, "models_run": [], "models_failed": {},
                "spans": {}, "duration": len(y) / SR, "models_pending": list(models),
                "complete": False})
    for kind in models:
        if kind not in CHAR_BUNDLES and kind != "phon":
            out["models_failed"][kind] = "unknown model"
            out["models_pending"].remove(kind)
            continue
        if kind == "phon":
            why = check_phonemizer()
            if why:
                out["models_failed"][kind] = why
                out["models_pending"].remove(kind)
                log(f"{kind}: skipped: {why}")
                continue
        model = None
        em = None
        t1 = time.monotonic()
        try:
            model = CtcModel(kind, device)
            em, spf = model.emissions(y)
            st, en = word_spans(em, spf, model, words)
            out["spans"][kind] = [_json_span(st[i], en[i]) for i in range(len(words))]
            out["models_run"].append(kind)
            log(f"{kind}: aligned in {time.monotonic() - t1:.1f}s")
        except Exception as e:  # noqa: BLE001
            out["models_failed"][kind] = f"{type(e).__name__}: {e}"[:500]
            log(f"{kind}: failed: {e}")
        finally:
            if model is not None:
                model.free()
            del model, em
            if device == "cuda":
                torch.cuda.empty_cache()
            out["models_pending"].remove(kind)
            if checkpoint is not None:
                checkpoint(out)
    if device == "cuda":
        out["peak_vram_mb"] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
        out["peak_vram_reserved_mb"] = round(torch.cuda.max_memory_reserved() / 2**20, 1)
    out["elapsed"] = round(time.monotonic() - t0, 2)
    out["complete"] = True
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="request JSON path")
    parser.add_argument("--output", required=True, help="result JSON path")
    args = parser.parse_args()

    # Keep stdout clean of library chatter: everything diagnostic goes to stderr.
    sys.stdout = sys.stderr
    out = {}
    try:
        with open(args.input, encoding="utf-8") as f:
            req = json.load(f)
        run(req, out, checkpoint=lambda o: write_json_atomic(args.output, o))
        code = 0
    except Exception as e:  # noqa: BLE001
        # Keep any models that finished before the failure alongside the error.
        out["error"] = f"{type(e).__name__}: {e}"[:1000]
        code = 1
    write_json_atomic(args.output, out)
    sys.exit(code)


if __name__ == "__main__":
    main()
