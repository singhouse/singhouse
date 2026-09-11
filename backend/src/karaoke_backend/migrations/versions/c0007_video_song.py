# SPDX-License-Identifier: AGPL-3.0-only
"""songs.video_filename — the retained karaoke video a song plays from

A song may now be created by importing a karaoke video the operator already
has. The video is KEPT: it becomes the song's display content, and its audio
track is extracted into the ordinary ``instrumental`` stem so the existing
mixer and key-shift path drives playback unchanged. This column records the
basename of that retained file inside the song's stems directory (``video.mp4``
and friends) — a basename, never a path, so the streaming route can join it
under the stems directory after a traversal check.

NULL for every song that predates this and for every separated song, which is
why it is nullable with no default: "no video" is the overwhelmingly common
case and needs no backfill.

**Post-baseline on purpose**, like every other net-new core change. Deployed
databases are stamped at c0001 and never execute the earlier revisions, so a
column added anywhere but its own revision would silently never reach them.
Fresh installs run c0001..c0007 and land in the same place.

The column below is exactly what ``models/song.py`` declares; the drift gate
(``test_fresh_upgrade_matches_metadata``, compare_type on) fails if the two
ever diverge.

Reflection-guarded like its neighbours: a database that somehow already has
the column (booted on this branch before the revision existed) adopts cleanly
instead of dying here on every boot. ``add_column`` is a plain ALTER on
SQLite — no table rebuild — so the FK reflection hazard that forbids batch
operations on pre-existing tables does not arise.

Revision ID: c0007
Revises: c0006
Create Date: 2026-08-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c0007'
down_revision: Union[str, None] = 'c0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {column['name'] for column in inspector.get_columns('songs')}

    if 'video_filename' not in existing:
        op.add_column(
            'songs',
            sa.Column('video_filename', sa.String(length=512), nullable=True),
        )


def downgrade() -> None:
    """A development affordance only — the live path never moves backwards."""
    op.drop_column('songs', 'video_filename')
