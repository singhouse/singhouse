# SPDX-License-Identifier: AGPL-3.0-only
"""
Seed an externally-sourced lyrics reference as a verified LyricsSet on a
target song.

The verified set never gets overwritten by transcription runs, so this gives
us a stable yardstick to evaluate against.

Usage (installed console script):
    kb-seed-lyrics-reference \\
        --song-id 10 \\
        --json /path/to/word_data.json \\
        --label "reference ground truth"

If --song-id is omitted, the script prints the song list and exits.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from sqlalchemy import select, update

from karaoke_backend.database import AsyncSessionLocal, require_schema
from karaoke_backend.models.song import LyricsSet, LyricsSource, Song


async def list_songs() -> None:
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(Song).order_by(Song.id)
        )).scalars().all()
        if not rows:
            print("(no songs)")
            return
        print(f"{'ID':>4}  {'STATUS':<10} ARTIST — TITLE")
        for s in rows:
            print(f"{s.id:>4}  {s.status:<10} {s.artist} — {s.title}")


async def seed(song_id: int, json_path: Path, label: str, activate: bool) -> None:
    payload = json.loads(json_path.read_text())
    if "lines" not in payload:
        raise SystemExit(f"{json_path}: missing 'lines' key — not a word_data file")

    plain_lyrics = "\n".join(
        " ".join(w.get("word", "") for w in line).strip()
        for line in payload["lines"]
    )
    metadata = payload.get("metadata", {}) or {}
    metadata.update({
        "imported_from": str(json_path),
        "lines": len(payload["lines"]),
        "words": sum(len(l) for l in payload["lines"]),
    })

    async with AsyncSessionLocal() as db:
        song = (await db.execute(select(Song).where(Song.id == song_id))).scalar_one_or_none()
        if song is None:
            raise SystemExit(f"Song {song_id} not found. Run without --song-id to list.")

        # Clear is_verified on existing sets for this song, then add the new one.
        await db.execute(
            update(LyricsSet)
            .where(LyricsSet.song_id == song_id)
            .values(is_verified=False)
        )
        ls = LyricsSet(
            song_id=song_id,
            source=LyricsSource.REFERENCE.value,
            label=label,
            is_verified=True,
            plain_lyrics=plain_lyrics,
            word_sync_json=json.dumps(payload),
            metadata_json=json.dumps(metadata),
        )
        db.add(ls)
        await db.flush()

        if activate:
            await db.execute(
                update(Song).where(Song.id == song_id).values(active_lyrics_id=ls.id)
            )

        await db.commit()
        print(
            f"Seeded LyricsSet id={ls.id} "
            f"(verified, {'active' if activate else 'inactive'}) "
            f"for song {song_id}: {song.artist} — {song.title}"
        )


async def _run() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--song-id", type=int, help="Target song ID")
    p.add_argument("--json", type=Path, help="Path to word_data JSON")
    p.add_argument("--label", default="external reference",
                   help="Human-readable label for the set")
    p.add_argument("--activate", action="store_true",
                   help="Mark the new set as active (drives playback)")
    args = p.parse_args()

    await require_schema("songs")  # read-only: never create/migrate schema here

    if not args.song_id:
        print("Usage: --song-id <id> --json <path> [--label ...] [--activate]\n")
        print("Songs in DB:")
        await list_songs()
        return 0

    if not args.json:
        raise SystemExit("--json is required when --song-id is given")
    if not args.json.exists():
        raise SystemExit(f"file not found: {args.json}")

    await seed(args.song_id, args.json, args.label, args.activate)
    return 0


def main() -> None:
    """Synchronous console-script entry point (``kb-seed-lyrics-reference``).

    ``[project.scripts]`` calls this with no arguments and expects a plain
    callable, so the async body lives in ``_run`` and is driven here.
    """
    sys.exit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
