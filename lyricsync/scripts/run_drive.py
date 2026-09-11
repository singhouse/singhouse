# SPDX-License-Identifier: MIT
"""
Run the lyricsync pipeline on Drive's lead vocals stem with a chosen
whisper model and reference-lyrics mode, writing word_data JSON
in the catalog shape.

Examples:
    python run_drive.py large-v3-turbo synced -o runs/large-v3-turbo-synced.json
    python run_drive.py large-v3 plain    -o runs/large-v3-plain.json
    python run_drive.py base   none       -o runs/base-none.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DRIVE_VOCALS = REPO / "backend/uploads/test/8194af6b4201/stems/lead_vocals.wav"
DRIVE_LRC = Path(os.environ.get("LRC", REPO / "lyricsync/scripts/data/drive.lrc"))
DRIVE_PLAIN = Path(os.environ.get("TXT", REPO / "lyricsync/scripts/data/drive.txt"))


HEART_PYTHON = REPO / "backend/.venv-demucs/bin/python"
HEART_SCRIPT = REPO / "backend/src/karaoke_backend/workers/heart_transcriptor.py"


def _make_transcriber(model: str):
    if model == "heart":
        from lyricsync.transcription.heart import HeartTranscriber
        return HeartTranscriber(
            python_path=HEART_PYTHON, script_path=HEART_SCRIPT,
        )
    if model == "heart-vad":
        from lyricsync.transcription.heart import HeartTranscriber
        return HeartTranscriber(
            python_path=HEART_PYTHON, script_path=HEART_SCRIPT,
            use_vad=True,
        )
    from lyricsync.transcription.faster_whisper import FasterWhisperTranscriber
    return FasterWhisperTranscriber(model=model)


def run(model: str, ref_mode: str, audio: Path, out_path: Path,
        anchor_gap: bool = False, gap_chain: bool = False) -> dict:
    from lyricsync import SyncPipeline, PipelineConfig

    plain = synced = None
    if ref_mode == "synced":
        synced = DRIVE_LRC.read_text()
    elif ref_mode == "plain":
        plain = DRIVE_PLAIN.read_text()
    elif ref_mode == "none":
        pass
    else:
        raise SystemExit(f"unknown ref_mode {ref_mode!r}")

    pipeline = SyncPipeline(
        transcriber=_make_transcriber(model),
        config=PipelineConfig(
            use_anchor_gap_alignment=anchor_gap,
            gap_handler_chain=gap_chain,
        ),
    )

    t0 = time.time()
    result = pipeline.run(
        audio_path=str(audio),
        plain_lyrics=plain,
        synced_lyrics=synced,
        language="en",
    )
    elapsed = time.time() - t0

    if result is None:
        raise SystemExit("pipeline returned None")

    lines_out = [
        [{"word": w.text, "start": w.start, "end": w.end} for w in line]
        for line in result.lines
    ]
    payload = {
        "lines": lines_out,
        "segments": result.segments,
        "metadata": {
            "words_total": result.metadata.words_total,
            "words_matched": result.metadata.words_matched,
            "words_corrected": result.metadata.words_corrected,
            "words_interpolated": result.metadata.words_interpolated,
            "lines_total": result.metadata.lines_total,
            "method": result.metadata.method,
            "language": result.metadata.language,
            "model": model,
            "ref_mode": ref_mode,
            "elapsed_seconds": elapsed,
            **result.metadata.extra,
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, default=lambda x: x.__dict__))
    print(f"wrote {out_path}  ({elapsed:.1f}s, {sum(len(l) for l in lines_out)} words)")
    return payload


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("model", help="whisper model name (e.g. large-v3, large-v3-turbo, base)")
    p.add_argument("ref_mode", choices=["synced", "plain", "none"])
    p.add_argument("-o", "--output", required=True, type=Path)
    p.add_argument("--audio", default=str(DRIVE_VOCALS), type=Path)
    p.add_argument("--anchor-gap", action="store_true",
                   help="use anchor-and-gap alignment (plain mode only)")
    p.add_argument("--gap-chain", action="store_true",
                   help="enable gap handler chain (anchor-gap + plain only)")
    args = p.parse_args()

    if not args.audio.exists():
        raise SystemExit(f"audio not found: {args.audio}")
    run(args.model, args.ref_mode, args.audio, args.output,
        anchor_gap=args.anchor_gap, gap_chain=args.gap_chain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
