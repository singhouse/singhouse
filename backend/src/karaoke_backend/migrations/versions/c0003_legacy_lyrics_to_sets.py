# SPDX-License-Identifier: AGPL-3.0-only
"""port legacy per-song lyrics columns into lyrics_sets (one-shot, idempotent)

This is the re-homed ``_migrate_legacy_lyrics`` sweep that used to run on EVERY
boot (since removed from ``database.py``). Same ``WHERE ... NOT EXISTS``
guard, same LRC-vs-plain detection, same ``{"migrated": true}`` marker — it
just runs once, here, instead of scanning the library at every startup.

Two deliberate differences from the boot version:

* ``owner_id`` is NOT written. On an adopted premium DB the unmapped column
  simply stays NULL and premium's own p0002 backfill sweeps it; on a core DB
  the value would be meaningless. This keeps the core chain free of any
  premium-tenancy semantics.
* it is a data revision only — no DDL, so it cannot alter a deployed schema.

Provably a no-op on existing databases (the upgrade check gates on the same
SELECT returning zero rows) and on every fresh install.

Revision ID: c0003
Revises: c0002
Create Date: 2026-07-26

"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c0003'
down_revision: Union[str, None] = 'c0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")

# Songs still holding legacy lyric data that never made it into lyrics_sets.
_LEGACY_SONGS = sa.text(
    """
    SELECT s.id, s.word_sync_json, s.custom_lyrics, s.active_lyrics_id
    FROM songs s
    WHERE (s.word_sync_json IS NOT NULL OR s.custom_lyrics IS NOT NULL)
      AND NOT EXISTS (
          SELECT 1 FROM lyrics_sets ls WHERE ls.song_id = s.id
      )
    """
)

_INSERT_WORD_SYNC = sa.text(
    """
    INSERT INTO lyrics_sets
        (song_id, source, label, is_verified, word_sync_json, metadata_json)
    VALUES (:song_id, 'transcription', 'legacy import', 0, :wsj, :meta)
    """
)

_INSERT_CUSTOM = sa.text(
    """
    INSERT INTO lyrics_sets
        (song_id, source, label, is_verified, plain_lyrics, synced_lyrics, metadata_json)
    VALUES (:song_id, 'manual', 'legacy custom', 0, :plain, :synced, :meta)
    """
)

_SET_ACTIVE = sa.text("UPDATE songs SET active_lyrics_id = :lid WHERE id = :sid")


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(_LEGACY_SONGS).fetchall()
    if not rows:
        logger.info("c0003: no legacy per-song lyrics to port")
        return

    migrated = 0
    for song_id, word_sync_json, custom_lyrics, active_lyrics_id in rows:
        new_active_id = None

        if word_sync_json:
            res = conn.execute(
                _INSERT_WORD_SYNC,
                {"song_id": song_id, "wsj": word_sync_json, "meta": '{"migrated": true}'},
            )
            new_active_id = res.lastrowid

        if custom_lyrics:
            # Same heuristic the boot sweep used: a timestamp tag near the head
            # means LRC, anything else is plain text.
            is_lrc = "[" in custom_lyrics and ":" in custom_lyrics[:32]
            conn.execute(
                _INSERT_CUSTOM,
                {
                    "song_id": song_id,
                    "plain": None if is_lrc else custom_lyrics,
                    "synced": custom_lyrics if is_lrc else None,
                    "meta": '{"migrated": true}',
                },
            )

        # Only adopt the ported set as active when the song had no active set —
        # never overwrite an operator's existing choice.
        if new_active_id and not active_lyrics_id:
            conn.execute(_SET_ACTIVE, {"lid": new_active_id, "sid": song_id})

        migrated += 1

    logger.info("c0003: ported legacy lyrics for %d song(s) into lyrics_sets", migrated)


def downgrade() -> None:
    """No automatic un-port.

    The ported rows are indistinguishable from hand-created ones once an
    operator has edited them, and the legacy columns they came from are left
    intact by ``upgrade`` — so rolling back the code is safe without touching
    data. Deleting rows here would risk destroying real edits.
    """
    pass
