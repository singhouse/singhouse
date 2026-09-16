# SPDX-License-Identifier: AGPL-3.0-only
"""Where the Plex connection settings live, and what may be read back out.

Two values, stored in two different places on purpose:

* the **URL** is ordinary operator configuration and lives in ``app_settings``
  under :data:`PLEX_URL_KEY`, like every other core knob;
* the **token** is a bearer credential for the operator's whole media library.
  It is written to a 0600 file next to the sqlite database (the session
  secret's neighbour, by the same rule — ``database.secret_dir``) and NEVER to
  the database, because ``karaoke.db`` gets copied around: backups, support
  bundles, "here's my DB, why is this song broken". A credential that rides
  along in those is a credential the operator did not knowingly share.

The token is also never returned by any route and never logged. The only fact
the API exposes about it is whether one is set at all.

**Environment override.** ``KARAOKE_PLEX_URL`` / ``KARAOKE_PLEX_TOKEN`` follow
the house precedence (``SESSION_SECRET``, ``KARAOKE_LRCLIB``): env wins over
stored state, and when either is set the settings become READ-ONLY — a PUT is
refused rather than accepted-and-ignored, so a container whose compose file
owns the configuration cannot silently disagree with its own UI.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.database import secret_dir
from karaoke_backend.models.settings import (
    DEFAULT_PLEX_URL,
    PLEX_URL_KEY,
    AppSetting,
)

logger = logging.getLogger(__name__)

#: Env override for the server URL. Set → the settings are read-only.
PLEX_URL_ENV = "KARAOKE_PLEX_URL"
#: Env override for the token. Set → the settings are read-only.
PLEX_TOKEN_ENV = "KARAOKE_PLEX_TOKEN"
#: Where the token file lives, if not next to the database.
PLEX_TOKEN_FILE_ENV = "PLEX_TOKEN_FILE"
#: Rewrites a Plex-side path prefix to a locally visible one (see below).
PLEX_PATH_MAP_ENV = "KARAOKE_PLEX_PATH_MAP"
#: Opt-in switch for reading lyrics out of Plex. Unset (shipped) is OFF.
PLEX_LYRICS_ENV = "KARAOKE_PLEX_LYRICS"

#: Default token filename, in :func:`karaoke_backend.database.secret_dir`.
TOKEN_FILENAME = ".plex_token"

_ON_VALUES = frozenset({"1", "true", "yes", "on"})


class PlexConfigError(ValueError):
    """An operator-supplied setting this module refuses to store."""


# ---------------------------------------------------------------------------
# Lyrics opt-in
# ---------------------------------------------------------------------------


def plex_lyrics_enabled() -> bool:
    """Whether the operator has opted in to reading lyrics out of Plex.

    Read at call time, not import time — the ``lrclib_enabled`` convention, so
    a systemd drop-in edit and a test both take effect without a reimport.

    Only the values in :data:`_ON_VALUES` grant. A typo, ``"maybe"``, ``"y"``:
    all OFF. The failure that matters is a stock install quietly ingesting
    third-party lyric text as ground truth, and a misconfigured variable must
    never be the thing that authorizes it.

    **Why this is gated at all, when the audio file next to it is not.** A
    track's audio is the operator's own file, sitting on the operator's own
    server. A track's lyrics on a Plex server may not be: Plex can populate
    them from a licensed metadata supplier, and whether the resulting text may
    be copied into a second application depends on its provenance and terms,
    which this module cannot determine from a JSON field. So the audio path is
    unconditional and the lyric path is opt-in; the operator who turns it on
    is the person who knows where their lyrics came from.
    """
    return os.getenv(PLEX_LYRICS_ENV, "").strip().lower() in _ON_VALUES


# ---------------------------------------------------------------------------
# URL
# ---------------------------------------------------------------------------


def normalize_url(raw: Optional[str]) -> str:
    """Canonicalize an operator-typed server URL, or raise.

    Empty in, empty out — clearing the setting is legal and means "no server".
    Otherwise: an http(s) scheme and a host are required, and the trailing
    slash comes off so every caller can join paths with a plain ``+`` and get
    one slash rather than two.

    The scheme is required rather than guessed. Defaulting a bare ``plex.lan``
    to http would silently downgrade an operator who meant https, and this
    connection carries their library token.
    """
    text = (raw or "").strip()
    if not text:
        return ""
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https"):
        raise PlexConfigError(
            "The server URL must start with http:// or https:// "
            "(for example http://plex.lan:32400)."
        )
    if not parts.netloc:
        raise PlexConfigError("The server URL is missing a host name.")
    return text.rstrip("/")


def env_url() -> Optional[str]:
    """The URL the environment pins, or None. Invalid values are refused."""
    raw = os.getenv(PLEX_URL_ENV)
    if raw is None or not raw.strip():
        return None
    return normalize_url(raw)


def env_token() -> Optional[str]:
    raw = os.getenv(PLEX_TOKEN_ENV)
    if raw is None or not raw.strip():
        return None
    return raw.strip()


def env_pinned() -> bool:
    """Whether the environment owns this configuration.

    EITHER variable is enough. Half-pinned configuration — a URL from compose,
    a token from the UI — is a state where a PUT would appear to work and then
    be overridden on the next boot for one field but not the other, and there
    is no reading of that which is not a support ticket.
    """
    return env_url() is not None or env_token() is not None


def config_source() -> str:
    """``"env"`` when the environment owns the settings, else ``"settings"``."""
    return "env" if env_pinned() else "settings"


async def get_stored_url(db: AsyncSession) -> str:
    row = await db.get(AppSetting, PLEX_URL_KEY)
    if row is None or row.value is None:
        return DEFAULT_PLEX_URL
    return row.value


async def set_stored_url(db: AsyncSession, url: str) -> None:
    """Upsert the URL setting (get-or-create), storing the value as text."""
    row = await db.get(AppSetting, PLEX_URL_KEY)
    if row is None:
        db.add(AppSetting(key=PLEX_URL_KEY, value=url))
    else:
        row.value = url
    await db.commit()


async def effective_url(db: AsyncSession) -> str:
    """The URL this install will actually connect to. Env wins."""
    pinned = env_url()
    if pinned is not None:
        return pinned
    return await get_stored_url(db)


# ---------------------------------------------------------------------------
# Token file
# ---------------------------------------------------------------------------


def token_path() -> Path:
    """Where the token file lives — ``PLEX_TOKEN_FILE``, else beside the DB."""
    override = os.getenv(PLEX_TOKEN_FILE_ENV)
    if override and override.strip():
        return Path(override.strip())
    return secret_dir() / TOKEN_FILENAME


def read_stored_token() -> str:
    """The token from the file, or ``""``. Never raises, never logs the value."""
    try:
        return token_path().read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def write_stored_token(token: str) -> None:
    """Write the token at mode 0600, replacing whatever was there.

    Created via ``os.open`` with the mode in the call so a NEW file is never
    world-readable for the instant between ``open`` and a follow-up ``chmod``.
    An EXISTING file keeps the mode it already had — ``O_CREAT``'s mode
    argument is ignored then — so the chmod afterwards is not redundant: it is
    the half that tightens a file a previous, laxer version (or an operator's
    editor) left readable.
    """
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        path.chmod(0o600)
    except OSError:  # pragma: no cover - platform-dependent
        logger.warning("Could not tighten permissions on the Plex token file")


def clear_stored_token() -> None:
    """Remove the token file. An empty token PUT means "forget my token"."""
    try:
        token_path().unlink(missing_ok=True)
    except OSError as exc:  # pragma: no cover - unwritable dir
        logger.warning("Could not remove the Plex token file: %s", exc)


def effective_token() -> str:
    """The token this install will actually present. Env wins."""
    pinned = env_token()
    if pinned is not None:
        return pinned
    return read_stored_token()


def token_is_set() -> bool:
    return bool(effective_token())


# ---------------------------------------------------------------------------
# Upload naming
# ---------------------------------------------------------------------------


def upload_basename(payload: dict) -> str:
    """The basename a track's audio is stored under in the uploads directory.

    Preference order is the library file's own name, then the server-relative
    part key's, then the title plus container. Only the ``{job_id}_`` prefix
    identifies the file to the rest of the system; the rest of the name is so
    an operator looking in the uploads directory can tell what they are
    looking at.

    Both callers pass a dict, but they pass DIFFERENT dicts, and the
    difference matters: the job passes what the SERVER reported, and composes
    ``{job_id}_{this}`` for a file it is about to write. The route passes only
    title and container — it has not asked the server anything yet, and the
    result is a display label on ``Song.filename``, never a path.
    """
    # Lazy, and it has to be: api.separate is a route module that pulls in the
    # app's import graph, and this module is imported from inside it.
    from karaoke_backend.api.separate import safe_upload_name

    for candidate in (payload.get("file_path"), payload.get("part_key")):
        if candidate:
            name = safe_upload_name(str(candidate), "")
            if name:
                return name

    title = (payload.get("title") or "track").strip() or "track"
    container = (payload.get("container") or "mp3").strip().lstrip(".") or "mp3"
    return safe_upload_name(f"{title}.{container}", "track.mp3")


# ---------------------------------------------------------------------------
# Library path mapping
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PathRewrite:
    plex_prefix: str
    local_prefix: str


def _parse_path_map(raw: str) -> list[PathRewrite]:
    rules: list[PathRewrite] = []
    for clause in raw.split(";"):
        clause = clause.strip()
        if not clause:
            continue
        plex_prefix, sep, local_prefix = clause.partition("=>")
        if not sep:
            logger.warning(
                "%s entry %r is not 'plex-prefix=>local-prefix' — ignoring it",
                PLEX_PATH_MAP_ENV, clause,
            )
            continue
        plex_prefix = plex_prefix.strip()
        local_prefix = local_prefix.strip()
        if not plex_prefix or not local_prefix:
            logger.warning(
                "%s entry %r has an empty side — ignoring it",
                PLEX_PATH_MAP_ENV, clause,
            )
            continue
        rules.append(PathRewrite(plex_prefix, local_prefix))
    return rules


def map_library_path(file_path: Optional[str]) -> Optional[str]:
    """Rewrite a Plex-reported path into one THIS machine can open.

    Plex reports the path as its own process sees it. When this install runs
    on the same box, or mounts the same storage, that path is already correct
    and no mapping is needed — which is why the variable is unset by default.
    When the two disagree (a container's ``/media`` is the host's
    ``/srv/music``), ``KARAOKE_PLEX_PATH_MAP="/media=>/srv/music"`` states the
    correspondence; several rules may be separated by ``;`` and the first
    matching prefix wins.

    Getting this wrong is not dangerous, only slower: a path that does not
    resolve to a readable file simply falls back to streaming the track from
    the server, which always works.
    """
    if not file_path:
        return None
    raw = os.getenv(PLEX_PATH_MAP_ENV, "").strip()
    if not raw:
        return file_path
    for rule in _parse_path_map(raw):
        if file_path.startswith(rule.plex_prefix):
            return rule.local_prefix + file_path[len(rule.plex_prefix):]
    return file_path
