# SPDX-License-Identifier: AGPL-3.0-only
"""Host-only single-song CD+G and MP3+G ZIP import."""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.api.separate import UPLOADS_DIR, safe_upload_name
from karaoke_backend.database import get_db
from karaoke_backend.jobs import queue
from karaoke_backend.jobs.cdg_import import MAX_CDG_BYTES
from karaoke_backend.models.song import JobKind, JobStatus, Song

logger = logging.getLogger(__name__)
router = APIRouter(tags=["CD+G import"])

MAX_CDG_UPLOAD_BYTES = 550 * 1024 * 1024
_CHUNK_BYTES = 1024 * 1024
_MULTIPART_SLACK_BYTES = 1024 * 1024
_EXTENSIONS = frozenset({".cdg", ".zip"})
_TYPES = frozenset(
    {
        "application/zip",
        "application/x-zip-compressed",
        "application/octet-stream",
        "application/x-cdg",
    }
)


class CdgImportSubmitResponse(BaseModel):
    job_id: str
    song_id: int
    status: str
    status_url: str
    message: str


def _unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


@router.post("/api/import/cdg", response_model=CdgImportSubmitResponse, status_code=202)
async def submit_cdg_import(
    request: Request,
    file: UploadFile = File(..., description="A bare CDG or one MP3+G ZIP from your library"),
    artist: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> CdgImportSubmitResponse:
    safe_name = safe_upload_name(file.filename, "graphics.cdg")
    extension = Path(safe_name).suffix.lower()
    if extension not in _EXTENSIONS:
        raise HTTPException(status_code=415, detail="Upload a bare .cdg or an MP3+G .zip file.")
    max_bytes = MAX_CDG_BYTES if extension == ".cdg" else MAX_CDG_UPLOAD_BYTES
    cap_label = "the 30-minute CDG packet limit" if extension == ".cdg" else "550 MB"

    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_bytes = int(declared)
        except ValueError:
            declared_bytes = -1
        if declared_bytes > max_bytes + _MULTIPART_SLACK_BYTES:
            raise HTTPException(
                status_code=413, detail=f"File too large — maximum is {cap_label}"
            )
    content_type = (file.content_type or "").split(";", 1)[0].lower()
    if content_type and content_type not in _TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported media type: {content_type}")

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    job_id = str(uuid.uuid4())
    upload_path = UPLOADS_DIR / f"{job_id}_{safe_name}"
    total = 0
    try:
        with upload_path.open("wb") as out:
            while chunk := await file.read(_CHUNK_BYTES):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large — maximum is {cap_label}",
                    )
                out.write(chunk)
    except HTTPException:
        _unlink(upload_path)
        raise
    except OSError as exc:
        _unlink(upload_path)
        logger.error("Could not store CD+G upload at %s: %s", upload_path, exc)
        raise HTTPException(status_code=500, detail="The CD+G file could not be stored.") from exc

    stem = Path(safe_name).stem
    if not artist and not title and " - " in stem:
        inferred_artist, inferred_title = (part.strip() for part in stem.split(" - ", 1))
    else:
        inferred_artist, inferred_title = artist or "Unknown Artist", title or stem
    song = Song(
        artist=inferred_artist,
        title=inferred_title,
        filename=safe_name,
        status="processing",
        job_id=job_id,
        owner_id=user.id,
    )
    db.add(song)
    await db.flush()
    queue.enqueue(
        db,
        kind=JobKind.CDG_IMPORT.value,
        job_id=job_id,
        song_id=song.id,
        owner_id=user.id,
        payload={"upload_name": upload_path.name},
    )
    await db.commit()
    return CdgImportSubmitResponse(
        job_id=job_id,
        song_id=song.id,
        status=JobStatus.QUEUED.value,
        status_url=f"{os.getenv('BASE_URL', 'http://localhost:8000')}/api/jobs/{job_id}",
        message="File uploaded. CD+G import queued.",
    )
