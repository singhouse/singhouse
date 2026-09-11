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
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

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

# The three files this job publishes. Each is built under the same name in the
# scratch directory and renamed over its sibling in the stems directory. Named
# once, here, so the set of files a re-split may overwrite reads as one list
# rather than as literals scattered through the handler.
REPLACEMENTS = (
    "lead_vocals.wav",
    "backing_vocals.wav",
    "karaoke.wav",
)


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
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=300
    )
    if result.returncode != 0 or not out.exists():
        raise JobFailure(
            "Could not rebuild the vocal track to re-split",
            f"ffmpeg exited {result.returncode}: {result.stderr[-500:]}",
        )


async def run_resplit(ctx: JobContext) -> Optional[str]:
    """Split this song's vocals again with a different Pass-2 model."""
    payload = ctx.payload
    stems_dir = Path(payload["stems_dir"])
    model = karaoke_models.resolve(
        payload.get("karaoke_model"), modal_worker.KARAOKE_MODEL
    )

    await _announce(ctx, progress=5, message=f"Re-splitting lead/backing ({model})")

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
        await asyncio.to_thread(modal_worker._ensure_s16, new_lead)
        await asyncio.to_thread(modal_worker._ensure_s16, new_backing)

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

        # Dropped BEFORE the renames, not after, because the two failure modes
        # are not equally bad. Clearing and then failing to rename costs one
        # re-transcription of audio that did not change. Renaming and then
        # failing to clear leaves a cache of the OLD split sitting next to the
        # new stems, and the next re-align silently times the lyrics against
        # audio that no longer exists — wrong, and with nothing to notice it.
        # The lead stem is the transcription's input, so any rename landing at
        # all invalidates the cache.
        transcription_cache.clear(ctx.song_id)

        for name in REPLACEMENTS:
            os.replace(scratch / name, stems_dir / name)
        write_separation_marker(stems_dir)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    logger.info("Re-split %s complete for song %s (%s)", ctx.job_id, ctx.song_id, model)
    return (
        f"Re-split with {model}; transcription cache cleared — re-transcribe "
        f"to refresh lyrics timing"
    )
