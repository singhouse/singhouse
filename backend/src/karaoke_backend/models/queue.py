# SPDX-License-Identifier: AGPL-3.0-only
"""The core BasicManualQueue: a minimal, manually-ordered list of songs from
*your own library* to sing next — nothing more. The richer rotation work
(fairness, persistence, shows lifecycle, multi-room) lives entirely in the
premium package and does not touch this table.

Schema decisions:

* references ``songs.id`` only — there are no free-text song entries (the queue
  points at your library, never an arbitrary title);
* ``ON DELETE CASCADE`` so deleting a song can never strand queue rows;
* ``singer_name`` is the whole "who's up" affordance — nullable free text, no
  singer/identity machinery; ``String(80)`` matches the premium rotation
  ``Singer.name`` for a clean future upgrade mapping;
* ``position`` carries the manual order (dense 0..n-1; the router renumbers the
  whole list on reorder, append = MAX+1; ORDER BY position, id);
* dequeue-on-play = DELETE the row — no status/played/history column (song
  history is a premium concern).

Deliberately absent: ``owner_id`` (added later via an additive migration only
if multi-room ever needs to scope the queue), ``client_id``, ``updated_at``,
and any ``UNIQUE(position)`` (which would fight SQLite mid-reorder). No
denormalised title/artist — join ``songs``.

The table name ``queue_entries`` deliberately sits outside the legacy
rotation/wishlist table names, so a rollback to an older build (whose boot code
dropped ``rotation_entries``/``wishlist_songs``) can never drop it.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func

from karaoke_backend.models.song import Base


class QueueEntry(Base):
    """One song queued to sing next, in a host-ordered list."""

    __tablename__ = "queue_entries"

    # No index=True on the PK: on SQLite an INTEGER PRIMARY KEY is the rowid, so
    # a separate ix_ index would be redundant. Only song_id + position are
    # indexed (the columns this table is actually queried/ordered by).
    id: int = Column(Integer, primary_key=True)
    song_id: int = Column(
        Integer,
        ForeignKey("songs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    singer_name: Optional[str] = Column(String(80), nullable=True)
    position: int = Column(Integer, nullable=False, index=True)
    created_at: datetime = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<QueueEntry id={self.id} song_id={self.song_id} "
            f"position={self.position} singer_name={self.singer_name!r}>"
        )
