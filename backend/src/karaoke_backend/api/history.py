# SPDX-License-Identifier: AGPL-3.0-only
"""Core flat play-history endpoints — the "what got sung" list.

A minimal, host-scoped, FLAT history over ``play_history``: record a play, mark
it completed, list/search/paginate it, prune it, and read/write the one retention
setting. There is no venue/show/room grouping and no analytics here — that is the
premium half of the history split. This router carries ZERO license/tier logic.

Contract (pinned in models/history.py + models/settings.py):

* a row is recorded ONLY at the queue's ▶ Sing action — the caller POSTs here at
  the dequeue moment; loading a song from the library records nothing;
* each Sing is its own row (repeat sings → multiple rows);
* title/artist/singer are SNAPSHOTTED onto the row so it survives the song being
  removed or re-imported — ``song_id`` then goes null (ON DELETE SET NULL) while
  the display text stays intact;
* ``completed`` starts false and is flipped by ``POST /{id}/complete`` when the
  player fires its ``ended`` event (idempotent);
* retention is a PLAIN operator setting (``history_retention_days``, default 30,
  ``0`` = keep forever), not a paywall — expired rows are pruned by it whenever
  the history is read or a play is recorded.

Every route requires the Host (``require_user``): in single-host core that is the
gate; there is no self-serve guest surface here.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.database import get_db
from karaoke_backend.models.history import PlayHistory
from karaoke_backend.models.settings import (
    DEFAULT_RETENTION_DAYS,
    HISTORY_RETENTION_KEY,
    MAX_RETENTION_DAYS,
    AppSetting,
)
from karaoke_backend.models.song import Song

router = APIRouter(prefix="/api/history", tags=["history"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PlayHistoryOut(BaseModel):
    id: int
    song_id: Optional[int] = None
    title: str
    artist: str
    singer_name: Optional[str] = None
    played_at: datetime
    completed: bool


class HistoryListResponse(BaseModel):
    entries: list[PlayHistoryOut]
    total: int


class RecordPlayRequest(BaseModel):
    song_id: int
    singer_name: Optional[str] = Field(None, max_length=80)


class RetentionSettings(BaseModel):
    retention_days: int


class RetentionUpdate(BaseModel):
    # 0 = keep forever; upper bound keeps the purge's timedelta from overflowing.
    retention_days: int = Field(ge=0, le=MAX_RETENTION_DAYS)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_out(row: PlayHistory) -> PlayHistoryOut:
    return PlayHistoryOut(
        id=row.id,
        song_id=row.song_id,
        title=row.title,
        artist=row.artist,
        singer_name=row.singer_name,
        played_at=row.played_at,
        completed=row.completed,
    )


async def _purge_expired(db: AsyncSession, retention_days: int) -> None:
    """Prune rows older than the retention window (a plain hygiene setting).

    ``0`` means keep forever, so there is nothing to prune. The cutoff is
    computed as NAIVE UTC to match how SQLite stores and reads back
    ``func.now()``/``CURRENT_TIMESTAMP`` (the queue's ``created_at`` uses the
    same server_default and comes back naive) — comparing a naive column to a
    tz-aware datetime would raise.
    """
    if retention_days <= 0:
        return  # 0 = keep forever
    # Clamp defensively: PUT /settings validates the ceiling, but a value read
    # back from a hand-edited DB must never reach timedelta() large enough to
    # overflow and 500 every list/record call that runs this purge.
    days = min(retention_days, MAX_RETENTION_DAYS)
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    await db.execute(sa_delete(PlayHistory).where(PlayHistory.played_at < cutoff))
    await db.commit()


async def _get_retention_days(db: AsyncSession) -> int:
    """Read the retention setting, falling back to the default.

    Missing row or an unparseable value both mean "operator hasn't set a valid
    override" — return ``DEFAULT_RETENTION_DAYS`` rather than surface an error.
    """
    row = await db.get(AppSetting, HISTORY_RETENTION_KEY)
    if row is None:
        return DEFAULT_RETENTION_DAYS
    try:
        return int(row.value)
    except (TypeError, ValueError):
        return DEFAULT_RETENTION_DAYS


async def _set_retention_days(db: AsyncSession, days: int) -> None:
    """Upsert the retention setting (get-or-create), storing the value as text."""
    row = await db.get(AppSetting, HISTORY_RETENTION_KEY)
    if row is None:
        db.add(AppSetting(key=HISTORY_RETENTION_KEY, value=str(days)))
    else:
        row.value = str(days)
    await db.commit()


# ---------------------------------------------------------------------------
# Routes — /settings declared with a fixed path and /{history_id} typed as int
# so a settings request can never be routed as a history-id lookup.
# ---------------------------------------------------------------------------


@router.get("/settings", response_model=RetentionSettings, summary="Read the retention setting")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> RetentionSettings:
    return RetentionSettings(retention_days=await _get_retention_days(db))


@router.put("/settings", response_model=RetentionSettings, summary="Update the retention setting")
async def put_settings(
    body: RetentionUpdate,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> RetentionSettings:
    await _set_retention_days(db, body.retention_days)
    return RetentionSettings(retention_days=await _get_retention_days(db))


@router.post("", response_model=PlayHistoryOut, status_code=201, summary="Record a play (▶ Sing)")
async def record_play(
    body: RecordPlayRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> PlayHistoryOut:
    song = await db.get(Song, body.song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="song not found")

    singer = (body.singer_name or "").strip() or None
    row = PlayHistory(
        song_id=song.id,
        title=song.title,
        artist=song.artist,
        singer_name=singer,
        completed=False,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    # Prune AFTER the insert commit so a just-written row can never be caught by
    # its own purge (a retention window of days makes that impossible in
    # practice, but ordering it this way keeps the invariant unconditional).
    await _purge_expired(db, await _get_retention_days(db))
    return _to_out(row)


@router.post("/{history_id}/complete", summary="Mark a play completed (player `ended`)")
async def complete_play(
    history_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> dict:
    row = await db.get(PlayHistory, history_id)
    if row is None:
        raise HTTPException(status_code=404, detail="history entry not found")
    # Idempotent: a second `ended` (or a manual re-hit) is a no-op.
    if not row.completed:
        row.completed = True
        await db.commit()
    return {"ok": True}


@router.get("", response_model=HistoryListResponse, summary="List play history, newest first")
async def list_history(
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> HistoryListResponse:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)

    # Prune first so a read never returns rows the retention window has expired.
    await _purge_expired(db, await _get_retention_days(db))

    base = select(PlayHistory)
    if search:
        term = f"%{search.strip()}%"
        base = base.where(
            or_(
                PlayHistory.title.ilike(term),
                PlayHistory.artist.ilike(term),
                PlayHistory.singer_name.ilike(term),
            )
        )

    total = (
        await db.execute(select(func.count()).select_from(base.subquery()))
    ).scalar_one()

    rows = (
        await db.execute(
            base.order_by(PlayHistory.played_at.desc(), PlayHistory.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()

    return HistoryListResponse(entries=[_to_out(r) for r in rows], total=total)


@router.delete("/{history_id}", summary="Remove one history entry")
async def delete_history(
    history_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> dict:
    row = await db.get(PlayHistory, history_id)
    if row is None:
        raise HTTPException(status_code=404, detail="history entry not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.delete("", summary="Clear the whole play history")
async def clear_history(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> dict:
    result = await db.execute(sa_delete(PlayHistory))
    await db.commit()
    return {"ok": True, "cleared": result.rowcount}
