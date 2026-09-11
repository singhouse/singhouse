# SPDX-License-Identifier: AGPL-3.0-only
"""
Lyrics fetcher -- wraps lrclib.net (free, no API key needed).

lrclib.net API docs: https://lrclib.net/docs

**lrclib is opt-in and OFF by default.** A stock install never contacts
lrclib.net; the operator turns it on with ``KARAOKE_LRCLIB=1``. Every path
that could reach the service funnels through :func:`fetch_lyrics`, which
raises :class:`LyricsProviderDisabledError` while the toggle is off, so "off"
means the provider is unavailable rather than merely un-preferred.
"""

import logging
import os
import urllib.parse
from dataclasses import dataclass
from typing import Optional, List

import httpx

from karaoke_backend import branding, plugins

logger = logging.getLogger(__name__)

LRCLIB_BASE = "https://lrclib.net/api"
USER_AGENT = branding.USER_AGENT
TIMEOUT = 10  # seconds

# Additive plugin hook: the hardcoded built-in lyrics provider name. ``lrclib``
# is the built-in; only a NON-built-in name is dispatched to a plugin. This is
# a provider-selection key, NOT the source label ("lrclib.net").
BUILTIN_LYRICS_PROVIDER = "lrclib"

#: Display label for the built-in provider, shown wherever its lyrics surface.
BUILTIN_LYRICS_LABEL = "lrclib.net"

#: Opt-in switch for the built-in provider. Unset (the shipped default) is OFF.
LRCLIB_ENV = "KARAOKE_LRCLIB"

_ON_VALUES = frozenset({"1", "true", "yes", "on"})


def lrclib_enabled() -> bool:
    """Whether the operator has opted in to the built-in lrclib provider.

    Read at call time, not import time, so tests and a systemd drop-in edit
    both take effect without a reimport (matching ``KARAOKE_MODAL`` and the
    rest of this codebase's env toggles).

    Only the values in :data:`_ON_VALUES` grant. Everything else — unset, a
    typo, ``"maybe"`` — is OFF, because the failure that matters is a stock
    install silently querying a third-party lyrics database, and a
    misconfigured variable must never be the thing that authorizes it.

    This governs the **built-in** provider only. A lyrics plugin arrives by
    being deliberately installed, which is its own opt-in.
    """
    return os.getenv(LRCLIB_ENV, "").strip().lower() in _ON_VALUES


@dataclass
class LyricsResult:
    artist: str
    title: str
    album: Optional[str]
    duration: Optional[float]          # seconds
    plain_lyrics: Optional[str]        # raw text, newline-separated
    synced_lyrics: Optional[str]       # LRC format if available
    source: str = "lrclib.net"

    @property
    def lines(self) -> List[str]:
        """Plain lyrics split into non-empty lines."""
        if not self.plain_lyrics:
            return []
        return [line.strip() for line in self.plain_lyrics.splitlines() if line.strip()]

    @property
    def has_sync(self) -> bool:
        return bool(self.synced_lyrics)


class LyricsNotFoundError(Exception):
    """Raised when no lyrics are found for the given artist/title."""


class LyricsServiceError(Exception):
    """Raised when the lrclib.net API returns an unexpected error."""


class LyricsProviderDisabledError(LyricsServiceError):
    """Raised when the built-in provider is asked for lyrics while opted out.

    Deliberately a *subclass* of :class:`LyricsServiceError`: every existing
    caller already treats a service error as "carry on without reference
    lyrics", so opting out degrades along the paths that were built to absorb
    an lrclib outage instead of needing a new branch at each one. Callers that
    want to say something more specific than "the service failed" — the
    explicit lookup route, the explicit ``reference_mode=lrclib`` — catch this
    first.
    """


async def _async_get(url: str) -> dict | list:
    """Make an async GET request and return parsed JSON, or raise on error."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        try:
            resp = await client.get(url, headers={"User-Agent": USER_AGENT})
            if resp.status_code == 404:
                raise LyricsNotFoundError(f"404 from lrclib for {url}")
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            raise LyricsServiceError(f"HTTP {exc.response.status_code} from lrclib: {url}") from exc
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            raise LyricsServiceError(f"Network error reaching lrclib: {exc}") from exc


def _parse_response(data: dict, fallback_artist: str, fallback_title: str) -> LyricsResult:
    """Convert a lrclib API response dict into a LyricsResult."""
    return LyricsResult(
        artist=data.get("artistName") or fallback_artist,
        title=data.get("trackName") or fallback_title,
        album=data.get("albumName"),
        duration=data.get("duration"),
        plain_lyrics=data.get("plainLyrics") or None,
        synced_lyrics=data.get("syncedLyrics") or None,
    )


async def fetch_lyrics(artist: str, title: str) -> LyricsResult:
    """
    Fetch lyrics for a given artist + title from lrclib.net.

    Strategy:
      1. Try the /get endpoint for an exact match.
      2. If that misses or returns no lyrics, fall back to /search.

    Raises:
        LyricsProviderDisabledError: if the operator has not opted in.
        LyricsNotFoundError: if nothing is found.
        LyricsServiceError: if the upstream API misbehaves.
    """
    # The single choke point. Every route to lrclib.net — ingest, the explicit
    # lookup endpoint, both editor reference modes, the player's fallback —
    # lands here, so the opt-in cannot be bypassed by adding a caller.
    if not lrclib_enabled():
        raise LyricsProviderDisabledError(
            f"The built-in {BUILTIN_LYRICS_LABEL} lyrics provider is off. "
            f"Set {LRCLIB_ENV}=1 to enable third-party lyrics lookup."
        )

    # --- 1. Exact match ---
    exact_url = (
        f"{LRCLIB_BASE}/get"
        f"?artist_name={urllib.parse.quote(artist)}"
        f"&track_name={urllib.parse.quote(title)}"
    )
    logger.debug("Fetching lyrics (exact): %s", exact_url)

    try:
        data = await _async_get(exact_url)
        if isinstance(data, dict) and (data.get("plainLyrics") or data.get("syncedLyrics")):
            logger.info("Found lyrics via exact match: %s - %s", artist, title)
            return _parse_response(data, artist, title)
    except LyricsNotFoundError:
        pass  # fall through to search
    except LyricsServiceError:
        logger.warning("Exact match request failed, trying search fallback")

    # --- 2. Search fallback ---
    search_url = (
        f"{LRCLIB_BASE}/search"
        f"?q={urllib.parse.quote(f'{artist} {title}')}"
    )
    logger.debug("Fetching lyrics (search): %s", search_url)

    results = await _async_get(search_url)

    if not isinstance(results, list) or not results:
        raise LyricsNotFoundError(f"No lyrics found for: {artist!r} - {title!r}")

    # Pick the best result: prefer entries with synced lyrics, then plain
    def score(item: dict) -> int:
        s = 0
        if item.get("syncedLyrics"):
            s += 2
        if item.get("plainLyrics"):
            s += 1
        return s

    best = max(results, key=score)

    if not best.get("plainLyrics") and not best.get("syncedLyrics"):
        raise LyricsNotFoundError(f"Results found but all empty for: {artist!r} - {title!r}")

    logger.info("Found lyrics via search: %s - %s", artist, title)
    return _parse_response(best, artist, title)


def _plugin_lyrics_provider(name: str):
    """Return the installed lyrics plugin whose name matches ``name``, else
    ``None``. Consulted ONLY for non-built-in names."""
    for ep_name, provider in plugins.instantiate_group(plugins.GROUP_LYRICS_PROVIDERS):
        if name in (getattr(provider, "name", None), ep_name):
            return provider
    return None


async def fetch_lyrics_by_provider(
    provider_name: Optional[str], artist: str, title: str
) -> LyricsResult:
    """Name-keyed lyrics fetch (additive plugin hook).

    ``lrclib`` is the hardcoded built-in: an empty / ``None`` name, or the
    literal ``"lrclib"``, calls :func:`fetch_lyrics`, which enforces the
    opt-in and raises ``LyricsProviderDisabledError`` while it is off. Any
    other name is dispatched to an installed, enabled lyrics plugin, raising
    ``LyricsServiceError`` when no such provider is available.

    A plugin is NOT governed by ``KARAOKE_LRCLIB``: installing a lyrics
    provider package is itself the deliberate act the opt-in exists to
    require, and the flag names one specific third-party service.
    """
    if not provider_name or provider_name == BUILTIN_LYRICS_PROVIDER:
        return await fetch_lyrics(artist, title)
    provider = _plugin_lyrics_provider(provider_name)
    if provider is None:
        raise LyricsServiceError(
            f"No lyrics provider named {provider_name!r} is installed"
        )
    if not provider.is_enabled():
        raise LyricsServiceError(
            f"Lyrics provider {provider_name!r} is not enabled"
        )
    return await provider.fetch(artist, title)
