# SPDX-License-Identifier: AGPL-3.0-only
"""
Song library CRUD endpoints.

GET    /api/songs              → List all songs
GET    /api/songs/{song_id}    → Get song details + stem URLs
DELETE /api/songs/{song_id}    → Delete song + stems
PATCH  /api/songs/{song_id}    → Update song metadata

GET    /api/songs/{song_id}/stems/{filename}   → Stream a stem file
POST   /api/songs/{song_id}/stems/resplit      → Re-run the lead/backing split
POST   /api/songs/{song_id}/retry              → Re-queue a failed ingest
GET    /api/songs/{song_id}/video              → Stream the retained video
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import get_current_user, get_host_id, require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.database import get_db
from karaoke_backend import stem_layout, stem_storage
from karaoke_backend.jobs import queue
from karaoke_backend.models.song import Job, JobKind, LyricsSet, Song, SongStatus
from karaoke_backend.workers import karaoke_models, modal_worker

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/songs", tags=["songs"])

STEMS_DIR = Path(os.getenv("STEMS_DIR", "stems"))
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class SongSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    artist: str
    title: str
    # Optional because the guest projection withholds it — see
    # _GUEST_SONG_FIELDS. Always populated for an authenticated caller.
    filename: Optional[str] = None
    duration: Optional[float] = None
    status: str
    created_at: str
    lyrics_synced: bool
    phase: Optional[str] = None        # current ingest phase, e.g. "transcribing"
    progress: Optional[int] = None     # 0–100, only meaningful while processing
    message: Optional[str] = None      # human-readable phase description
    # Surface enough of the active LyricsSet's metadata to drive provider-
    # specific affordances in the UI. Derived from the active set's
    # metadata_json; null when there's no active set.
    external_provider: Optional[str] = None
    lyrics_format_version: Optional[int] = None
    external_id: Optional[str] = None
    # Whether this row was created by importing a karaoke video the operator
    # already had — the video is retained and IS the song's picture. Defaults
    # False, which is also what the guest projection serves (see
    # _GUEST_SONG_FIELDS: the field is deliberately not on the allowlist).
    has_video: bool = False


class VocalStemURL(BaseModel):
    id: str
    name: Optional[str] = None
    url: str


class StemURLs(BaseModel):
    instrumental: Optional[str] = None
    lead_vocals: Optional[str] = None
    backing_vocals: Optional[str] = None
    karaoke: Optional[str] = None
    vocals: list[VocalStemURL] = []


class LyricsSetSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    label: Optional[str] = None
    is_verified: bool
    is_active: bool = False
    has_word_sync: bool = False
    has_synced_lyrics: bool = False
    has_plain_lyrics: bool = False
    metadata: Optional[dict] = None
    created_at: str


class SongDetail(SongSummary):
    stems: Optional[StemURLs] = None
    error_message: Optional[str] = None
    job_id: Optional[str] = None
    word_sync: Optional[dict] = None        # active LyricsSet's word_sync_json
    custom_lyrics: Optional[str] = None     # legacy field; kept for back-compat
    active_lyrics_id: Optional[int] = None
    lyrics_sets: list[LyricsSetSummary] = []
    # Whether a provider-owned source document is available for this song.
    # Derived from the active set's external_id + provider capability
    # (no filesystem stat) — the endpoint itself still 404s if unavailable.
    has_source_doc: bool = False
    # Relative URL for the retained video, populated only when the song is
    # ready AND the file is actually on disk. `has_video` (inherited from
    # SongSummary) answers "was this a video import"; this answers "can it be
    # played right now", which is the disk-checked question — same split as
    # `stems`.
    video_url: Optional[str] = None


class SongListResponse(BaseModel):
    songs: list[SongSummary]
    total: int
    page: int
    page_size: int


class SongUpdateRequest(BaseModel):
    artist: Optional[str] = None
    title: Optional[str] = None
    lyrics_synced: Optional[bool] = None
    custom_lyrics: Optional[str] = None


class ResplitRequest(BaseModel):
    # An ID from karaoke_models.CHOICES, never a filename: the value is
    # resolved server-side into the checkpoint a subprocess is handed.
    karaoke_model: str


class ResplitResponse(BaseModel):
    job_id: str
    song_id: int
    message: str


class RetryIngestResponse(BaseModel):
    job_id: str
    song_id: int
    # The kind of job that was re-queued — the one that PRODUCED this song, so
    # not always an ingest. The caller shows a Plex re-import and a re-upload
    # differently, and has no other way to tell which it just started.
    kind: str
    # False when the original ingest's options could not be read back and the
    # retry ran on server defaults instead — see `retry_ingest`. The caller is
    # told rather than left to assume the re-run matches the first attempt.
    options_recovered: bool
    message: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# What a song must already have on disk for a re-split to mean anything: the
# vocal pair Pass 2 produces and the bed the karaoke mix needs. A video import
# has an instrumental and nothing else, so this is also what excludes it.
RESPLIT_REQUIRED_STEMS = ("lead_vocals.wav", "backing_vocals.wav", "instrumental.wav")


# The kinds that CREATE a song. Every song in the library arrived through
# exactly one of them, and `retry_ingest` replays the most recent one it finds
# — retrying a song means re-running the job that made it, which is only an
# ingest when the song came from an upload. The re-transcribe/re-align/re-split
# kinds are deliberately absent: they operate on a song that already exists,
# and replaying one would not rebuild the stems a failed song is missing.
SONG_PRODUCING_KINDS = (
    JobKind.INGEST.value,
    JobKind.PLEX_IMPORT.value,
    JobKind.VIDEO_IMPORT.value,
)

# What the retry response calls each of them. The message is shown verbatim,
# and "Ingest re-queued" over a job that is about to ask a media server for a
# track would contradict the `kind` sitting next to it.
_RETRY_NOUN = {
    JobKind.INGEST.value: "Ingest",
    JobKind.PLEX_IMPORT.value: "Media server import",
    JobKind.VIDEO_IMPORT.value: "Video import",
}


def _song_stems_dir(song: Song) -> Optional[Path]:
    return stem_storage.active_stems_dir(song, STEMS_DIR)


# Container extension → the media type a browser needs to play it inline.
# Kept here rather than derived from `mimetypes`, whose table varies by host
# and does not know `.mkv` on every platform.
VIDEO_MEDIA_TYPES: dict[str, str] = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
}


def _song_video_path(song: Song) -> Optional[Path]:
    """Absolute path of the song's retained video, or None.

    None means "there is nothing to serve": no video recorded, no stems
    directory, or a stored name that is not a bare basename. That last case is
    a corrupt row rather than a caller's doing — the column is only ever
    written by the import job — but the traversal check runs anyway, because
    the value is about to be joined onto a directory path and a check that
    only runs where an attack is expected is a check that eventually misses.
    """
    filename = song.video_filename
    if not filename:
        return None
    if filename != Path(filename).name:
        logger.warning(
            "Song %s has a video_filename that is not a basename — refusing it",
            song.id,
        )
        return None
    stems_dir = _song_stems_dir(song)
    if stems_dir is None:
        return None
    return stems_dir / filename


def _job_to_phase(job: Optional[Job]) -> tuple[Optional[str], Optional[int], Optional[str]]:
    """The library row's phase/progress/message, from its current job.

    ``phase`` is the pipeline step, not the lifecycle status — since the
    durable queue those are different columns. Rows written before the queue existed have no
    phase, so their status (which WAS the phase) stands in.
    """
    if job is None:
        return (None, None, None)
    return (job.phase or job.status, job.progress, job.message)


async def _fetch_jobs_for(db: AsyncSession, songs: list[Song]) -> dict[str, Job]:
    """Return job_id → Job for the songs that have a current job_id."""
    job_ids = [s.job_id for s in songs if s.job_id]
    if not job_ids:
        return {}
    rows = (await db.execute(select(Job).where(Job.id.in_(job_ids)))).scalars().all()
    return {j.id: j for j in rows}


def _provider_fields(
    metadata_json: Optional[str],
) -> tuple[Optional[str], Optional[int], Optional[str]]:
    """Extract (external_provider, lyrics_format_version, external_id) from a
    LyricsSet's raw metadata_json. Reads neutral keys first, then falls back
    to the provider registry's resolve_legacy_metadata hook for persisted
    legacy rows. Returns all-None when the column is empty or malformed —
    every field is advisory, never required by the UI."""
    if not metadata_json:
        return (None, None, None)
    try:
        md = json.loads(metadata_json)
    except Exception:
        return (None, None, None)

    provider = md.get("source")
    external_id = md.get("external_id")
    version = md.get("format_version")

    if provider is None or external_id is None:
        from karaoke_backend.api.providers import resolve_legacy_metadata
        legacy = resolve_legacy_metadata(md)
        if legacy is not None:
            leg_provider, leg_id, leg_version = legacy
            if provider is None:
                provider = leg_provider
            if external_id is None:
                external_id = leg_id
            if version is None:
                version = leg_version

    if external_id is not None:
        external_id = str(external_id)
    try:
        version = int(version) if version is not None else None
    except (TypeError, ValueError):
        version = None
    return (provider, version, external_id)


def _song_to_summary(
    song: Song,
    job: Optional[Job] = None,
    *,
    active_lyrics_metadata: Optional[str] = None,
) -> SongSummary:
    phase, progress, message = _job_to_phase(job)
    provider, fmt_version, external_id = _provider_fields(active_lyrics_metadata)
    return SongSummary(
        id=song.id,
        artist=song.artist,
        title=song.title,
        filename=song.filename,
        duration=song.duration,
        status=song.status,
        created_at=song.created_at.isoformat() if song.created_at else "",
        lyrics_synced=song.lyrics_synced,
        phase=phase,
        progress=progress,
        message=message,
        external_provider=provider,
        lyrics_format_version=fmt_version,
        external_id=external_id,
        has_video=song.video_filename is not None,
    )


# Fields an unauthenticated caller may see on a library row.
#
# This is an allowlist, deliberately, and the direction matters: a field added
# to SongSummary later is withheld from guests until someone names it here, so
# the failure mode of forgetting to update this set is over-restriction rather
# than disclosure. A denylist fails the other way.
#
# Withheld on purpose: `filename`, `external_provider`, `external_id`, and
# `lyrics_format_version` all describe where a row came from rather than what
# it is. Nothing on the guest surface needs that — the join-page picker renders
# title and artist only — and the guest surface is the one reachable without a
# credential. Provenance stays available to the authenticated host, both here
# and on the host-only detail route. `has_video` is withheld on the same
# grounds: it says how the row was made, and the video route it advertises is
# host-only anyway, so a guest who saw the flag could do nothing with it.
#
# Also withheld, and less obviously: `phase`, `progress`, and `message`. These
# are copied from the row's Job, and `message` is free text an importer
# composes — the import path writes the provider's own display label into it.
# A field that carries provenance in its *contents* defeats an allowlist built
# on field names, so the job-derived fields stay out. Guests read `status`,
# which is a fixed enum, and the picker shows only `ready` rows anyway.
_GUEST_SONG_FIELDS = frozenset({
    "id",
    "artist",
    "title",
    "duration",
    "status",
    "created_at",
    "lyrics_synced",
})


def _to_guest_summary(full: SongSummary) -> SongSummary:
    """Re-project a summary down to the guest-visible allowlist."""
    return SongSummary(**full.model_dump(include=set(_GUEST_SONG_FIELDS)))


def _lyrics_set_to_summary(ls: LyricsSet, *, is_active: bool) -> LyricsSetSummary:
    metadata: Optional[dict] = None
    if ls.metadata_json:
        try:
            metadata = json.loads(ls.metadata_json)
        except Exception:
            metadata = None
    return LyricsSetSummary(
        id=ls.id,
        source=ls.source,
        label=ls.label,
        is_verified=ls.is_verified,
        is_active=is_active,
        has_word_sync=ls.word_sync_json is not None,
        has_synced_lyrics=ls.synced_lyrics is not None,
        has_plain_lyrics=ls.plain_lyrics is not None,
        metadata=metadata,
        created_at=ls.created_at.isoformat() if ls.created_at else "",
    )


async def _song_to_detail(db: AsyncSession, song: Song) -> SongDetail:
    stems_dir = _song_stems_dir(song)

    # Load all lyrics sets, plus the active one's word_sync.
    sets = (await db.execute(
        select(LyricsSet).where(LyricsSet.song_id == song.id).order_by(LyricsSet.created_at)
    )).scalars().all()

    word_sync: Optional[dict] = None
    active_set = next((s for s in sets if s.id == song.active_lyrics_id), None)
    if active_set and active_set.word_sync_json:
        try:
            word_sync = json.loads(active_set.word_sync_json)
        except Exception:
            word_sync = None

    # Back-compat: if no active set has word_sync but the legacy column
    # still has data (pre-migration row), surface it.
    if word_sync is None and song.word_sync_json:
        try:
            word_sync = json.loads(song.word_sync_json)
        except Exception:
            pass

    # Build stem URLs from disk, using the active set's voice roster (if any)
    # to order and name per-voice vocal stems. Use relative URLs so they work
    # from any host (LAN, localhost, etc.).
    voices = word_sync.get("voices") if isinstance(word_sync, dict) else None
    stem_urls: Optional[StemURLs] = None
    if song.status == "ready" and stems_dir and stems_dir.exists():
        stem_urls = StemURLs(
            **stem_layout.stem_urls_payload(stems_dir, "", song.id, voices)
        )

    # Current job (for phase/progress)
    job: Optional[Job] = None
    if song.job_id:
        job = (await db.execute(select(Job).where(Job.id == song.job_id))).scalar_one_or_none()
    phase, progress, message = _job_to_phase(job)

    provider, fmt_version, external_id = _provider_fields(
        active_set.metadata_json if active_set else None,
    )

    # Same split as `stems`: the flag records what the row IS, the URL is only
    # offered when the file is actually there to serve.
    video_url: Optional[str] = None
    video_path = _song_video_path(song)
    if song.status == "ready" and video_path is not None and video_path.is_file():
        video_url = f"/api/songs/{song.id}/video"

    return SongDetail(
        id=song.id,
        artist=song.artist,
        title=song.title,
        filename=song.filename,
        duration=song.duration,
        status=song.status,
        created_at=song.created_at.isoformat() if song.created_at else "",
        lyrics_synced=song.lyrics_synced,
        phase=phase,
        progress=progress,
        message=message,
        external_provider=provider,
        lyrics_format_version=fmt_version,
        external_id=external_id,
        stems=stem_urls,
        error_message=song.error_message,
        job_id=song.job_id,
        word_sync=word_sync,
        custom_lyrics=song.custom_lyrics,
        active_lyrics_id=song.active_lyrics_id,
        lyrics_sets=[
            _lyrics_set_to_summary(ls, is_active=(ls.id == song.active_lyrics_id))
            for ls in sets
        ],
        has_source_doc=external_id is not None,
        has_video=song.video_filename is not None,
        video_url=video_url,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=SongListResponse, summary="List all processed songs")
async def list_songs(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    page_size: int = Query(20, ge=1, le=500, description="Items per page"),
    status: Optional[str] = Query(None, description="Filter by status: processing|ready|failed"),
    artist: Optional[str] = Query(None, description="Filter by artist (partial match)"),
    search: Optional[str] = Query(None, description="Free-text search across title, artist, and filename"),
    db: AsyncSession = Depends(get_db),
    host_id: int = Depends(get_host_id),
    user: Optional[Identity] = Depends(get_current_user),
) -> SongListResponse:
    """
    Return a paginated list of songs in the library.

    Scoped to a host via `get_host_id`: the authenticated host sees their own
    library, and a guest admitted to that host — one holding a credential the
    deployment issued, not one who named a tenant in a query string — can
    search it without logging in. This powers song search on the login-free
    /join page.

    A caller with no authenticated identity is served a reduced projection
    (`_GUEST_SONG_FIELDS`) that withholds row provenance, and their `search`
    does not match on `filename`. Matching on a withheld field would leave the
    field readable one bit at a time: the result count answers "is there a row
    whose filename contains X", which reconstructs exactly what the projection
    removes. The two have to move together.

    Songs are ordered newest-first. Use `status`, `artist`, or `search` to filter results.
    """
    is_guest = user is None

    query = select(Song).where(Song.owner_id == host_id)

    if status:
        query = query.where(Song.status == status)
    if artist:
        query = query.where(Song.artist.ilike(f"%{artist}%"))
    if search:
        needle = f"%{search.strip()}%"
        if search.strip():
            fields = [Song.title.ilike(needle), Song.artist.ilike(needle)]
            if not is_guest:
                fields.append(Song.filename.ilike(needle))
            query = query.where(or_(*fields))

    # Count total
    count_query = select(func.count()).select_from(query.subquery())
    total: int = (await db.execute(count_query)).scalar_one()

    # Paginate
    offset = (page - 1) * page_size
    query = query.order_by(Song.created_at.desc()).offset(offset).limit(page_size)
    rows = (await db.execute(query)).scalars().all()

    jobs_by_id = await _fetch_jobs_for(db, list(rows))

    # Bulk-load active LyricsSet metadata so the UI can decide per-row
    # whether to surface provider-specific affordances (e.g. "re-parse").
    active_ids = [s.active_lyrics_id for s in rows if s.active_lyrics_id]
    metadata_by_id: dict[int, str] = {}
    if active_ids:
        ls_rows = (await db.execute(
            select(LyricsSet.id, LyricsSet.metadata_json).where(LyricsSet.id.in_(active_ids))
        )).all()
        metadata_by_id = {lid: md for lid, md in ls_rows if md}

    songs = [
        _song_to_summary(
            s,
            jobs_by_id.get(s.job_id) if s.job_id else None,
            active_lyrics_metadata=metadata_by_id.get(s.active_lyrics_id),
        )
        for s in rows
    ]
    if is_guest:
        songs = [_to_guest_summary(s) for s in songs]

    return SongListResponse(
        songs=songs,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{song_id}", response_model=SongDetail, summary="Get song details + stem URLs")
async def get_song(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> SongDetail:
    """
    Get full details for a single song, including stem download URLs (if ready).
    """
    result = await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == user.id)
    )
    song = result.scalar_one_or_none()

    if song is None:
        raise HTTPException(status_code=404, detail=f"Song {song_id} not found")

    return await _song_to_detail(db, song)


@router.patch("/{song_id}", response_model=SongDetail, summary="Update song metadata")
async def update_song(
    song_id: int,
    body: SongUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> SongDetail:
    """
    Update editable metadata for a song: artist name, title, or lyrics_synced flag.
    """
    result = await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == user.id)
    )
    song = result.scalar_one_or_none()

    if song is None:
        raise HTTPException(status_code=404, detail=f"Song {song_id} not found")

    if body.artist is not None:
        song.artist = body.artist
    if body.title is not None:
        song.title = body.title
    if body.lyrics_synced is not None:
        song.lyrics_synced = body.lyrics_synced
    if body.custom_lyrics is not None:
        song.custom_lyrics = body.custom_lyrics

    await db.commit()
    await db.refresh(song)

    return await _song_to_detail(db, song)


@router.delete("/{song_id}", status_code=200, summary="Delete a song and its stems")
async def delete_song(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> dict[str, str]:
    """
    Delete a song record from the database and remove all associated stem files from disk.

    This is also where a song's UPLOADS are released. The ingest and video
    import handlers keep theirs on a permanent failure so
    ``POST /api/songs/{id}/retry`` can replay phase 1 from them, which means
    the file outlives the failure by design — deleting the song is the
    operator saying no retry is coming, and it is the only remaining moment at
    which that disk can be reclaimed.

    There is no in-flight guard here, on purpose and as before: a song deleted
    under a running job already had its stems directory removed from under the
    worker, and the upload goes the same way. The worker's next progress write
    finds no row and stops (``LeaseLost``); the open file handle outlives the
    unlink on POSIX. Refusing the delete would make "get this out of my
    library" wait on a job the operator may be deleting the song to escape.
    """
    result = await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == user.id)
    )
    song = result.scalar_one_or_none()

    if song is None:
        raise HTTPException(status_code=404, detail=f"Song {song_id} not found")

    # Remove stems from disk
    # Delete the owned root, not merely the selected generation. This removes
    # legacy files, every superseded generation, and unpublished retry debris.
    stems_dir = Path(song.stems_path) if song.stems_path else STEMS_DIR / str(song.id)
    if stems_dir.exists():
        try:
            shutil.rmtree(stems_dir)
            logger.info("Deleted stems for song %d at %s", song_id, stems_dir)
        except OSError as exc:
            logger.warning("Could not remove stems dir %s: %s", stems_dir, exc)

    # Collected BEFORE the delete: the job rows cascade away with the song, and
    # their ids are the only thing that names the uploads on disk (every one is
    # stored as `{job_id}_{filename}`).
    job_ids = list((await db.execute(
        select(Job.id).where(Job.song_id == song_id)
    )).scalars().all())

    await db.delete(song)
    await db.commit()

    # After the commit, and best-effort: an uploads directory that cannot be
    # read is a disk-space problem, not a reason to fail a delete the database
    # has already made.
    if job_ids:
        removed = queue.unlink_uploads_for(job_ids)
        logger.info(
            "Deleted song %d: released %d upload(s) from %d job(s)",
            song_id, removed, len(job_ids),
        )

    return {"message": f"Song {song_id} deleted"}


@router.get(
    "/{song_id}/video",
    response_class=FileResponse,
    summary="Stream a song's karaoke video",
)
async def get_song_video(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> FileResponse:
    """
    Stream the karaoke video retained for a song imported from a video file.

    404 for a song this caller does not own, exactly as the stem route does:
    a 403 would confirm the id exists and turn this into an enumeration oracle
    for another tenant's library.

    Range requests are handled by Starlette's ``FileResponse``, which is what
    makes a `<video>` element able to seek. No ``Content-Disposition`` is set:
    the file is meant to be played in place, not saved.
    """
    result = await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == user.id)
    )
    song = result.scalar_one_or_none()

    if song is None:
        raise HTTPException(status_code=404, detail=f"Song {song_id} not found")

    if song.status != "ready":
        raise HTTPException(
            status_code=409,
            detail=f"Song {song_id} is not ready yet (status: {song.status})",
        )

    video_path = _song_video_path(song)
    if video_path is None or not video_path.is_file():
        raise HTTPException(
            status_code=404, detail=f"Song {song_id} has no video"
        )

    media_type = VIDEO_MEDIA_TYPES.get(
        video_path.suffix.lower(), "application/octet-stream"
    )
    return FileResponse(path=str(video_path), media_type=media_type)


@router.get(
    "/{song_id}/stems/{filename}",
    response_class=FileResponse,
    summary="Download a stem file",
)
async def get_stem_file(
    song_id: int,
    filename: str,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> FileResponse:
    """
    Stream a stem file for download.

    Valid filenames are the recognized stem basenames actually present on disk
    for this song: `instrumental`, `karaoke`, `lead_vocals`, `backing_vocals`
    (numbered variants `lead_vocals_<N>`/`backing_vocals_<N>` included), or
    any `vocal_<id>` per-voice stem, in `.flac` or `.wav`.
    """
    # Reject path traversal before anything else — the allowlist below is
    # basenames only, but a malformed filename should 400 regardless of song.
    if filename != Path(filename).name:
        raise HTTPException(
            status_code=400,
            detail="Invalid filename.",
        )

    result = await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == user.id)
    )
    song = result.scalar_one_or_none()

    if song is None:
        raise HTTPException(status_code=404, detail=f"Song {song_id} not found")

    if song.status != "ready":
        raise HTTPException(
            status_code=409,
            detail=f"Song {song_id} is not ready yet (status: {song.status})",
        )

    stems_dir = _song_stems_dir(song)
    if stems_dir is None:
        raise HTTPException(status_code=404, detail="Stems directory not recorded")

    allowed = stem_layout.allowed_stem_filenames(stems_dir)
    if filename not in allowed:
        raise HTTPException(
            status_code=404,
            detail=f"Stem file '{filename}' not found — separation may have failed partially",
        )

    stem_path = stems_dir / filename
    media_type = "audio/flac" if filename.endswith(".flac") else "audio/wav"
    return FileResponse(
        path=str(stem_path),
        media_type=media_type,
        filename=filename,
    )


@router.post(
    "/{song_id}/stems/resplit",
    response_model=ResplitResponse,
    status_code=202,
    summary="Re-run the lead/backing vocal split with a different model",
)
async def resplit_stems(
    song_id: int,
    body: ResplitRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> ResplitResponse:
    """Queue a fresh Pass-2 split of this song's vocals.

    The Pass-2 model is chosen at upload time and was final until re-split existed — the
    upload is deleted once separation finishes, so nothing could re-run the
    lead/backing split. This can, off the stems already on disk.

    Every refusal here is one the caller can act on. What it cannot be is a
    partial job: the handler builds the replacements in a scratch directory
    and renames them into place, so a song whose re-split fails still has the
    stems it had this morning. Lyric timings are the exception, and they are
    not silently wrong afterwards — the transcription cache is dropped, and
    the job's final message says a re-transcribe is what refreshes them.
    """
    result = await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == user.id)
    )
    song = result.scalar_one_or_none()
    if song is None:
        raise HTTPException(status_code=404, detail=f"Song {song_id} not found")

    if not body.karaoke_model or not karaoke_models.is_valid(body.karaoke_model):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown karaoke_model {body.karaoke_model!r}. "
                f"Choose one of: {', '.join(sorted(karaoke_models.CHOICES))}."
            ),
        )

    if song.status != "ready":
        raise HTTPException(
            status_code=409,
            detail=f"Song {song_id} is not ready yet (status: {song.status})",
        )

    stems_dir = _song_stems_dir(song)
    missing = [
        name for name in RESPLIT_REQUIRED_STEMS if not (stems_dir / name).is_file()
    ]
    if missing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Song {song_id} has no separated vocals to re-split "
                f"(missing: {', '.join(missing)})."
            ),
        )

    # Re-split knows how to produce exactly two lanes, because that is what
    # Pass 2 produces: one lead and one backing. A song carrying more (a
    # multi-lead import's numbered generics, or per-voice `vocal_<id>` stems)
    # would come out of this job with those extra lanes orphaned beside a
    # freshly split pair, and nothing would say so. Refusing is the honest
    # answer; `scan_vocals` is what the read side derives lanes from, so it is
    # what decides here too.
    roster = [vs.id for vs in stem_layout.scan_vocals(stems_dir)]
    if roster != ["lead", "backing"]:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Re-split handles a plain lead/backing pair; song {song_id} "
                f"has vocal lanes: {', '.join(roster) or '(none)'}."
            ),
        )

    # A separator plugin owns both passes and may not run demucs or
    # audio-separator at all, so there is no Pass 2 here to re-run. Saying so
    # beats queueing a job that would run the built-in split over stems the
    # plugin produced.
    if modal_worker._plugin_separator() is not None:
        raise HTTPException(
            status_code=503,
            detail="Re-split is not available with a separator plugin",
        )

    if not modal_worker.DEMUCS_PYTHON.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                f"Demucs venv not found at {modal_worker.DEMUCS_PYTHON}. "
                f"Create it with: uv venv .venv-demucs --python 3.13 && "
                f"source .venv-demucs/bin/activate && "
                f"uv pip install demucs torch torchaudio torchcodec "
                f"'audio-separator[cpu]'"
            ),
        )

    # One at a time. Two re-splits of one song would race for the same three
    # filenames, and the loser would publish a lead/backing pair that does not
    # match the karaoke mix beside it. The queue's own terminal set is what
    # "still in flight" means — spelling the live statuses out here would drift
    # the first time one is added.
    inflight = await db.execute(
        select(Job.id).where(
            Job.song_id == song_id,
            Job.kind == JobKind.RESPLIT.value,
            Job.status.notin_(queue.TERMINAL_STATUSES),
        )
    )
    running = inflight.scalars().first()
    if running is not None:
        raise HTTPException(
            status_code=409,
            detail=f"A re-split is already running for song {song_id} (job {running}).",
        )

    job_id = str(uuid.uuid4())
    queue.enqueue(
        db,
        kind=JobKind.RESPLIT.value,
        job_id=job_id,
        song_id=song_id,
        owner_id=user.id,
        message=f"Re-splitting lead/backing vocals ({body.karaoke_model})",
        payload={
            "stems_dir": str(stems_dir),
            "stems_root": str(Path(song.stems_path) if song.stems_path else STEMS_DIR / str(song.id)),
            "expected_generation": song.active_stem_generation,
            "karaoke_model": body.karaoke_model,
        },
    )
    # Same reason the lyrics routes do it: left stale, the library row keeps
    # reporting the previous job while this one runs.
    await db.execute(update(Song).where(Song.id == song_id).values(job_id=job_id))
    await db.commit()

    return ResplitResponse(
        job_id=job_id,
        song_id=song_id,
        message=f"Re-split queued with {body.karaoke_model}",
    )


@router.post(
    "/{song_id}/retry",
    response_model=RetryIngestResponse,
    status_code=202,
    summary="Re-queue the job that produced a song whose ingest failed",
)
async def retry_ingest(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> RetryIngestResponse:
    """Re-queue the job that produced this song, for a song that failed.

    A failed song used to be a dead row: the options were chosen in a form that
    is gone, and the only way back was to supply the source again. This
    re-queues the SAME job, with the same payload, so a failure the operator
    has since fixed (an LLM endpoint that was down, a separation backend that
    was not configured yet, a lyrics lookup that timed out, a restart mid-run)
    costs one click.

    **Whichever job produced the song.** A song reaches the library through an
    upload, a Plex import or a video import, and only the first of those is an
    ingest. Retrying the others as an ingest re-ran the wrong handler against a
    payload it could not read, so what is replayed is the most recent job of
    any ``SONG_PRODUCING_KINDS`` — and the response says which, in ``kind``.

    **Phase-1 failures are recoverable now, and that is the point.** The two
    upload-owning handlers RETAIN their upload on a permanent failure rather
    than releasing it (``jobs.ingest``, ``jobs.video_import``; the file is
    reclaimed when the song is deleted). Those two facts are one feature:
    before, a song that died during separation answered this route with "the
    source audio is gone", so the only retryable failures were the ones that
    happened AFTER separation had already succeeded — the rarer half. A Plex
    import needs no retained file at all: a retry re-fetches the track from
    the operator's server, which is why that handler still drops its copy.

    Every refusal is synchronous and names what the caller has to fix:

    * **404** — no such song, or not this caller's. Same shape as every other
      route here: a 403 would confirm the id exists in another tenant's
      library.
    * **409** — the song is not ``failed``. Retry is a rescue, not a re-run
      button: a ``ready`` song has its stems and belongs on ``/lyrics/*``, and
      a ``processing`` one already has a job doing this work. The detail names
      the current status so "wait" and "this needs different action" are
      distinguishable.
    * **409** — the source audio ingest would need is gone. Only phase 1 needs
      it: past the ``.separation-complete`` marker the stems ARE the artifact
      and ingest resumes off them, so the upload is checked only when that
      marker is absent. Now that the upload survives a failure this fires only
      when the file is TRULY gone — swept by hand, or lost with the disk. The
      detail names the missing file, because "re-upload the file" is the whole
      of the remedy and the operator has to know which.
    * **409** — the video a video import would re-adopt is gone. Same shape and
      the same reason, against ``completed_video_name`` instead of the
      separation marker: an import that got as far as writing both artifacts
      re-runs off them, and one that did not has nothing but its upload.
    * **409** — a Plex import with no media server configured. The handler's
      first act is to resolve the track on the server, so a retry with no URL
      would fail a second later with a message the operator has to go and dig
      out of the job row. Skipped when the separation marker is present: that
      re-run never asks the server for anything.
    * **409** — a job for this song is still in flight. Two ingests of one song
      would write the same stems directory, the same transcription cache and
      the same ``songs.job_id``. Checked against the queue's own terminal set
      rather than a list of live statuses spelled out here, for the reason
      ``resplit_stems`` gives.
    * **409** — the row stopped being ``failed`` while this call was queueing.
      The two checks above only READ, so the write is guarded as well: the
      status flip is conditional on ``failed`` and a caller that matches zero
      rows lost the race and has its enqueue rolled back with it.

    **How the options are recovered.** They are not on the song row — the
    Pass-2 model, the pasted reference lyrics, the two LLM flags, the Plex
    rating key, the video's upload name all live only in the job's payload —
    so the payload of this song's most recent producing job is what is
    replayed, verbatim. That is the failed job itself in the normal case, which
    is exactly the point: the retry re-runs what was actually asked for the
    first time. When no such job survives (its rows were pruned) there is
    nothing to replay, and the retry falls back to a default INGEST — with
    ``options_recovered: false`` saying so — because an ingest of the song's
    own upload is the only run that can be reconstructed from the song row
    alone. A retry on default settings is worth offering, but not worth passing
    off as a faithful re-run.

    Artist and title are the exception to "verbatim" for the two handlers that
    read them out of the payload (``run_ingest``, and ``run_plex_import``,
    which forwards them). Both are editable after the fact, so both are taken
    from the SONG ROW instead: correcting the metadata is the commonest thing
    an operator does between a failure and its retry, and a faithful replay
    would silently undo it. ``run_video_import`` reads neither, so a video
    payload is left exactly as it was.

    Replaying the payload also keeps the upload's NAME, which still carries the
    ORIGINAL job's id prefix. That is safe. ``queue.unlink_uploads_for`` is
    called from two places, and neither can reach this file behind the
    operator's back: ``sweep_legacy`` at boot, which only ever names legacy
    rows (kind IS NULL), and ``delete_song``, which names this song's own jobs
    — and by then the song, and any retry of it, is gone anyway.
    """
    # Resolved at call time from the ingest module's own view of the world, and
    # not from this module's snapshot: these two paths have to be the ones the
    # handlers will look at, or the checks answer about different files. The
    # two handler helpers are imported here for the reason `jobs.registry`
    # gives for resolving its targets late — the handler modules import back
    # into `karaoke_backend.api`, so a router that bound them at import time
    # would be making a cycle out of a one-line preflight. `plex.config` has
    # no such cycle; it sits with the others only so the preflight's inputs
    # are resolved in one place.
    from karaoke_backend.api.separate import STEMS_DIR as INGEST_STEMS_DIR, UPLOADS_DIR
    from karaoke_backend.jobs.ingest import separation_is_complete
    from karaoke_backend.jobs.video_import import completed_video_name
    from karaoke_backend.plex import config as plex_config

    result = await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == user.id)
    )
    song = result.scalar_one_or_none()
    if song is None:
        raise HTTPException(status_code=404, detail=f"Song {song_id} not found")

    if song.status != SongStatus.FAILED.value:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Song {song_id} has not failed (status: {song.status}) — "
                f"only a failed ingest can be retried."
            ),
        )

    inflight = (await db.execute(
        select(Job.id, Job.kind).where(
            Job.song_id == song_id,
            Job.status.notin_(queue.TERMINAL_STATUSES),
        )
    )).first()
    if inflight is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"A job is already in flight for song {song_id} "
                f"(job {inflight.id}, kind {inflight.kind or 'unknown'})."
            ),
        )

    last_job = (await db.execute(
        select(Job)
        .where(Job.song_id == song_id, Job.kind.in_(SONG_PRODUCING_KINDS))
        .order_by(Job.created_at.desc(), Job.id.desc())
        .limit(1)
    )).scalars().first()

    recovered = queue.payload_of(last_job) if last_job is not None else {}
    options_recovered = bool(recovered)
    # An importer's row with an EMPTY payload is not a replayable import — a
    # plex_import with no rating key resolves nothing, a video_import with no
    # upload name adopts nothing — so it takes the same default-ingest path as
    # no row at all, and the upload check below tells the operator so.
    kind = last_job.kind if options_recovered else JobKind.INGEST.value
    stems_dir = INGEST_STEMS_DIR / str(song_id)

    if kind == JobKind.PLEX_IMPORT.value:
        payload = dict(recovered)
        # `run_plex_import` forwards these two into the ingest payload, so the
        # same rule as ingest applies — see the docstring.
        payload["artist"] = song.artist
        payload["title"] = song.title
        # The re-import goes back to the server for the track, so there is no
        # upload to check — but there IS a server to be missing, and the
        # handler's first act is to resolve the rating key against it. Skipped
        # once separation is complete: that re-run asks the server for nothing
        # it cannot do without (a lyric fetch on that path fails soft). Only
        # the URL is checked, not the token: whether the server wants one is
        # the server's answer, and a rejected token already fails the job
        # with the server's own message.
        if not separation_is_complete(stems_dir) and not await plex_config.effective_url(db):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Song {song_id} was imported from a media server and has "
                    f"no separated stems, but no media server URL is "
                    f"configured — configure the media server, then retry."
                ),
            )
        enqueue_message = "Retrying media server import"
    elif kind == JobKind.VIDEO_IMPORT.value:
        # Verbatim, all of it: `run_video_import` reads only `upload_name`, and
        # neither artist nor title, so there is nothing here for a metadata
        # correction to have gone stale against.
        payload = dict(recovered)
        # An import that wrote both artifacts re-runs off them (the handler's
        # own re-entry gate) and needs no upload; one that did not has nothing
        # else to adopt.
        if completed_video_name(stems_dir) is None:
            upload_name = payload.get("upload_name")
            # Basename-checked for the same reason as the ingest branch below.
            upload_name = Path(str(upload_name)).name if upload_name else ""
            # Written BACK, so the name this route stats is the string the
            # handler joins — a check on a sanitised value the handler never
            # sees would answer about one file and open another.
            if upload_name:
                payload["upload_name"] = upload_name
            if not upload_name or not (UPLOADS_DIR / upload_name).is_file():
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"The video song {song_id} was imported from is no "
                        f"longer on disk (missing: "
                        f"{upload_name or 'no file recorded'}) and the import "
                        f"never finished — upload the video again."
                    ),
                )
        enqueue_message = "Retrying video import"
    else:
        if options_recovered:
            payload = dict(recovered)
        else:
            payload = {
                "upload_path": None,
                "artist": song.artist,
                "title": song.title,
                "pasted_lyrics": None,
                "llm_correction": False,
                "llm_paging": False,
                "karaoke_model": karaoke_models.DEFAULT_CHOICE,
            }

        # Two fields are NOT replayed: `run_ingest` reads artist and title out
        # of the payload, and both are editable after the fact (Details tab,
        # PATCH /songs/{id}). A verbatim replay would quietly revert a
        # correction the operator made precisely BECAUSE the first attempt got
        # them wrong — the commonest thing to fix between a failure and its
        # retry. The song row is what they edited, so the song row wins for
        # these two; everything else in the payload is the original job's,
        # untouched.
        payload["artist"] = song.artist
        payload["title"] = song.title

        if not separation_is_complete(stems_dir):
            upload_name = payload.get("upload_path")
            if not upload_name:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Song {song_id} has no separated stems and no record of the "
                        f"audio it was made from — upload the file again."
                    ),
                )
            # The stored value is a basename by construction
            # (`safe_upload_name`), but it is about to be joined onto a
            # directory, so it is re-checked here rather than trusted: a row
            # that somehow held a path would otherwise make this stat
            # somewhere else entirely.
            upload_name = Path(str(upload_name)).name
            # Written back for the same reason as the video branch: the
            # handler must open the file this route checked, not the raw value.
            payload["upload_path"] = upload_name
            source_audio = UPLOADS_DIR / upload_name
            if not source_audio.is_file():
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"The audio song {song_id} was uploaded from is no longer on "
                        f"disk (missing: {upload_name}) and no separated stems "
                        f"remain — upload the file again."
                    ),
                )
        enqueue_message = "Retrying ingest"

    job_id = str(uuid.uuid4())
    # Enqueued into THIS transaction and deliberately not committed yet: the
    # status flip below is the real guard, and a job that outlived a lost race
    # would be a second ingest on one stems directory.
    queue.enqueue(
        db,
        kind=kind,
        job_id=job_id,
        song_id=song_id,
        owner_id=user.id,
        message=enqueue_message,
        payload=payload,
    )
    # The error belongs to the attempt that is being replaced. Left in place it
    # would sit on a row that now says `processing`, and the UI would show a
    # song failing and running at once.
    #
    # `WHERE status = 'failed'` is what makes this route safe against itself.
    # Both checks above READ the row and let it go, so two retries fired at the
    # same song — a double-click, two tabs — can both walk past them; only a
    # conditional write settles which one owns the row. The loser matches zero
    # rows, rolls its own enqueue back with the transaction, and is told 409
    # the way a stale caller is told 409 anywhere else here.
    flipped = await db.execute(
        update(Song)
        .where(Song.id == song_id, Song.status == SongStatus.FAILED.value)
        .values(
            status=SongStatus.PROCESSING.value,
            error_message=None,
            job_id=job_id,
        )
    )
    if flipped.rowcount == 0:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"Song {song_id} stopped being failed while this retry was "
                f"being queued — another retry got there first."
            ),
        )
    await db.commit()

    return RetryIngestResponse(
        job_id=job_id,
        song_id=song_id,
        kind=kind,
        options_recovered=options_recovered,
        message=(
            f"{_RETRY_NOUN[kind]} re-queued with the original options"
            if options_recovered
            else "Ingest re-queued with server defaults (original options unavailable)"
        ),
    )
