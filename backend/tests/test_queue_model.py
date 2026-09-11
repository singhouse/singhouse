# SPDX-License-Identifier: AGPL-3.0-only
"""Smoke coverage for the QueueEntry model (BasicManualQueue).

The router + store + UI are covered elsewhere; this only proves the model round-trips and
that deleting a Song cascades away its queue rows (ON DELETE CASCADE + the
engine's FK pragma), so a deleted song can never strand queue entries.
"""

import pytest
from sqlalchemy import select

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.models.queue import QueueEntry
from karaoke_backend.models.song import Song


@pytest.mark.asyncio
async def test_queue_entry_roundtrip_and_cascade_delete_on_song_removal():
    async with AsyncSessionLocal() as db:
        song = Song(artist="A", title="T", filename="f.mp3", status="ready")
        db.add(song)
        await db.flush()
        song_id = song.id
        db.add(QueueEntry(song_id=song_id, singer_name="Alice", position=0))
        db.add(QueueEntry(song_id=song_id, singer_name=None, position=1))  # nullable singer
        await db.commit()

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(QueueEntry)
                .where(QueueEntry.song_id == song_id)
                .order_by(QueueEntry.position, QueueEntry.id)
            )
        ).scalars().all()
        assert [r.position for r in rows] == [0, 1]
        assert rows[0].singer_name == "Alice"
        assert rows[1].singer_name is None
        assert rows[0].created_at is not None  # server_default populated

    # deleting the parent Song must cascade its queue rows away
    async with AsyncSessionLocal() as db:
        song = await db.get(Song, song_id)
        await db.delete(song)
        await db.commit()

    async with AsyncSessionLocal() as db:
        remaining = (
            await db.execute(select(QueueEntry).where(QueueEntry.song_id == song_id))
        ).scalars().all()
        assert remaining == []
