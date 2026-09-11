# SPDX-License-Identifier: AGPL-3.0-only
"""BasicManualQueue endpoints — the core "sing next" list.

A minimal, host-ordered queue over ``queue_entries``: list, add, remove,
reorder, clear. The richer rotation system (fairness, singer accounts, shows,
multi-room) is premium and mounts INSTEAD of this router in multi-user
assembly — main.py mounts exactly one of the two.

Contract (pinned in models/queue.py):

* ordering is ``ORDER BY position, id`` — ties are legal (no UNIQUE) and
  break by insertion order;
* append lands at ``MAX(position) + 1``;
* reorder renumbers the whole list dense 0..n-1; delete does NOT renumber
  (gaps are harmless under the ordering rule and the append rule);
* dequeue-on-play is just ``DELETE /api/queue/{entry_id}`` — no status or
  history column, playing a song removes its row.

Every route requires the Host (``require_user``): in single-host mode that is
the gate; there is no self-serve guest surface here — the host adds rows and
types the singer's name.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import Identity
from karaoke_backend.database import get_db
from karaoke_backend.models.queue import QueueEntry
from karaoke_backend.models.song import Song

router = APIRouter(prefix="/api/queue", tags=["queue"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class QueueEntryOut(BaseModel):
    id: int
    song_id: int
    singer_name: Optional[str] = None
    position: int
    # Joined from Song so the UI never needs a second fetch per row.
    title: str
    artist: str
    duration: Optional[float] = None
    status: str


class QueueListResponse(BaseModel):
    entries: list[QueueEntryOut]


class QueueAddRequest(BaseModel):
    song_id: int
    singer_name: Optional[str] = Field(None, max_length=80)


class QueueReorderRequest(BaseModel):
    entry_ids: list[int]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_out(entry: QueueEntry, song: Song) -> QueueEntryOut:
    return QueueEntryOut(
        id=entry.id,
        song_id=entry.song_id,
        singer_name=entry.singer_name,
        position=entry.position,
        title=song.title,
        artist=song.artist,
        duration=song.duration,
        status=song.status,
    )


async def _fetch_queue(db: AsyncSession) -> list[tuple[QueueEntry, Song]]:
    rows = await db.execute(
        select(QueueEntry, Song)
        .join(Song, QueueEntry.song_id == Song.id)
        .order_by(QueueEntry.position, QueueEntry.id)
    )
    return [(entry, song) for entry, song in rows.all()]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=QueueListResponse, summary="List the queue in play order")
async def list_queue(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> QueueListResponse:
    return QueueListResponse(
        entries=[_to_out(e, s) for e, s in await _fetch_queue(db)]
    )


@router.post("", response_model=QueueEntryOut, status_code=201, summary="Append a song to the queue")
async def add_to_queue(
    body: QueueAddRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> QueueEntryOut:
    song = await db.get(Song, body.song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="song not found")

    singer = (body.singer_name or "").strip() or None
    max_pos = (await db.execute(select(func.max(QueueEntry.position)))).scalar()
    entry = QueueEntry(
        song_id=song.id,
        singer_name=singer,
        position=(max_pos if max_pos is not None else -1) + 1,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return _to_out(entry, song)


@router.put("/order", response_model=QueueListResponse, summary="Reorder the whole queue")
async def reorder_queue(
    body: QueueReorderRequest,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> QueueListResponse:
    """Set the play order to exactly ``entry_ids`` and renumber dense 0..n-1.

    The ids must be a permutation of the current queue — anything else means
    the client is stale (a row was added or removed since it rendered), and
    the answer is 409 so it refetches rather than silently dropping rows.
    """
    current = {e.id: e for e, _ in await _fetch_queue(db)}
    if sorted(body.entry_ids) != sorted(current.keys()) or len(
        set(body.entry_ids)
    ) != len(body.entry_ids):
        raise HTTPException(
            status_code=409,
            detail="queue changed — refresh and retry",
        )

    for position, entry_id in enumerate(body.entry_ids):
        current[entry_id].position = position
    await db.commit()

    return QueueListResponse(
        entries=[_to_out(e, s) for e, s in await _fetch_queue(db)]
    )


@router.delete("/{entry_id}", summary="Remove one queue entry (dequeue-on-play)")
async def remove_from_queue(
    entry_id: int,
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> dict:
    entry = await db.get(QueueEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="queue entry not found")
    await db.delete(entry)
    await db.commit()
    return {"ok": True}


@router.delete("", summary="Clear the whole queue")
async def clear_queue(
    db: AsyncSession = Depends(get_db),
    user: Identity = Depends(require_user),
) -> dict:
    result = await db.execute(sa_delete(QueueEntry))
    await db.commit()
    return {"ok": True, "cleared": result.rowcount}
