# SPDX-License-Identifier: AGPL-3.0-only
"""Import one track from the operator's own media server, then ingest it.

A THIN front half bolted onto ``jobs.ingest``. Everything this handler does
happens before ingest's first phase: get the audio into the uploads directory
under the name the rest of the system expects, optionally pick up a reference
lyric, and hand a normal ingest payload to ``run_ingest``. There is no second
copy of the pipeline here and there must never be one — a Plex-imported song
is an ordinary song, separated by the ordinary orchestrator, and any behaviour
that differs is a bug rather than a feature.

**Copy, never move, never link.** The file on the media server is the
operator's library. This job may read it; it may not rearrange it. A hardlink
would be worse than a move, not better — the library file and the upload would
be one inode, and the uploads reaper deleting "its" file after separation
would delete the operator's music. So: ``copyfile``, always, and the local path
is only ever opened for reading.

**The copy belongs to the attempt, and dies with it.** ``jobs.ingest`` RETAINS
the upload it is handed on a permanent failure, because for an uploaded song
that file is the only way back and ``POST /api/songs/{id}/retry`` replays the
job against it. A Plex import has a better source than a retained copy: a
retry of one re-materialises the track from the operator's own server, which
is the authority for the file and is still there. So a ``JobFailure`` coming
back out of the handoff releases the copy THIS job made — keeping it would
leave an orphan nothing ever reads and nothing ever collects. A ``LeaseLost``
does not: the copy belongs to whoever holds the claim now.

**Two ways in, one outcome.** When the library's storage is visible to this
machine (the common self-hosted case — same box, or the same NFS mount), the
file is copied straight off disk, which is fast and costs the server nothing.
When it is not, the track is streamed from the server over HTTP. The path
mapping (``KARAOKE_PLEX_PATH_MAP``) exists to make the first case reachable
from a container; getting it wrong is not dangerous, it just falls back to the
second.

**Upload naming is load-bearing.** The materialised file MUST be named
``{job_id}_{safe_filename}`` — ``queue.unlink_uploads_for`` reaps a job's
leftovers by that prefix, and a file named any other way is one nothing ever
collects. The in-progress copy is ``{job_id}_{safe_filename}.partial``, which
still carries the prefix and is therefore still reaped; the rename into place
is ``os.replace`` within one directory, so ingest never sees a half-written
file that exists under the final name.

**The server is the authority for the file, not the client.** The browser
posts back a rating key and display metadata; it does NOT get to say which
path on this machine to copy. This handler re-resolves the part key and the
library path from ``GET /library/metadata/{rating_key}`` before it touches
anything, because a client that could hand this process an arbitrary
``file_path`` could have any readable file on the box copied into the library
and served back as a song. The rating key itself is trusted, and can be: it is
opaque, and the server resolves it in its own namespace, so the worst a
doctored one names is a different track on the operator's own server.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Optional

from karaoke_backend.jobs import queue
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.jobs.ingest import run_ingest, separation_is_complete
from karaoke_backend.models.song import JobPhase
from karaoke_backend.plex import config as plex_config
from karaoke_backend.plex.client import PlexClient, PlexError

logger = logging.getLogger(__name__)

#: Progress reported while the front half runs. Ingest's own scale starts at 0
#: again the moment it takes over, and that is fine: the phase changes too, so
#: the bar is read against a different label rather than appearing to go
#: backwards within one.
_PROGRESS_FETCHING = 20
_PROGRESS_MATERIALISED = 60
_PROGRESS_HANDOFF = 90

_IMPORT_MESSAGE = "Importing from Plex"

#: Suffix of the in-progress copy. Keeps the `{job_id}_` prefix so the
#: uploads reaper still collects it; see the module docstring.
PARTIAL_SUFFIX = ".partial"


def _existing_upload(uploads_dir: Path, job_id: str) -> Optional[Path]:
    """A finished upload this job already produced, if any.

    The re-entry probe, and deliberately a filesystem question rather than a
    server one: a requeued attempt should not have to ask the media server
    anything to discover that it already has the bytes. ``.partial`` files are
    skipped — one of those is a copy that did NOT finish, and reusing it would
    feed the separator a truncated track.
    """
    prefix = f"{job_id}_"
    try:
        entries = sorted(uploads_dir.iterdir())
    except OSError:
        return None
    for path in entries:
        if not path.name.startswith(prefix) or path.name.endswith(PARTIAL_SUFFIX):
            continue
        try:
            if path.is_file() and path.stat().st_size > 0:
                return path
        except OSError:
            continue
    return None


def _local_library_file(file_path: Optional[str]) -> Optional[Path]:
    """The library file as THIS machine can open it, if it can open it at all.

    Returns None whenever the answer is not an unambiguous "yes, that is a
    readable regular file here" — a missing path, a directory, a broken mount.
    Every None simply routes the job to the streaming fallback, so this is
    allowed to be conservative and silent.
    """
    mapped = plex_config.map_library_path(file_path)
    if not mapped:
        return None
    try:
        path = Path(mapped)
        return path if path.is_file() else None
    except OSError:
        return None


async def run_plex_import(ctx: JobContext) -> Optional[str]:
    """Materialise a track from the media server, then run the normal ingest.

    The return value is ``run_ingest``'s: this handler's own work is finished
    by the time ingest starts, and the worker's terminal message should be the
    one describing the ingest that actually produced the song.
    """
    from karaoke_backend.api.separate import STEMS_DIR, UPLOADS_DIR
    from karaoke_backend.database import AsyncSessionLocal

    payload = ctx.payload
    if ctx.song_id is None:
        raise JobFailure("Plex import job has no song")

    rating_key = payload.get("rating_key")
    if not rating_key:
        raise JobFailure("This import has no track to resolve on the server.")
    artist = payload.get("artist") or "Unknown Artist"
    title = payload.get("title") or ""
    # A HINT from the browse listing, used only to skip a pointless lyric
    # lookup. The server's own answer decides whether a lyric is really there.
    has_lyrics_hint = bool(payload.get("has_lyrics"))

    async def set_phase(pct: int, msg: str) -> None:
        """Publish progress — and double as the lease check on every step.

        ``update_progress`` returns False when this worker no longer holds the
        claim; turning that into an exception stops the handler before it can
        write a file for a job that belongs to someone else now.
        """
        if not await queue.update_progress(
            ctx.job_id,
            ctx.worker_id,
            phase=JobPhase.IMPORTING.value,
            progress=pct,
            message=msg,
        ):
            raise LeaseLost(ctx.job_id)

    async with AsyncSessionLocal() as db:
        base_url = await plex_config.effective_url(db)
    client = PlexClient(base_url, plex_config.effective_token())

    stems_dir = STEMS_DIR / str(ctx.song_id)
    upload_path: Optional[Path] = None
    partial_path: Optional[Path] = None

    try:
        await set_phase(0, _IMPORT_MESSAGE)

        # ── 1. Materialise the audio ──────────────────────────────────
        # Three ways in, cheapest first. A lease that lapsed after the work
        # was done comes back as a fresh claim, so every one of these has to
        # be reachable on a second entry.
        if separation_is_complete(stems_dir):
            # The stems ARE the artifact from here on; ingest's own re-entry
            # gate will see the same marker and skip straight past separation.
            # Asking the media server for a file nobody will read would be
            # work done to throw away.
            logger.info(
                "Plex import %s: separation already complete for song %d — "
                "nothing to materialise",
                ctx.job_id, ctx.song_id,
            )
        elif (existing := _existing_upload(UPLOADS_DIR, ctx.job_id)) is not None:
            upload_path = existing
            logger.info(
                "Plex import %s: reusing the upload a previous attempt left at %s",
                ctx.job_id, existing.name,
            )
        else:
            # Only now does anything reach the server — and the FIRST thing it
            # asks is where the file actually is. Nothing below reads a path
            # that came from the client.
            media = await client.track_media(str(rating_key))
            if media is None:
                raise JobFailure(
                    "That track is no longer in the media server's library."
                )

            name = plex_config.upload_basename({
                "file_path": media.file_path,
                "part_key": media.part_key,
                "title": media.title or title,
                "container": media.container,
            })
            upload_path = UPLOADS_DIR / f"{ctx.job_id}_{name}"
            partial_path = UPLOADS_DIR / f"{ctx.job_id}_{name}{PARTIAL_SUFFIX}"

            UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
            # A leftover from an attempt that died mid-copy is a whole track's
            # worth of dead bytes under a name we are about to write.
            _unlink_quietly(partial_path)

            local = _local_library_file(media.file_path)
            await set_phase(_PROGRESS_FETCHING, _IMPORT_MESSAGE)
            if local is not None:
                # Off the event loop: a lossless album track is tens of MB and
                # a copy of it would otherwise block the heartbeat.
                await asyncio.to_thread(shutil.copyfile, local, partial_path)
                logger.info(
                    "Plex import %s: copied the library file for %r", ctx.job_id, title
                )
            else:
                await client.fetch_part_to(str(media.part_key or ""), partial_path)

            if not partial_path.is_file() or partial_path.stat().st_size == 0:
                raise JobFailure(
                    "The track could not be copied from the media server.",
                    f"empty or missing copy at {partial_path}",
                )
            # Same directory, so the rename is atomic: ingest either finds a
            # complete file under this name or no file at all.
            os.replace(partial_path, upload_path)
            partial_path = None

        await set_phase(_PROGRESS_MATERIALISED, _IMPORT_MESSAGE)

        # ── 2. Reference lyrics (opt-in, off by default) ──────────────
        pasted_lyrics: Optional[str] = None
        if has_lyrics_hint and plex_config.plex_lyrics_enabled():
            try:
                pasted_lyrics = await client.fetch_plain_lyrics(str(rating_key))
            except PlexError as exc:
                # Never fatal. A song with no reference lyric ingests fine —
                # that is the shipped default for every song — so a lyric fetch
                # that fails must not cost the operator the import.
                logger.warning(
                    "Plex import %s: lyrics unavailable for %r (%s)",
                    ctx.job_id, title, exc,
                )
                pasted_lyrics = None

        await set_phase(_PROGRESS_HANDOFF, _IMPORT_MESSAGE)

    except LeaseLost:
        # Not a failure of the job — a failure of THIS worker to still own it.
        # The upload stays: it belongs to whoever holds the claim now.
        raise
    except JobFailure:
        _release(upload_path, partial_path)
        raise
    except PlexError as exc:
        _release(upload_path, partial_path)
        raise JobFailure(str(exc), str(exc)) from exc
    except OSError as exc:
        _release(upload_path, partial_path)
        raise JobFailure(
            "The track could not be copied into this install's uploads folder.",
            str(exc),
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error in Plex import job %s", ctx.job_id)
        _release(upload_path, partial_path)
        raise JobFailure("Unexpected error", str(exc)) from exc

    # ── 3. Hand off to the ordinary ingest ─────────────────────────────
    # Same job, same ids, same claim — only the payload is rewritten into the
    # shape ``run_ingest`` reads. Nothing Plex-specific survives the handoff:
    # from here the song is indistinguishable from an uploaded one, which is
    # exactly the property that keeps this file thin.
    ingest_ctx = replace(
        ctx,
        payload={
            # None on the resume path above: ingest reads this only when its
            # own separation marker is absent, and treats None as "no upload"
            # rather than looking for a file named after nothing.
            "upload_path": upload_path.name if upload_path is not None else None,
            "artist": artist,
            "title": title,
            "pasted_lyrics": pasted_lyrics,
            "llm_paging": bool(payload.get("llm_paging")),
            "karaoke_model": payload.get("karaoke_model"),
        },
    )
    try:
        return await run_ingest(ingest_ctx)
    except LeaseLost:
        # Someone else holds the job — and therefore the copy — now.
        raise
    except JobFailure:
        # Ingest keeps the file it is given on a failure so a retry can re-run
        # phase 1 from it. That is right for an UPLOAD and wrong here: a retry
        # of a Plex import re-fetches the track from the operator's server, so
        # this copy would be read by nobody. Released by the job that made it,
        # which is the only code that knows it was a copy.
        _release(upload_path, None)
        raise


def _release(upload_path: Optional[Path], partial_path: Optional[Path]) -> None:
    """Drop whatever this attempt wrote, on a PERMANENT failure.

    Both names, because a failure can land on either side of the rename. The
    reaper would eventually collect them by prefix anyway; doing it here means
    a failed import does not sit on a track's worth of disk until it does.
    """
    for path in (partial_path, upload_path):
        if path is not None:
            _unlink_quietly(path)


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
