#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Standalone script to run HeartTranscriptor for lyrics transcription.

Runs in .venv-demucs (requires torch + transformers).
Called as a subprocess from word_sync_worker.py.

Usage:
    .venv-demucs/bin/python workers/heart_transcriptor.py <audio_path> [--language en]

Outputs JSON to stdout with the same format as our Whisper pipeline:
    {"segments": [...], "language": "en"}
"""

import argparse
import json
import sys
import os

# The rescue ladder: whisper retries a chunk at each successive temperature
# when the logprob/compression checks reject the previous decode. It is what
# makes a run non-reproducible, so it is OPT-IN (--temperature-fallback) and
# reserved for the manual re-transcribe action. The first pass decodes greedily
# at 0.0 and is therefore deterministic.
TEMPERATURE_LADDER = (0.0, 0.1, 0.2, 0.4)


def build_generate_kwargs(language: str, *, temperature_fallback: bool = False) -> dict:
    """Assemble the HF ``generate_kwargs`` for one Heart decode.

    Pure — no torch, no model. Kept separate so the temperature policy is
    testable without a checkpoint.
    """
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
    parser.add_argument("--model-path", default=None, help="Path to checkpoint dir")
    parser.add_argument(
        "--vad-segments",
        default=None,
        help="Path to JSON file with [[start_sec, end_sec], ...] VAD segments. "
             "When set, the script slices audio per segment and offsets word timestamps "
             "back to global time, instead of running the full file through the HF pipeline.",
    )
    parser.add_argument(
        "--temperature-fallback",
        action="store_true",
        help="Enable the 0.0/0.1/0.2/0.4 temperature rescue ladder. OFF by default: "
             "the first transcription pass decodes greedily at 0.0 so it is "
             "reproducible. The manual re-transcribe action turns this on.",
    )
    args = parser.parse_args()

    # Find checkpoint
    if args.model_path:
        ckpt_dir = args.model_path
    else:
        # KARAOKE_HEART_CKPT env override, else cwd-relative: the backend spawns
        # this script with cwd=backend/, where ckpt/ lives.
        ckpt_dir = os.getenv("KARAOKE_HEART_CKPT") or os.path.join(
            os.getcwd(), "ckpt", "HeartTranscriptor-oss"
        )

    if not os.path.isdir(ckpt_dir):
        print(json.dumps({"error": f"Checkpoint not found: {ckpt_dir}"}))
        sys.exit(1)

    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor, pipeline

    # fp16 matmul is unimplemented on PyTorch CPU ("addmm_impl_cpu_ not
    # implemented for 'Half'"), so only use it on CUDA; CPU runs fp32.
    use_cuda = torch.cuda.is_available()
    device = "cuda" if use_cuda else "cpu"
    dtype = torch.float16 if use_cuda else torch.float32

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

        # Whisper expects 16k mono float32. Load once, slice per segment.
        audio, sr = librosa.load(args.audio_path, sr=16000, mono=True)
        sys.stderr.write(f"Loaded audio: {len(audio)/sr:.1f}s @ {sr}Hz\n")

        for seg_i, (seg_start, seg_end) in enumerate(vad_segs):
            s_idx = int(float(seg_start) * sr)
            e_idx = int(float(seg_end) * sr)
            slice_audio = audio[s_idx:e_idx].astype(np.float32)
            if len(slice_audio) < sr * 0.1:
                continue
            # Bound the decode to what the slice could plausibly contain. Left
            # at the 448-token default, a low-content slice never emits EOS and
            # runs to max_length; with return_timestamps="word" the alignment
            # path then holds cross-attention for every layer and head across
            # the whole decode, spiking GiB on a slice worth a few words. VAD
            # drops most such slices now — this bounds whatever still arrives.
            seg_kwargs = dict(generate_kwargs)
            seg_kwargs["max_new_tokens"] = max(
                8, min(440, int((float(seg_end) - float(seg_start)) * 12) + 8)
            )
            seg_result = pipe(
                {"array": slice_audio, "sampling_rate": sr},
                return_timestamps="word",
                generate_kwargs=seg_kwargs,
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
