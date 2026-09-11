# SPDX-License-Identifier: AGPL-3.0-only
"""Video import endpoint.

POST /api/import/video → Add a karaoke video file from your own library.

The operator already has the video — one they authored, or one that came with
their own material — and wants it in the library as a playable song. The route
does what ``/api/separate`` does structurally: validate cheaply, put the file
somewhere durable, write a ``queued`` row, and return. The work itself lives in
``karaoke_backend.jobs.video_import`` and is run by the worker.

Poll the returned ``job_id`` at ``GET /api/jobs/{job_id}``; that route already
serves every kind and needs nothing added for this one.

**What actually bounds an oversized upload, honestly.** Three things sit
between a caller and the disk, and only the first two are admission control.
The multipart layer that produces ``UploadFile`` has already spooled the WHOLE
request body into the system temp directory before this function is entered,
so nothing here can prevent that transfer once it starts. The declared
``Content-Length`` is therefore checked first, before the file is touched, and
refuses every well-behaved client that announces more than the cap. The chunked
copy below then caps what lands in the uploads directory — which is the
durable, operator-visible space — and a request that runs over takes its
partial file with it. What remains is a client that lies about its length: it
still costs transient spool space in the temp directory. Closing that needs a
raw-stream rewrite of the endpoint, which is deliberately not taken here — it
would give up the ``UploadFile`` parsing conveniences for a marginal gain on a
service deployed on the operator's own network.

Note also what ``/api/separate`` does differently: it accumulates its chunks
and writes once, which is fine for a song-length audio file and is not fine
here, where uploads are measured in gigabytes. Chunks go straight to the file.
"""

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
from karaoke_backend.database import get_db
from karaoke_backend.jobs import queue
from karaoke_backend.jobs.video_import import VIDEO_EXTENSIONS
from karaoke_backend.models.song import JobKind, JobStatus, Song

logger = logging.getLogger(__name__)

router = APIRouter(tags=["video import"])

# Same resolution as api/separate.py — the env is the single source of truth
# for where an upload lands, and both routes have to agree with the workers.
UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "uploads"))

# Container MIME types a browser plausibly reports for the four formats the
# import supports. ``application/octet-stream`` is the generic every file
# picker falls back to; it is accepted, and the extension carries the decision
# in that case.
ACCEPTED_VIDEO_TYPES = frozenset({
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-matroska",
    "application/octet-stream",
})

DEFAULT_MAX_VIDEO_SIZE_MB = 2048

_CHUNK_BYTES = 1024 * 1024

# A declared Content-Length covers the multipart framing as well as the file:
# boundaries, headers, and the artist/title fields. One megabyte of slack keeps
# a file that is exactly at the cap from being refused for its envelope.
_MULTIPART_SLACK_BYTES = 1024 * 1024

_SUPPORTED = "Upload a karaoke video file (MP4, WebM, MOV, or MKV)."


def max_video_size_mb() -> int:
    """The upload cap, read at CALL time (the ``jobs.queue`` env convention).

    Import-time capture would make the value untestable and would freeze an
    operator's ``MAX_VIDEO_SIZE_MB`` at whatever it was when the module first
    loaded.
    """
    raw = os.getenv("MAX_VIDEO_SIZE_MB", "").strip()
    if not raw:
        return DEFAULT_MAX_VIDEO_SIZE_MB
    try:
        value = int(raw)
    except ValueError:
        logger.warning(
            "MAX_VIDEO_SIZE_MB=%r is not an integer — using %s",
            raw, DEFAULT_MAX_VIDEO_SIZE_MB,
        )
        return DEFAULT_MAX_VIDEO_SIZE_MB
    if value < 1:
        logger.warning(
            "MAX_VIDEO_SIZE_MB=%r is below 1 — using %s",
            raw, DEFAULT_MAX_VIDEO_SIZE_MB,
        )
        return DEFAULT_MAX_VIDEO_SIZE_MB
    return value


# ---------------------------------------------------------------------------
# Response schema — the same five fields ``/api/separate`` answers with, so a
# caller can drive both submissions through one code path.
# ---------------------------------------------------------------------------


class VideoImportSubmitResponse(BaseModel):
    job_id: str
    song_id: int
    status: str
    status_url: str
    message: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _infer_artist_title(
    safe_filename: str, artist: Optional[str], title: Optional[str]
) -> tuple[str, str]:
    """"Artist - Title.ext" → (artist, title), same rule as /api/separate."""
    stem_name = Path(safe_filename).stem
    if not artist and not title and " - " in stem_name:
        left, right = stem_name.split(" - ", 1)
        return left.strip(), right.strip()
    return (artist or "Unknown Artist", title or stem_name)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/api/import/video",
    response_model=VideoImportSubmitResponse,
    status_code=202,
    summary="Import a karaoke video file into your library",
)
async def submit_video_import(
    request: Request,
    file: UploadFile = File(..., description="A karaoke video file you already have"),
    artist: Optional[str] = Form(None, description="Artist name (optional metadata)"),
    title: Optional[str] = Form(None, description="Song title (optional metadata)"),
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> VideoImportSubmitResponse:
    """
    Add a karaoke video file from your own library as a playable song.

    The video is kept as the song's picture and its audio track becomes the
    song's stem, so playback runs through the same mixer and key shift as
    every other song. Nothing is separated and no lyrics are looked up — a
    karaoke video normally carries its words on screen already.

    Supported containers: MP4, WebM, MOV, MKV.

    Every cheap synchronous check stays here — media type, extension, size cap
    — because a 4xx the caller reads immediately beats a job that fails a
    minute later with the same information. What leaves is the work itself:
    this writes a `queued` row and returns, and the worker picks it up.

    Returns a `job_id` you can poll at `GET /api/jobs/{job_id}`.
    """
    max_mb = max_video_size_mb()
    max_bytes = max_mb * 1024 * 1024

    # The declared length first, before the file is read at all: it is the only
    # check here that can refuse an oversized upload without the caller having
    # sent the whole of it. A client that lies is caught by the cap on the copy
    # below; see the module docstring for what that does and does not bound.
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_bytes = int(declared)
        except ValueError:
            declared_bytes = -1
        if declared_bytes > max_bytes + _MULTIPART_SLACK_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large — maximum is {max_mb} MB",
            )

    # Media type first (best-effort — browsers often send a generic type),
    # then the extension, which is not merely advisory here: the retained file
    # keeps its container extension, so an unrecognized one has no landing
    # name and would only fail later inside the job.
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type and content_type not in ACCEPTED_VIDEO_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported media type: {content_type}. {_SUPPORTED}",
        )

    safe_filename = Path(file.filename or "video.mp4").name
    extension = Path(safe_filename).suffix.lower()
    if extension not in VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=(
                f"Unsupported file extension: {extension or '(none)'}. "
                f"{_SUPPORTED}"
            ),
        )

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    job_id = str(uuid.uuid4())
    upload_path = UPLOADS_DIR / f"{job_id}_{safe_filename}"

    total_read = 0
    oversize = False
    try:
        with upload_path.open("wb") as out:
            while chunk := await file.read(_CHUNK_BYTES):
                total_read += len(chunk)
                if total_read > max_bytes:
                    # Stop at the first chunk that crosses the line: there is
                    # no reason to keep writing a file that is already refused.
                    oversize = True
                    break
                out.write(chunk)
    except OSError as exc:
        _unlink_quietly(upload_path)
        logger.error("Could not store video upload at %s: %s", upload_path, exc)
        raise HTTPException(
            status_code=500, detail="The video file could not be stored."
        ) from exc

    if oversize:
        _unlink_quietly(upload_path)
        raise HTTPException(
            status_code=413,
            detail=f"File too large — maximum is {max_mb} MB",
        )

    logger.info(
        "Saved video upload: %s (%d MB)", upload_path, total_read // 1024 // 1024
    )

    inferred_artist, inferred_title = _infer_artist_title(safe_filename, artist, title)

    song = Song(
        artist=inferred_artist,
        title=inferred_title,
        filename=safe_filename,
        status="processing",
        job_id=job_id,
        owner_id=user.id,
    )
    db.add(song)
    await db.flush()  # get song.id

    # The payload carries the upload's NAME, not its path: the uploads
    # directory is resolved when the job runs, so a job written before a
    # container/volume move still finds its file.
    queue.enqueue(
        db,
        kind=JobKind.VIDEO_IMPORT.value,
        job_id=job_id,
        song_id=song.id,
        owner_id=user.id,
        payload={
            "upload_name": upload_path.name,
            "artist": inferred_artist,
            "title": inferred_title,
        },
    )
    await db.commit()
    await db.refresh(song)

    base_url = os.getenv("BASE_URL", "http://localhost:8000")

    return VideoImportSubmitResponse(
        job_id=job_id,
        song_id=song.id,
        status=JobStatus.QUEUED.value,
        status_url=f"{base_url}/api/jobs/{job_id}",
        message="File uploaded. Video import queued.",
    )
