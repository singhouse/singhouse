# SPDX-License-Identifier: AGPL-3.0-only
"""Add the transactional active stem-generation pointer.

Revision ID: c0008
Revises: c0007
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "c0008"
down_revision: Union[str, None] = "c0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    existing = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("songs")}
    if "active_stem_generation" not in existing:
        op.add_column("songs", sa.Column("active_stem_generation", sa.String(64), nullable=True))

def downgrade() -> None:
    op.drop_column("songs", "active_stem_generation")
