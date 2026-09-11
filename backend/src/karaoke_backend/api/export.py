# SPDX-License-Identifier: AGPL-3.0-only
"""Single-song CD+G / MP3+G export endpoints.

GET /api/export/settings           → the attribution-card toggle
PUT /api/export/settings           → update the toggle
GET /api/export/songs/{song_id}    → download an MP3+G zip or a bare .cdg

The heavy lifting — resolution, encoding, file assembly — lives in
``export.service``; this router owns the HTTP shapes only: query validation,
the typed-exception-to-status mapping (404 not found, 409 not exportable as
asked, 501 rasteriser not installed), and safe download headers.

Every route requires the Host. Song access is owner-scoped and a foreign
song is indistinguishable from a missing one, like the stem download route.
"""

from __future__ import annotations

import urllib.parse
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.database import get_db
from karaoke_backend.export import service
from karaoke_backend.models.settings import CDG_CARD_KEY, AppSetting

router = APIRouter(prefix="/api/export", tags=["export"])


class ExportSettings(BaseModel):
    attribution_card: bool = Field(
        description=(
            "Whether exported CD+G streams open with the attribution card "
            "when the song's intro has room for it."
        )
    )


def _content_disposition(filename: str) -> str:
    """A safe attachment header for a filename that may not be ASCII.

    The plain ``filename`` parameter must stay ASCII, so non-ASCII characters
    degrade there and the exact name rides the RFC 5987 ``filename*`` form,
    which capable clients prefer.
    """
    ascii_name = (
        filename.encode("ascii", "replace").decode("ascii").replace('"', "_")
    )
    header = f'attachment; filename="{ascii_name}"'
    if filename != ascii_name:
        header += f"; filename*=UTF-8''{urllib.parse.quote(filename, safe='')}"
    return header


@router.get(
    "/settings",
    response_model=ExportSettings,
    summary="Read the export settings",
)
async def get_settings(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> ExportSettings:
    return ExportSettings(
        attribution_card=await service.get_attribution_card_setting(db)
    )


@router.put(
    "/settings",
    response_model=ExportSettings,
    summary="Update the export settings",
)
async def put_settings(
    body: ExportSettings,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> ExportSettings:
    # Get-or-create upsert; stored as "true"/"false" text, parsed by readers.
    value = "true" if body.attribution_card else "false"
    row = await db.get(AppSetting, CDG_CARD_KEY)
    if row is None:
        db.add(AppSetting(key=CDG_CARD_KEY, value=value))
    else:
        row.value = value
    await db.commit()
    return ExportSettings(
        attribution_card=await service.get_attribution_card_setting(db)
    )


@router.get(
    "/songs/{song_id}",
    summary="Export one song as MP3+G or bare CDG",
    response_class=Response,
)
async def export_song(
    song_id: int,
    format: Literal["mp3g", "cdg"] = Query(
        "mp3g", description="mp3g = zip of paired MP3 + CDG; cdg = the bare stream"
    ),
    audio: Optional[Literal["karaoke", "instrumental"]] = Query(
        None,
        description=(
            "Which stem mix feeds the MP3. An explicit choice is honoured "
            "or refused (409 when that stem is missing); omitted means "
            "karaoke mix with instrumental fallback"
        ),
    ),
    card: Optional[bool] = Query(
        None,
        description=(
            "Override the stored attribution-card setting for this request"
        ),
    ),
    lyrics_set: Optional[int] = Query(
        None, description="Explicit lyrics set id (default: the song's active set)"
    ),
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> Response:
    """Build and stream the export as a file download."""
    try:
        result = await service.export_song(
            db,
            song_id=song_id,
            owner_id=user.id,
            fmt=format,
            audio=audio,
            card=card,
            lyrics_set_id=lyrics_set,
        )
    except service.RasterUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except service.ExportNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except service.ExportConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return Response(
        content=result.content,
        media_type=result.media_type,
        headers={"Content-Disposition": _content_disposition(result.filename)},
    )
