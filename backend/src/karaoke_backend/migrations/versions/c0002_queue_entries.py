# SPDX-License-Identifier: AGPL-3.0-only
"""queue_entries — the core BasicManualQueue table

**Post-baseline on purpose.** Deployed DBs are stamped at c0001 and never
execute it, so anything net-new has to be its own revision or those installs —
the live one included — would silently never get the table. Fresh installs run
c0001 then c0002 and land in the same place.

The DDL below is the same table ``models/queue.py`` declares; the drift gate
(``test_fresh_upgrade_matches_metadata``) fails if the two ever diverge.

Revision ID: c0002
Revises: c0001
Create Date: 2026-07-26

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c0002'
down_revision: Union[str, None] = 'c0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Guarded because a database booted on this branch between the addition of
    # the QueueEntry model and the removal of the boot create_all
    # ALREADY has this table. Such a DB adopts cleanly — verification covers
    # only the c0001 tables — and would then die here on every boot, stamped at
    # c0001 with the table present and no way forward but hand-editing
    # alembic_version. Deployed DBs predate the QueueEntry model and are
    # unaffected either way.
    if 'queue_entries' in sa.inspect(op.get_bind()).get_table_names():
        return

    op.create_table('queue_entries',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('song_id', sa.Integer(), nullable=False),
    sa.Column('singer_name', sa.String(length=80), nullable=True),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['song_id'], ['songs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('queue_entries', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_queue_entries_position'), ['position'], unique=False)
        batch_op.create_index(batch_op.f('ix_queue_entries_song_id'), ['song_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('queue_entries', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_queue_entries_song_id'))
        batch_op.drop_index(batch_op.f('ix_queue_entries_position'))

    op.drop_table('queue_entries')
