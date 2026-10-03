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

import shutil
from typing import Any

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
from karaoke_backend.workers import modal_offload, modal_worker, word_sync_worker
from karaoke_backend.workers.managed_processing import InvalidAttestation, validated_attestation, heart_model_status

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
    llm_paging: bool = Field(default=False, description="A user-configured paging endpoint is available; remote readiness is unverified.")
    lyrics_lookup: LyricsLookupFeature
    cdg_export: bool = Field(
        description=(
            "Whether the CD+G export rasteriser is installed (the optional "
            "export extra). False means the export routes answer 501."
        )
    )
    plex_lyrics: PlexLyricsFeature
    processing: dict[str, Any] = Field(
        description=(
            "Honest runtime readiness for playback and optional processing. "
            "The desktop manifest is reported, never used to invent a fallback."
        )
    )


def _desktop_processing_manifest() -> dict[str, Any]:
    try:
        value = validated_attestation()
    except InvalidAttestation:
        return {"configured": True, "valid": False}
    if value is None:
        return {}
    return {"configured": True, "valid": True, **value}


def _processing_readiness() -> dict[str, Any]:
    playback_tools = {name: shutil.which(name) is not None for name in ("ffmpeg", "ffprobe")}
    local_python = False
    manifest = _desktop_processing_manifest()
    capabilities = (set(manifest.get("verifiedCapabilities", ()))
                    if manifest.get("valid") else set())
    if manifest.get("valid"):
        local_python = True
    from karaoke_backend.workers.managed_processing import model_set_ready
    local_separation = (
        local_python and manifest.get("capabilitiesReady") is True
        and "separation" in capabilities and model_set_ready("separation", manifest)
    )
    local_transcription = (
        local_python and manifest.get("capabilitiesReady") is True
        and "transcription" in capabilities and model_set_ready("transcription", manifest)
    )
    modal_detail = modal_offload.readiness()
    # Source configuration alone is not readiness. Packaged bootstrap may supply
    # a qualified release contract + consent + checked metadata before workers
    # start. This endpoint remains observational and performs no remote calls.
    modal_ready = modal_detail.get("desktop_qualified") is True
    runtime = None
    if local_python:
        runtime = {"id": manifest["runtimeManifestId"], "accelerator": manifest["accelerator"],
                   "capabilities": sorted(capabilities) if manifest.get("capabilitiesReady") is True else []}

    def fact(ready: bool, unavailable: str) -> dict[str, Any]:
        return {"ready": True} if ready else {"ready": False, "reason": unavailable}

    return {
        "heart_model": heart_model_status(),
        "playback": fact(
            all(playback_tools.values()),
            "ffmpeg and ffprobe are required for playback preparation",
        ),
        "transcription": fact(
            local_transcription or modal_ready,
            "no verified local transcription models or ready user-owned Modal",
        ),
        "separation": fact(
            local_separation or modal_ready,
            "no verified local separation models or ready user-owned Modal",
        ),
        "modal": {**fact(
            modal_ready,
            "user-owned Modal is configured but remotely unverified"
            if modal_detail["configured"] else "user-owned Modal is not configured",
        ), "configured": modal_detail["configured"], "selected": modal_offload.is_enabled(),
            "releaseSupported": modal_detail.get("releaseSupported") is True},
        "runtime": runtime,
    }


@router.get(
    "/processing",
    response_model=dict[str, Any],
    summary="Native processing readiness",
)
async def get_processing_features(
    _user: Identity = Depends(require_user),
) -> dict[str, Any]:
    return _processing_readiness()


@router.get("", response_model=FeaturesResponse, summary="Operator-gated capabilities")
async def get_features(
    _user: Identity = Depends(require_user),
) -> FeaturesResponse:
    """Report which optional capabilities this deployment has switched on.

    A UI hint only. Every capability reported here is enforced independently
    at its own route — a client that ignores this response gets a 503, not a
    third-party request.
    """
    from karaoke_backend.workers.llm_client import paging_configured

    return FeaturesResponse(
        llm_paging=paging_configured(),
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
        processing=_processing_readiness(),
    )
