# SPDX-License-Identifier: AGPL-3.0-only
"""Plex media-server library source — connection settings, browse, import.

``/api/plex/*``. Host only, every route: this reads the operator's private
media server through the operator's own credential, and there is no reading of
that which a guest is entitled to. ``require_user`` is the whole gate in core
single-host mode.

What these routes are for, said plainly because the copy is load-bearing: the
operator points this install at a media server they run, and imports songs
from a collection they already have. Nothing here searches for music, finds
music, or acquires music. The browse routes list what is already in a library
that already exists.

**Why an upstream 401 is not answered with a 401.** The frontend's axios
interceptor treats a 401 from this API as "your session expired" and bounces
the host to the unlock gate. A rejected *Plex* token is not a rejected
*session*, and mapping one onto the other would log the operator out of the
app for typing their media-server token wrong. Upstream auth failures are
therefore reported as 400 with a message that says the server rejected the
token — a 4xx carrying the fact, without hijacking the app's own auth signal.
"""

from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.database import get_db
from karaoke_backend.jobs import queue
from karaoke_backend.models.song import JobKind, Song
from karaoke_backend.plex import config as plex_config
from karaoke_backend.plex.client import PlexAuthError, PlexClient, PlexError
from karaoke_backend.workers import karaoke_models

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plex", tags=["plex"])

#: Ceiling on one import call. Not a licence limit — a queue-depth one: each
#: track becomes a separation job measured in GPU minutes, and a UI that lets
#: someone select ten thousand rows and press a button once is a UI that fills
#: the queue for a week by accident.
MAX_IMPORT_TRACKS = 200

#: Ceiling on one browse page, so a caller cannot ask the media server for its
#: entire library in one request on this install's behalf.
MAX_PAGE_SIZE = 500

#: Ceiling on one filter value. A filter is something a person typed into a
#: box; anything longer is not a search term, and it travels into a query
#: string on the operator's own server.
MAX_FILTER_LENGTH = 200


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PlexSettings(BaseModel):
    url: str = Field(description="Media server base URL, or '' when unset.")
    token_set: bool = Field(
        description=(
            "Whether a token is stored. The token itself is never returned by "
            "any route in this API."
        )
    )
    source: str = Field(
        description=(
            "'env' when the environment pins the configuration (the settings "
            "are then read-only), otherwise 'settings'."
        )
    )
    lyrics_enabled: bool = Field(
        description="Whether the operator opted in to reading lyrics from Plex."
    )


class PlexSettingsUpdate(BaseModel):
    url: Optional[str] = Field(
        default=None, description="Omit to leave the stored URL alone."
    )
    token: Optional[str] = Field(
        default=None,
        description=(
            "Omit to leave the stored token alone. An empty string DELETES the "
            "stored token."
        ),
    )


class PlexLibraryOut(BaseModel):
    key: str
    title: str


class PlexTestResponse(BaseModel):
    ok: bool
    libraries: list[PlexLibraryOut] = []


class PlexLibrariesResponse(BaseModel):
    libraries: list[PlexLibraryOut] = []


class PlexTrackOut(BaseModel):
    rating_key: str
    title: str
    artist: str
    album: Optional[str] = None
    duration_ms: Optional[int] = None
    part_key: Optional[str] = None
    file_path: Optional[str] = None
    container: Optional[str] = None
    has_lyrics: bool = False


class PlexTracksResponse(BaseModel):
    tracks: list[PlexTrackOut] = []
    total: int
    offset: int
    limit: int


class PlexImportTrack(BaseModel):
    rating_key: str
    title: str
    artist: Optional[str] = None
    part_key: Optional[str] = None
    file_path: Optional[str] = None
    container: Optional[str] = None
    has_lyrics: bool = False


class PlexImportRequest(BaseModel):
    tracks: list[PlexImportTrack]
    llm_correction: bool = False
    llm_paging: bool = False
    karaoke_model: Optional[str] = None


class PlexImportJob(BaseModel):
    job_id: str
    song_id: int
    title: str
    artist: str


class PlexImportResponse(BaseModel):
    jobs: list[PlexImportJob] = []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _settings_payload(db: AsyncSession) -> PlexSettings:
    return PlexSettings(
        url=await plex_config.effective_url(db),
        token_set=plex_config.token_is_set(),
        source=plex_config.config_source(),
        lyrics_enabled=plex_config.plex_lyrics_enabled(),
    )


async def _client(db: AsyncSession) -> PlexClient:
    """A client for the configured server, or a 400 explaining what is missing."""
    url = await plex_config.effective_url(db)
    if not url:
        raise HTTPException(
            status_code=400,
            detail="No media server URL is configured yet.",
        )
    return PlexClient(url, plex_config.effective_token())


def _as_http_error(exc: PlexError) -> HTTPException:
    """Map a client error onto a 4xx the operator can act on.

    Never a 401 — see the module docstring. Never the token either: nothing
    this module formats contains it, and this is the function that would be
    tempted to add context.
    """
    if isinstance(exc, PlexAuthError):
        return HTTPException(
            status_code=400,
            detail="The media server rejected the token.",
        )
    return HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@router.get("/settings", response_model=PlexSettings, summary="Read the Plex connection settings")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> PlexSettings:
    """Report the connection settings. The token is reported as a boolean only."""
    return await _settings_payload(db)


@router.put("/settings", response_model=PlexSettings, summary="Update the Plex connection settings")
async def put_settings(
    body: PlexSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> PlexSettings:
    """Store the URL and/or the token.

    Each field is independently optional so the UI can save a URL without
    re-typing the token — which it could not do anyway, since it is never
    given the token back. An empty-string token is the explicit "forget it".

    Refused with 409 while the environment pins the configuration: accepting a
    write that the next read would silently override is worse than saying no.
    """
    if plex_config.env_pinned():
        raise HTTPException(
            status_code=409,
            detail=(
                "The media-server connection is configured by this server's "
                "environment and cannot be changed here."
            ),
        )

    if body.url is not None:
        try:
            normalized = plex_config.normalize_url(body.url)
        except plex_config.PlexConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        await plex_config.set_stored_url(db, normalized)

    if body.token is not None:
        token = body.token.strip()
        if token:
            plex_config.write_stored_token(token)
        else:
            plex_config.clear_stored_token()

    return await _settings_payload(db)


@router.post("/test", response_model=PlexTestResponse, summary="Test the media-server connection")
async def test_connection(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> PlexTestResponse:
    """Try one read against the configured server and report what came back.

    Listing the libraries IS the test: it is the cheapest call that proves the
    URL, the token, and the operator's expectation of what is on the server all
    agree, and it gives the UI the list it needs next anyway.
    """
    client = await _client(db)
    try:
        libraries = await client.list_libraries()
    except PlexError as exc:
        raise _as_http_error(exc) from exc
    return PlexTestResponse(
        ok=True,
        libraries=[PlexLibraryOut(key=lib.key, title=lib.title) for lib in libraries],
    )


# ---------------------------------------------------------------------------
# Browse
# ---------------------------------------------------------------------------


@router.get("/libraries", response_model=PlexLibrariesResponse, summary="List the server's music libraries")
async def list_libraries(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> PlexLibrariesResponse:
    client = await _client(db)
    try:
        libraries = await client.list_libraries()
    except PlexError as exc:
        raise _as_http_error(exc) from exc
    return PlexLibrariesResponse(
        libraries=[PlexLibraryOut(key=lib.key, title=lib.title) for lib in libraries]
    )


@router.get(
    "/libraries/{library_key}/tracks",
    response_model=PlexTracksResponse,
    summary="List one page of a music library's tracks",
)
async def list_tracks(
    library_key: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=MAX_PAGE_SIZE),
    title: Optional[str] = Query(
        None, max_length=MAX_FILTER_LENGTH,
        description="Substring filter on the track title (case-insensitive)",
    ),
    artist: Optional[str] = Query(
        None, max_length=MAX_FILTER_LENGTH,
        description="Substring filter on the artist name (case-insensitive)",
    ),
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> PlexTracksResponse:
    """One page of tracks, optionally filtered by title and/or artist.

    Both filters are applied by the MEDIA SERVER, across the whole library —
    not to the page this route happens to have fetched. That distinction is
    the entire point of the parameters: a page-local filter reads as a search
    to whoever types in it, and against a library of tens of thousands of
    tracks it is one that almost never finds anything, because page one is an
    alphabetical accident rather than a candidate set.

    Both are substring, case-insensitive, and AND-combined when both are given
    (there is no OR form upstream, which is why they are two fields rather
    than one box). ``total`` is the server's count of the MATCHES, so paging
    over a filtered listing is honest: offset/limit walk the match set.
    """
    client = await _client(db)
    try:
        page = await client.list_tracks(
            library_key, offset=offset, limit=limit, title=title, artist=artist
        )
    except PlexError as exc:
        raise _as_http_error(exc) from exc

    items = page.items

    return PlexTracksResponse(
        tracks=[
            PlexTrackOut(
                rating_key=t.rating_key,
                title=t.title,
                artist=t.artist,
                album=t.album,
                duration_ms=t.duration_ms,
                part_key=t.part_key,
                file_path=t.file_path,
                container=t.container,
                has_lyrics=t.has_lyrics,
            )
            for t in items
        ],
        total=page.total,
        offset=offset,
        limit=limit,
    )


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


@router.post(
    "/import",
    response_model=PlexImportResponse,
    status_code=202,
    summary="Queue an import of tracks from your Plex library",
)
async def import_tracks(
    body: PlexImportRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> PlexImportResponse:
    """Write one Song + one queued job per track and return.

    Structurally the same move ``/api/separate`` makes: validate cheaply, write
    the rows, return 202, let the worker do the work. The difference is that
    there is no upload to receive — the audio is materialised by the job, from
    a server this install can reach on its own.

    All rows land in ONE transaction. A song whose job never got written would
    sit in ``processing`` forever with nothing to advance it.
    """
    if not body.tracks:
        raise HTTPException(status_code=400, detail="No tracks were selected.")
    if len(body.tracks) > MAX_IMPORT_TRACKS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Select at most {MAX_IMPORT_TRACKS} tracks per import "
                f"(you selected {len(body.tracks)})."
            ),
        )
    if not karaoke_models.is_valid(body.karaoke_model):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown karaoke_model {body.karaoke_model!r}. "
                f"Choose one of: {', '.join(sorted(karaoke_models.CHOICES))}."
            ),
        )

    from karaoke_backend.workers.managed_processing import require_heart_model
    require_heart_model(allow_wait=True)

    # Fail before writing anything when there is nothing to import FROM: the
    # job would raise the same complaint a minute later, having already put a
    # `processing` song in the library.
    if not await plex_config.effective_url(db):
        raise HTTPException(
            status_code=400, detail="No media server URL is configured yet."
        )

    model = body.karaoke_model or karaoke_models.DEFAULT_CHOICE
    jobs: list[PlexImportJob] = []

    for track in body.tracks:
        job_id = str(uuid.uuid4())
        artist = (track.artist or "").strip() or "Unknown Artist"
        title = (track.title or "").strip() or "Untitled"
        # What the JOB acts on. Deliberately does NOT carry `part_key`,
        # `file_path` or `container`, even though the request may send them:
        # those name a location the worker will open, and a request body is
        # not an authority on this machine's filesystem. The job re-resolves
        # all three from the server using the rating key. The fields still
        # arrive on the model because the browse listing round-trips its rows
        # and they are worth keeping legible in a request log.
        track_payload = {
            "rating_key": track.rating_key,
            "artist": artist,
            "title": title,
            # A hint, not a fact — it only decides whether the job bothers
            # asking about lyrics at all.
            "has_lyrics": bool(track.has_lyrics),
            "llm_correction": bool(body.llm_correction),
            "llm_paging": bool(body.llm_paging),
            "karaoke_model": model,
        }

        song = Song(
            artist=artist,
            title=title,
            # A display LABEL derived from metadata, not a path and not a
            # promise about the file on disk: only the server can say what the
            # library file is called, and it has not been asked yet. The job
            # names the actual upload from what the server reports.
            filename=plex_config.upload_basename(
                {"title": title, "container": track.container}
            ),
            status="processing",
            job_id=job_id,
            owner_id=user.id,
        )
        db.add(song)
        await db.flush()  # get song.id

        queue.enqueue(
            db,
            kind=JobKind.PLEX_IMPORT.value,
            job_id=job_id,
            song_id=song.id,
            owner_id=user.id,
            payload=track_payload,
            message="Import queued",
        )
        jobs.append(
            PlexImportJob(job_id=job_id, song_id=song.id, title=title, artist=artist)
        )

    await db.commit()
    logger.info("Queued %d import(s) from the media server", len(jobs))
    return PlexImportResponse(jobs=jobs)
