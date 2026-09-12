# SPDX-License-Identifier: AGPL-3.0-only
"""
Lyrics-set CRUD: a song can have many lyric sets (transcription runs, manual
edits, an externally-verified reference). One is "active" (drives playback);
one may be "verified" (the eval ground truth).

Endpoints:
    GET    /api/songs/{song_id}/lyrics                  → list all sets
    POST   /api/songs/{song_id}/lyrics                  → create a manual set
    GET    /api/songs/{song_id}/lyrics/{lid}            → get one (with payload)
    PATCH  /api/songs/{song_id}/lyrics/{lid}            → edit fields
    POST   /api/songs/{song_id}/lyrics/{lid}/activate   → make this set active
    POST   /api/songs/{song_id}/lyrics/{lid}/verify     → mark as ground truth
    POST   /api/songs/{song_id}/lyrics/{lid}/copy       → duplicate a set
    DELETE /api/songs/{song_id}/lyrics/{lid}            → remove
    POST   /api/songs/{song_id}/lyrics/transcribe       → kick off a fresh
                                                          transcription run as a
                                                          new set; returns job_id
    POST   /api/songs/{song_id}/lyrics/realign          → reuse cached
                                                          transcription, realign
                                                          against new reference
    POST   /api/songs/{song_id}/lyrics/{lid}/page       → re-run LLM paging on
                                                          an existing set's word
                                                          timings; returns job_id
    GET    /api/songs/{song_id}/lyrics/cache            → cache status helper
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.database import get_db
from karaoke_backend import stem_storage
from lyricsync import (
    MatchConfig,
    PipelineConfig,
    PostProcessConfig,
    VadConfig,
)
from karaoke_backend.jobs import queue
from karaoke_backend.models.song import JobKind, LyricsSet, LyricsSource, Song, SongStatus
from karaoke_backend.workers import transcription_cache
from karaoke_backend.workers.lyrics_worker import (
    BUILTIN_LYRICS_LABEL,
    LyricsNotFoundError,
    LyricsProviderDisabledError,
    LyricsServiceError,
    fetch_lyrics,
    lrclib_enabled,
)
from karaoke_backend.workers.word_sync_worker import (
    ALL_MODELS,
    DEFAULT_MODEL,
    describe_run,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/songs/{song_id}/lyrics", tags=["lyrics-sets"])

STEMS_DIR = Path(os.getenv("STEMS_DIR", "stems"))


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


VALID_SOURCES = {s.value for s in LyricsSource}


class LyricsSetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    song_id: int
    source: str
    label: Optional[str] = None
    is_verified: bool
    is_active: bool
    has_word_sync: bool
    has_synced_lyrics: bool
    has_plain_lyrics: bool
    plain_lyrics: Optional[str] = None
    synced_lyrics: Optional[str] = None
    word_sync: Optional[dict] = None
    metadata: Optional[dict] = None
    created_at: str
    updated_at: str


class LyricsSetCreate(BaseModel):
    source: str = LyricsSource.MANUAL.value
    label: Optional[str] = None
    plain_lyrics: Optional[str] = None
    synced_lyrics: Optional[str] = None
    word_sync_json: Optional[dict] = None
    metadata_json: Optional[dict] = None
    activate: bool = True


class LyricsSetUpdate(BaseModel):
    label: Optional[str] = None
    is_verified: Optional[bool] = None
    plain_lyrics: Optional[str] = None
    synced_lyrics: Optional[str] = None
    word_sync_json: Optional[dict] = None
    metadata_json: Optional[dict] = None


class LyricsSetCopy(BaseModel):
    label: Optional[str] = None
    activate: bool = False


# Pydantic mirrors of the lyricsync configs. Defaults are duplicated rather
# than imported so OpenAPI documents the limits clearly.

class VadConfigIn(BaseModel):
    frame_size: int = 1024
    onset_threshold: float = Field(0.03, ge=0, le=1)
    offset_threshold: float = Field(0.02, ge=0, le=1)
    min_silence_duration: float = Field(1.5, ge=0)
    max_segment_duration: float = Field(30.0, gt=0)


class MatchConfigIn(BaseModel):
    gap_penalty: float = Field(-0.5, le=0)
    exact_score: float = 2.0
    close_score: float = 1.0
    weak_score: float = 0.0
    phonetic_score: float = 0.5
    mismatch_score: float = -1.0
    lev_close_threshold: float = Field(0.75, ge=0, le=1)
    lev_weak_threshold: float = Field(0.5, ge=0, le=1)
    phonetic_threshold: float = Field(0.7, ge=0, le=1)


class PostProcessConfigIn(BaseModel):
    min_word_duration: float = Field(0.12, ge=0)
    min_inter_word_gap: float = Field(0.05, ge=0)
    whisper_quality_threshold: float = Field(0.35, ge=0, le=1)
    per_word_singing_duration: float = Field(0.4, ge=0)


class PipelineConfigIn(BaseModel):
    vad: VadConfigIn = Field(default_factory=VadConfigIn)
    matching: MatchConfigIn = Field(default_factory=MatchConfigIn)
    postprocess: PostProcessConfigIn = Field(default_factory=PostProcessConfigIn)


ReferenceMode = Literal["auto", "paste", "lrclib", "active", "none"]


class TranscribeRequest(BaseModel):
    whisper_model: str = DEFAULT_MODEL
    use_vad: bool = True
    language: Optional[str] = None
    plain_lyrics: Optional[str] = None      # used when reference_mode == "paste"
    synced_lyrics: Optional[str] = None     # used when reference_mode == "paste"
    # Default flipped auto→none 2026-07-27: anchored alignment is opt-in.
    # heart-vad-none is the shipped arm, chosen on evaluation across a
    # ten-song set.
    reference_mode: ReferenceMode = "none"
    pipeline_config: Optional[PipelineConfigIn] = None
    activate: bool = True
    # The two LLM stages the upload form offers. Both were ingest-only, so
    # every way of redoing a song's lyrics silently dropped them. Both
    # default off: they reach the operator's own configured endpoint, and a
    # re-sync that quietly started calling one would be a surprise.
    #
    # Correction runs inside the aligner, so it is honoured on BOTH routes,
    # but only the PLAIN-TEXT alignment path holds a corrector. A synced (LRC)
    # reference dispatches to the LRC-anchored aligner, which has none, and an
    # unanchored run never reaches an aligner at all — in both, asking for
    # correction is accepted and does nothing.
    llm_correction: bool = False
    llm_paging: bool = False


class PageRequest(BaseModel):
    activate: bool = True


class TranscribeResponse(BaseModel):
    job_id: str
    song_id: int
    message: str


class CacheStatusOut(BaseModel):
    exists: bool
    path: Optional[str] = None
    label: str
    # The preserved deterministic first pass, present once a forced
    # re-transcribe has overwritten this entry. Reported only — nothing reads
    # it yet. `exists`/`path` keep their existing meaning (the ACTIVE, newest
    # transcription); the frontend's "Re-align only" toggle is wired to them.
    baseline_exists: bool = False
    baseline_path: Optional[str] = None


def _to_pipeline_config(body: Optional[PipelineConfigIn]) -> PipelineConfig:
    """Convert the Pydantic mirror to the frozen lyricsync dataclass."""
    if body is None:
        return PipelineConfig()
    return PipelineConfig(
        vad=VadConfig(**body.vad.model_dump()),
        matching=MatchConfig(**body.matching.model_dump()),
        postprocess=PostProcessConfig(**body.postprocess.model_dump()),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def get_song_or_404(db: AsyncSession, song_id: int, owner_id: int) -> Song:
    song = (await db.execute(
        select(Song).where(Song.id == song_id, Song.owner_id == owner_id)
    )).scalar_one_or_none()
    if song is None:
        raise HTTPException(404, f"Song {song_id} not found")
    return song


async def get_set_or_404(db: AsyncSession, song_id: int, lid: int, owner_id: int) -> LyricsSet:
    ls = (await db.execute(
        select(LyricsSet).where(
            LyricsSet.id == lid,
            LyricsSet.song_id == song_id,
            LyricsSet.owner_id == owner_id,
        )
    )).scalar_one_or_none()
    if ls is None:
        raise HTTPException(404, f"Lyrics set {lid} not found for song {song_id}")
    return ls


def require_ready(song: Song) -> None:
    """Refuse a re-sync job on a song that is not READY.

    Every route below re-runs part of the pipeline over artifacts a finished
    ingest left behind. On a song that is still ``processing`` those artifacts
    are being written right now — a second job would race the ingest for the
    same transcription cache and the same ``songs.job_id``, so the library row
    would report whichever of the two wrote last. On a ``failed`` song they may
    not exist at all, and the honest remedy is ``POST /api/songs/{id}/retry``,
    not a job that fails a minute later because a stem is missing.

    Same status and same wording as the stem/video routes in ``api/songs.py``:
    the 409 NAMES the current status, because "not ready" on its own leaves the
    caller unable to tell "wait" from "this will never work".
    """
    if song.status != SongStatus.READY.value:
        raise HTTPException(
            409,
            f"Song {song.id} is not ready yet (status: {song.status})",
        )


def _to_out(ls: LyricsSet, *, is_active: bool, full: bool = False) -> LyricsSetOut:
    word_sync = None
    if full and ls.word_sync_json:
        try:
            word_sync = json.loads(ls.word_sync_json)
        except Exception:
            word_sync = None
    metadata = None
    if ls.metadata_json:
        try:
            metadata = json.loads(ls.metadata_json)
        except Exception:
            metadata = None

    return LyricsSetOut(
        id=ls.id,
        song_id=ls.song_id,
        source=ls.source,
        label=ls.label,
        is_verified=ls.is_verified,
        is_active=is_active,
        has_word_sync=ls.word_sync_json is not None,
        has_synced_lyrics=ls.synced_lyrics is not None,
        has_plain_lyrics=ls.plain_lyrics is not None,
        plain_lyrics=ls.plain_lyrics if full else None,
        synced_lyrics=ls.synced_lyrics if full else None,
        word_sync=word_sync,
        metadata=metadata,
        created_at=ls.created_at.isoformat() if ls.created_at else "",
        updated_at=ls.updated_at.isoformat() if ls.updated_at else "",
    )


async def _resolve_reference(
    mode: ReferenceMode,
    body: TranscribeRequest,
    song: Song,
    db: AsyncSession,
    owner_id: int,
) -> Tuple[Optional[str], Optional[str]]:
    """Resolve `(plain_lyrics, synced_lyrics)` per the requested mode.

    Raises ``HTTPException`` for an invalid combination so the caller can
    surface a clean 4xx instead of running a doomed background task.
    """
    if mode == "paste":
        if body.plain_lyrics is None and body.synced_lyrics is None:
            raise HTTPException(400, "reference_mode=paste requires plain_lyrics or synced_lyrics")
        return body.plain_lyrics, body.synced_lyrics

    if mode == "none":
        # Since "none" became the default (2026-07-27), a caller that sends
        # lyrics but omits reference_mode would otherwise have them silently
        # discarded — the pre-flip "auto" default used them.
        if body.plain_lyrics or body.synced_lyrics:
            raise HTTPException(
                400,
                "Lyrics were supplied but reference_mode is 'none' (the default) — "
                "use reference_mode='paste' to anchor to them, or omit them.",
            )
        return None, None

    if mode == "active":
        if not song.active_lyrics_id:
            raise HTTPException(404, "No active lyrics set to use as reference")
        active = await get_set_or_404(db, song.id, song.active_lyrics_id, owner_id)
        if active.source == LyricsSource.TRANSCRIPTION.value:
            # Only suggest the lrclib route when it would actually work —
            # recommending a mode that answers 503 is worse than not
            # mentioning it.
            remedies = "Pick a manual/reference set, or paste lyrics"
            if lrclib_enabled():
                remedies = (
                    "Pick a manual/reference/lrclib set, paste lyrics, or use "
                    "reference_mode=lrclib"
                )
            raise HTTPException(
                409,
                "Active set is a transcription — using it as reference would feed "
                f"Whisper's own output back in. {remedies}.",
            )
        return active.plain_lyrics, active.synced_lyrics

    if mode == "lrclib":
        try:
            lyr = await fetch_lyrics(artist=song.artist, title=song.title)
        except LyricsNotFoundError as exc:
            raise HTTPException(404, "No plain lyrics found. Paste lyrics or choose audio-only generation.") from exc
        except LyricsProviderDisabledError as exc:
            # Before LyricsServiceError (its base): asking for a reference the
            # operator has switched off is a configuration answer, not a
            # transient upstream failure the caller should retry.
            raise HTTPException(
                503,
                f"Third-party lyrics lookup ({BUILTIN_LYRICS_LABEL}) is turned "
                f"off on this server.",
            ) from exc
        except LyricsServiceError as exc:
            raise HTTPException(502, f"lrclib request failed: {exc}") from exc
        plain = (lyr.plain_lyrics or "").strip() or None
        if plain is None:
            raise HTTPException(
                404, "No plain lyrics found. Paste lyrics or choose audio-only generation.",
            )
        return plain, None

    # auto: explicit body → active(non-transcription) → lrclib → none.
    # With the lookup off, the lrclib step raises LyricsProviderDisabledError,
    # which the existing handler below absorbs — "auto" degrades to
    # whisper-only exactly as it does when lrclib has no match.
    plain = body.plain_lyrics
    synced = body.synced_lyrics

    if plain is None and synced is None and song.active_lyrics_id:
        active = await get_set_or_404(db, song.id, song.active_lyrics_id, owner_id)
        if active.source != LyricsSource.TRANSCRIPTION.value:
            plain = active.plain_lyrics
            synced = active.synced_lyrics

    if plain is None and synced is None:
        try:
            lyr = await fetch_lyrics(artist=song.artist, title=song.title)
            plain = (lyr.plain_lyrics or "").strip() or None
            # Fetched timestamps must never choose the LRC alignment path.
            synced = None
        except LyricsProviderDisabledError:
            # Distinct from "no match": the operator switched the lookup off,
            # and a log line claiming lrclib had nothing would send them
            # hunting for a data problem that does not exist.
            logger.info(
                "auto reference: lyrics lookup is off — falling back to whisper-only"
            )
        except (LyricsNotFoundError, LyricsServiceError) as exc:
            logger.info("auto reference: no lrclib match (%s) — falling back to whisper-only", exc)

    return plain, synced


def _vocals_path_for(song: Song) -> Path:
    stems_dir = stem_storage.active_stems_dir(song, STEMS_DIR)
    for name in ("lead_vocals.flac", "lead_vocals.wav", "vocals.wav", "Vocals.wav"):
        candidate = stems_dir / name
        if candidate.exists():
            return candidate
    return stems_dir / "lead_vocals.wav"  # fallback that won't exist — caller surfaces error


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[LyricsSetOut])
async def list_sets(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> list[LyricsSetOut]:
    song = await get_song_or_404(db, song_id, user.id)
    rows = (await db.execute(
        select(LyricsSet).where(LyricsSet.song_id == song_id).order_by(LyricsSet.created_at)
    )).scalars().all()
    return [_to_out(ls, is_active=(ls.id == song.active_lyrics_id), full=False) for ls in rows]


@router.get("/cache", response_model=CacheStatusOut)
async def get_cache_status(
    song_id: int,
    model: str = DEFAULT_MODEL,
    use_vad: bool = True,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> CacheStatusOut:
    """Whether a cached transcription exists for the given model/VAD combo.

    Used by the UI to enable the "Re-align only" toggle in the Re-sync panel.
    """
    await get_song_or_404(db, song_id, user.id)
    if model not in ALL_MODELS:
        raise HTTPException(400, f"Invalid model. Must be one of: {sorted(ALL_MODELS)}")
    label = describe_run(model, use_vad=use_vad)
    path = transcription_cache.cache_path(song_id, label)
    baseline = transcription_cache.baseline_path(song_id, label)
    return CacheStatusOut(
        exists=path.exists(),
        path=str(path) if path.exists() else None,
        label=label,
        baseline_exists=baseline.exists(),
        baseline_path=str(baseline) if baseline.exists() else None,
    )



@router.get("/{lid:int}", response_model=LyricsSetOut)
async def get_set(
    song_id: int,
    lid: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> LyricsSetOut:
    song = await get_song_or_404(db, song_id, user.id)
    ls = await get_set_or_404(db, song_id, lid, user.id)
    return _to_out(ls, is_active=(ls.id == song.active_lyrics_id), full=True)


# ---------------------------------------------------------------------------
# Create / Update / Delete
# ---------------------------------------------------------------------------


@router.post("", response_model=LyricsSetOut, status_code=201)
async def create_set(
    song_id: int,
    body: LyricsSetCreate,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> LyricsSetOut:
    song = await get_song_or_404(db, song_id, user.id)
    if body.source not in VALID_SOURCES:
        raise HTTPException(400, f"Invalid source. Must be one of: {sorted(VALID_SOURCES)}")

    ls = LyricsSet(
        song_id=song.id,
        owner_id=user.id,
        source=body.source,
        label=body.label,
        is_verified=False,
        plain_lyrics=body.plain_lyrics,
        synced_lyrics=body.synced_lyrics,
        word_sync_json=json.dumps(body.word_sync_json) if body.word_sync_json else None,
        metadata_json=json.dumps(body.metadata_json) if body.metadata_json else None,
    )
    db.add(ls)
    await db.flush()

    if body.activate:
        await db.execute(update(Song).where(Song.id == song.id).values(active_lyrics_id=ls.id))

    await db.commit()
    await db.refresh(ls)
    is_active = body.activate or song.active_lyrics_id == ls.id
    return _to_out(ls, is_active=is_active, full=True)


@router.patch("/{lid:int}", response_model=LyricsSetOut)
async def update_set(
    song_id: int,
    lid: int,
    body: LyricsSetUpdate,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> LyricsSetOut:
    song = await get_song_or_404(db, song_id, user.id)
    ls = await get_set_or_404(db, song_id, lid, user.id)

    if body.label is not None:
        ls.label = body.label
    if body.plain_lyrics is not None:
        ls.plain_lyrics = body.plain_lyrics
    if body.synced_lyrics is not None:
        ls.synced_lyrics = body.synced_lyrics
    if body.word_sync_json is not None:
        ls.word_sync_json = json.dumps(body.word_sync_json)
    if body.metadata_json is not None:
        ls.metadata_json = json.dumps(body.metadata_json)
    if body.is_verified is True:
        # Enforce single verified set per song
        await db.execute(
            update(LyricsSet)
            .where(LyricsSet.song_id == song_id, LyricsSet.id != lid)
            .values(is_verified=False)
        )
        ls.is_verified = True
    elif body.is_verified is False:
        ls.is_verified = False

    await db.commit()
    await db.refresh(ls)
    return _to_out(ls, is_active=(ls.id == song.active_lyrics_id), full=True)


@router.post("/{lid:int}/activate", response_model=LyricsSetOut)
async def activate_set(
    song_id: int,
    lid: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> LyricsSetOut:
    song = await get_song_or_404(db, song_id, user.id)
    ls = await get_set_or_404(db, song_id, lid, user.id)
    await db.execute(update(Song).where(Song.id == song_id).values(active_lyrics_id=ls.id))
    await db.commit()
    return _to_out(ls, is_active=True, full=True)


@router.post("/{lid:int}/verify", response_model=LyricsSetOut)
async def verify_set(
    song_id: int,
    lid: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> LyricsSetOut:
    song = await get_song_or_404(db, song_id, user.id)
    ls = await get_set_or_404(db, song_id, lid, user.id)
    # Clear the flag on any siblings, then set on this one.
    await db.execute(
        update(LyricsSet)
        .where(LyricsSet.song_id == song_id, LyricsSet.id != lid)
        .values(is_verified=False)
    )
    ls.is_verified = True
    await db.commit()
    await db.refresh(ls)
    return _to_out(ls, is_active=(ls.id == song.active_lyrics_id), full=True)


@router.post("/{lid:int}/copy", response_model=LyricsSetOut, status_code=201)
async def copy_set(
    song_id: int,
    lid: int,
    body: Optional[LyricsSetCopy] = None,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> LyricsSetOut:
    """Duplicate a lyrics set (all payloads). The copy keeps the original's
    source (content provenance is unchanged) but never the verified flag —
    two identical ground truths would be a lie the moment one is edited.
    Metadata records ``copied_from_set`` so provenance survives edits."""
    body = body or LyricsSetCopy()
    song = await get_song_or_404(db, song_id, user.id)
    src = await get_set_or_404(db, song_id, lid, user.id)

    metadata = {}
    if src.metadata_json:
        try:
            metadata = json.loads(src.metadata_json)
        except Exception:
            metadata = {}
    metadata["copied_from_set"] = src.id

    ls = LyricsSet(
        song_id=song.id,
        owner_id=user.id,
        source=src.source,
        label=body.label or f"copy of {src.label or src.source}",
        is_verified=False,
        plain_lyrics=src.plain_lyrics,
        synced_lyrics=src.synced_lyrics,
        word_sync_json=src.word_sync_json,
        metadata_json=json.dumps(metadata),
    )
    db.add(ls)
    await db.flush()

    if body.activate:
        await db.execute(update(Song).where(Song.id == song_id).values(active_lyrics_id=ls.id))

    await db.commit()
    await db.refresh(ls)
    return _to_out(ls, is_active=body.activate, full=True)


@router.delete("/{lid:int}")
async def delete_set(
    song_id: int,
    lid: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> dict[str, str]:
    song = await get_song_or_404(db, song_id, user.id)
    ls = await get_set_or_404(db, song_id, lid, user.id)
    if song.active_lyrics_id == ls.id:
        # Pick an arbitrary remaining set to activate, else None.
        replacement = (await db.execute(
            select(LyricsSet)
            .where(LyricsSet.song_id == song_id, LyricsSet.id != lid)
            .order_by(LyricsSet.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        await db.execute(
            update(Song)
            .where(Song.id == song_id)
            .values(active_lyrics_id=replacement.id if replacement else None)
        )
    await db.delete(ls)
    await db.commit()
    return {"message": f"Lyrics set {lid} deleted"}


# ---------------------------------------------------------------------------
# Re-transcribe: kicks off a fresh transcription run as a new set
# ---------------------------------------------------------------------------


@router.post("/transcribe", response_model=TranscribeResponse, status_code=202)
async def transcribe(
    song_id: int,
    body: TranscribeRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> TranscribeResponse:
    """Queue a fresh transcription run; result lands as a new LyricsSet.

    The reference is resolved HERE, not in the handler: `_resolve_reference`
    is the source of every 400/404/409/502/503 this route can answer, and a
    caller deserves those synchronously rather than as a job that fails a
    minute later. What goes in the payload is the resolved result.
    """
    if body.whisper_model not in ALL_MODELS:
        raise HTTPException(400, f"Invalid model. Must be one of: {sorted(ALL_MODELS)}")

    song = await get_song_or_404(db, song_id, user.id)
    require_ready(song)
    vocals_path = _vocals_path_for(song)
    if not vocals_path.exists():
        raise HTTPException(409, f"No vocals stem found for song {song_id}")

    plain_lyrics, synced_lyrics = await _resolve_reference(
        body.reference_mode, body, song, db, user.id,
    )

    job_id = str(uuid.uuid4())
    queue.enqueue(
        db,
        kind=JobKind.RETRANSCRIBE.value,
        job_id=job_id,
        song_id=song_id,
        owner_id=user.id,
        message=f"Re-transcribing with {body.whisper_model}",
        payload={
            "artist": song.artist,
            "title": song.title,
            "vocals_path": str(vocals_path),
            "plain_lyrics": plain_lyrics,
            "synced_lyrics": synced_lyrics,
            "whisper_model": body.whisper_model,
            "use_vad": body.use_vad,
            "language": body.language,
            "reference_mode": body.reference_mode,
            "pipeline_config": (
                body.pipeline_config.model_dump() if body.pipeline_config else None
            ),
            "activate": body.activate,
            "llm_correction": body.llm_correction,
            "llm_paging": body.llm_paging,
        },
    )
    # Point the library row at the job that is actually live. Left stale, the
    # song list keeps showing whatever the LAST job did — including a `done`
    # from an ingest that finished days ago — while this one runs.
    await db.execute(update(Song).where(Song.id == song_id).values(job_id=job_id))
    await db.commit()

    return TranscribeResponse(
        job_id=job_id,
        song_id=song_id,
        message=f"Re-transcription queued with {body.whisper_model}",
    )


@router.post("/realign", response_model=TranscribeResponse, status_code=202)
async def realign(
    song_id: int,
    body: TranscribeRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> TranscribeResponse:
    """Realign cached transcription against new reference; new LyricsSet.

    The cache check stays in the route for the same reason the reference
    resolution does: "there is nothing to realign" is a 409 the caller can act
    on, not a job worth queueing.
    """
    if body.whisper_model not in ALL_MODELS:
        raise HTTPException(400, f"Invalid model. Must be one of: {sorted(ALL_MODELS)}")

    song = await get_song_or_404(db, song_id, user.id)
    require_ready(song)

    label = describe_run(body.whisper_model, use_vad=body.use_vad)
    cache_file = transcription_cache.cache_path(song_id, label)
    if not cache_file.exists():
        raise HTTPException(
            409,
            f"No cached transcription for song {song_id} ({label}). "
            f"Run /transcribe first.",
        )

    plain_lyrics, synced_lyrics = await _resolve_reference(
        body.reference_mode, body, song, db, user.id,
    )

    vocals_path = _vocals_path_for(song)

    job_id = str(uuid.uuid4())
    queue.enqueue(
        db,
        kind=JobKind.REALIGN.value,
        job_id=job_id,
        song_id=song_id,
        owner_id=user.id,
        message=(
            f"Re-aligning {label} (unanchored)"
            if body.reference_mode == "none"
            else f"Re-aligning {label} against {body.reference_mode} reference"
        ),
        payload={
            "artist": song.artist,
            "title": song.title,
            "vocals_path": str(vocals_path) if vocals_path.exists() else None,
            "plain_lyrics": plain_lyrics,
            "synced_lyrics": synced_lyrics,
            "whisper_model": body.whisper_model,
            "use_vad": body.use_vad,
            # Forwarded even though a realign never transcribes — the cached
            # transcription it aligns was decoded in whatever language the run
            # that produced it chose, and `realign_only` takes no `language`
            # argument. It rides along so the two re-sync routes take the SAME
            # request body to the SAME payload keys: a caller that sets
            # `language` and gets it silently dropped on one of the two has no
            # way to tell which. Recorded on the job row, so a payload is also
            # readable as "what was asked for".
            "language": body.language,
            "reference_mode": body.reference_mode,
            "pipeline_config": (
                body.pipeline_config.model_dump() if body.pipeline_config else None
            ),
            "activate": body.activate,
            "llm_correction": body.llm_correction,
            "llm_paging": body.llm_paging,
        },
    )
    await db.execute(update(Song).where(Song.id == song_id).values(job_id=job_id))
    await db.commit()

    return TranscribeResponse(
        job_id=job_id,
        song_id=song_id,
        message=f"Re-alignment queued ({label})",
    )


@router.post("/{lid:int}/page", response_model=TranscribeResponse, status_code=202)
async def page_set(
    song_id: int,
    lid: int,
    body: Optional[PageRequest] = None,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> TranscribeResponse:
    """Queue LLM page structuring for an existing set; result is a new set.

    The cheap half of a re-sync. Paging groups already-timed words into
    display pages, so it needs neither the GPU nor the aligner — but before
    this route existed, the only way to reach it was a fresh ingest, which meant re-running
    both.

    The synchronous refusals are the ones the caller can act on: a song that
    is not ready has nothing settled to page (409), a set with no word timings
    has nothing to group (409), and an unconfigured LLM endpoint is an operator
    setting rather than a job that will fail a minute from now (503).
    """
    body = body or PageRequest()
    song = await get_song_or_404(db, song_id, user.id)
    require_ready(song)
    ls = await get_set_or_404(db, song_id, lid, user.id)

    if not ls.word_sync_json:
        raise HTTPException(
            409,
            f"Lyrics set {lid} has no word timings to page — run a "
            f"transcription first.",
        )

    # The same variable `make_correction_config` warns on, checked here rather
    # than there: paging with no endpoint configured is a 503 the operator can
    # fix, not a job that queues and quietly declines.
    if not os.environ.get("KARAOKE_LLM_BASE_URL", "").strip():
        raise HTTPException(
            503,
            "No LLM endpoint is configured on this server "
            "(KARAOKE_LLM_BASE_URL is unset).",
        )

    job_id = str(uuid.uuid4())
    queue.enqueue(
        db,
        kind=JobKind.PAGE.value,
        job_id=job_id,
        song_id=song_id,
        owner_id=user.id,
        message=f"Structuring pages for set {lid}",
        payload={"lyrics_set_id": lid, "activate": body.activate},
    )
    # Same reason /transcribe does it: left stale, the library row keeps
    # reporting whatever the previous job finished doing while this one runs.
    await db.execute(update(Song).where(Song.id == song_id).values(job_id=job_id))
    await db.commit()

    return TranscribeResponse(
        job_id=job_id,
        song_id=song_id,
        message=f"LLM paging queued for lyrics set {lid}",
    )
