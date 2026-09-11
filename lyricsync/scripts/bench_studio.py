# SPDX-License-Identifier: MIT
"""
Benchmark the lyricsync pipeline on a studio audio track using a saved
reference lyrics set from the database as ground truth.

Steps:
  1. Run two-pass Demucs+roformer separation (cached to scratch dir per song)
  2. Transcribe lead_vocals with the chosen whisper model (cached to scratch)
  3. Align against the catalog reference's plain or synced lyrics
  4. Compare alignment output to the reference word_sync_json (ground truth)

Usage:
    python bench_studio.py 17 "/mnt/.../Pardon Me.flac" --ref-id 19 --ref-mode synced \\
        --model large-v3-turbo --anchor-gap
    # already-isolated vocals (e.g. Rock Band stem):
    python bench_studio.py 13 vocals.wav --ref-id 20 --ref-mode synced --skip-separation

Cache layout (default scratch=/tmp/karaoke-bench):
    <scratch>/<song_id>/
        stems/{lead_vocals,backing_vocals,instrumental}.wav
        whisper-<model>.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parents[2]
DB_PATH = REPO / "backend/karaoke.db"
SCRATCH_DEFAULT = Path("/tmp/karaoke-bench")


def db_load_reference(song_id: int, ref_id: Optional[int]) -> dict:
    conn = sqlite3.connect(DB_PATH)
    if ref_id is None:
        # pick the longest reference set for this song
        row = conn.execute(
            "SELECT id, label, plain_lyrics, synced_lyrics, word_sync_json "
            "FROM lyrics_sets WHERE song_id=? AND source='reference' "
            "AND word_sync_json IS NOT NULL "
            "ORDER BY length(word_sync_json) DESC LIMIT 1",
            (song_id,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT id, label, plain_lyrics, synced_lyrics, word_sync_json "
            "FROM lyrics_sets WHERE id=?",
            (ref_id,),
        ).fetchone()
    if not row:
        raise SystemExit(f"no reference set found (song={song_id}, ref_id={ref_id})")
    rid, label, plain, synced, ws_json = row
    artist, title = conn.execute(
        "SELECT artist, title FROM songs WHERE id=?", (song_id,)
    ).fetchone()
    return {
        "id": rid, "label": label, "song_id": song_id,
        "artist": artist, "title": title,
        "plain": plain, "synced": synced,
        "word_sync": json.loads(ws_json),
    }


def flatten_word_sync(ws: dict | list) -> list[dict]:
    """word_data shape varies — handle list-of-lines or dict with lines/segments."""
    if isinstance(ws, list):
        lines = ws
    elif isinstance(ws, dict):
        lines = ws.get("lines") or ws.get("segments") or []
    else:
        return []
    flat = []
    for line in lines:
        if isinstance(line, list):
            for w in line:
                flat.append(w)
        elif isinstance(line, dict) and "words" in line:
            for w in line["words"]:
                flat.append(w)
    return flat


def normalize_word(s: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def compare_to_truth(result_lines: list[list], truth_words: list[dict]) -> dict:
    """Compare aligned output to ground truth word_sync.

    Returns metrics:
      n_aligned, n_truth, n_text_matches (1:1 by order), median_abs_delta_s,
      max_abs_delta_s, frac_within_300ms.
    """
    aligned = []
    for line in result_lines:
        for w in line:
            aligned.append(w)
    n_aligned = len(aligned)
    n_truth = len(truth_words)

    # text-only sequence match
    a_norm = [normalize_word(getattr(w, "text", "") or w.get("word") or w.get("text") or "")
              for w in aligned]
    t_norm = [normalize_word(w.get("word") or w.get("text") or "") for w in truth_words]

    # 1:1 pair by order, walking up to 6 forward to find a text match.
    # Collect SIGNED deltas (aligned_start - truth_start) so we can
    # subtract a global offset before reporting tightness.
    signed: list[float] = []
    j = 0
    matched = 0
    for i, a in enumerate(a_norm):
        if not a:
            continue
        for k in range(j, min(j + 6, len(t_norm))):
            if t_norm[k] == a and t_norm[k]:
                a_w = aligned[i]
                t_w = truth_words[k]
                a_start = getattr(a_w, "start", None)
                if a_start is None:
                    a_start = a_w.get("start")
                t_start = t_w.get("start")
                if a_start is not None and t_start is not None:
                    signed.append(float(a_start) - float(t_start))
                    matched += 1
                j = k + 1
                break
    if not signed:
        return {"n_aligned": n_aligned, "n_truth": n_truth, "matched": 0}

    sorted_signed = sorted(signed)
    median_signed = sorted_signed[len(sorted_signed) // 2]
    centered = [abs(d - median_signed) for d in signed]
    raw_abs = [abs(d) for d in signed]

    def _stats(vals: list[float]) -> dict:
        s = sorted(vals)
        return {
            "median": round(s[len(s) // 2], 3),
            "p90": round(s[int(len(s) * 0.9)], 3) if len(s) > 10 else round(max(s), 3),
            "max": round(max(s), 3),
            "frac_within_300ms": round(sum(1 for v in s if v < 0.3) / len(s), 3),
            "frac_within_500ms": round(sum(1 for v in s if v < 0.5) / len(s), 3),
        }

    return {
        "n_aligned": n_aligned,
        "n_truth": n_truth,
        "matched": matched,
        "global_offset_s": round(median_signed, 3),  # aligned - truth
        "raw_abs": _stats(raw_abs),
        "centered_abs": _stats(centered),
    }


async def run_separation(audio: Path, stems_dir: Path) -> Path:
    sys.path.insert(0, str(REPO / "backend"))
    from workers.modal_worker import separate_stems

    lead = stems_dir / "lead_vocals.wav"
    if lead.exists():
        print(f"  [cached] using existing {lead}")
        return lead

    print(f"  separating {audio.name} -> {stems_dir}")
    t0 = time.time()
    await separate_stems(audio, stems_dir, job_id=f"bench-{audio.stem[:20]}")
    print(f"  separation: {time.time()-t0:.1f}s")
    return lead


def transcribe(audio: Path, model: str, cache_path: Path) -> "TranscriptionResult":
    sys.path.insert(0, str(REPO / "lyricsync/src"))
    from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

    if cache_path.exists():
        print(f"  [cached] using whisper cache {cache_path.name}")
        data = json.loads(cache_path.read_text())
        segments = []
        for s in data.get("segments", []):
            words = [
                TimedWord(text=w["text"], start=float(w["start"]), end=float(w["end"]))
                for w in s["words"]
            ]
            segments.append(TranscriptionSegment(
                start=float(s["start"]), end=float(s["end"]),
                text=s["text"], words=words,
            ))
        full_text = " ".join(s.text for s in segments)
        return TranscriptionResult(
            segments=segments,
            language=data.get("language") or "en",
            full_text=full_text,
        )

    print(f"  transcribing with {model}...")
    from lyricsync.transcription.faster_whisper import FasterWhisperTranscriber
    t0 = time.time()
    transcriber = FasterWhisperTranscriber(model=model)
    result = transcriber.transcribe(str(audio), language="en")
    print(f"  whisper: {time.time()-t0:.1f}s")

    # cache preserves segment boundaries (hallucination filter is per-segment)
    cache_payload = {
        "segments": [
            {
                "start": s.start, "end": s.end, "text": s.text,
                "words": [{"text": w.text, "start": w.start, "end": w.end}
                          for w in s.words],
            }
            for s in result.segments
        ],
        "language": result.language,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache_payload))
    return result


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("song_id", type=int)
    p.add_argument("audio", type=Path, help="path to studio audio file")
    p.add_argument("--ref-id", type=int, default=None,
                   help="lyrics_sets.id to use as reference (default: longest)")
    p.add_argument("--ref-mode", choices=["plain", "synced"], default="synced")
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--anchor-gap", action="store_true")
    p.add_argument("--gap-chain", action="store_true")
    p.add_argument("--no-detect-offset", action="store_true")
    p.add_argument("--scratch", type=Path, default=SCRATCH_DEFAULT)
    p.add_argument("--skip-separation", action="store_true",
                   help="treat the audio file as already-isolated lead vocals "
                        "(skip Demucs+roformer)")
    p.add_argument("-o", "--output", type=Path, default=None)
    args = p.parse_args()

    if not args.audio.exists():
        raise SystemExit(f"audio not found: {args.audio}")

    ref = db_load_reference(args.song_id, args.ref_id)
    truth_words = flatten_word_sync(ref["word_sync"])
    print(f"song {args.song_id}: {ref['artist']} - {ref['title']}")
    print(f"reference set {ref['id']} ({ref['label']}): "
          f"{len(truth_words)} truth words, "
          f"first={truth_words[0].get('start'):.2f}s "
          f"last={truth_words[-1].get('end', truth_words[-1].get('start')):.2f}s")

    song_dir = args.scratch / str(args.song_id)
    stems_dir = song_dir / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)

    # 1. Separate (or use given audio directly as the lead-vocal stem)
    if args.skip_separation:
        lead = args.audio
        print(f"  [skip-separation] using {lead.name} as lead vocals")
    else:
        lead = asyncio.run(run_separation(args.audio, stems_dir))

    # 2. Transcribe
    cache = song_dir / f"whisper-{args.model}.json"
    transcription = transcribe(lead, args.model, cache)

    # 3. Align
    sys.path.insert(0, str(REPO / "lyricsync/src"))
    from lyricsync import SyncPipeline, PipelineConfig
    plain = synced = None
    if args.ref_mode == "plain":
        plain = ref["plain"]
        if not plain:
            raise SystemExit(f"reference set {ref['id']} has no plain_lyrics")
    else:
        synced = ref["synced"]
        if not synced:
            raise SystemExit(f"reference set {ref['id']} has no synced_lyrics")

    cfg = PipelineConfig(
        use_anchor_gap_alignment=args.anchor_gap,
        gap_handler_chain=args.gap_chain,
        detect_lrc_offset=not args.no_detect_offset,
    )
    pipeline = SyncPipeline(transcriber=None, config=cfg)
    t0 = time.time()
    result = pipeline.align_only(
        whisper_result=transcription, plain_lyrics=plain, synced_lyrics=synced,
    )
    if result is None:
        raise SystemExit("align_only returned None")
    print(f"alignment: {time.time()-t0:.2f}s, method={result.metadata.method}")

    # 4. Compare
    metrics = compare_to_truth(result.lines, truth_words)
    print(f"metrics: {json.dumps(metrics, indent=2)}")

    # First-word offset hint
    if truth_words and result.lines and result.lines[0]:
        first_aligned = result.lines[0][0]
        first_aligned_start = getattr(first_aligned, "start", None)
        first_truth_start = truth_words[0].get("start")
        if first_aligned_start is not None and first_truth_start is not None:
            print(f"first-word offset (aligned - truth): "
                  f"{first_aligned_start - first_truth_start:+.2f}s")

    # 5. Write output
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        lines_out = [
            [{"word": w.text, "start": w.start, "end": w.end} for w in line]
            for line in result.lines
        ]
        payload = {
            "song_id": args.song_id, "ref_id": ref["id"], "ref_mode": args.ref_mode,
            "model": args.model, "anchor_gap": args.anchor_gap, "gap_chain": args.gap_chain,
            "metrics": metrics,
            "alignment": {
                "method": result.metadata.method,
                "words_total": result.metadata.words_total,
                "words_matched": result.metadata.words_matched,
                "words_corrected": result.metadata.words_corrected,
                "words_interpolated": result.metadata.words_interpolated,
                "extra": result.metadata.extra,
            },
            "lines": lines_out,
        }
        args.output.write_text(json.dumps(payload, indent=2,
                                          default=lambda x: x.__dict__))
        print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
