#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Export real word_sync docs from the karaoke DB as editor test fixtures.

Dumps lyrics sets into frontend/fixtures/lyrics/<method>/, one JSON file per
set, plus an index.json manifest the editor lab's fixture picker and the
corpus tests read. The output directory is GITIGNORED on purpose: these are
lyrics from your own library — they stay on this machine. Tests that consume them skip
cleanly when the directory is absent; unit tests use synthetic docs.

Selection: every transcription-family doc (whisper-only / lrc-anchored /
needleman-wunsch / unknown — these are the editor's raison d'être, and there
are only ~35), plus a capped sample of provider-origin docs (page/syllable
handling coverage). --all lifts the cap; --cap METHOD=N overrides per-method.

Usage:
    python3 backend/scripts/export-lyrics-fixtures.py [--all] [--cap METHOD=N ...] [--db PATH] [--out DIR]
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = REPO_ROOT / "backend" / "karaoke.db"
DEFAULT_OUT = REPO_ROOT / "frontend" / "fixtures" / "lyrics"

DEFAULT_CAP = 10  # per method, unless --all or overridden by --cap


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:60] or "untitled"


def method_of(metadata: dict | None, word_sync: dict) -> str:
    method = (metadata or {}).get("method") or (word_sync.get("metadata") or {}).get("method")
    return method or "unknown"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--all", action="store_true", help="no cap on any method")
    ap.add_argument("--cap", action="append", default=[], metavar="METHOD=N",
                    help="per-method cap override (repeatable)")
    args = ap.parse_args()

    caps: dict[str, int] = {}
    for spec in args.cap:
        m, _, n = spec.rpartition("=")
        if not m or not n.isdigit():
            ap.error(f"--cap expects METHOD=N, got {spec!r}")
        caps[m] = int(n)

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    rows = db.execute(
        """
        SELECT ls.id, ls.song_id, ls.source, ls.label, ls.metadata_json,
               ls.word_sync_json, s.artist, s.title
        FROM lyrics_sets ls JOIN songs s ON s.id = ls.song_id
        WHERE ls.word_sync_json IS NOT NULL
        ORDER BY ls.id
        """
    ).fetchall()

    args.out.mkdir(parents=True, exist_ok=True)
    kept_per_method: Counter[str] = Counter()
    index = []

    for lid, song_id, source, label, metadata_json, ws_json, artist, title in rows:
        try:
            word_sync = json.loads(ws_json)
            metadata = json.loads(metadata_json) if metadata_json else None
        except json.JSONDecodeError:
            print(f"  skip set {lid}: unparseable JSON")
            continue

        method = method_of(metadata, word_sync)
        fv = (word_sync.get("metadata") or {}).get("format_version")
        if not args.all:
            cap = caps.get(method, DEFAULT_CAP)
            if kept_per_method[method] >= cap:
                continue
            kept_per_method[method] += 1

        rel = Path(method) / f"{song_id:04d}-{lid}-{slugify(f'{artist}-{title}')}.json"
        path = args.out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        fixture = {
            "lyrics_set_id": lid,
            "song_id": song_id,
            "artist": artist,
            "title": title,
            "source": source,
            "label": label,
            "method": method,
            "format_version": fv,
            "word_sync": word_sync,
        }
        path.write_text(json.dumps(fixture, ensure_ascii=False, indent=1))
        index.append(
            {
                "file": str(rel),
                "lyrics_set_id": lid,
                "song_id": song_id,
                "artist": artist,
                "title": title,
                "method": method,
                "format_version": fv,
                "lines": len(word_sync.get("lines") or []),
            }
        )

    (args.out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))

    by_method = Counter(e["method"] for e in index)
    print(f"Exported {len(index)} fixtures to {args.out}")
    for method, n in sorted(by_method.items()):
        print(f"  {method:20} {n}")


if __name__ == "__main__":
    main()
