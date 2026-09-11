# SPDX-License-Identifier: AGPL-3.0-only
"""
Ingest API endpoints.

POST /api/separate          → Upload audio, ENQUEUE the full ingest pipeline.
GET  /api/jobs/{job_id}     → Poll job lifecycle status + phase + progress.

The route enqueues and returns; the pipeline itself lives in
``karaoke_backend.jobs.ingest`` and is run by the worker (durable-queue design).

Job.status is the lifecycle:   queued → running → done | failed
Job.phase is what it is doing: queued → separating → fetching_lyrics →
                               transcribing → aligning → done | failed
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import Principal, require_user, require_user_or_guest
from karaoke_backend import stem_layout
from karaoke_backend.api.identity import Identity
from karaoke_backend.database import get_db
from karaoke_backend.jobs import queue
from karaoke_backend.models.song import Job, JobKind, JobStatus, Song
from karaoke_backend.workers import karaoke_models

logger = logging.getLogger(__name__)

router = APIRouter(tags=["separation"])

# Where uploaded files are stored before processing
UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "uploads"))
# Where completed stems are stored
STEMS_DIR = Path(os.getenv("STEMS_DIR", "stems"))

# Accepted audio MIME types
ACCEPTED_AUDIO_TYPES = {
    "audio/mpeg", "audio/mp3",
    "audio/wav", "audio/x-wav", "audio/wave",
    "audio/flac", "audio/x-flac",
    "audio/mp4", "audio/m4a", "audio/x-m4a",
    "audio/ogg", "audio/vorbis",
    "audio/aac",
    "application/octet-stream",  # generic binary — accepted but not validated deeply
}

MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "500"))


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class SeparationSubmitResponse(BaseModel):
    job_id: str
    song_id: int
    status: str
    status_url: str
    message: str


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


class JobStatusResponse(BaseModel):
    job_id: str
    song_id: Optional[int] = None
    status: str                         # queued|running|done|failed
    phase: str                          # queued|separating|…|aligning|done|failed
    progress: int                       # 0–100, spans the entire ingest pipeline
    message: Optional[str] = None
    stems: Optional[StemURLs] = None   # populated when status == "done"
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def safe_upload_name(raw: Optional[str], default: str) -> str:
    """The basename of a caller-supplied filename, never a path.

    ``Path(...).name`` is the whole of it — it drops every directory component,
    so "../../etc/passwd" becomes "passwd" and an absolute path becomes its
    last segment. The extra guard is for the three names that survive that and
    still are not filenames (``""``, ``"."``, ``".."``): each would compose a
    job-prefixed upload name that means something else to the filesystem than
    it reads as.

    Shared with the Plex import job, which has to compose its upload name the
    SAME way — the uploads reaper finds a job's file by the ``{job_id}_``
    prefix, so any second spelling of this is a second way to leak a file.
    """
    name = Path(raw or default).name
    if name in ("", ".", ".."):
        return default
    return name


def _make_stems_urls(song_id: int, stems_dir: Path, base_url: str) -> StemURLs:
    """Build stem download URLs for a completed song.

    Separations are standard songs with no voice roster, so `voices` stays
    None; the flat well-known keys are populated from disk.
    """
    return StemURLs(**stem_layout.stem_urls_payload(stems_dir, base_url, song_id))


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/api/separate",
    response_model=SeparationSubmitResponse,
    status_code=202,
    summary="Submit an audio file for stem separation",
)
async def submit_separation(
    file: UploadFile = File(..., description="Audio file to separate"),
    artist: Optional[str] = Form(None, description="Artist name (optional metadata)"),
    title: Optional[str] = Form(None, description="Song title (optional metadata)"),
    plain_lyrics: Optional[str] = Form(None, description="Pasted reference lyrics; anchors alignment and skips any lyrics lookup"),
    llm_correction: bool = Form(False, description="Enable LLM lyric correction"),
    llm_paging: bool = Form(False, description="Enable LLM page structuring"),
    karaoke_model: Optional[str] = Form(
        None,
        description=(
            "Pass-2 lead/backing model ID (see karaoke_models.CHOICES). "
            "Omit for the server-configured default."
        ),
    ),
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> SeparationSubmitResponse:
    """
    Upload an audio file and queue async GPU stem separation.

    Supported formats: MP3, WAV, FLAC, M4A, OGG, AAC.
    Max size: 500 MB.

    Every cheap synchronous check stays here — content type, size cap — because
    a 4xx the caller reads immediately beats a job that fails a minute later
    with the same information. What leaves is the work itself: this writes a
    `queued` row and returns, and the worker picks it up.

    Returns a `job_id` you can poll at `GET /api/jobs/{job_id}`.
    """
    # Refuse an unknown Pass-2 model ID BEFORE the upload body is read: it is
    # the cheapest check here, and an ID this server does not know means the
    # caller and the allowlist disagree — worth a 400 the operator sees now
    # rather than a silent fall back to the default after a GPU-minutes job.
    if not karaoke_models.is_valid(karaoke_model):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown karaoke_model {karaoke_model!r}. "
                f"Choose one of: {', '.join(sorted(karaoke_models.CHOICES))}."
            ),
        )

    # Validate content type (best-effort — browsers often send wrong MIME)
    content_type = (file.content_type or "").lower()
    if content_type and content_type not in ACCEPTED_AUDIO_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported media type: {content_type}. Upload an audio file.",
        )

    # Read file with size cap
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    job_id = str(uuid.uuid4())
    safe_filename = safe_upload_name(file.filename, "upload.wav")
    upload_path = UPLOADS_DIR / f"{job_id}_{safe_filename}"

    max_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
    total_read = 0
    chunks = []
    while chunk := await file.read(1024 * 1024):  # 1 MB chunks
        total_read += len(chunk)
        if total_read > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File too large — maximum is {MAX_FILE_SIZE_MB} MB",
            )
        chunks.append(chunk)

    upload_path.write_bytes(b"".join(chunks))
    logger.info("Saved upload: %s (%d MB)", upload_path, total_read // 1024 // 1024)

    # Infer artist/title from filename if not provided
    # Supports "Artist - Title.ext" and "Artist - Title" patterns
    stem_name = Path(safe_filename).stem
    if not artist and not title and " - " in stem_name:
        parts = stem_name.split(" - ", 1)
        inferred_artist = parts[0].strip()
        inferred_title = parts[1].strip()
    else:
        inferred_title = title or stem_name
        inferred_artist = artist or "Unknown Artist"

    # Create Song record
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

    # Enqueue. The payload carries the upload's NAME, not its path: the
    # uploads directory is resolved when the job runs, so a job written before
    # a container/volume move still finds its file.
    queue.enqueue(
        db,
        kind=JobKind.INGEST.value,
        job_id=job_id,
        song_id=song.id,
        owner_id=user.id,
        payload={
            "upload_path": upload_path.name,
            "artist": inferred_artist,
            "title": inferred_title,
            "pasted_lyrics": plain_lyrics,
            "llm_correction": llm_correction,
            "llm_paging": llm_paging,
            "karaoke_model": karaoke_model or karaoke_models.DEFAULT_CHOICE,
        },
    )
    await db.commit()
    await db.refresh(song)

    # Detect server base URL from environment or use sensible default
    base_url = os.getenv("BASE_URL", "http://localhost:8000")

    return SeparationSubmitResponse(
        job_id=job_id,
        song_id=song.id,
        status=JobStatus.QUEUED.value,
        status_url=f"{base_url}/api/jobs/{job_id}",
        message="File uploaded. Stem separation queued.",
    )


@router.get(
    "/api/jobs/{job_id}",
    response_model=JobStatusResponse,
    summary="Poll stem separation job status",
)
async def get_job_status(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(require_user_or_guest),
) -> JobStatusResponse:
    """
    Poll the status of a stem separation or import job.

    The host sees everything about their own jobs. A guest sees progress and
    nothing else, and only for jobs belonging to the host who admitted them.

    This partially re-opens a route an earlier hardening pass closed. That pass
    was right at the time — guests could not start an import, so no guest had a
    job to watch and the guest branch was unreachable code. Guest-initiated
    import is coming back, and a guest who triggers an import and then cannot
    see it succeed or fail has a feature that appears to do nothing.

    Note the ordering: the poll route has to exist before any provider can opt
    into guest import, so this lands first. Until one does — and none that ship
    today declares the capability — no guest can obtain a job id through import
    at all.

    What stays closed is the detail, because that is where the leak was:

    - ``message`` is free text the importer composes from the provider's
      display label, so it names the vendor verbatim. That is precisely the
      provenance the guest song projection exists to withhold, and handing it
      back through a job poll would undo that a field at a time.
    - ``error`` is ``str(exc)`` and routinely carries filesystem paths off the
      operator's machine.
    - ``stems`` are download URLs for the host's audio, which guests cannot
      fetch anyway.

    A job belonging to another host is a **404**, never a 403: a 403 confirms
    the id exists, which turns this route into an oracle for enumerating other
    tenants' job ids.

    The scope is the admitting host's jobs, not the guest's own — a `Job` has
    no creator column to filter on. What makes that acceptable is that job ids
    are `uuid4`, so a guest cannot reach a job they were never handed the id
    for. Anything that makes job ids guessable — a sequential id, a slug from
    the title — turns this into a read of the host's whole job history.

    - **status** — the queue LIFECYCLE: `queued` → `running` → `done` |
      `failed`. These four are the only values, and the only ones worth
      branching on.
    - **phase** — what the job is doing: `queued` → `separating` →
      `fetching_lyrics` → `transcribing` → `aligning` → `done` | `failed`
      (`importing` for a catalog import). Display text, not control flow. It
      falls back to `status` for rows written before the queue existed.
    - **progress**: 0–100 integer
    - **stems**: populated when `status == "done"` (host only)

    Poll every 2–5 seconds until `status` is `done` or `failed`.
    """
    result = await db.execute(
        select(Job).where(Job.id == job_id, Job.owner_id == principal.host_id)
    )
    job = result.scalar_one_or_none()

    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")

    phase = job.phase or job.status

    if principal.is_guest:
        # An allowlist, not a redaction. Blanking known-bad fields off a fully
        # populated response is a pattern that silently re-leaks the next field
        # somebody adds to the model; naming what a guest may see means the
        # next field defaults to withheld.
        return JobStatusResponse(
            job_id=job.id,
            song_id=job.song_id,
            status=job.status,
            phase=phase,
            progress=job.progress,
            message=None,
            stems=None,
            error=None,
        )

    stems: Optional[StemURLs] = None
    if job.status == JobStatus.DONE.value and job.stems:
        try:
            stems_data = json.loads(job.stems)
            stems = StemURLs(**stems_data)
        except Exception:
            pass

    # Raw error_message is exception text (str(exc)) and can carry internal
    # paths. The caller here is the account holder, who is entitled to it.
    error: Optional[str] = None
    if job.status == JobStatus.FAILED.value:
        error = job.error_message

    return JobStatusResponse(
        job_id=job.id,
        song_id=job.song_id,
        status=job.status,
        phase=phase,
        progress=job.progress,
        message=job.message,
        stems=stems,
        error=error,
    )
