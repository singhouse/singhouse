# SPDX-License-Identifier: MIT
"""Re-align cached whisper output (a `*-none.json` run output) against
reference lyrics, without re-transcribing. Useful for benchmarking
alignment changes against a fixed transcription.

Usage:
    python realign.py runs/heart-vad-none.json plain runs/heart-vad-plain-gapchain.json \
        --anchor-gap --gap-chain
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DRIVE_LRC = REPO / "lyricsync/scripts/data/drive.lrc"
DRIVE_PLAIN = REPO / "lyricsync/scripts/data/drive.txt"


def load_words(path: Path):
    from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

    data = json.loads(path.read_text())
    flat = []
    for line in data.get("lines", []):
        for w in line:
            text = w.get("word") or w.get("text") or ""
            flat.append(TimedWord(
                text=text, start=float(w["start"]), end=float(w["end"]),
            ))

    segment = TranscriptionSegment(
        start=flat[0].start if flat else 0.0,
        end=flat[-1].end if flat else 0.0,
        text=" ".join(w.text for w in flat),
        words=flat,
    )
    return TranscriptionResult(
        segments=[segment],
        language=data.get("metadata", {}).get("language") or "en",
        full_text=segment.text,
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("cache", type=Path, help="path to *-none.json (cached whisper output)")
    p.add_argument("ref_mode", choices=["synced", "plain", "none"])
    p.add_argument("output", type=Path)
    p.add_argument("--anchor-gap", action="store_true")
    p.add_argument("--gap-chain", action="store_true")
    p.add_argument("--no-detect-offset", action="store_true",
                   help="disable LRC offset detection")
    args = p.parse_args()

    sys.path.insert(0, str(REPO / "lyricsync/src"))
    from lyricsync import SyncPipeline, PipelineConfig

    plain = synced = None
    if args.ref_mode == "synced":
        synced = DRIVE_LRC.read_text()
    elif args.ref_mode == "plain":
        plain = DRIVE_PLAIN.read_text()

    cfg = PipelineConfig(
        use_anchor_gap_alignment=args.anchor_gap,
        gap_handler_chain=args.gap_chain,
        detect_lrc_offset=not args.no_detect_offset,
    )
    pipeline = SyncPipeline(transcriber=None, config=cfg)  # transcriber unused

    transcription = load_words(args.cache)
    result = pipeline.align_only(
        whisper_result=transcription, plain_lyrics=plain, synced_lyrics=synced,
    )
    if result is None:
        raise SystemExit("align_only returned None")

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
            "ref_mode": args.ref_mode,
            "anchor_gap": args.anchor_gap,
            "gap_chain": args.gap_chain,
            **result.metadata.extra,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, default=lambda x: x.__dict__))
    n = sum(len(l) for l in lines_out)
    print(f"wrote {args.output}  ({n} words, method={result.metadata.method})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
