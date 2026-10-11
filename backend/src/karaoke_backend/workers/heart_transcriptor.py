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
import math
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


# Longest exception message carried into a skip record / stderr line.
_SKIP_MSG_LIMIT = 200


def _is_out_of_memory(exc: BaseException) -> bool:
    """True for an accelerator OOM, which must never be swallowed as a bad segment.

    Detected without importing torch: ``torch.cuda.OutOfMemoryError`` (and its
    ``torch.OutOfMemoryError`` alias) by class name anywhere in the MRO, and the
    older / MPS form, a plain ``RuntimeError`` whose message says "out of memory".
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


def _describe_exception(exc: BaseException) -> str:
    msg = str(exc)
    if len(msg) > _SKIP_MSG_LIMIT:
        msg = msg[:_SKIP_MSG_LIMIT] + "..."
    return f"{type(exc).__name__}: {msg}"


def transcribe_vad_segments(pipe, audio, sr, vad_segs, generate_kwargs, log=None):
    """Decode each VAD segment separately and offset word times back to global.

    Returns ``(words, full_text_parts, skipped)``. A segment whose decode (or
    result post-processing) raises is logged, recorded in ``skipped`` as
    ``{"index", "start", "end", "error"}`` (``index`` is the 0-based position in
    ``vad_segs``), contributes no words or text, and does not stop the song: a
    hallucinated tail must not fail every other segment with it. Only such
    per-segment faults are skippable: ``RuntimeError``/``MemoryError`` (device
    asserts, allocator failures) and accelerator OOM propagate, as does anything
    that is not an ``Exception``. If every attempted segment raised, or more than
    ``max(1, attempted // 4)`` did, the song genuinely failed and this raises.

    No torch import: ``pipe`` is any callable with the HF ASR pipeline's shape.
    """
    import numpy as np

    if log is None:
        log = sys.stderr.write

    full_text_parts: list[str] = []
    words: list[dict] = []
    skipped: list[dict] = []
    attempted = 0
    first_exc = None

    for seg_i, (seg_start, seg_end) in enumerate(vad_segs):
        s_idx = int(float(seg_start) * sr)
        # Clamp rounding to one decoder window; retain guarded segment recovery.
        e_idx = min(int(float(seg_end) * sr), s_idx + int(WINDOW_SECONDS * sr))
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
            n_chunks = len(seg_result.get("chunks", []))
        except Exception as exc:
            if _must_propagate(exc):
                raise
            if first_exc is None:
                first_exc = exc
            error = _describe_exception(exc)
            skipped.append({
                "index": seg_i,
                "start": float(seg_start),
                "end": float(seg_end),
                "error": error,
            })
            log(
                f"  seg {seg_i+1}/{len(vad_segs)} "
                f"[{float(seg_start):.1f}s-{float(seg_end):.1f}s]: "
                f"SKIPPED ({error})\n"
            )
            continue
        full_text_parts.append(seg_text)
        words.extend(seg_words)
        log(
            f"  seg {seg_i+1}/{len(vad_segs)} "
            f"[{float(seg_start):.1f}s-{float(seg_end):.1f}s]: "
            f"{n_chunks} words\n"
        )

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
# --------------------------------------------------------------------------- #
# Maximum VAD segment length
# --------------------------------------------------------------------------- #
# Word timestamps come from cross-attention concatenated over every decode
# step, layer and head, so decode memory grows with the tokens a slice yields,
# i.e. with its length. The parent process splits VAD regions; with
# ``--max-segment-seconds auto`` it splits at a 30 s ceiling and this script,
# which knows the device, re-splits longer slices to a cap chosen from the
# free accelerator memory measured AFTER the model is loaded.
#
# The helpers below are pure (no torch) so the policy is testable without a
# checkpoint. This script runs in its own processing environment, which is
# not guaranteed to have lyricsync installed, so the policy lives here rather
# than being imported.

AUTO_MAX_SEGMENT = "auto"
# bounded-v1 was measured with 15-second managed VAD slices. Library defaults
# and adaptive recommendations must not expand that admitted GPU workload.
MEASURED_MAX_SEGMENT_SECONDS = 15.0
# Whisper's window; also the pipeline's chunk_length_s. No slice may exceed it.
WINDOW_SECONDS = 30
GIB = 1024 ** 3

# (minimum free bytes after model load, cap in seconds), checked in order;
# below every tier the cap is CUDA_FLOOR_SEGMENT_SECONDS.
#
# These thresholds are conservative ESTIMATES, not measurements, and should
# be re-measured on real cards. The reasoning: the Heart checkpoint holds
# roughly 3-3.5 GiB in fp16, so an 8 GB card that also drives a desktop
# (~1.5 GiB) has only ~2-3 GiB free after loading, which is where a ~29 s
# slice ran out of memory; it stays at 15 s. A 24 GB card with a few GiB in
# use has well over 12 GiB free and gets the full 30 s window. Cards in
# between (12-16 GB) get 20 s.
CUDA_SEGMENT_TIERS = (
    (12 * GIB, 30.0),
    (6 * GIB, 20.0),
)
CUDA_FLOOR_SEGMENT_SECONDS = 15.0
# CPU keeps 15 s; host RAM is not probed. CPU decodes in fp32, so a 30 s
# slice roughly doubles the host memory the word-timestamp attention holds,
# which risks the OOM killer on 8-16 GB machines.
CPU_SEGMENT_SECONDS = 15.0
# Any other accelerator (mps, xpu, unknown) or a failed memory read keeps the
# cap that is known to be safe on ~8 GB cards.
SAFE_SEGMENT_SECONDS = 15.0


def parse_max_segment_seconds(value: str):
    """argparse type for ``--max-segment-seconds``: ``"auto"`` or a positive number."""
    if value.strip().lower() == AUTO_MAX_SEGMENT:
        return AUTO_MAX_SEGMENT
    try:
        seconds = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"expected 'auto' or seconds, got {value!r}"
        ) from None
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError(f"segment length must be > 0, got {value!r}")
    return seconds


def resolve_max_segment_seconds(device_type: str, free_bytes) -> float:
    """Pick the automatic cap for a device (pure).

    ``device_type`` is the torch device type ("cuda" covers ROCm builds too);
    ``free_bytes`` is free device memory after the model is loaded, or None if
    it could not be read.
    """
    if device_type == "cpu":
        return CPU_SEGMENT_SECONDS
    if device_type != "cuda" or free_bytes is None:
        return SAFE_SEGMENT_SECONDS
    for min_free, seconds in CUDA_SEGMENT_TIERS:
        if free_bytes >= min_free:
            return seconds
    return CUDA_FLOOR_SEGMENT_SECONDS


def split_segments_to_cap(segments, cap: float) -> list:
    """Re-split any segment longer than ``cap`` into equal parts (pure).

    A segment of length L > cap becomes ceil(L / cap) parts of length
    L / parts, so every part is <= cap and no short sliver is left at the end.
    Segments within the cap pass through unchanged; coverage is preserved.
    """
    out = []
    for seg_start, seg_end in segments:
        start, end = float(seg_start), float(seg_end)
        length = end - start
        if length <= cap:
            out.append((start, end))
            continue
        # The epsilon keeps float noise (e.g. 30.000000001 / 30) from adding
        # a near-empty extra part.
        parts = max(1, math.ceil(length / cap - 1e-9))
        step = length / parts
        for i in range(parts):
            out.append((start + i * step, end if i == parts - 1 else start + (i + 1) * step))
    return out


def _free_device_bytes(torch, device: str):
    """Free memory on a CUDA device, or None when it cannot be read."""
    try:
        free, _total = torch.cuda.mem_get_info(torch.device(device))
        return int(free)
    except Exception:  # noqa: BLE001 - any failure falls back to the safe cap
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", help="Path to audio file (WAV)")
    parser.add_argument("--language", default="en", help="Language code")
    parser.add_argument("--model-path", default=None, help="Path to checkpoint dir")
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default=None)
    parser.add_argument("--managed-vad-config", default=None, help="Run RMS VAD inside the admitted managed worker using this JSON configuration")
    parser.add_argument(
        "--vad-segments",
        default=None,
        help="Path to JSON file with [[start_sec, end_sec], ...] VAD segments. "
             "When set, the script slices audio per segment and offsets word timestamps "
             "back to global time, instead of running the full file through the HF pipeline.",
    )
    parser.add_argument(
        "--max-segment-seconds",
        type=parse_max_segment_seconds,
        default=None,
        help="Longest slice decoded in one pass when --vad-segments is set: "
             "'auto' sizes it from free device memory after the model loads, "
             "a number is a fixed cap. Longer VAD segments are re-split into "
             "equal parts. Omitted: segments are decoded as given.",
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

    from contextlib import nullcontext
    guarded = (os.getenv("KARAOKE_PROCESSING_ACCELERATOR") == "cuda"
               or bool(os.getenv("KARAOKE_PROCESSING_MEMORY_JSON")))
    if guarded:
        from karaoke_backend.workers.memory_admission import admit
    if args.managed_vad_config is not None and (not guarded or args.vad_segments):
        raise ValueError("Managed VAD requires a managed worker and cannot combine with external segments")
    admission = nullcontext(args.device)
    if guarded:
        admission = admit("heart-transcriptor", args.device, [args.audio_path],
                          unmeasured_cuda=unmeasured_gpu_path(args))
    with admission as selected:
        args.device = selected
        args.managed_vad_segments = (managed_vad_segments(args.audio_path, args.managed_vad_config)
                                     if args.managed_vad_config is not None else None)
        run_inference(args, ckpt_dir)


def unmeasured_gpu_path(args):
    """Name a requested mode outside the measured GPU profile, or None.

    The GPU budget was measured with managed VAD at the default ``VadConfig``
    (the qualification profiler passes ``--managed-vad-config {}``) and greedy
    decoding, so every managed slice retains the measured 15-second ceiling.
    Anything else uses the CPU budget instead.
    """
    if args.managed_vad_config is not None:
        from lyricsync._config import VadConfig
        if vad_config_from_json(args.managed_vad_config) != VadConfig():
            return "transcription with a non-default voice activity configuration"
    elif not args.vad_segments:
        return "whole-file transcription without voice activity detection"
    else:
        problem = segment_problem(args.vad_segments, args.audio_path)
        if problem is not None:
            return f"transcription of supplied segments with {problem}"
    if args.temperature_fallback:
        return "transcription with temperature fallback"
    return None


def segment_problem(segments_path, audio_path):
    """Why supplied VAD segments fall outside the measured profile, or None.

    Segments must be finite, ordered and non-overlapping, inside the audio,
    and no longer than the measured maximum segment length.
    """
    import math
    from lyricsync._config import VadConfig
    longest = MEASURED_MAX_SEGMENT_SECONDS
    try:
        import soundfile
        with open(segments_path) as handle:
            segments = json.load(handle)
        duration = soundfile.info(audio_path).duration
    except Exception:  # noqa: BLE001 - unreadable input is simply unmeasured
        return "unreadable segments or audio"
    if not isinstance(segments, list):
        return "a malformed segment list"
    previous_end = 0.0
    # Allow one 16 kHz sample of rounding at the end of the audio.
    tolerance = 1 / 16000
    for segment in segments:
        if (not isinstance(segment, (list, tuple)) or len(segment) != 2
                or not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in segment)):
            return "a malformed segment"
        start, end = (float(value) for value in segment)
        if not (math.isfinite(start) and math.isfinite(end)):
            return "a non-finite boundary"
        if start < previous_end or end <= start:
            return "overlapping or unordered segments"
        if end > duration + tolerance:
            return "a segment past the end of the audio"
        if end - start > longest + 1e-9:
            return f"a segment longer than the measured {longest:g} seconds"
        previous_end = end
    return None


def vad_config_from_json(configuration):
    """Build the installed VadConfig, ignoring fields this version lacks.

    The worker script and the processing runtime can differ by a release in
    development; unknown keys keep that skew from failing the job.
    """
    from dataclasses import fields
    from lyricsync._config import VadConfig
    values = json.loads(configuration)
    if not isinstance(values, dict):
        raise ValueError("Managed VAD configuration must be a JSON object")
    known = {field.name for field in fields(VadConfig)}
    return VadConfig(**{key: value for key, value in values.items() if key in known})


def managed_vad_segments(audio_path, configuration):
    """Decode managed PCM/FLOAT WAV after admission, preserving RMS segmentation."""
    import soundfile
    from lyricsync.audio.vad import rms_vad_segments
    config = vad_config_from_json(configuration)
    # This managed entry point remains inside the existing measured workload.
    from dataclasses import replace
    config = replace(config, max_segment_duration=min(
        config.max_segment_duration or MEASURED_MAX_SEGMENT_SECONDS, MEASURED_MAX_SEGMENT_SECONDS))
    samples, sample_rate = soundfile.read(audio_path, dtype="float32", always_2d=True)
    samples = samples.mean(axis=1)
    return rms_vad_segments(samples, sample_rate, config)


def run_inference(args, ckpt_dir):
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor, pipeline

    # fp16 matmul is unimplemented on PyTorch CPU ("addmm_impl_cpu_ not
    # implemented for 'Half'"), so only use it on CUDA; CPU runs fp32.
    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("Attested CUDA accelerator is unavailable")
    if device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("Attested Metal accelerator is unavailable")
    dtype = torch.float16 if device in ("cuda", "mps") else torch.float32

    sys.stderr.write(f"Loading HeartTranscriptor from {ckpt_dir} on {device} ({dtype})...\n")

    model = WhisperForConditionalGeneration.from_pretrained(
        ckpt_dir, torch_dtype=dtype, low_cpu_mem_usage=True, local_files_only=True
    )
    processor = WhisperProcessor.from_pretrained(ckpt_dir, local_files_only=True)

    pipe = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        device=device,
        torch_dtype=dtype,
        chunk_length_s=WINDOW_SECONDS,
        batch_size=1,
    )

    generate_kwargs = build_generate_kwargs(
        args.language, temperature_fallback=args.temperature_fallback
    )

    full_text_parts: list[str] = []
    words: list[dict] = []
    skipped: list[dict] = []

    if args.vad_segments or getattr(args, "managed_vad_segments", None) is not None:
        import librosa

        if getattr(args, "managed_vad_segments", None) is not None:
            vad_segs = args.managed_vad_segments
        else:
            with open(args.vad_segments) as f:
                vad_segs = json.load(f)
        sys.stderr.write(
            f"VAD pre-segmentation: {len(vad_segs)} segments from {args.audio_path}\n"
        )

        if args.max_segment_seconds is not None:
            if args.max_segment_seconds == AUTO_MAX_SEGMENT:
                device_type = torch.device(device).type
                free_bytes = (
                    _free_device_bytes(torch, device) if device_type == "cuda" else None
                )
                cap = resolve_max_segment_seconds(device_type, free_bytes)
                free_note = (
                    f"{free_bytes / GIB:.2f} GiB free" if free_bytes is not None
                    else "free memory not read"
                )
                sys.stderr.write(
                    f"Max segment: auto -> {cap:.1f}s on {device} ({free_note})\n"
                )
            else:
                cap = float(args.max_segment_seconds)
                sys.stderr.write(f"Max segment: fixed {cap:.1f}s\n")
            before = len(vad_segs)
            vad_segs = split_segments_to_cap(vad_segs, cap)
            if len(vad_segs) != before:
                sys.stderr.write(
                    f"Re-split {before} VAD segments into {len(vad_segs)} (<= {cap:.1f}s)\n"
                )

        # Whisper expects 16k mono float32. Load once, slice per segment.
        audio, sr = librosa.load(args.audio_path, sr=16000, mono=True)
        sys.stderr.write(f"Loaded audio: {len(audio)/sr:.1f}s @ {sr}Hz\n")

        words, full_text_parts, skipped = transcribe_vad_segments(
            pipe, audio, sr, vad_segs, generate_kwargs
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
    # Only when something was skipped, so a clean song's JSON is unchanged.
    if skipped:
        output["skipped_segments"] = skipped
        sys.stderr.write(
            f"Skipped {len(skipped)} VAD segment(s) after decode errors: "
            + ", ".join(
                f"seg {sk['index'] + 1} [{sk['start']:.1f}s-{sk['end']:.1f}s]" for sk in skipped
            )
            + "\n"
        )

    sys.stderr.write(f"Done: {len(segments)} segments, {len(words)} words\n")
    print(json.dumps(output))


if __name__ == "__main__":
    main()
