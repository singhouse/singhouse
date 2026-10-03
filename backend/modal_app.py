#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Modal GPU app: karaoke stem separation (demucs + mel_band_roformer) + Heart
transcription, running on a CUDA container in your own Modal account.

The two-pass separation and Heart per-VAD-segment transcription return
results for local mixing and alignment through Modal RPC.
The dispatcher-side client is ``workers/modal_offload.py``.

Deploy from your own Modal account (one-time, re-run after editing this file):

    modal deploy backend/modal_app.py

The first deploy bakes the three model checkpoints into the image (Heart ~3 GB,
mel_band_roformer, demucs mdx_extra), so cold starts don't re-download them.

Then enable the offload in the backend (env, e.g. a systemd drop-in):

    KARAOKE_MODAL=1                 # route GPU work to Modal
    KARAOKE_MODAL_APP=karaoke-gpu   # must match APP_NAME below (optional)

Heavy ML imports (torch/demucs/transformers/librosa) live INSIDE the functions
so this module stays importable on the dispatcher (where only the `modal`
client is installed) for `modal deploy` and `Function.from_name` lookups.
"""

from __future__ import annotations

import os

import modal

# --------------------------------------------------------------------------- #
# Config (read at deploy time; override via env before `modal deploy`)
# --------------------------------------------------------------------------- #
APP_NAME = os.environ.get("KARAOKE_MODAL_APP", "karaoke-gpu")
GPU = os.environ.get("KARAOKE_MODAL_GPU", "T4")  # T4|L4|A10G|A100 ...

HEART_REPO = "HeartMuLa/HeartTranscriptor-oss"
HEART_DIR = "/models/heart"

KARAOKE_MODEL = os.environ.get(
    "KARAOKE_MODEL",
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
)
# Pass-2 models baked alongside the default so an uploader's per-song pick does
# not have to download inside the job. Mirrors karaoke_models.CHOICES on the
# backend side; a model named there but missing here still works, it just pays
# a download on every cold container. Keep the two lists in step.
EXTRA_KARAOKE_MODELS = ["UVR_MDXNET_KARA_2.onnx"]
AS_MODEL_DIR = "/models/audio-separator"

# Heart checkpoint files we actually need (skip optimizer/dupe artifacts).
_HEART_PATTERNS = [
    "*.json", "*.safetensors", "*.txt", "*.model",
    "tokenizer*", "merges.txt", "vocab.json",
]

app = modal.App(APP_NAME)


# --------------------------------------------------------------------------- #
# Image: CUDA torch + the two separation stacks + Heart, with models baked in
# --------------------------------------------------------------------------- #
def _bake_models() -> None:
    """Run at image-build time; filesystem writes persist into the image."""
    import os as _os

    from huggingface_hub import snapshot_download

    # 1. Heart (fine-tuned Whisper for lyrics) — ~3 GB.
    snapshot_download(HEART_REPO, local_dir=HEART_DIR, allow_patterns=_HEART_PATTERNS)

    # 2. Demucs mdx_extra → torch hub cache (default $HOME/.cache).
    from demucs.pretrained import get_model
    get_model("mdx_extra")

    # 3. Pass-2 karaoke split models (audio-separator) → AS_MODEL_DIR.
    _os.makedirs(AS_MODEL_DIR, exist_ok=True)
    from audio_separator.separator import Separator
    sep = Separator(model_file_dir=AS_MODEL_DIR, output_dir="/tmp")
    # load_model downloads the ckpt + its yaml config if absent (CPU at build).
    for _model in dict.fromkeys([KARAOKE_MODEL, *EXTRA_KARAOKE_MODELS]):
        sep.load_model(model_filename=_model)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch",
        "torchaudio",
        "demucs",
        "audio-separator[gpu]",
        "transformers",
        "librosa",
        "soundfile",
        "numpy",
        "huggingface_hub",
    )
    .run_function(_bake_models)
)


# --------------------------------------------------------------------------- #
# Separation helpers
# --------------------------------------------------------------------------- #
def _run_demucs(audio_path, model_name: str, device: str, scratch):
    """Pass 1 via demucs's Python API with soundfile I/O (no torchcodec).

    Identical to the MPS runner: load → resample → per-track mean/std
    normalize → apply_model → denormalize → write FLOAT wavs.
    """
    from pathlib import Path

    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.audio import convert_audio
    from demucs.pretrained import get_model

    data, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.T)

    model = get_model(model_name)
    model.eval()
    wav = convert_audio(wav, sr, model.samplerate, model.audio_channels)

    ref = wav.mean(0)
    wav_n = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        sources = apply_model(
            model, wav_n[None], device=device, split=True, overlap=0.25, progress=False
        )[0]
    sources = sources * ref.std() + ref.mean()

    stems: dict = {}
    for name, source in zip(model.sources, sources):
        p = Path(scratch) / f"demucs_{name}.wav"
        sf.write(str(p), source.cpu().numpy().T, model.samplerate, subtype="FLOAT")
        stems[name] = p
    return stems


@app.function(image=image, gpu=GPU, timeout=1800)
def separate_remote(
    audio_bytes: bytes,
    filename: str,
    demucs_model: str = "mdx_extra",
    karaoke_model: str = "",
) -> dict:
    """Two-pass separation on CUDA.

    ``karaoke_model`` names the Pass-2 model for this call; empty (the default,
    and what an older caller sends) uses the image's baked-in ``KARAOKE_MODEL``.
    A name that was not baked into the image downloads on first use in this
    container, so it costs a download per cold start until it is added to
    ``EXTRA_KARAOKE_MODELS`` and the app is redeployed.

    Returns raw stems as bytes (the dispatcher mixes instrumental/karaoke and
    normalizes to 16-bit locally, via modal_worker._mix_and_finalize):

        {"ok": True, "pass2": "ok",
         "drums": b, "bass": b, "other": b,
         "lead_vocals": b, "backing_vocals": b}
    """
    import subprocess
    import tempfile
    from pathlib import Path

    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    with tempfile.TemporaryDirectory(prefix="sep_") as scratch:
        work = Path(scratch)
        # Keep the upload separate from ffmpeg's output even for input.wav.
        raw_in = work / ("source" + Path(filename or "input").suffix)
        raw_in.write_bytes(audio_bytes)
        audio_path = work / "input.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw_in),
             "-ar", "44100", "-ac", "2", str(audio_path)],
            check=True, capture_output=True,
        )

        stems = _run_demucs(audio_path, demucs_model, device, work)
        required = ("vocals", "drums", "bass", "other")
        for name in required:
            src = stems.get(name)
            if src is None or not src.is_file() or src.stat().st_size == 0:
                return {"ok": False, "error": f"{name} stem not produced"}

        karaoke_out = work / "_karaoke_out"
        karaoke_out.mkdir()
        try:
            from audio_separator.separator import Separator

            sep = Separator(
                model_file_dir=AS_MODEL_DIR,
                output_dir=str(karaoke_out),
                output_format="WAV",
            )
            sep.load_model(model_filename=karaoke_model or KARAOKE_MODEL)
            sep.separate(str(stems["vocals"]))
        except Exception as exc:
            return {"ok": False, "error": f"Pass-2 separation failed: {str(exc)[:300]}"}

        # Never guess roles from lexical order or substitute unsplit vocals.
        roles = {"lead_vocals": [], "backing_vocals": []}
        for path in karaoke_out.iterdir():
            if not path.is_file() or path.suffix.lower() != ".wav":
                continue
            name = path.name.lower()
            # The input basename can itself contain `_vocals_` (Demucs's
            # demucs_vocals.wav). Explicit separator role labels take priority
            # over those inherited words; two explicit roles remain ambiguous.
            lead = "(vocals)" in name
            backing = "(instrumental)" in name
            if not lead and not backing:
                lead = "_vocals_" in name
                backing = "_instrumental_" in name
            if lead and backing:
                return {"ok": False, "error": "Ambiguous Pass-2 stem roles"}
            if lead:
                roles["lead_vocals"].append(path)
            if backing:
                roles["backing_vocals"].append(path)
        for role, paths in roles.items():
            if len(paths) != 1 or paths[0].stat().st_size == 0:
                return {"ok": False, "error": f"Missing or ambiguous Pass-2 {role}"}
        out = {"ok": True, "pass2": "ok"}
        out.update({name: stems[name].read_bytes() for name in ("drums", "bass", "other")})
        out.update({role: paths[0].read_bytes() for role, paths in roles.items()})
        return out


# --------------------------------------------------------------------------- #
# Transcription
# --------------------------------------------------------------------------- #
def _is_out_of_memory(exc: BaseException) -> bool:
    """An accelerator OOM must never be swallowed as a bad segment.

    By class name (``torch.cuda.OutOfMemoryError`` / ``torch.OutOfMemoryError``)
    or the older plain-``RuntimeError`` "out of memory" message; no torch import.
    """
    if any(cls.__name__ == "OutOfMemoryError" for cls in type(exc).__mro__):
        return True
    return "out of memory" in str(exc).lower()


def _must_propagate(exc: BaseException) -> bool:
    """Errors that are never a skippable bad segment.

    Only a per-segment decode/post-processing fault (e.g. the tokenizer's
    ``IndexError`` on a truncated multibyte character) is skippable. Any
    ``RuntimeError`` (CUDA/MPS device asserts and ``torch.AcceleratorError``,
    which poison every later segment; cuBLAS/cuDNN failures; allocator
    failures) or ``MemoryError`` (incl. numpy's ``_ArrayMemoryError``), and any
    accelerator OOM, fails the song rather than silently truncating it.
    """
    return isinstance(exc, (RuntimeError, MemoryError)) or _is_out_of_memory(exc)


def _transcribe_vad_segments(pipe, audio, sr, vad_segments, generate_kwargs) -> tuple:
    """Per-VAD-segment decode with per-segment failure isolation.

    Mirrors ``transcribe_vad_segments`` in the local runner
    (backend/src/karaoke_backend/workers/heart_transcriptor.py): a segment whose
    decode raises is skipped and recorded (0-based ``index`` into
    ``vad_segments``, ``start``, ``end``, ``error``) instead of failing the whole
    song. ``RuntimeError``/``MemoryError`` and accelerator OOM propagate (see
    ``_must_propagate``); if every attempted segment raised, or more than
    ``max(1, attempted // 4)`` did, this raises. Returns
    ``(words, full_text_parts, skipped)``.
    """
    import sys

    import numpy as np

    full_text_parts: list[str] = []
    words: list[dict] = []
    skipped: list[dict] = []
    attempted = 0
    first_exc = None

    for seg_i, (seg_start, seg_end) in enumerate(vad_segments):
        s_idx, e_idx = int(float(seg_start) * sr), int(float(seg_end) * sr)
        slice_audio = audio[s_idx:e_idx].astype(np.float32)
        if len(slice_audio) < sr * 0.1:
            continue
        seg_kwargs = dict(generate_kwargs)
        seg_kwargs["max_new_tokens"] = max(
            8, min(440, int((float(seg_end) - float(seg_start)) * 12) + 8)
        )
        attempted += 1
        try:
            seg_result = pipe(
                {"array": slice_audio, "sampling_rate": sr},
                return_timestamps="word",
                generate_kwargs=seg_kwargs,
            )
            seg_text = seg_result.get("text", "").strip()
            seg_words: list[dict] = []
            for c in seg_result.get("chunks", []):
                text = c.get("text", "").strip()
                if not text:
                    continue
                ts = c.get("timestamp", (None, None))
                start = ts[0] if ts[0] is not None else 0.0
                end = ts[1] if ts[1] is not None else start + 0.1
                seg_words.append({
                    "word": text,
                    "start": float(start) + float(seg_start),
                    "end": float(end) + float(seg_start),
                })
        except Exception as exc:
            if _must_propagate(exc):
                raise
            if first_exc is None:
                first_exc = exc
            msg = str(exc)
            if len(msg) > 200:
                msg = msg[:200] + "..."
            error = f"{type(exc).__name__}: {msg}"
            skipped.append({
                "index": seg_i,
                "start": float(seg_start),
                "end": float(seg_end),
                "error": error,
            })
            sys.stderr.write(
                f"  seg {seg_i+1}/{len(vad_segments)} "
                f"[{float(seg_start):.1f}s-{float(seg_end):.1f}s]: "
                f"SKIPPED ({error})\n"
            )
            continue
        full_text_parts.append(seg_text)
        words.extend(seg_words)

    if attempted and len(skipped) == attempted:
        raise RuntimeError(
            f"All {attempted} attempted VAD segments failed to decode; "
            f"first error: {skipped[0]['error']}"
        ) from first_exc
    # A few hallucinated segments are tolerable; more than a quarter of the song
    # (at least one always allowed) means the decode itself is unhealthy.
    if len(skipped) > max(1, attempted // 4):
        raise RuntimeError(
            f"Too many VAD segments failed to decode: {len(skipped)} of {attempted}; "
            f"first error: {skipped[0]['error']}"
        ) from first_exc

    return words, full_text_parts, skipped


@app.function(image=image, gpu=GPU, timeout=1800)
def transcribe_remote(
    audio_bytes: bytes,
    filename: str,
    vad_segments: list | None = None,
    language: str = "en",
    temperature_fallback: bool = False,
) -> dict:
    """Heart transcription on CUDA (fp16). VAD segments come from the
    dispatcher (computed locally on CPU) exactly as in the MPS path.

    ``temperature_fallback`` mirrors ``--temperature-fallback`` on the local and
    MPS runners: off (the default) decodes greedily at 0.0 so the first pass is
    reproducible; on restores the 0.0/0.1/0.2/0.4 rescue ladder for the manual
    re-transcribe action.

    Returns: {"segments": [...], "language", "transcriber": "heart", "full_text"}
    plus ``"skipped_segments": [...]`` only when a VAD segment's decode raised
    and was skipped (see ``_transcribe_vad_segments``).
    """
    if vad_segments == []:
        return {"segments": [], "language": language, "transcriber": "heart", "full_text": ""}

    import tempfile
    from pathlib import Path

    import torch
    from transformers import (
        WhisperForConditionalGeneration,
        WhisperProcessor,
        pipeline,
    )

    work = Path(tempfile.mkdtemp(prefix="heart_"))
    audio_path = work / (filename or "input.wav")
    audio_path.write_bytes(audio_bytes)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    model = WhisperForConditionalGeneration.from_pretrained(
        HEART_DIR, torch_dtype=dtype, low_cpu_mem_usage=True
    )
    processor = WhisperProcessor.from_pretrained(HEART_DIR)
    pipe = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        device=device,
        torch_dtype=dtype,
        chunk_length_s=30,
        batch_size=1,
    )

    generate_kwargs = {
        "language": language,
        "task": "transcribe",
        "condition_on_prev_tokens": False,
        "compression_ratio_threshold": 1.8,
        "temperature": (0.0, 0.1, 0.2, 0.4) if temperature_fallback else 0.0,
        "logprob_threshold": -1.0,
        "no_speech_threshold": 0.4,
    }

    full_text_parts: list[str] = []
    words: list[dict] = []
    skipped: list[dict] = []

    if vad_segments is not None:
        import librosa

        audio, sr = librosa.load(str(audio_path), sr=16000, mono=True)
        words, full_text_parts, skipped = _transcribe_vad_segments(
            pipe, audio, sr, vad_segments, generate_kwargs
        )
        full_text = " ".join(p for p in full_text_parts if p)
    else:
        result = pipe(
            str(audio_path),
            return_timestamps="word",
            generate_kwargs=generate_kwargs,
        )
        for c in result.get("chunks", []):
            text = c.get("text", "").strip()
            if not text:
                continue
            ts = c.get("timestamp", (None, None))
            start = ts[0] if ts[0] is not None else 0.0
            end = ts[1] if ts[1] is not None else start + 0.1
            words.append({"word": text, "start": start, "end": end})
        full_text = result.get("text", "")

    # Group into segments by gaps > 1.5s (identical to the MPS/local runners).
    segments: list[dict] = []
    current: list[dict] = []
    for w in words:
        if current and w["start"] - current[-1]["end"] > 1.5:
            segments.append({
                "start": current[0]["start"],
                "end": current[-1]["end"],
                "text": " ".join(cw["word"] for cw in current),
                "words": current,
            })
            current = []
        current.append(w)
    if current:
        segments.append({
            "start": current[0]["start"],
            "end": current[-1]["end"],
            "text": " ".join(cw["word"] for cw in current),
            "words": current,
        })

    import shutil
    shutil.rmtree(work, ignore_errors=True)

    out = {
        "segments": segments,
        "language": language,
        "transcriber": "heart",
        "full_text": full_text,
    }
    # Only when something was skipped, so a clean song's result is unchanged.
    if skipped:
        out["skipped_segments"] = skipped
    return out


@app.function(image=image, gpu=GPU)
def healthcheck() -> dict:
    """Confirm the baked models are present and CUDA is visible in-container."""
    import os as _os

    import torch
    return {
        "heart_ckpt": _os.path.isdir(HEART_DIR),
        "as_models": _os.path.isdir(AS_MODEL_DIR),
        "cuda": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }


@app.local_entrypoint()
def smoke():
    """`modal run backend/modal_app.py` — builds the image (baking models on
    first run) and verifies both model dirs + CUDA from inside the container."""
    import json

    print(json.dumps(healthcheck.remote(), indent=2))
