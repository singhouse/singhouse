# SPDX-License-Identifier: AGPL-3.0-only
"""Core capability discovery — what this deployment has switched on.

Public module. The frontend needs to know which optional, operator-
gated capabilities exist before it renders affordances for them: an "look up
lyrics" button that always 503s is worse than no button.

Deliberately narrow. This reports **operator configuration**, not license
state, not user permissions, and not which plugins are installed (that is
``GET /api/catalog/providers``). It answers one question per entry: may the
UI offer this?

Behind ``require_user`` — the same reasoning as ``/api/catalog/providers``:
which third-party services an operator has enabled is part of their private
deployment posture, and only host surfaces consume this.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.export import raster
from karaoke_backend.plex.config import PLEX_LYRICS_ENV, plex_lyrics_enabled
from karaoke_backend.workers.lyrics_worker import (
    BUILTIN_LYRICS_LABEL,
    BUILTIN_LYRICS_PROVIDER,
    lrclib_enabled,
)

router = APIRouter(prefix="/api/features", tags=["features"])


class LyricsLookupFeature(BaseModel):
    """The built-in third-party lyrics provider's opt-in state."""

    enabled: bool = Field(
        description=(
            "Whether the operator has opted in to the built-in lyrics "
            "provider. False on a stock install."
        )
    )
    provider: str = Field(description="Provider selection key.")
    label: str = Field(description="Display name, for labeling fetched lyrics.")


class PlexLyricsFeature(BaseModel):
    """Whether lyrics may be read off the operator's own media server.

    Separate from ``lyrics_lookup`` because it is a separate question with a
    separate answer: that one is about contacting a third-party service at
    all, this one is about whether text already sitting on the operator's
    server may be reused as an alignment reference. Importing the AUDIO is not
    gated by either.
    """

    enabled: bool = Field(
        description=(
            "Whether the operator has opted in to reading lyrics from their "
            "media server. False on a stock install."
        )
    )
    env: str = Field(description="The environment variable that grants it.")


class FeaturesResponse(BaseModel):
    lyrics_lookup: LyricsLookupFeature
    cdg_export: bool = Field(
        description=(
            "Whether the CD+G export rasteriser is installed (the optional "
            "export extra). False means the export routes answer 501."
        )
    )
    plex_lyrics: PlexLyricsFeature


@router.get("", response_model=FeaturesResponse, summary="Operator-gated capabilities")
async def get_features(
    _user: Identity = Depends(require_user),
) -> FeaturesResponse:
    """Report which optional capabilities this deployment has switched on.

    A UI hint only. Every capability reported here is enforced independently
    at its own route — a client that ignores this response gets a 503, not a
    third-party request.
    """
    return FeaturesResponse(
        lyrics_lookup=LyricsLookupFeature(
            enabled=lrclib_enabled(),
            provider=BUILTIN_LYRICS_PROVIDER,
            label=BUILTIN_LYRICS_LABEL,
        ),
        cdg_export=raster.raster_available(),
        plex_lyrics=PlexLyricsFeature(
            enabled=plex_lyrics_enabled(),
            env=PLEX_LYRICS_ENV,
        ),
    )
