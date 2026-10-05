# SPDX-License-Identifier: AGPL-3.0-only
"""The ingest orchestrator: separation → reference lyrics → transcribe → align.

Moved out of ``api/separate.py`` with the durable queue. The route now only writes a queued
row; this is the single entry point the worker, the tests and any future
CLI/batch caller share.

**Phase resume.** The job may be entered more than once — a lease that lapsed
while the process was gone comes back as a fresh claim — so each phase asks
the filesystem whether its artifact already exists before doing the work
again. A transcription cache under the song's stems directory makes
``generate_word_sync`` align-only by itself. The phases with no artifact (the
reference-lyrics fetch, LLM paging) simply re-run; they are seconds, not
minutes, and ``pasted_lyrics`` survives in the payload.

**Why separation is checkpointed by a marker and not by the stem files.**
The three stems are not written atomically: ``modal_worker`` copies
``lead_vocals.wav`` into place and lets ffmpeg write ``instrumental.wav`` and
then ``karaoke.wav`` straight to their final names. A process killed during
the karaoke mix therefore leaves all three NAMES present with the last one
truncated — indistinguishable, by existence alone, from a clean run. Resuming
on that would publish corrupt stems AND release the upload that was the only
way to redo the work. So completion is an explicit fact this module writes,
once, after separation returns: ``.separation-complete``, created via a temp
file and ``os.replace`` so it either exists in full or not at all. The marker
gates the resume branch and every success-path release of the upload.

**Upload lifecycle.** The upload is released in exactly two places, and
neither of them is a failure. (a) Once the marker says separation finished —
the stems are the artifact from then on. (b) When the song is deleted:
``DELETE /api/songs/{id}`` reaps the uploads of every job that song owned.

It is RETAINED on permanent failure. ``POST /api/songs/{id}/retry`` replays
this job, and phase 1 has nothing to separate without the file — so releasing
it here (as this module used to, and as the pre-queue blanket ``finally``
did) made every failure BEFORE the marker unrecoverable, which is precisely
the class a retry button exists to rescue: a separation backend that was not
configured yet, a GPU that was busy, a process killed mid-run. The disk that
costs is bounded and attributable — a failed song sits in the library with a
delete button beside it, and deleting it takes the upload with it.

On a lost lease the upload is untouched too, for a different reason: it
belongs to the run that holds the claim now, and deleting it would be aimed at
somebody else's work.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import update

from karaoke_backend.jobs import queue
from karaoke_backend.jobs._llm import make_correction_progress_callback
from karaoke_backend.jobs._progress import make_message_callback
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.models.song import Job, JobPhase, LyricsSet, LyricsSource, Song
from karaoke_backend.workers.llm_paging import page_word_sync
from karaoke_backend.workers.lyrics_worker import (
    LRCLIB_ENV,
    LyricsNotFoundError,
    LyricsServiceError,
    fetch_lyrics,
    lrclib_enabled,
)
from karaoke_backend.workers.modal_worker import (
    StemSeparationError,
    ProcessingRefusedError,
    separate_stems,
    separation_timeout,
)
from karaoke_backend.workers.word_sync_worker import (
    DEFAULT_MODEL,
    describe_run,
    generate_word_sync,
    make_correction_config,
)

logger = logging.getLogger(__name__)

# Phase → (overall progress range start, end). Overall progress is 0–100 across
# the whole pipeline so the frontend bar moves monotonically.
_PHASE_RANGES = {
    JobPhase.SEPARATING.value:      (0, 75),
    JobPhase.FETCHING_LYRICS.value: (75, 78),
    JobPhase.TRANSCRIBING.value:    (78, 95),
    JobPhase.ALIGNING.value:        (95, 100),
}

# The outputs separation is expected to leave behind. Recorded IN the marker,
# never used as the completion test — see the module docstring for why file
# existence cannot distinguish a finished mix from a killed one.
SEPARATION_ARTIFACTS = ("lead_vocals.wav", "instrumental.wav", "karaoke.wav")

SEPARATION_MARKER = ".separation-complete"


class IngestError(Exception):
    """Raised when a non-separation ingest phase fails."""


def separation_is_complete(stems_dir: Path) -> bool:
    """Whether a previous attempt finished separation for this song."""
    return (stems_dir / SEPARATION_MARKER).is_file()


def write_separation_marker(stems_dir: Path) -> None:
    """Record that separation finished, atomically.

    Temp file + ``os.replace``: rename within a directory is atomic on POSIX,
    so a crash leaves either no marker or a complete one. A half-written
    marker would reintroduce exactly the ambiguity it exists to remove.
    """
    marker = stems_dir / SEPARATION_MARKER
    tmp = stems_dir / f"{SEPARATION_MARKER}.tmp"
    payload = json.dumps(
        {
            "artifacts": [
                name for name in SEPARATION_ARTIFACTS if (stems_dir / name).exists()
            ],
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, marker)


def _phase_progress(phase: str, sub_pct: int) -> int:
    """Map a sub-phase pct (0-100) into the overall pipeline pct."""
    lo, hi = _PHASE_RANGES.get(phase, (0, 100))
    sub_pct = max(0, min(100, sub_pct))
    return lo + round((hi - lo) * sub_pct / 100)


async def _run_with_retry(coro_factory, *, job_id: str, timeout_s: int) -> None:
    """Run ``coro_factory()`` with one retry on StemSeparationError.

    The separation worker owns and reaps every local child before cancellation
    reaches here, so timeout cannot release the queue slot ahead of GPU work.
    """
    last_err: Optional[Exception] = None
    for attempt in range(2):
        try:
            await asyncio.wait_for(coro_factory(), timeout=timeout_s)
            return
        except asyncio.TimeoutError:
            raise StemSeparationError(f"Stem separation timed out after {timeout_s}s")
        except ProcessingRefusedError:
            # Processing was refused up front; a second attempt cannot change that.
            raise
        except StemSeparationError as e:
            last_err = e
            if attempt == 0:
                logger.warning("Job %s failed (attempt 1), retrying: %s", job_id, e)
                await asyncio.sleep(5)
                continue
            raise
    if last_err:
        raise last_err


async def _mark_song_processing(song_id: int) -> None:
    from karaoke_backend.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        await db.execute(
            update(Song).where(Song.id == song_id).values(status="processing")
        )
        await db.commit()


async def run_ingest(ctx: JobContext) -> Optional[str]:
    """End-to-end ingest: separation → lrclib metadata fetch → transcription →
    align (using pasted lyrics or opted-in plain-text lookup when available).

    Updates Job + Song rows throughout. Song stays in ``processing`` until
    every phase succeeds; only then is it flipped to ``ready``. The worker
    owns the job row's terminal state; the returned string becomes its final
    message.
    """
    from karaoke_backend.api.separate import STEMS_DIR, UPLOADS_DIR, _make_stems_urls
    from karaoke_backend.database import AsyncSessionLocal

    payload = ctx.payload
    song_id = ctx.song_id
    if song_id is None:
        raise JobFailure("Ingest job has no song")

    artist: str = payload.get("artist") or "Unknown Artist"
    title: str = payload.get("title") or ""
    pasted_lyrics: Optional[str] = payload.get("pasted_lyrics")
    llm_correction: bool = bool(payload.get("llm_correction"))
    llm_paging: bool = bool(payload.get("llm_paging"))
    # Pass-2 lead/backing model for this song, as an ID from
    # karaoke_models.CHOICES. It is absent on legacy jobs and on uploads that
    # did not touch the picker; separate_stems reads that as "use the
    # server-configured model", preserving their original behaviour.
    karaoke_model: Optional[str] = payload.get("karaoke_model")

    stems_dir = STEMS_DIR / str(song_id)
    upload_name = payload.get("upload_path")
    audio_path = UPLOADS_DIR / upload_name if upload_name else None

    async def set_phase(phase: str, sub_pct: int, msg: str) -> None:
        """Publish progress — and double as the lease check on every phase.

        `update_progress` returns False when this worker no longer holds the
        claim. Turning that into an exception is what stops the handler before
        it reaches the `songs` / `lyrics_sets` writes, which have no claim
        column of their own to be refused by.
        """
        if not await queue.update_progress(
            ctx.job_id,
            ctx.worker_id,
            phase=phase,
            progress=_phase_progress(phase, sub_pct),
            message=msg,
        ):
            raise LeaseLost(ctx.job_id)

    async def on_separation_progress(_status: str, pct: int, msg: str) -> None:
        # modal_worker emits its own status strings ("uploading", "mixing", …);
        # collapse them all under the umbrella "separating" phase.
        await set_phase(JobPhase.SEPARATING.value, pct, msg)

    await _mark_song_processing(song_id)

    try:
        # ── 1. Stem separation ────────────────────────────────────────
        if separation_is_complete(stems_dir):
            logger.info(
                "Job %s: separation marker present at %s — resuming after separation",
                ctx.job_id, stems_dir,
            )
            await set_phase(
                JobPhase.SEPARATING.value, 100, "Stems already separated — resuming"
            )
        else:
            if audio_path is None or not audio_path.exists():
                raise IngestError(
                    "The uploaded audio is gone and no stems were produced — "
                    "re-upload the file."
                )
            await set_phase(JobPhase.SEPARATING.value, 0, "Starting stem separation")
            await _run_with_retry(
                lambda: separate_stems(
                    audio_path=audio_path,
                    stems_dir=stems_dir,
                    job_id=ctx.job_id,
                    on_progress=on_separation_progress,
                    karaoke_model=karaoke_model,
                ),
                job_id=ctx.job_id,
                # Follows the inner stage deadlines: a guarded worker may choose
                # its slower measured CPU route after its own memory check.
                timeout_s=separation_timeout(),
            )
            # Only now — separation returned, so every mix ran to completion.
            write_separation_marker(stems_dir)

        # The stems are the artifact now; the upload is only ever needed to
        # produce them. Gated on the marker rather than on reaching this line,
        # so no future edit above can make the release outrun the proof.
        if audio_path is not None and separation_is_complete(stems_dir):
            _unlink_quietly(audio_path)

        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Song).where(Song.id == song_id).values(stems_path=str(stems_dir))
            )
            await db.commit()

        # ── 2. Reference lyrics ────────────────────────────────────────
        # Opted-in lookup supplies words only; derive timing from this audio.
        # Pasted lyrics take priority, and a stock install makes no lookup.
        plain_lyrics: Optional[str] = None
        synced_lyrics: Optional[str] = None
        paging_lyrics: Optional[str] = None
        duration: Optional[float] = None
        if pasted_lyrics and pasted_lyrics.strip():
            plain_lyrics = pasted_lyrics.strip()
            paging_lyrics = plain_lyrics
            await set_phase(JobPhase.FETCHING_LYRICS.value, 100, "Using pasted lyrics")
        elif not lrclib_enabled():
            # Checked before the phase message rather than relying on
            # fetch_lyrics to raise: announcing "Looking up lyrics…" for a
            # lookup that will not happen misdescribes the ingest, and the
            # operator should be able to tell "off" from "found nothing".
            logger.info(
                "Lyrics lookup is off (%s unset) — ingest aligns unanchored",
                LRCLIB_ENV,
            )
            await set_phase(
                JobPhase.FETCHING_LYRICS.value, 100,
                "Lyrics lookup is off — aligning unanchored",
            )
        else:
            await set_phase(
                JobPhase.FETCHING_LYRICS.value, 0,
                f"Looking up lyrics for {artist} – {title}",
            )
            try:
                lyrics = await fetch_lyrics(artist=artist, title=title)
                plain_lyrics = (lyrics.plain_lyrics or "").strip() or None
                paging_lyrics = plain_lyrics
                duration = lyrics.duration
                msg = ("Using fetched plain lyrics — timing from audio"
                       if plain_lyrics else
                       "No plain lyrics found — using audio-only generation; paste lyrics to retry")
                await set_phase(JobPhase.FETCHING_LYRICS.value, 100, msg)
                if duration is not None:
                    async with AsyncSessionLocal() as db:
                        await db.execute(
                            update(Song).where(Song.id == song_id).values(duration=duration)
                        )
                        await db.commit()
            except (LyricsNotFoundError, LyricsServiceError) as exc:
                logger.info("No reference lyrics for %s – %s: %s", artist, title, exc)
                await set_phase(
                    JobPhase.FETCHING_LYRICS.value, 100,
                    "Lyrics lookup unavailable — using audio-only generation; paste lyrics to retry",
                )

        # ── 3. Transcription + alignment ──────────────────────────────
        vocals_path = stems_dir / "lead_vocals.wav"
        if not vocals_path.exists():
            # fallback: any vocals stem
            for name in ("vocals.wav", "Vocals.wav"):
                alt = stems_dir / name
                if alt.exists():
                    vocals_path = alt
                    break
        if not vocals_path.exists():
            raise IngestError(f"No vocals stem found in {stems_dir}")

        await set_phase(
            JobPhase.TRANSCRIBING.value, 0, f"Transcribing vocals with {DEFAULT_MODEL}"
        )
        pipeline_config = None
        correction_progress_fn = None
        if llm_correction:
            from lyricsync import PipelineConfig
            pipeline_config = make_correction_config(PipelineConfig())
            correction_progress_fn = make_correction_progress_callback(
                ctx.job_id,
                ctx.worker_id,
                asyncio.get_running_loop(),
            )

        # song_id is what writes the transcription cache — and a cache hit on a
        # later attempt is what makes the transcription phase resume as
        # align-only. Omitting it (as the pre-queue call did) meant ingest
        # re-transcribed from scratch forever.
        word_data = await generate_word_sync(
            vocals_path=str(vocals_path),
            artist=artist,
            title=title,
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            whisper_model=DEFAULT_MODEL,
            use_vad=True,
            song_id=song_id,
            pipeline_config=pipeline_config,
            correction_progress_fn=correction_progress_fn,
            device_notice_fn=make_message_callback(
                ctx.job_id, ctx.worker_id, asyncio.get_running_loop()
            ),
        )
        if word_data is None:
            raise IngestError("Transcription returned no result")

        if llm_paging and paging_lyrics:
            await set_phase(JobPhase.ALIGNING.value, 30, "Structuring pages (LLM)")
            word_data = await page_word_sync(word_data, paging_lyrics)

        await set_phase(JobPhase.ALIGNING.value, 50, "Saving lyrics set")

        # ── 4. Persist as a new LyricsSet, mark active ────────────────
        label = describe_run(DEFAULT_MODEL, use_vad=True)
        ref_mode = word_data["metadata"].get("ref_mode", "none")
        if ref_mode != "none":
            label = f"{label}-{ref_mode}"

        # Re-verify the claim on the threshold of the only multi-table write
        # in this handler. Transcription can run for minutes with no job-row
        # write in between, which is exactly long enough to lose a lease; a
        # stale worker arriving here would add a duplicate LyricsSet and flip
        # a Song to `ready` out from under whoever reclaimed the job. Nothing
        # can make this atomic across tables — it narrows the window to one
        # statement, and that is the honest claim.
        if not await queue.heartbeat(ctx.job_id, ctx.worker_id):
            raise LeaseLost(ctx.job_id)

        # BASE_URL is read HERE, at the moment the URLs are built and stored,
        # not at handler entry: the tunnel comes up after the worker starts,
        # so a job claimed on the first pass would otherwise bake the
        # pre-tunnel host into `job.stems` and hand out unreachable links.
        base_url = os.getenv("BASE_URL", "http://localhost:8000")
        stems_json = _make_stems_urls(song_id, stems_dir, base_url).model_dump_json()

        async with AsyncSessionLocal() as db:
            new_set = LyricsSet(
                song_id=song_id,
                owner_id=ctx.owner_id,
                source=LyricsSource.TRANSCRIPTION.value,
                label=label,
                is_verified=False,
                plain_lyrics=plain_lyrics,
                synced_lyrics=synced_lyrics,
                word_sync_json=json.dumps(word_data),
                metadata_json=json.dumps(word_data["metadata"]),
            )
            db.add(new_set)
            await db.flush()  # populate new_set.id

            await db.execute(
                update(Song)
                .where(Song.id == song_id)
                .values(
                    active_lyrics_id=new_set.id,
                    status="ready",
                    lyrics_synced=True,
                )
            )
            await db.execute(
                update(Job)
                .where(Job.id == ctx.job_id, Job.claimed_by == ctx.worker_id)
                .values(stems=stems_json)
            )
            await db.commit()

        logger.info("Ingest %s complete for song %d (%s)", ctx.job_id, song_id, label)
        return "Ingest complete"

    # Nothing below releases `audio_path`. Every one of these paths is a
    # failure, and a failed song is retryable: see the module docstring's
    # upload lifecycle.
    except LeaseLost:
        # Not a failure of the job — a failure of THIS worker to still own it.
        # The upload stays: it belongs to the run that holds the claim now,
        # and deleting it here would be the same bug as the blanket `finally`,
        # aimed at somebody else's work.
        raise
    except ProcessingRefusedError as exc:
        raise JobFailure(str(exc), str(exc)) from exc
    except StemSeparationError as exc:
        raise JobFailure("Stem separation failed", str(exc)) from exc
    except IngestError as exc:
        raise JobFailure(str(exc), str(exc)) from exc
    except JobFailure:
        raise
    except Exception as exc:
        logger.exception("Unexpected error in job %s", ctx.job_id)
        raise JobFailure("Unexpected error", str(exc)) from exc


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
