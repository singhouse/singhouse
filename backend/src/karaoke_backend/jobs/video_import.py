# SPDX-License-Identifier: AGPL-3.0-only
"""Import a karaoke video the operator already has into their library.

The counterpart to ``jobs.ingest``, and deliberately much smaller. Ingest takes
an audio file apart; this takes a finished karaoke video the operator authored
or otherwise already holds and simply ADOPTS it. Nothing is separated, nothing
is transcribed, no lyrics are fetched — a karaoke video normally has its words
burned into the picture already, so producing a second set of them would be
work nobody asked for on top of the ones already on screen.

**What the job actually does.** The video is RETAINED and becomes the song's
display content. Its audio track is extracted once, into the ordinary
``instrumental`` stem, so playback runs through the existing audio engine —
mixer, key shift, the lot — instead of through a second, video-shaped path
that would have to grow its own copy of all of it. The song is therefore an
ordinary one-stem song to every reader downstream; the only new fact is
``Song.video_filename``, which names the retained file.

**Storage.** New audio defaults to MP3; ``STEM_FORMAT=flac`` selects
16-bit FLAC. For FLAC the extracted stem is written ``-sample_fmt s16``. A 32-bit
FLAC decodes fine in most tools and then silently fails in Web Audio in the
player, which is the worst shape a bug can take: the import reports success and
the song is silent. The flag is not an optimisation and must not be dropped.

**Marker/temp discipline.** Both artifacts are written to a temp name in their
destination directory and moved into place with ``os.replace`` — a rename
within a directory is atomic on POSIX, so a crash leaves either a complete file
or none. Nothing here re-derives completeness from mere file existence, which
is the trap the separation marker exists to avoid. The video is COPIED to that
temp name rather than renamed from the uploads directory: uploads and stems may
sit on different filesystems, where a rename fails outright.

**Re-entry.** A job is requeued when its lease lapses, whatever its handler
did — so this handler can be entered a second time for an import that already
finished, because the tail between releasing the upload and the worker's
terminal write is small but real. Entry therefore reads the stems directory
first, the way ingest reads its separation marker: a retained video file AND
the extracted stem both present means an earlier attempt reached the persist,
and the re-run redoes only the persist, which is idempotent. A partial state —
a stem but no video — is NOT complete and falls through to the ordinary path;
that is correct, because the persist only ever runs after both artifacts land,
so a song in that state was never ``ready`` and has nothing to protect.

**Upload lifecycle.** Two releases, neither of them a failure. (a) Once both
artifacts are in place and the song row is written — from then on the stems
directory is the artifact, and a requeued re-run completes through the
re-entry gate above without it. (b) When the song is deleted:
``DELETE /api/songs/{id}`` reaps the uploads of every job that song owned.

It is RETAINED on permanent failure, for the same reason ``jobs.ingest``
retains its own: ``POST /api/songs/{id}/retry`` re-queues THIS job, and with
no completed video on disk the handler has nothing to probe, extract or adopt
without the upload. Deleting it on the way out of a failure left the operator
re-uploading a file they had already given us — a bad probe, a missing ffmpeg,
an unreadable container are all things they can fix and try again. A failed
song is visible in the library with a delete button, so the disk a retained
upload holds is attributable and reclaimable.

It is NOT released in a blanket ``finally`` either: a lost lease belongs to
whoever holds the job now, and deleting their input would be aimed at somebody
else's work.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from sqlalchemy import update

from karaoke_backend.jobs import queue
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.models.song import JobPhase, Song
from karaoke_backend.stem_encoding import stem_codec_args, stem_format
from karaoke_backend.stem_layout import STEM_EXTS, resolve_stem

logger = logging.getLogger(__name__)

# The container formats an import may carry. Enforced by the upload route AND
# re-derived here: the payload is durable, so a row written by an older route
# (or by hand) reaches this handler without having passed today's checks.
VIDEO_EXTENSIONS: frozenset[str] = frozenset({".mp4", ".webm", ".mov", ".mkv"})

# The retained video's basename inside the stems directory, extension aside.
VIDEO_BASENAME = "video"

# Compatibility for extensions that still produce the original FLAC artifact.
# New core imports select their output through stem_format() at job time.
AUDIO_STEM_FILENAME = "instrumental.flac"

_PROBE_TIMEOUT = 120
_EXTRACT_TIMEOUT = 1800

# Coarse on purpose. There is no sub-phase worth reporting inside a single
# ffmpeg invocation, and a progress bar that lies smoothly is worse than one
# that moves in steps.
_PROGRESS_PROBED = 10
_PROGRESS_EXTRACTED = 60
_PROGRESS_MOVED = 90
_PROGRESS_DONE = 100


class VideoImportError(Exception):
    """A failure the operator should read, raised from inside a phase."""


# ---------------------------------------------------------------------------
# ffprobe / ffmpeg — the house pattern (asyncio.to_thread + subprocess.run),
# replicated locally rather than imported from karaoke_backend.export, which is
# an optional extra this module must not depend on.
# ---------------------------------------------------------------------------


def _missing_tool_message(tool: str) -> str:
    return (
        f"{tool} is not installed or not on this server's PATH. "
        f"Install ffmpeg to import a karaoke video file."
    )


async def _run(cmd: list[str], *, timeout: int) -> subprocess.CompletedProcess:
    """Run a media tool off the event loop, or raise VideoImportError.

    A missing binary is separated from every other failure here because it is
    the one an operator can act on directly, and the raw OSError text does not
    say so.
    """
    try:
        return await asyncio.to_thread(
            subprocess.run, cmd,
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise VideoImportError(_missing_tool_message(cmd[0])) from exc
    except subprocess.TimeoutExpired as exc:
        raise VideoImportError(
            f"{cmd[0]} timed out after {timeout}s on this file."
        ) from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise VideoImportError(f"{cmd[0]} could not be run: {exc}") from exc


def _is_real_video_stream(stream: object) -> bool:
    """A picture, as opposed to a cover image riding along in an audio file.

    An attached picture — the album art in an MP3, a poster frame — is reported
    by ffprobe as a video stream like any other, distinguished only by its
    ``attached_pic`` disposition. Counting one as a picture would let an
    audio-only file import as a video song whose entire runtime is one still
    frame, which is the failure this check exists to prevent.
    """
    if not isinstance(stream, dict) or stream.get("codec_type") != "video":
        return False
    disposition = stream.get("disposition")
    if isinstance(disposition, dict) and disposition.get("attached_pic"):
        return False
    return True


async def _probe(path: Path) -> tuple[Optional[float], bool, bool]:
    """(duration_seconds, has_audio_stream, has_video_stream) for a media file.

    One invocation answers all three questions, so a large file is opened once.
    Duration is optional — a container that does not declare one still imports,
    it simply has no duration on the row — but the two streams are not: a video
    with no audio has nothing for the mixer to play, and a file with no picture
    is an audio file wearing a video container, which belongs in the ordinary
    audio path rather than here.
    """
    cmd = [
        "ffprobe", "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        str(path),
    ]
    proc = await _run(cmd, timeout=_PROBE_TIMEOUT)
    if proc.returncode != 0:
        logger.error(
            "ffprobe failed for %s: %s", path, (proc.stderr or "").strip()[-2000:]
        )
        raise VideoImportError(
            "The video file could not be read — it may be corrupt or in an "
            "unsupported format."
        )

    try:
        data = json.loads(proc.stdout or "{}")
    except ValueError as exc:
        raise VideoImportError("The video file could not be read.") from exc
    if not isinstance(data, dict):
        raise VideoImportError("The video file could not be read.")

    streams = data.get("streams")
    streams = streams if isinstance(streams, list) else []
    has_audio = any(
        isinstance(s, dict) and s.get("codec_type") == "audio" for s in streams
    )
    has_video = any(_is_real_video_stream(s) for s in streams)

    duration: Optional[float] = None
    fmt = data.get("format")
    raw = fmt.get("duration") if isinstance(fmt, dict) else None
    if raw is not None:
        try:
            duration = float(raw)
        except (TypeError, ValueError):
            duration = None
    if duration is not None and duration <= 0:
        duration = None

    return duration, has_audio, has_video


async def _extract_audio(src: Path, dest: Path) -> None:
    """Write ``src``'s audio track to ``dest`` in the selected format, atomically."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".{dest.name}.tmp"
    # A leftover from a run that was killed mid-write is a whole file's worth
    # of dead bytes, and these files are large. The temp name is fixed and the
    # stems directory belongs to this job, so removing it first is safe.
    _unlink_quietly(tmp)
    cmd = [
        "ffmpeg", "-y", "-i", str(src),
        "-vn", "-map_metadata", "-1",
        *stem_codec_args(dest.suffix.lstrip(".")),
        str(tmp),
    ]
    proc = await _run(cmd, timeout=_EXTRACT_TIMEOUT)
    if proc.returncode != 0 or not tmp.is_file():
        logger.error(
            "ffmpeg audio extraction failed for %s: %s",
            src, (proc.stderr or "").strip()[-2000:],
        )
        _unlink_quietly(tmp)
        raise VideoImportError("The audio track could not be extracted from the video.")
    os.replace(tmp, dest)


async def _adopt_video(src: Path, dest: Path) -> None:
    """Copy the upload into the stems directory under its final name.

    Copy-then-replace, not rename: the uploads directory and the stems
    directory are separately configured and routinely land on different
    filesystems, where ``rename`` fails with EXDEV. The copy goes to a temp
    name in the DESTINATION directory so the final move is a same-directory
    rename and therefore atomic.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".{dest.name}.tmp"
    # Same reason as the extraction: clear a previous run's partial before
    # writing, and clear this run's on the way out however it ends. A video
    # left half-copied is the largest piece of garbage this job can produce.
    _unlink_quietly(tmp)
    try:
        await asyncio.to_thread(shutil.copyfile, src, tmp)
        os.replace(tmp, dest)
    except OSError as exc:
        raise VideoImportError(f"The video file could not be stored: {exc}") from exc
    finally:
        # A no-op on the success path — ``os.replace`` already consumed it.
        _unlink_quietly(tmp)


# ---------------------------------------------------------------------------
# Re-entry + persist
# ---------------------------------------------------------------------------


def completed_video_name(stems_dir: Path) -> Optional[str]:
    """The retained video's filename when BOTH artifacts are already on disk.

    The video-import counterpart to ``ingest.separation_is_complete``, and the
    same principle: re-enter at the first phase whose output is missing. Both
    files are required, because only the pair proves an earlier attempt got as
    far as the persist — the stem alone is a half-finished import, and its song
    was never ``ready``.
    """
    if resolve_stem(stems_dir, "instrumental") is None:
        return None
    for extension in sorted(VIDEO_EXTENSIONS):
        candidate = stems_dir / f"{VIDEO_BASENAME}{extension}"
        if candidate.is_file():
            return candidate.name
    return None


async def _persist_ready(
    song_id: int,
    *,
    stems_dir: Path,
    duration: Optional[float],
    video_filename: str,
) -> None:
    """Flip the song to ``ready`` and record where its artifacts are.

    Written once and called from both the first run and a re-run, so the two
    cannot drift into disagreeing about what a finished import looks like. The
    statement is idempotent by construction: it sets values, never increments.
    """
    from karaoke_backend.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        await db.execute(
            update(Song)
            .where(Song.id == song_id)
            .values(
                status="ready",
                duration=duration,
                stems_path=str(stems_dir),
                video_filename=video_filename,
            )
        )
        await db.commit()


# ---------------------------------------------------------------------------
# The handler
# ---------------------------------------------------------------------------


async def run_video_import(ctx: JobContext) -> Optional[str]:
    """Adopt an uploaded karaoke video as a ready song.

    Probe → extract audio → adopt the video → persist. The Song stays
    ``processing`` until all three artifacts (stem, video, row) are in place;
    only then is it flipped to ``ready``. The worker owns the job row's
    terminal state; the returned string becomes its final message.

    Re-entrant: an attempt that finds both artifacts already on disk redoes
    the persist and nothing else. See the module docstring.
    """
    from karaoke_backend.api.separate import STEMS_DIR, UPLOADS_DIR

    payload = ctx.payload
    song_id = ctx.song_id
    if song_id is None:
        raise JobFailure("Video import job has no song")

    stems_dir = STEMS_DIR / str(song_id)
    upload_name = payload.get("upload_name")
    upload_path = UPLOADS_DIR / upload_name if upload_name else None

    async def set_phase(pct: int, msg: str) -> None:
        """Publish progress — and double as the lease check on every step.

        ``update_progress`` returns False when this worker no longer holds the
        claim. Turning that into an exception is what stops the handler before
        it reaches the ``songs`` write, which has no claim column of its own to
        be refused by.
        """
        if not await queue.update_progress(
            ctx.job_id,
            ctx.worker_id,
            phase=JobPhase.IMPORTING.value,
            progress=pct,
            message=msg,
        ):
            raise LeaseLost(ctx.job_id)

    try:
        await set_phase(0, "Reading the video file")

        # Before anything is asked of the upload: an earlier attempt may have
        # finished the whole import and then had its lease requeued out from
        # under the tail of it. Failing such a re-run for a missing upload
        # would fail a song that is complete and playable.
        finished_video = completed_video_name(stems_dir)
        if finished_video is not None:
            logger.info(
                "Video import %s: song %d already has both artifacts — "
                "re-running the persist only",
                ctx.job_id, song_id,
            )
            # The retained file is a byte copy of the upload, so it answers the
            # duration question exactly as the upload did.
            duration, _has_audio, _has_video = await _probe(stems_dir / finished_video)
            await set_phase(_PROGRESS_MOVED, "Saving the song")
            if not await queue.heartbeat(ctx.job_id, ctx.worker_id):
                raise LeaseLost(ctx.job_id)
            await _persist_ready(
                song_id,
                stems_dir=stems_dir,
                duration=duration,
                video_filename=finished_video,
            )
            if upload_path is not None:
                _unlink_quietly(upload_path)
            await set_phase(_PROGRESS_DONE, "Video import complete")
            return "Video import complete"

        if upload_path is None or not upload_path.is_file():
            raise VideoImportError(
                "The uploaded video is gone — upload the file again."
            )

        # Re-derived rather than trusted: the payload is durable and may have
        # been written by an older route with a different allowlist.
        extension = Path(upload_name).suffix.lower()
        if extension not in VIDEO_EXTENSIONS:
            raise VideoImportError(
                f"{extension or 'That file'} is not a supported video "
                f"container (MP4, WebM, MOV, or MKV)."
            )

        duration, has_audio, has_video = await _probe(upload_path)
        if not has_audio:
            raise VideoImportError("The video file has no audio track.")
        if not has_video:
            # An audio file in a video container, or one whose only "picture"
            # is embedded cover art. Importing it would produce a song whose
            # screen is black for its whole runtime.
            raise VideoImportError(
                "The file has no picture — import it through the audio upload "
                "instead."
            )
        await set_phase(_PROGRESS_PROBED, "Extracting the audio track")

        audio_dest = stems_dir / f"instrumental.{stem_format()}"
        await _extract_audio(upload_path, audio_dest)
        # A retry may use a different output setting than its failed attempt.
        # Only retire the old format after the replacement landed atomically;
        # otherwise lookup precedence could select the stale extraction.
        for ext in STEM_EXTS:
            alternate = stems_dir / f"instrumental{ext}"
            if alternate != audio_dest:
                alternate.unlink(missing_ok=True)
        await set_phase(_PROGRESS_EXTRACTED, "Storing the video")

        video_filename = f"{VIDEO_BASENAME}{extension}"
        await _adopt_video(upload_path, stems_dir / video_filename)
        await set_phase(_PROGRESS_MOVED, "Saving the song")

        # Re-verify the claim on the threshold of the persist. Extraction can
        # run for minutes with no job-row write in between, which is long
        # enough to lose a lease; a stale worker arriving here would flip a
        # Song to `ready` out from under whoever reclaimed the job. This
        # narrows the window to one statement rather than closing it, and that
        # is the honest claim.
        if not await queue.heartbeat(ctx.job_id, ctx.worker_id):
            raise LeaseLost(ctx.job_id)

        await _persist_ready(
            song_id,
            stems_dir=stems_dir,
            duration=duration,
            video_filename=video_filename,
        )

        # The stems directory holds both artifacts now; the upload was only
        # ever the way to produce them.
        _unlink_quietly(upload_path)

        await set_phase(_PROGRESS_DONE, "Video import complete")
        logger.info(
            "Video import %s complete for song %d (%s)",
            ctx.job_id, song_id, video_filename,
        )
        return "Video import complete"

    # Nothing below releases `upload_path`. A failed video import is retryable
    # and the upload is what it would be retried FROM: see the module
    # docstring's upload lifecycle.
    except LeaseLost:
        # Not a failure of the job — a failure of THIS worker to still own it.
        # The upload stays: it belongs to the run that holds the claim now.
        raise
    except VideoImportError as exc:
        raise JobFailure(str(exc), str(exc)) from exc
    except JobFailure:
        raise
    except Exception as exc:
        logger.exception("Unexpected error in video import job %s", ctx.job_id)
        raise JobFailure("Unexpected error", str(exc)) from exc


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
