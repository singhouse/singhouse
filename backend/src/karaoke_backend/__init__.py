# SPDX-License-Identifier: AGPL-3.0-only
"""Backend package (src layout).

Loading ``.env`` happens HERE, at package import, and the placement is
load-bearing rather than stylistic.

``karaoke_backend.database`` reads ``DATABASE_URL`` at module scope
(``DATABASE_URL = os.getenv(...)`` followed immediately by
``create_async_engine``), so anything that populates the environment has to run
before that module is imported. Putting the load in ``main.py`` would cover the
API server and nothing else: ``kb-db`` (via ``karaoke_backend.db.bootstrap`` and
``.migrate``) and the Alembic migration env both reach ``database`` transitively
without ever passing through ``main``, and would have silently kept using the
default SQLite path while the server used the configured one. A package
``__init__`` is the only place every one of those entry points passes through
first.

``override=False`` is equally deliberate. The real process environment always
wins over the file, so a deployment configured through systemd
(``EnvironmentFile=`` / ``Environment=``) cannot be quietly overridden by a
stray ``.env`` left in the working directory. ``.env`` fills gaps; it never
takes anything over.

The path is anchored to the current working directory rather than discovered by
walking upwards. python-dotenv's default search climbs parent directories until
it finds a match, which on a developer machine can silently pick up an
unrelated ``.env`` from above the checkout. An explicit path can only ever read
the file the docs tell you to create. cwd is the right anchor because it is
already the anchor for everything else configurable here -- the default database
path, ``UPLOADS_DIR`` and ``STEMS_DIR`` are all cwd-relative, and both the
systemd unit and the documented dev command run from ``backend/``.

Three states are tracked, not two, because "found" and "applied" are genuinely
different and conflating them produces a log line that states the opposite of
the truth. ``load_dotenv`` returns False for a file that exists but yields no
variables -- an empty one, or one whose every line is commented out, which is
exactly the state an operator debugging their configuration tends to be in.
Reporting that as "no .env here" would answer "why is my .env ignored?" with a
falsehood, which is worse than the silence this whole mechanism replaced.
"""

from pathlib import Path

from dotenv import load_dotenv

__version__ = "0.1.0"

#: Absolute path of the ``.env`` consulted at import (whether or not it exists).
DOTENV_PATH = Path.cwd() / ".env"

#: True if a file is present at that path, regardless of what it contained.
DOTENV_FOUND = DOTENV_PATH.is_file()

try:
    #: True only if the file was present AND set at least one variable.
    DOTENV_LOADED = load_dotenv(DOTENV_PATH, override=False)
except (OSError, UnicodeDecodeError) as exc:
    # Fail loudly, but not with a bare traceback out of an import statement.
    #
    # Failing is right: silently continuing past an unreadable config file is
    # the exact class of bug this module exists to remove. But because the load
    # lives in the package __init__ -- the property that makes it work at all --
    # one bad file takes down the server, `kb-db`, the Alembic env and the test
    # suite together. `kb-db` is the tool an operator would reach for to
    # recover, so the message has to name the file and the fix rather than
    # leaving them to decode a PermissionError raised from `import`.
    raise RuntimeError(
        f"Could not read the environment file at {DOTENV_PATH}: {exc}. "
        "Fix its permissions or encoding (it must be readable UTF-8 text), "
        "or remove it to fall back to the process environment alone."
    ) from exc
