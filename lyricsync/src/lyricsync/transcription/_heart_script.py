#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Standalone script to run HeartTranscriptor for lyrics transcription.

Runs in a separate Python environment (requires torch + transformers).
Called as a subprocess from lyricsync.transcription.heart.HeartTranscriber.

Usage:
    python _heart_script.py <audio_path> --device cpu [--language en] [--model-path /path/to/checkpoint]

Outputs JSON to stdout:
    {"segments": [...], "language": "en"}
"""

import argparse
import json
import sys
import os

# The temperature rescue ladder is opt-in: the first transcription pass decodes
# greedily at 0.0 so it is reproducible, and only the caller's explicit
# re-transcribe action asks for the ladder via --temperature-fallback.
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", help="Path to audio file (WAV)")
    parser.add_argument("--language", default="en", help="Language code")
    parser.add_argument("--model-path", default=None, help="Path to checkpoint dir (required)")
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default=None)
    parser.add_argument(
        "--temperature-fallback",
        action="store_true",
        help="Enable the 0.0/0.1/0.2/0.4 temperature rescue ladder (default: greedy 0.0).",
    )
    args = parser.parse_args()

    if not args.model_path:
        print(json.dumps({"error": "--model-path is required when running from the library"}))
        sys.exit(1)

    ckpt_dir = args.model_path

    if not os.path.isdir(ckpt_dir):
        print(json.dumps({"error": f"Checkpoint not found: {ckpt_dir}"}))
        sys.exit(1)

    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor, pipeline

    sys.stderr.write(f"Loading HeartTranscriptor from {ckpt_dir}...\n")

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("Attested CUDA accelerator is unavailable")
    if device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("Attested Metal accelerator is unavailable")
    dtype = torch.float16 if device in ("cuda", "mps") else torch.float32

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

    sys.stderr.write(f"Transcribing {args.audio_path}...\n")

    result = pipe(
        args.audio_path,
        return_timestamps="word",
        generate_kwargs=build_generate_kwargs(
            args.language, temperature_fallback=args.temperature_fallback
        ),
    )

    chunks = result.get("chunks", [])
    words = []
    for c in chunks:
        text = c.get("text", "").strip()
        if not text:
            continue
        ts = c.get("timestamp", (None, None))
        start = ts[0] if ts[0] is not None else 0.0
        end = ts[1] if ts[1] is not None else start + 0.1
        words.append({"word": text, "start": start, "end": end})

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
        "full_text": result.get("text", ""),
    }

    sys.stderr.write(f"Done: {len(segments)} segments, {len(words)} words\n")
    print(json.dumps(output))


if __name__ == "__main__":
    main()
