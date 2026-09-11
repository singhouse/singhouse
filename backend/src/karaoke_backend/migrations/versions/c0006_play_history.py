# SPDX-License-Identifier: AGPL-3.0-only
"""play_history + app_settings — the core flat play history tables

**Post-baseline on purpose**, like every net-new core table. Deployed DBs are
stamped at c0001 and never execute the earlier revisions, so anything net-new
has to be its own revision or those installs would silently never get the table.
Fresh installs run c0001..c0006 and land in the same place.

The DDL below is exactly what ``models/history.py`` and ``models/settings.py``
declare; the drift gate (``test_fresh_upgrade_matches_metadata``, compare_type
on) fails if the two ever diverge.

``play_history`` keeps one row per ▶ Sing, snapshotting title/artist/singer so a
row outlives the song it points at — ``song_id`` is ``ON DELETE SET NULL`` so a
song removal nulls the FK rather than stranding or cascading the row.
``app_settings`` is the plain core operator key/value store; its first tenant is
history retention (default 30 days, 0 = keep forever), a hygiene setting that
prunes old rows — never a paywall.

Each create is reflection-guarded so a database that somehow already has one of
these tables (e.g. booted on this branch before the boot create_all was removed)
adopts cleanly instead of dying here on every boot.

Revision ID: c0006
Revises: c0005
Create Date: 2026-08-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c0006'
down_revision: Union[str, None] = 'c0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = set(inspector.get_table_names())

    if 'play_history' not in existing:
        op.create_table('play_history',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('song_id', sa.Integer(), nullable=True),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('artist', sa.String(length=255), nullable=False),
        sa.Column('singer_name', sa.String(length=80), nullable=True),
        sa.Column('played_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('completed', sa.Boolean(), server_default=sa.text('0'), nullable=False),
        sa.ForeignKeyConstraint(['song_id'], ['songs.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
        )
        # batch on a table CREATED in this same revision — no live data or
        # DB-side FK clause to lose, so the rebuild-reflection hazard the
        # migration gate guards against does not apply here.
        with op.batch_alter_table('play_history', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_play_history_played_at'), ['played_at'], unique=False)
            batch_op.create_index(batch_op.f('ix_play_history_song_id'), ['song_id'], unique=False)

    if 'app_settings' not in existing:
        op.create_table('app_settings',
        sa.Column('key', sa.String(length=64), nullable=False),
        sa.Column('value', sa.String(length=255), nullable=False),
        sa.PrimaryKeyConstraint('key')
        )


def downgrade() -> None:
    """A development affordance only — the live path never moves backwards."""
    with op.batch_alter_table('play_history', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_play_history_song_id'))
        batch_op.drop_index(batch_op.f('ix_play_history_played_at'))

    op.drop_table('app_settings')
    op.drop_table('play_history')
