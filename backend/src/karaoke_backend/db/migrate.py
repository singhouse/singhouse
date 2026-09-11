# SPDX-License-Identifier: AGPL-3.0-only
"""Alembic ``Config`` construction for the CORE migration chain.

The config is built **programmatically**, never discovered from ``alembic.ini``
or the current working directory:

* ``script_location`` is resolved from this file's location, so it survives
  the src-layout move and works identically from the CLI, from the app
  lifespan, and from a pip-installed wheel;
* the database URL is passed through ``config.attributes`` rather than
  ``set_main_option``, because alembic runs main-option values through
  ``ConfigParser`` interpolation — a SQLite path containing ``%`` would raise.

``backend/alembic.ini`` exists only so ``alembic revision --autogenerate``
works by hand during development; nothing at runtime reads it.
"""

from pathlib import Path
from typing import Optional

from alembic.config import Config

from karaoke_backend.database import DATABASE_URL

# ``db/`` and ``migrations/`` are siblings inside the package.
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def sync_url(async_url: Optional[str] = None) -> str:
    """Return the synchronous equivalent of the app's async database URL.

    Migrations run synchronously (see ``migrations/env.py`` for why), so the
    ``sqlite+aiosqlite://`` driver prefix is swapped for plain ``sqlite://``.
    Any other backend URL is returned unchanged.
    """
    url = DATABASE_URL if async_url is None else async_url
    return url.replace("sqlite+aiosqlite://", "sqlite://")


def make_config(connection=None, url: Optional[str] = None) -> Config:
    """Build the alembic ``Config`` for the core chain.

    ``connection`` (a *sync* SQLAlchemy Connection) is honoured by ``env.py``
    when present, which lets tests and ``ensure_schema`` drive migrations on a
    connection they already own instead of opening a second engine.
    """
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.attributes["sync_url"] = sync_url(url)
    if connection is not None:
        cfg.attributes["connection"] = connection
    return cfg
