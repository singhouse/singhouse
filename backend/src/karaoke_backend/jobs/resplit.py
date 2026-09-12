# SPDX-License-Identifier: AGPL-3.0-only
"""Re-run the Pass-2 lead/backing split on a song that is already in the library.

The Pass-2 model is picked at upload time, and until re-split existed that pick was final:
the uploaded audio is deleted the moment separation finishes, and ingest
short-circuits on the ``.separation-complete`` marker, so nothing could ever
run Pass 2 again. Discovering after the fact that a track's doubled vocals
needed the other model meant re-uploading it and losing the song's history.

Pass 1 is not re-run and does not need to be: it produced the vocal stem this
job splits. When the older ``vocals.wav`` is still on disk that stem is
used directly; otherwise the existing lead and backing are summed back into
one, which is the same signal to within the mix.

**Nothing existing is touched until the replacements are complete.** Every
output is built in a scratch directory inside the song's stems directory and
moved into place with ``os.replace`` — an atomic rename within one filesystem.
A client that is mid-playback keeps reading the old inode and finishes the
song; the next request gets the new file. A failure at any earlier point
leaves the song exactly as it was, which is why a Pass-2 failure here is
terminal rather than the degradation ``separate_stems`` accepts on a first
ingest: there, an imperfect split beats no song at all; here, it would
overwrite stems that already work.
"""

from __future__ import annotations

import asyncio
import ctypes
import logging
import json
import os
import shutil
from pathlib import Path
from typing import Optional
from sqlalchemy import select, update
from datetime import datetime, timezone

from karaoke_backend.jobs import queue
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.jobs.ingest import write_separation_marker
from karaoke_backend.models.song import JobPhase
from karaoke_backend.workers import karaoke_models, modal_worker, transcription_cache
from karaoke_backend.workers.modal_worker import StemSeparationError

logger = logging.getLogger(__name__)

# Scratch directories are named per JOB, not per song. Two re-splits of one
# song should never be able to overlap — the route refuses the second — but a
# shared name would make a stale directory from a killed worker something this
# job could delete out from under a live one, and that is not a risk worth
# carrying for a shorter name.
SCRATCH_PREFIX = "_resplit-"


def _sync_generation(path: Path) -> None:
    """Flush a complete generation before its database pointer can commit."""
    for child in path.iterdir():
        if child.is_file():
            with child.open("rb") as stream:
                os.fsync(stream.fileno())
    _sync_directory(path)

def _sync_directory(path: Path) -> None:
    if os.name == "nt":
        _sync_directory_windows(path)
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise RuntimeError(f"Cannot durably sync directory {path}") from exc
    try:
        os.fsync(fd)
    except OSError as exc:
        raise RuntimeError(f"Cannot durably sync directory {path}") from exc
    finally:
        os.close(fd)


def _sync_directory_windows(path: Path, kernel32=None) -> None:
    """Flush a directory using the supported Win32 directory-handle API."""
    api = kernel32 or ctypes.WinDLL("kernel32", use_last_error=True)
    create = api.CreateFileW
    if kernel32 is None:
        create.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                           ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
                           ctypes.c_void_p]
        create.restype = ctypes.c_void_p
    handle = create(str(path), 0x80000000 | 0x40000000, 0x1 | 0x2 | 0x4, None, 3,
                    0x02000000, None)
    invalid = ctypes.c_void_p(-1).value
    if handle is None or handle == invalid:
        raise RuntimeError(f"Cannot open directory for durable sync: {path}")
    error = None
    try:
        if not api.FlushFileBuffers(handle):
            error = RuntimeError(f"Cannot durably sync directory {path}")
    finally:
        if not api.CloseHandle(handle) and error is None:
            error = RuntimeError(f"Cannot close durable directory handle {path}")
    if error is not None:
        raise error

# The three files this job publishes. Each is built under the same name in the
# scratch directory and renamed over its sibling in the stems directory. Named
# once, here, so the set of files a re-split may overwrite reads as one list
# rather than as literals scattered through the handler.
REPLACEMENTS = (
    "lead_vocals.wav",
    "backing_vocals.wav",
    "karaoke.wav",
)

def _complete_generation(path: Path) -> bool:
    try:
        marker = json.loads((path / ".separation-complete").read_text())
    except (OSError, ValueError):
        return False
    required_files = {*REPLACEMENTS, "instrumental.wav"}
    canonical_marker = {"lead_vocals.wav", "instrumental.wav", "karaoke.wav"}
    return canonical_marker <= set(marker.get("artifacts", ())) and all((path / n).is_file() for n in required_files)

async def _durability_barrier(generation: Path, stems_root: Path) -> None:
    await asyncio.to_thread(_sync_generation, generation)
    await asyncio.to_thread(_sync_directory, generation.parent)
    await asyncio.to_thread(_sync_directory, stems_root)

async def _publish(ctx: JobContext, generation: str, expected: Optional[str]) -> None:
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import Job, Song
    now = datetime.now(timezone.utc)
    expected_clause = (Song.active_stem_generation.is_(None) if expected is None
                       else Song.active_stem_generation == expected)
    async with AsyncSessionLocal() as db:
        already = (await db.execute(select(Song.active_stem_generation).where(
            Song.id == ctx.song_id,
            select(Job.id).where(Job.id == ctx.job_id, Job.claimed_by == ctx.worker_id,
                Job.status.notin_(queue.TERMINAL_STATUSES), Job.lease_expires_at > now).exists(),
        ))).scalar_one_or_none()
        if already == generation:
            return
        changed = await db.execute(update(Song).where(
            Song.id == ctx.song_id, expected_clause,
            select(Job.id).where(Job.id == ctx.job_id, Job.claimed_by == ctx.worker_id,
                Job.status.notin_(queue.TERMINAL_STATUSES), Job.lease_expires_at > now).exists(),
        ).values(active_stem_generation=generation))
        if changed.rowcount != 1:
            raise LeaseLost(ctx.job_id)
        await db.commit()


async def _announce(
    ctx: JobContext, *, progress: int, message: str
) -> None:
    """Publish progress, and treat a refused write as a lost claim.

    Same shape as ``jobs.transcribe._announce``: the job row is the only table
    with a claim column, so a refused write there is the only chance to stop
    before touching the filesystem.
    """
    if not await queue.update_progress(
        ctx.job_id,
        ctx.worker_id,
        phase=JobPhase.SEPARATING.value,
        progress=progress,
        message=message,
    ):
        raise LeaseLost(ctx.job_id)


async def _mix_vocals(lead: Path, backing: Path, out: Path) -> None:
    """Sum the existing lead and backing back into one vocal stem.

    ``normalize=0`` because the two were split FROM one signal: ffmpeg's
    default would scale each input by 1/n and hand Pass 2 a track 6 dB quieter
    than the one it was trained to split.
    """
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(lead),
        "-i", str(backing),
        "-filter_complex",
        "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[out]",
        "-map", "[out]",
        "-acodec", "pcm_s16le",
        str(out),
    ]
    try:
        result = await modal_worker._await_subprocess(cmd, timeout=300)
    except (StemSeparationError, asyncio.TimeoutError) as exc:
        raise JobFailure(
            "Could not rebuild the vocal track to re-split",
            str(exc),
        ) from exc
    if not out.exists():
        raise JobFailure(
            "Could not rebuild the vocal track to re-split",
            f"ffmpeg exited {result.returncode} without producing {out.name}",
        )


async def run_resplit(ctx: JobContext) -> Optional[str]:
    """Split this song's vocals again with a different Pass-2 model."""
    payload = ctx.payload
    stems_dir = Path(payload["stems_dir"])
    stems_root = Path(payload.get("stems_root", payload["stems_dir"]))
    expected_generation = payload.get("expected_generation")
    generation = f"resplit-{ctx.job_id}"
    if generation != Path(generation).name or not generation.replace("-", "").isalnum():
        raise JobFailure("Could not publish replacement stems", "invalid job id")
    generation_dir = stems_root / ".generations" / generation
    model = karaoke_models.resolve(
        payload.get("karaoke_model"), modal_worker.KARAOKE_MODEL
    )

    await _announce(ctx, progress=5, message=f"Re-splitting lead/backing ({model})")

    if _complete_generation(generation_dir):
        await _durability_barrier(generation_dir, stems_root)
        await _publish(ctx, generation, expected_generation)
        return f"Re-split with {model}; transcription cache cleared — re-transcribe to refresh lyrics timing"

    async def on_progress(_status: str, pct: int, msg: str) -> None:
        await _announce(ctx, progress=pct, message=msg)

    scratch = stems_dir / f"{SCRATCH_PREFIX}{ctx.job_id}"
    # This job's own leftovers, and only this job's: a directory left by a
    # killed attempt at THIS job id says nothing about what is in it, so it is
    # removed rather than resumed. Siblings are left alone — they may belong to
    # a worker that is still running.
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True, exist_ok=True)

    try:
        vocals_src = stems_dir / "vocals.wav"
        if not vocals_src.exists():
            await _announce(ctx, progress=10, message="Rebuilding the vocal track")
            vocals_src = scratch / "vocals.wav"
            await _mix_vocals(
                stems_dir / "lead_vocals.wav",
                stems_dir / "backing_vocals.wav",
                vocals_src,
            )

        await _announce(ctx, progress=20, message="Splitting lead/backing vocals")
        try:
            lead_out, backing_out = await modal_worker.run_pass2(
                vocals_src,
                scratch / "pass2",
                model,
                on_progress,
                # An unrecognized pair is a refusal here, not a coin flip: this
                # song's lead and backing are already correct, and guessing
                # them the wrong way round would silently swap them.
                allow_alphabetical_fallback=False,
            )
        except StemSeparationError as exc:
            raise JobFailure(
                f"The {model} split failed — this song's stems are unchanged",
                str(exc),
            ) from exc
        if lead_out is None or backing_out is None:
            raise JobFailure(
                f"The {model} split produced no lead/backing pair — this "
                f"song's stems are unchanged",
                f"Pass 2 output in {scratch / 'pass2'} could not be identified "
                f"as a lead/backing pair",
            )

        new_lead = scratch / "lead_vocals.wav"
        new_backing = scratch / "backing_vocals.wav"
        new_karaoke = scratch / "karaoke.wav"
        shutil.copy2(lead_out, new_lead)
        shutil.copy2(backing_out, new_backing)
        # audio-separator inherits its input's bit depth, and a 32-bit WAV is
        # silently undecodable in the browser — see `_ensure_s16`.
        for stem in (new_lead, new_backing):
            normalized = modal_worker._ensure_s16(stem)
            if asyncio.iscoroutine(normalized):
                await normalized

        await _announce(ctx, progress=85, message="Mixing the karaoke track")
        mixed = await modal_worker.mix_karaoke(
            stems_dir / "instrumental.wav", new_backing, new_karaoke
        )
        if not mixed:
            raise JobFailure(
                "Could not mix the karaoke track — this song's stems are unchanged",
                f"mix_karaoke fell back to the instrumental alone for {stems_dir}",
            )

        # Last check before the only irreversible step in the job. Pass 2 runs
        # for minutes with no job-row write of its own in between, which is
        # long enough to lose a lease; `stems` has no claim column, so this is
        # the only thing standing between a stale worker and another worker's
        # song files.
        if not await queue.heartbeat(ctx.job_id, ctx.worker_id):
            raise LeaseLost(ctx.job_id)

        # Dropped BEFORE publication, not after, because the two failure modes
        # are not equally bad. Clearing and then failing to rename costs one
        # re-transcription of audio that did not change. Renaming and then
        # failing to clear leaves a cache of the OLD split sitting next to the
        # new stems, and the next re-align silently times the lyrics against
        # audio that no longer exists — wrong, and with nothing to notice it.
        # The lead stem is the transcription's input, so any rename landing at
        # all invalidates the cache.
        transcription_cache.clear(ctx.song_id)

        attempt_dir = stems_root / ".generations" / f".attempt-{ctx.job_id}"
        shutil.rmtree(attempt_dir, ignore_errors=True)
        attempt_dir.mkdir(parents=True)
        # A generation is self-contained. Copy unchanged playable assets first,
        # then move the replacement trio; the DB pointer changes only after all
        # files are durable and visible under one directory.
        for source in stems_dir.iterdir():
            if source.is_file() and source.name not in REPLACEMENTS:
                shutil.copy2(source, attempt_dir / source.name)
        for name in REPLACEMENTS:
            os.replace(scratch / name, attempt_dir / name)
        write_separation_marker(attempt_dir)
        await asyncio.to_thread(_sync_generation, attempt_dir)
        generation_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(attempt_dir, generation_dir)
        except OSError:
            if not _complete_generation(generation_dir):
                raise
            shutil.rmtree(attempt_dir, ignore_errors=True)
        await _durability_barrier(generation_dir, stems_root)
        await _publish(ctx, generation, expected_generation)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    logger.info("Re-split %s complete for song %s (%s)", ctx.job_id, ctx.song_id, model)
    return (
        f"Re-split with {model}; transcription cache cleared — re-transcribe "
        f"to refresh lyrics timing"
    )
