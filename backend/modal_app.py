#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Modal GPU app: karaoke stem separation (demucs + mel_band_roformer) + Heart
transcription, running on a CUDA container instead of the local box / Mac MPS.

This is the cloud counterpart of ``workers/remote_runtime/{mac_separate,
mac_heart_transcriptor}.py`` (which target Apple-Silicon MPS over SSH). Same
two-pass separation, same Heart per-VAD-segment transcription, same output
shapes — only the transport (Modal RPC + bytes) and the device (CUDA) differ.
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
# Separation helpers (mirror workers/remote_runtime/mac_separate.py)
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


def _silent_wav_bytes(reference_wav) -> bytes:
    """Silent WAV matching a reference's params (for the pass-2 fallback)."""
    import io
    import wave

    try:
        with wave.open(str(reference_wav), "rb") as ref:
            params = ref.getparams()
        buf = io.BytesIO()
        with wave.open(buf, "wb") as out:
            out.setparams(params)
            out.writeframes(b"\x00" * (params.nframes * params.sampwidth * params.nchannels))
        return buf.getvalue()
    except Exception:
        sample_rate, num_samples = 44100, 44100 * 10
        data_size = num_samples * 2
        return (
            b"RIFF" + (36 + data_size).to_bytes(4, "little") + b"WAVE" + b"fmt "
            + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little")
            + sample_rate.to_bytes(4, "little") + (sample_rate * 2).to_bytes(4, "little")
            + (2).to_bytes(2, "little") + (16).to_bytes(2, "little") + b"data"
            + data_size.to_bytes(4, "little") + b"\x00" * data_size
        )


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

        {"ok": True, "pass2": "ok"|"fallback",
         "drums": b, "bass": b, "other": b,
         "lead_vocals": b, "backing_vocals": b}
    """
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path

    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    work = Path(tempfile.mkdtemp(prefix="sep_"))

    # Normalize any input container (mp3/m4a/flac/wav) to 44.1k WAV so
    # soundfile can read it (matches demucs's own ffmpeg-backed loading).
    raw_in = work / (filename or "input")
    raw_in.write_bytes(audio_bytes)
    audio_path = work / "input.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw_in),
         "-ar", "44100", "-ac", "2", str(audio_path)],
        check=True, capture_output=True,
    )

    # ---- Pass 1: demucs ----
    stems = _run_demucs(audio_path, demucs_model, device, work)
    vocals_src = stems.get("vocals")
    if not vocals_src or not vocals_src.exists():
        return {"ok": False, "error": "vocals stem not produced"}

    out: dict = {"ok": True, "pass2": "ok"}
    for stem in ("drums", "bass", "other"):
        src = stems.get(stem)
        if src and src.exists():
            out[stem] = src.read_bytes()

    # ---- Pass 2: karaoke lead/backing split (non-fatal) ----
    pass2_model = karaoke_model or KARAOKE_MODEL
    karaoke_out = work / "_karaoke_out"
    karaoke_out.mkdir(parents=True, exist_ok=True)
    try:
        from audio_separator.separator import Separator

        sep = Separator(
            model_file_dir=AS_MODEL_DIR,
            output_dir=str(karaoke_out),
            output_format="WAV",
        )
        sep.load_model(model_filename=pass2_model)
        sep.separate(str(vocals_src))
    except Exception as exc:  # pass 2 is non-fatal — full vocals as lead
        out["lead_vocals"] = vocals_src.read_bytes()
        out["backing_vocals"] = _silent_wav_bytes(vocals_src)
        out["pass2"] = "fallback"
        out["pass2_error"] = str(exc)[:300]
    else:
        # audio-separator: "(Vocals)" = lead, "(Instrumental)" = backing.
        lead = backing = None
        for f in karaoke_out.iterdir():
            name = f.name.lower()
            if "(vocals)" in name or "_vocals_" in name:
                lead = f
            elif "(instrumental)" in name or "_instrumental_" in name:
                backing = f
        if lead is None or backing is None:
            outputs = sorted(karaoke_out.glob("*.wav"))
            if len(outputs) >= 2:
                lead, backing = outputs[-1], outputs[0]
        out["lead_vocals"] = lead.read_bytes() if lead else vocals_src.read_bytes()
        out["backing_vocals"] = (
            backing.read_bytes() if backing else _silent_wav_bytes(vocals_src)
        )

    shutil.rmtree(work, ignore_errors=True)
    return out


# --------------------------------------------------------------------------- #
# Transcription (mirror workers/remote_runtime/mac_heart_transcriptor.py)
# --------------------------------------------------------------------------- #
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
    """
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

    if vad_segments:
        import librosa
        import numpy as np

        audio, sr = librosa.load(str(audio_path), sr=16000, mono=True)
        for seg_start, seg_end in vad_segments:
            s_idx, e_idx = int(float(seg_start) * sr), int(float(seg_end) * sr)
            slice_audio = audio[s_idx:e_idx].astype(np.float32)
            if len(slice_audio) < sr * 0.1:
                continue
            seg_result = pipe(
                {"array": slice_audio, "sampling_rate": sr},
                return_timestamps="word",
                generate_kwargs=generate_kwargs,
            )
            full_text_parts.append(seg_result.get("text", "").strip())
            for c in seg_result.get("chunks", []):
                text = c.get("text", "").strip()
                if not text:
                    continue
                ts = c.get("timestamp", (None, None))
                start = ts[0] if ts[0] is not None else 0.0
                end = ts[1] if ts[1] is not None else start + 0.1
                words.append({
                    "word": text,
                    "start": float(start) + float(seg_start),
                    "end": float(end) + float(seg_start),
                })
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

    return {
        "segments": segments,
        "language": language,
        "transcriber": "heart",
        "full_text": full_text,
    }


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
