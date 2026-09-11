#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Remote (Apple Silicon / MPS) two-pass stem separation runner.

Mac-mini counterpart of the demucs + audio-separator passes in
``backend/workers/modal_worker.py``. Invoked over SSH by
``backend/workers/remote.py::remote_separate``.

Produces, into ``--output-dir``:
    drums.wav, bass.wav, other.wav   (Pass 1 demucs — for the local instrumental mix)
    lead_vocals.wav, backing_vocals.wav  (Pass 2 mel_band_roformer karaoke split)

The instrumental/karaoke ffmpeg mixes are done back on the dispatcher host,
which already has ffmpeg, so this script never has to mix.

Pass 2 is non-fatal: if the karaoke model fails, the full vocals are used as
lead and a silent backing track is written — matching modal_worker's fallback.

Prints a one-line JSON status to stdout: {"ok": true, "pass2": "ok"|"fallback", "device": "mps"}
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path
from typing import Optional


def _pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    sys.stderr.write("RUN: " + " ".join(cmd) + "\n")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.stderr:
        sys.stderr.write(result.stderr[-2000:] + "\n")
    if result.returncode != 0:
        raise RuntimeError(f"command failed (exit {result.returncode})")
    return result


def _run_demucs(audio_path: Path, model_name: str, device: str, scratch: Path) -> dict:
    """Pass 1 via demucs's Python API with soundfile I/O.

    The demucs CLI uses ``torchaudio.load``, which in torchaudio 2.9+ delegates
    to TorchCodec and needs ffmpeg *shared libraries* — unavailable on this Mac
    (no Homebrew). soundfile (libsndfile, bundled in its wheel) reads/writes WAV
    with no codec libs, so we load/resample/run/save ourselves. This mirrors the
    normalization demucs.separate applies (per-track mean/std).
    """
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.audio import convert_audio
    from demucs.pretrained import get_model

    data, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.T)  # [channels, samples]

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
        p = scratch / f"demucs_{name}.wav"
        sf.write(str(p), source.cpu().numpy().T, model.samplerate, subtype="FLOAT")
        stems[name] = p
    return stems


def _create_silent_wav(path: Path, reference_wav: Path) -> None:
    try:
        with wave.open(str(reference_wav), "rb") as ref:
            params = ref.getparams()
        with wave.open(str(path), "wb") as out:
            out.setparams(params)
            out.writeframes(b"\x00" * (params.nframes * params.sampwidth * params.nchannels))
    except Exception:
        sample_rate = 44100
        num_samples = sample_rate * 10
        data_size = num_samples * 2
        header = (
            b"RIFF" + (36 + data_size).to_bytes(4, "little") + b"WAVE" + b"fmt "
            + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little")
            + sample_rate.to_bytes(4, "little") + (sample_rate * 2).to_bytes(4, "little")
            + (2).to_bytes(2, "little") + (16).to_bytes(2, "little") + b"data"
            + data_size.to_bytes(4, "little") + b"\x00" * data_size
        )
        path.write_bytes(header)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--demucs-model", default="mdx_extra")
    parser.add_argument("--device", default="auto", help="auto|mps|cuda|cpu")
    parser.add_argument("--karaoke-model", required=True)
    parser.add_argument("--karaoke-model-dir", required=True)
    parser.add_argument("--demucs-timeout", type=int, default=1800)
    parser.add_argument("--karaoke-timeout", type=int, default=1800)
    args = parser.parse_args()

    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    audio_path = Path(args.audio_path).resolve()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir.parent
    device = _pick_device(args.device)
    py = sys.executable
    audio_sep = str(Path(py).parent / "audio-separator")

    # ---- Pass 1: demucs (in-process; soundfile I/O, no torchcodec) ----
    stems = _run_demucs(audio_path, args.demucs_model, device, work)
    vocals_src = stems.get("vocals")
    if not vocals_src or not vocals_src.exists():
        print(json.dumps({"ok": False, "error": "vocals stem not produced"}))
        sys.exit(1)
    for stem in ("drums", "bass", "other"):
        src = stems.get(stem)
        if src and src.exists():
            shutil.copy2(src, out_dir / f"{stem}.wav")

    # ---- Pass 2: mel_band_roformer karaoke split (non-fatal) ----
    pass2 = "ok"
    karaoke_out = work / "_karaoke_out"
    karaoke_out.mkdir(parents=True, exist_ok=True)
    try:
        _run(
            [audio_sep, str(vocals_src),
             "--model_filename", args.karaoke_model,
             "--model_file_dir", args.karaoke_model_dir,
             "--output_dir", str(karaoke_out),
             "--output_format", "WAV"],
            timeout=args.karaoke_timeout,
        )
    except Exception as exc:
        sys.stderr.write(f"Pass 2 failed, using full vocals as lead: {exc}\n")
        shutil.copy2(vocals_src, out_dir / "lead_vocals.wav")
        _create_silent_wav(out_dir / "backing_vocals.wav", vocals_src)
        pass2 = "fallback"
    else:
        # audio-separator: "(Vocals)" = lead, "(Instrumental)" = backing
        lead_found = backing_found = False
        for f in karaoke_out.iterdir():
            name = f.name.lower()
            if "(vocals)" in name or "_vocals_" in name:
                shutil.copy2(f, out_dir / "lead_vocals.wav"); lead_found = True
            elif "(instrumental)" in name or "_instrumental_" in name:
                shutil.copy2(f, out_dir / "backing_vocals.wav"); backing_found = True
        if not lead_found or not backing_found:
            outputs = sorted(karaoke_out.glob("*.wav"))
            if len(outputs) >= 2:
                shutil.copy2(outputs[-1], out_dir / "lead_vocals.wav")
                shutil.copy2(outputs[0], out_dir / "backing_vocals.wav")
                lead_found = backing_found = True
        if not lead_found:
            shutil.copy2(vocals_src, out_dir / "lead_vocals.wav")
        if not backing_found:
            _create_silent_wav(out_dir / "backing_vocals.wav", vocals_src)

    for p in stems.values():
        try:
            p.unlink()
        except OSError:
            pass
    shutil.rmtree(karaoke_out, ignore_errors=True)

    print(json.dumps({"ok": True, "pass2": pass2, "device": device}))


if __name__ == "__main__":
    main()
