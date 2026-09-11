# SPDX-License-Identifier: AGPL-3.0-only
"""
Per-song transcription cache.

The output of `Transcriber.transcribe(...)` is the expensive bit (Heart on
GPU is ~30 s, faster-whisper large-v3 is similar). Re-alignment with a
different reference doesn't need a fresh transcription, so we cache the
raw `TranscriptionResult` to disk and let `SyncPipeline.align_only(...)`
run against it in milliseconds.

Files live at::

    {STEMS_DIR}/{song_id}/transcription.{label}.json           # active
    {STEMS_DIR}/{song_id}/transcription.{label}.baseline.json  # archive

where ``label`` is the ``describe_run()`` output (e.g. ``heart-vad``,
``large-v3``) so different model/VAD combos coexist.

The canonical path is AUTHORITATIVE: it always holds the newest
transcription, and every reader (re-align, ingest phase-resume) uses it
unconditionally: keep both files, but the newest always stays active.

The ``.baseline.json`` sibling is a write-once archive of the OLDEST
SURVIVING entry for its label. In the normal flow that is the deterministic
ingest pass — it decodes greedily (``temperature=0.0``) and is reproducible,
while a manual re-transcribe re-arms the 0.0/0.1/0.2/0.4 rescue ladder and
is not. Keeping it makes "did I break it, or did it just roll differently?"
answerable later. It is written by :func:`preserve_baseline` immediately
before a forced overwrite, never moved forward by subsequent re-transcribes,
and READ BY NOTHING today — surfacing it is future re-sync UX work.

Two caveats for whoever does surface it, because neither is enforced:

- The archive is only a *deterministic* pass when ingest populated that
  label first. Ingest always transcribes with the default model, but a
  re-transcribe may pick any model; for a label ingest never used, the
  first entry is itself a rescue run, and write-once means it stays the
  archive forever.
- The pair's coherence is not enforced. If the active entry is removed
  out-of-band (manual cleanup, a partial restore) while the sibling
  survives, the next transcribe writes a fresh active entry and the
  orphaned archive is never refreshed — the two files may then describe
  different runs.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

logger = logging.getLogger(__name__)


def _stems_root() -> Path:
    return Path(os.getenv("STEMS_DIR", "stems"))


def cache_path(song_id: int, label: str) -> Path:
    """Return the on-disk path for a cached transcription.

    ``label`` is the ``describe_run()`` output — pass it in directly so
    callers don't have to duplicate the model/VAD → label mapping.
    """
    return _stems_root() / str(song_id) / f"transcription.{label}.json"


def baseline_path(song_id: int, label: str) -> Path:
    """Return the on-disk path for the preserved first-pass transcription.

    ``label`` is the ``describe_run()`` output — pass it in directly so
    callers don't have to duplicate the model/VAD → label mapping.
    """
    return _stems_root() / str(song_id) / f"transcription.{label}.baseline.json"


def clear(song_id: int) -> int:
    """Delete every cached transcription for a song. Returns how many went.

    Baselines included, and that is the point: the archive exists to answer
    "did I break it, or did it just roll differently?" about a transcription
    of a particular audio file. Once the lead stem has been re-split, both
    files describe audio that no longer exists on disk — keeping the archive
    would preserve a comparison that can no longer be made and, worse, leave
    a realign aligning against a transcription of the old stem.

    Every OSError is logged and swallowed. A cache is a cache: the caller has
    already done the expensive, irreversible work by the time it gets here.
    """
    song_dir = _stems_root() / str(song_id)
    removed = 0
    try:
        entries = sorted(song_dir.glob("transcription.*.json"))
    except OSError as exc:
        logger.warning("Could not list the transcription cache for %s: %s", song_dir, exc)
        return 0
    for entry in entries:
        try:
            entry.unlink()
            removed += 1
        except OSError as exc:
            logger.warning("Could not remove cached transcription %s: %s", entry, exc)
    if removed:
        logger.info("Cleared %d cached transcription(s) for song %s", removed, song_id)
    return removed


def preserve_baseline(path: Path) -> bool:
    """Archive the current cache entry as the first-pass baseline, once.

    ``path`` is a canonical :func:`cache_path`; the archive is its
    ``.baseline.json`` sibling. Returns True when a baseline exists on disk
    afterwards.

    Write-once by design: if the archive already exists this is a no-op. The
    baseline must stay the OLDEST surviving pass forever — if a third
    re-transcribe shifted it forward, the archive would just be "the previous
    roll of the dice" and the comparison it exists for would be meaningless.

    An ``OSError`` is logged and swallowed, INCLUDING from the existence
    checks: on Python 3.12 ``Path.exists()`` re-raises anything that isn't
    ENOENT/ENOTDIR/EBADF/ELOOP, so an unreadable stems directory would
    otherwise escape. Losing the baseline is bad; throwing away a finished
    transcription because the archive failed is worse.
    """
    target = path.with_name(f"{path.stem}.baseline{path.suffix}")
    try:
        if not path.exists():
            return False
        if target.exists():
            return True
        # Same tmp-then-atomic-rename discipline as `save`: a reader must
        # never observe a half-copied baseline, and two overlapping forced
        # runs must not share a staging file.
        fd, tmp_name = tempfile.mkstemp(
            dir=target.parent, prefix=f"{target.name}.", suffix=".tmp"
        )
        tmp = Path(tmp_name)
        try:
            # fdopen first, so the descriptor is owned by a context manager
            # before anything else can raise and strand it.
            with os.fdopen(fd, "wb") as dst, path.open("rb") as src:
                os.fchmod(dst.fileno(), 0o644)  # mkstemp gives 0600
                shutil.copyfileobj(src, dst)
            tmp.replace(target)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    except OSError as exc:
        logger.warning(
            "Failed to preserve transcription baseline %s: %s", target, exc,
        )
        return False
    logger.info("Transcription baseline preserved: %s", target)
    return True


def save(path: Path, result: TranscriptionResult) -> None:
    """Persist a TranscriptionResult to disk as JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dataclasses.asdict(result)
    # Unique tmp name, same directory (so the rename stays atomic). A fixed
    # ".tmp" was safe only while every write came from a cache MISS; forced
    # re-transcription means two runs for one song can be in flight at once
    # (double-clicked re-transcribe, KARAOKE_JOB_CONCURRENCY > 1), and they
    # would interleave writes into one file and publish half of each — which
    # `load` then swallows as a plain cache miss.
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f"{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        # mkstemp creates 0600; the plain open() this replaced produced
        # 0666 & ~umask. Keep the published file's permissions as they were.
        os.chmod(tmp, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    logger.info(
        "Transcription cache saved: %s (%d segments)",
        path, len(result.segments),
    )


def load(path: Path) -> Optional[TranscriptionResult]:
    """Load a cached TranscriptionResult, or None if missing/corrupt."""
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        segments = []
        for s in data.get("segments", []):
            words = [
                TimedWord(
                    text=w.get("text", ""),
                    start=float(w.get("start", 0.0)),
                    end=float(w.get("end", 0.0)),
                    interpolated=bool(w.get("interpolated", False)),
                )
                for w in s.get("words", [])
            ]
            segments.append(TranscriptionSegment(
                start=float(s.get("start", 0.0)),
                end=float(s.get("end", 0.0)),
                text=s.get("text", ""),
                words=words,
            ))
        return TranscriptionResult(
            segments=segments,
            language=data.get("language"),
            full_text=data.get("full_text", ""),
        )
    except (OSError, ValueError, KeyError, TypeError) as exc:
        logger.warning("Transcription cache load failed for %s: %s", path, exc)
        return None
