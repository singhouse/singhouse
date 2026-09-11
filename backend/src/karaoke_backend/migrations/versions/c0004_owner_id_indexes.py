# SPDX-License-Identifier: AGPL-3.0-only
"""create the owner_id indexes on adopted databases

**Why this exists.** Adoption STAMPS c0001 rather than running it, so anything
c0001 would have created that a deployed database happens to lack is never
created at all. The three ``owner_id`` indexes are exactly that case: the live
database was built by ``create_all`` before those indexes existed, and
``create_all`` no-ops on a table that already exists, so it never added them.

Fresh installs get them from c0001; adopted installs would silently never have
them, and the drift gate cannot see it because it only ever runs against a
fresh database. Premium tenant isolation filters every list query on
``owner_id``, so this is the divergence most worth closing.

Additive and idempotent: ``CREATE INDEX`` only, guarded by reflection, on
tables that already exist. No rebuild, no ALTER of an existing object, no data
touched — the upgrade safety proof gains three CREATE INDEX statements and
nothing else.

An addition beyond the original c0001–c0003 chain, adopted for the rationale
above.

Revision ID: c0004
Revises: c0003
Create Date: 2026-07-26

"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c0004'
down_revision: Union[str, None] = 'c0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")

# (index name, table, column) — must match what c0001 declares.
_INDEXES = (
    ("ix_songs_owner_id", "songs", "owner_id"),
    ("ix_jobs_owner_id", "jobs", "owner_id"),
    ("ix_lyrics_sets_owner_id", "lyrics_sets", "owner_id"),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    created = []
    for name, table, column in _INDEXES:
        if table not in tables:
            continue
        columns = {c["name"] for c in inspector.get_columns(table)}
        if column not in columns:
            # No owner_id here at all (a core-only DB that predates it, or a
            # future shape). Nothing to index; leave it alone.
            continue
        if name in {ix["name"] for ix in inspector.get_indexes(table)}:
            continue
        op.create_index(name, table, [column], unique=False)
        created.append(name)

    if created:
        logger.info("c0004: created %s", ", ".join(created))
    else:
        logger.info("c0004: owner_id indexes already present")


def downgrade() -> None:
    """Deliberately empty — dropping an index a fresh install also has would
    make downgrade destructive for no benefit."""
    pass
