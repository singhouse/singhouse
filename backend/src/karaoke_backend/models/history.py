# SPDX-License-Identifier: AGPL-3.0-only
"""The core flat play history: one row per ▶ Sing, and nothing more.

Core keeps a *flat* record of what was sung — a single list, newest-first, with
no venue/show/room concept and no per-account ownership. The richer, grouped
history (venue-scoped show reports, analytics, multi-room) lives entirely in the
premium package and does not touch this table. There is ZERO license/tier logic
here: this is the plain core half of the history split.

What counts as a play:

* a play is recorded ONLY at the queue's ▶ Sing action — the dequeue moment.
  Loading a song straight from the library is NOT a play and writes no row;
* each Sing is its own row — the same song sung three times is three rows, never
  a counter bump.

Schema decisions:

* ``song_id`` references ``songs.id`` with ``ON DELETE SET NULL`` — deleting or
  re-importing a song must never strand a history row and must never cascade the
  history away with it; the FK just goes null;
* ``title``/``artist``/``singer_name`` are SNAPSHOTS taken at Sing time, mirrored
  off the ``Song`` and the queue entry. They are the whole point of the table
  surviving a song deletion/re-import: the row still reads correctly with a null
  ``song_id`` because the display text lives on the row itself. ``singer_name``
  is ``String(80)`` to match the queue's ``singer_name`` free text;
* ``played_at`` is the sort key (indexed, newest-first) and defaults server-side
  to ``func.now()`` — the same default the queue's ``created_at`` uses, which
  SQLite stores and reads back as naive UTC;
* ``completed`` starts false at Sing time and is flipped true later by the
  player's ``ended`` event through the ``/complete`` endpoint — the backend only
  provides the endpoint; the frontend wires the event.

Retention is a PLAIN operator setting (default 30 days, ``0`` = keep forever),
not a paywall and not license state — expired rows are pruned by that setting,
see ``models/settings.py`` and the history router's purge helper.

Deliberately absent: ``owner_id``, and any venue/show/room column — those are
premium concerns. No join is ever required to render a row.
"""

from datetime import datetime
from typing import Optional

import sqlalchemy as sa
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, func

from karaoke_backend.models.song import Base


class PlayHistory(Base):
    """One ▶ Sing, snapshotted so it outlives the song it points at."""

    __tablename__ = "play_history"

    # No index=True on the PK: on SQLite an INTEGER PRIMARY KEY is the rowid, so
    # a separate ix_ index would be redundant. song_id and played_at are indexed
    # (the columns this table is filtered and ordered by).
    id: int = Column(Integer, primary_key=True)
    song_id: Optional[int] = Column(
        Integer,
        ForeignKey("songs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    title: str = Column(String(255), nullable=False)          # snapshot of Song.title
    artist: str = Column(String(255), nullable=False)         # snapshot of Song.artist
    singer_name: Optional[str] = Column(String(80), nullable=True)  # snapshot of QueueEntry.singer_name
    played_at: datetime = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )
    # False at play-start; the player's `ended` event flips it via /complete.
    completed: bool = Column(Boolean, nullable=False, server_default=sa.text("0"))

    def __repr__(self) -> str:
        return (
            f"<PlayHistory id={self.id} song_id={self.song_id} "
            f"title={self.title!r} singer_name={self.singer_name!r} "
            f"completed={self.completed}>"
        )
