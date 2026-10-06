# SPDX-License-Identifier: AGPL-3.0-only
"""
Lyrics fetch endpoint.

GET /api/lyrics?artist=<artist>&title=<title>
    -> Returns plain + synced (LRC) lyrics from the selected provider

GET /api/lyrics/lookup?artist=<artist>&title=<title>
    -> ``{found, plain_lyrics, synced}`` from the built-in provider, for
       previewing reference lyrics before a file is added

The built-in lrclib provider is opt-in and OFF by default, so on a stock
install this route answers 503 instead of proxying a third-party service.

Behind ``require_user``: the route makes an outbound request to a third party
on the caller's behalf, so an open one is an anonymous proxy and a way to
spend an operator's connectivity. Only host surfaces call it (``AudioPlayer``,
mounted in ``HostShell``); no guest surface does. This closes the gating that
``api/gate.py`` deferred to the lrclib opt-in track.

Per-song lyrics-set CRUD lives at /api/songs/{id}/lyrics/* (see api.lyrics_sets).
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.workers.lyrics_worker import (
    BUILTIN_LYRICS_LABEL,
    BUILTIN_LYRICS_PROVIDER,
    LyricsNotFoundError,
    LyricsProviderDisabledError,
    LyricsServiceError,
    fetch_lyrics,
    fetch_lyrics_by_provider,
    lrclib_enabled,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/lyrics", tags=["lyrics"])


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class LyricsResponse(BaseModel):
    artist: str
    title: str
    album: Optional[str] = None
    duration: Optional[float] = None          # seconds
    plain_lyrics: Optional[str] = None        # raw text block
    synced_lyrics: Optional[str] = None       # LRC format
    lines: list[str] = []                     # plain lyrics as individual lines
    has_sync: bool = False
    source: str = BUILTIN_LYRICS_LABEL        # shown in the UI, never blank


class LyricsLookupResponse(BaseModel):
    found: bool
    plain_lyrics: Optional[str] = None
    synced: bool = False


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=LyricsResponse, summary="Fetch lyrics for a song")
async def get_lyrics(
    artist: str = Query(..., description="Artist name", min_length=1, max_length=255),
    title: str = Query(..., description="Song title", min_length=1, max_length=255),
    provider: str = Query(
        BUILTIN_LYRICS_PROVIDER,
        description="Lyrics provider name (default: the built-in lrclib source)",
    ),
    _user: Identity = Depends(require_user),
) -> LyricsResponse:
    """
    Fetch plain and synced lyrics for a given artist + title.

    The built-in provider is lrclib.net, which is **opt-in and off by
    default** — until the operator sets ``KARAOKE_LRCLIB=1`` this answers 503.
    A non-default ``provider`` selects an installed lyrics plugin (an
    additive hook), which is governed by its own installation rather than by
    that flag.
    """
    logger.info("Lyrics request: %r - %r", artist, title)

    try:
        if provider == BUILTIN_LYRICS_PROVIDER:
            result = await fetch_lyrics(artist=artist, title=title)
        else:
            result = await fetch_lyrics_by_provider(provider, artist, title)
    except LyricsNotFoundError as exc:
        logger.info("Lyrics not found: %s", exc)
        raise HTTPException(
            status_code=404,
            detail=f"No lyrics found for '{artist}' - '{title}'",
        ) from exc
    except LyricsProviderDisabledError as exc:
        # Must precede LyricsServiceError — it is a subclass, and "you have
        # not turned this on" is a different answer from "the service broke".
        logger.info("Lyrics lookup requested while opted out: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=(
                f"Third-party lyrics lookup ({BUILTIN_LYRICS_LABEL}) is turned "
                f"off on this server."
            ),
        ) from exc
    except LyricsServiceError as exc:
        logger.error("Lyrics service error: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="Failed to reach lyrics service -- please try again later",
        ) from exc

    return LyricsResponse(
        artist=result.artist,
        title=result.title,
        album=result.album,
        duration=result.duration,
        plain_lyrics=result.plain_lyrics,
        synced_lyrics=result.synced_lyrics,
        lines=result.lines,
        has_sync=result.has_sync,
        source=result.source,
    )


@router.get(
    "/lookup",
    response_model=LyricsLookupResponse,
    summary="Look up reference lyrics before adding a file",
)
async def lookup_lyrics(
    artist: str = Query(..., description="Artist name", min_length=1, max_length=255),
    title: str = Query(..., description="Song title", min_length=1, max_length=255),
    _user: Identity = Depends(require_user),
) -> LyricsLookupResponse:
    """
    Preview the plain lyrics ingest would use for ``artist`` + ``title``.

    Same lookup as ingest (``fetch_lyrics``). A miss is an ordinary answer
    (``found: false``), not an error. When the operator has not opted in to
    the built-in provider this answers 404 without contacting anything.
    """
    if not lrclib_enabled():
        raise HTTPException(status_code=404, detail="Lyrics lookup is turned off on this server.")

    try:
        result = await fetch_lyrics(artist=artist, title=title)
    except LyricsNotFoundError:
        return LyricsLookupResponse(found=False)
    except LyricsProviderDisabledError as exc:
        raise HTTPException(
            status_code=404, detail="Lyrics lookup is turned off on this server."
        ) from exc
    except LyricsServiceError as exc:
        logger.warning("Lyrics lookup failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="Failed to reach lyrics service -- please try again later",
        ) from exc

    plain = (result.plain_lyrics or "").strip() or None
    return LyricsLookupResponse(found=plain is not None, plain_lyrics=plain, synced=result.has_sync)
