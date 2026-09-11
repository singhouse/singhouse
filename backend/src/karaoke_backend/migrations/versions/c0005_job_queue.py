# SPDX-License-Identifier: AGPL-3.0-only
"""durable job queue columns on `jobs`

**Why this exists.** Background work used to be fire-and-forget: a route handed
a coroutine to Starlette's ``BackgroundTasks`` and the only record that it ever
ran was the ``jobs`` row it happened to update. A restart mid-separation lost
the work and the row both. The durable queue makes the row the unit of work — a worker
claims it under a lease and re-enters it where the on-disk artifacts say it
left off — which needs somewhere to keep the claim.

**Hand-written, and deliberately so.** Autogenerate proposes a
``batch_alter_table`` here because the deployed ``jobs.status`` is
``VARCHAR(20)`` where the model says ``String(32)``. A batch op rebuilds the
table, and SQLite reflection cannot see FK ``ON DELETE`` clauses, so the
rebuild would silently downgrade ``jobs.song_id``'s CASCADE to a bare
reference. ``test_migrations.py`` bans it outright. The type discrepancy is
left exactly as it is: it is harmless (SQLite does not enforce VARCHAR length)
and closing it is not worth a rebuild.

Additive and idempotent: new columns and one index, each guarded by
reflection, on a table that already exists. No rebuild, no ALTER of an
existing object, no data touched.

Legacy-row normalization is NOT here. Rows carrying a pre-queue phase string
in ``status`` are failed at boot by ``jobs.queue.sweep_legacy`` — a migration
that decided the fate of live rows would run before the operator could see
what it was about to do, and would have to be re-run by hand if a restart
raced it.

Revision ID: c0005
Revises: c0004
Create Date: 2026-07-30

"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c0005'
down_revision: Union[str, None] = 'c0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")

# (name, type, extra kwargs) — must match the ORM model exactly, or the
# drift gate (test_fresh_upgrade_matches_metadata, compare_type=True) fails.
_COLUMNS = (
    ("kind", sa.String(32), {"nullable": True}),
    ("payload", sa.Text(), {"nullable": True}),
    ("attempts", sa.Integer(), {"nullable": False, "server_default": "0"}),
    ("claimed_by", sa.String(64), {"nullable": True}),
    ("lease_expires_at", sa.DateTime(timezone=True), {"nullable": True}),
    ("phase", sa.String(32), {"nullable": True}),
    ("started_at", sa.DateTime(timezone=True), {"nullable": True}),
    ("finished_at", sa.DateTime(timezone=True), {"nullable": True}),
)

_INDEX_NAME = "ix_jobs_status_lease"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "jobs" not in set(inspector.get_table_names()):
        logger.info("c0005: no jobs table — nothing to do")
        return

    existing = {c["name"] for c in inspector.get_columns("jobs")}
    added = []
    for name, type_, kwargs in _COLUMNS:
        if name in existing:
            continue
        op.add_column("jobs", sa.Column(name, type_, **kwargs))
        added.append(name)

    if _INDEX_NAME not in {ix["name"] for ix in inspector.get_indexes("jobs")}:
        op.create_index(
            _INDEX_NAME, "jobs", ["status", "lease_expires_at"], unique=False
        )
        added.append(_INDEX_NAME)

    if added:
        logger.info("c0005: added %s", ", ".join(added))
    else:
        logger.info("c0005: job queue columns already present")


def downgrade() -> None:
    """A development affordance only — the live path never moves backwards."""
    op.drop_index(_INDEX_NAME, table_name="jobs")
    for name, _type, _kwargs in reversed(_COLUMNS):
        op.drop_column("jobs", name)
