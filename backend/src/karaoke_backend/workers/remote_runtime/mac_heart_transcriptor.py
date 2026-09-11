#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Remote (Apple Silicon / MPS) HeartTranscriptor runner.

This is the Mac-mini counterpart of ``backend/workers/heart_transcriptor.py``.
It is rsync'd to ``~/karaoke-worker/scripts/`` on the worker host and invoked
over SSH by ``backend/workers/remote.py::RemoteHeartTranscriber``.

The only meaningful difference from the local script is device selection:
the local box has CUDA; the Mac mini has MPS. Everything else — VAD-segment
slicing, per-segment word timestamps, output JSON shape — is identical so the
parser on the dispatcher side does not care which host produced the result.

Usage:
    .venv/bin/python scripts/mac_heart_transcriptor.py <audio.wav> \
        --model-path ckpt/HeartTranscriptor-oss \
        --vad-segments work/<id>/vad.json [--language en] [--fp32]

Outputs JSON to stdout:
    {"segments": [...], "language": "en", "transcriber": "heart", "full_text": "..."}
"""

import argparse
import json
import os
import sys

# Mirror of backend/workers/heart_transcriptor.py: the retry ladder is opt-in
# so the first pass decodes greedily at 0.0 and is reproducible; the manual
# re-transcribe action passes --temperature-fallback as the rescue path.
TEMPERATURE_LADDER = (0.0, 0.1, 0.2, 0.4)


def build_generate_kwargs(language: str, *, temperature_fallback: bool = False) -> dict:
    """Assemble the HF ``generate_kwargs`` for one Heart decode (pure)."""
    return {
        "language": language,
        "task": "transcribe",
        "condition_on_prev_tokens": False,
        "compression_ratio_threshold": 1.8,
        "temperature": TEMPERATURE_LADDER if temperature_fallback else 0.0,
        "logprob_threshold": -1.0,
        "no_speech_threshold": 0.4,
    }


def _pick_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", help="Path to audio file (WAV/FLAC)")
    parser.add_argument("--language", default="en", help="Language code")
    parser.add_argument("--model-path", default=None, help="Path to checkpoint dir")
    parser.add_argument(
        "--vad-segments",
        default=None,
        help="Path to JSON file with [[start_sec, end_sec], ...] VAD segments.",
    )
    parser.add_argument(
        "--fp32",
        action="store_true",
        help="Force float32 (fall back here if fp16 misbehaves on MPS).",
    )
    parser.add_argument(
        "--temperature-fallback",
        action="store_true",
        help="Enable the 0.0/0.1/0.2/0.4 temperature rescue ladder. OFF by default: "
             "the first transcription pass decodes greedily at 0.0 so it is "
             "reproducible. The manual re-transcribe action turns this on.",
    )
    args = parser.parse_args()

    # Let unsupported MPS ops silently fall back to CPU instead of erroring.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    if args.model_path:
        ckpt_dir = args.model_path
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        ckpt_dir = os.path.join(base, "ckpt", "HeartTranscriptor-oss")

    if not os.path.isdir(ckpt_dir):
        print(json.dumps({"error": f"Checkpoint not found: {ckpt_dir}"}))
        sys.exit(1)

    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor, pipeline

    device = _pick_device()
    dtype = torch.float32 if (args.fp32 or device == "cpu") else torch.float16
    sys.stderr.write(f"Loading HeartTranscriptor from {ckpt_dir} on {device} ({dtype})...\n")

    model = WhisperForConditionalGeneration.from_pretrained(
        ckpt_dir, torch_dtype=dtype, low_cpu_mem_usage=True
    )
    processor = WhisperProcessor.from_pretrained(ckpt_dir)

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

    generate_kwargs = build_generate_kwargs(
        args.language, temperature_fallback=args.temperature_fallback
    )

    full_text_parts: list[str] = []
    words: list[dict] = []

    if args.vad_segments:
        import librosa
        import numpy as np

        with open(args.vad_segments) as f:
            vad_segs = json.load(f)
        sys.stderr.write(
            f"VAD pre-segmentation: {len(vad_segs)} segments from {args.audio_path}\n"
        )

        audio, sr = librosa.load(args.audio_path, sr=16000, mono=True)
        sys.stderr.write(f"Loaded audio: {len(audio)/sr:.1f}s @ {sr}Hz\n")

        for seg_i, (seg_start, seg_end) in enumerate(vad_segs):
            s_idx = int(float(seg_start) * sr)
            e_idx = int(float(seg_end) * sr)
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
            sys.stderr.write(
                f"  seg {seg_i+1}/{len(vad_segs)} "
                f"[{float(seg_start):.1f}s-{float(seg_end):.1f}s]: "
                f"{len(seg_result.get('chunks', []))} words\n"
            )
        full_text = " ".join(p for p in full_text_parts if p)
    else:
        sys.stderr.write(f"Transcribing {args.audio_path}...\n")
        result = pipe(
            args.audio_path,
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

    # Group into segments by gaps > 1.5s
    segments = []
    current_words = []
    for w in words:
        if current_words and w["start"] - current_words[-1]["end"] > 1.5:
            segments.append({
                "start": current_words[0]["start"],
                "end": current_words[-1]["end"],
                "text": " ".join(cw["word"] for cw in current_words),
                "words": current_words,
            })
            current_words = []
        current_words.append(w)
    if current_words:
        segments.append({
            "start": current_words[0]["start"],
            "end": current_words[-1]["end"],
            "text": " ".join(cw["word"] for cw in current_words),
            "words": current_words,
        })

    output = {
        "segments": segments,
        "language": args.language,
        "transcriber": "heart",
        "full_text": full_text,
    }

    sys.stderr.write(f"Done: {len(segments)} segments, {len(words)} words\n")
    print(json.dumps(output))


if __name__ == "__main__":
    main()
