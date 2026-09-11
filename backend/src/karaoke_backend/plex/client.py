# SPDX-License-Identifier: AGPL-3.0-only
"""A small, read-only Plex client — libraries, tracks, lyrics, one media file.

Scope, stated narrowly because it is the point: this talks to ONE server, the
operator's own, at an address the operator typed in, and it only ever reads.
It does not search anything, it does not discover servers, it does not touch
plex.tv, and it has no write path at all. What it is for is the operator's own
collection, on their own network.

**One choke point for network I/O.** Every JSON request goes through the
module-level :func:`_get`, and the lyric-text and media-file reads through
:func:`_get_text` and :func:`_stream_to` beside it (a function whose contract
is "returns parsed JSON" cannot also carry a text body or a chunked copy of a
50 MB file). Module level, not methods, so a test patches ONE symbol and knows
nothing reached the network — which is what the lyrics opt-in test asserts.
The shape is the one the lrclib worker uses for its own single entry point.
(Named only in prose, deliberately: the lrclib opt-in guard scans every
tracked module for that entry point's identifier, and this file is not one of
the modules allowed to reach that service.)

**The token travels in a header**, never in a query string: a URL ends up in
access logs, in ``Referer``, and in every exception string this module builds.
Nothing here formats a URL that contains the credential, so an error message
is safe to show the operator verbatim.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import httpx

from karaoke_backend.plex.config import PLEX_LYRICS_ENV, plex_lyrics_enabled

logger = logging.getLogger(__name__)

#: Seconds. A LAN media server answers metadata in milliseconds; anything near
#: this is a server that is down, wedged, or not a Plex server at all.
TIMEOUT = 15

#: Plex's library-section type for a MUSIC library. Movie/show/photo sections
#: are on the same endpoint and are not ours to list.
MUSIC_SECTION_TYPE = "artist"

#: Plex's metadata type number for a track.
TRACK_TYPE = 10

#: Plex's stream type number for lyrics.
LYRIC_STREAM_TYPE = 4

#: Default page size for a track listing.
DEFAULT_PAGE_SIZE = 200

_CHUNK_BYTES = 1024 * 1024  # 1 MiB

#: Hard cap on a text body (a lyric sheet). A lyric is kilobytes; anything
#: near this is not one.
MAX_TEXT_BYTES = 1024 * 1024  # 1 MiB

# An LRC timing tag: [mm:ss.xx], [m:ss], [mm:ss:xx]. Minutes are allowed more
# than two digits because a long track legitimately passes 99 minutes.
_LRC_TIME_TAG = re.compile(r"\[\d{1,4}:\d{2}(?:[.:]\d{1,3})?\]")
# An LRC metadata tag: [ar:...], [ti:...], [offset:...] — a whole-line header,
# never lyric text.
_LRC_META_LINE = re.compile(r"^\[[a-zA-Z#]+:[^\]]*\]$")


class PlexError(Exception):
    """The Plex server could not be reached, or did not answer usefully."""


class PlexAuthError(PlexError):
    """The server rejected the token (401)."""


class PlexLyricsDisabledError(PlexError):
    """Lyrics were requested while the Plex lyrics opt-in is off.

    A *subclass* of :class:`PlexError` deliberately, the way
    ``LyricsProviderDisabledError`` subclasses ``LyricsServiceError``: every
    caller already treats "no lyrics came back" as "carry on without a
    reference", so opting out degrades along the path that was built to absorb
    a lyric fetch failing, rather than needing a new branch at each caller.
    """


# ---------------------------------------------------------------------------
# Parsed shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PlexLibrary:
    key: str
    title: str


@dataclass(frozen=True)
class TrackItem:
    rating_key: str
    title: str
    artist: str
    album: Optional[str]
    duration_ms: Optional[int]
    #: The server-relative path to the media file, e.g. ``/library/parts/12/…``
    part_key: Optional[str]
    #: The path as the SERVER sees it. Useful only when this install can see
    #: the same storage; ``None`` when the server does not report one.
    file_path: Optional[str]
    #: Container/extension as reported ("mp3", "flac", …), lowercased.
    container: Optional[str]
    has_lyrics: bool


@dataclass(frozen=True)
class TrackMedia:
    """What the SERVER says a track's media is — the authoritative answer.

    Distinct from the same three fields on :class:`TrackItem`, which reach the
    browser and come back with whatever the client chose to send. This is what
    the import job acts on.
    """

    rating_key: str
    part_key: Optional[str]
    file_path: Optional[str]
    container: Optional[str]
    title: Optional[str]
    artist: Optional[str]
    has_lyrics: bool


@dataclass(frozen=True)
class TrackPage:
    items: list[TrackItem]
    total: int


# ---------------------------------------------------------------------------
# Network choke points
# ---------------------------------------------------------------------------


def _headers(token: str) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    if token:
        headers["X-Plex-Token"] = token
    return headers


def _wrap_transport_error(exc: Exception, url: str) -> PlexError:
    return PlexError(f"Could not reach the media server at {url}: {exc}")


def _async_client(**kwargs) -> httpx.AsyncClient:
    """Every HTTP client in this module is built here. One place, two reasons.

    **Redirects are never followed.** The token rides in a request header, and
    httpx replays headers onto a redirect target — so a server (or anything
    able to answer as one) that replies ``302 Location: https://elsewhere/``
    would hand the operator's library credential to a host they never named.
    A 3xx is therefore reported as an error rather than chased; see
    :func:`_raise_for_status`.

    **Tests need a seam.** Patching this one symbol swaps in an
    ``httpx.MockTransport`` for the whole module, which is how the streaming
    paths are exercised without a socket.
    """
    kwargs.setdefault("timeout", TIMEOUT)
    # Not setdefault: no caller may opt back in.
    kwargs["follow_redirects"] = False
    return httpx.AsyncClient(**kwargs)


def _raise_for_status(resp: httpx.Response, url: str) -> None:
    if resp.status_code == 401:
        raise PlexAuthError("The media server rejected the token.")
    if 300 <= resp.status_code < 400:
        # Not followed, and not silently accepted either: an unfollowed
        # redirect has an empty body, which would otherwise land as a
        # zero-byte "track" or an empty lyric.
        raise PlexError(
            f"The media server redirected the request (HTTP "
            f"{resp.status_code}). Redirects are not followed, because they "
            f"would carry your token to another address — check the server URL."
        )
    if resp.status_code >= 400:
        raise PlexError(f"The media server answered HTTP {resp.status_code} for {url}")


async def _get(url: str, params: Optional[dict] = None,
               headers: Optional[dict] = None) -> dict:
    """GET ``url`` and return parsed JSON. The one JSON path to the network."""
    async with _async_client() as client:
        try:
            resp = await client.get(url, params=params, headers=headers)
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            raise _wrap_transport_error(exc, url) from exc
        _raise_for_status(resp, url)
        try:
            data = resp.json()
        except ValueError as exc:
            raise PlexError(
                f"The server at {url} did not answer with JSON — check that "
                f"the URL points at a media server."
            ) from exc
    return data if isinstance(data, dict) else {}


async def _get_text(url: str, headers: Optional[dict] = None) -> str:
    """GET ``url`` and return the body as text, capped at :data:`MAX_TEXT_BYTES`.

    Streamed rather than read whole so the cap is an admission control and not
    a post-mortem: the endpoint behind this is meant to serve a lyric sheet,
    and something answering it with a gigabyte must not be able to spend this
    process's memory proving it. A body over the cap is an error rather than a
    truncation — half a lyric silently becomes half a reference.
    """
    body = bytearray()
    async with _async_client() as client:
        try:
            async with client.stream("GET", url, headers=headers) as resp:
                _raise_for_status(resp, url)
                async for chunk in resp.aiter_bytes(_CHUNK_BYTES):
                    body.extend(chunk)
                    if len(body) > MAX_TEXT_BYTES:
                        raise PlexError(
                            f"The lyric the server returned is larger than the "
                            f"{MAX_TEXT_BYTES // 1024} KB limit."
                        )
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            raise _wrap_transport_error(exc, url) from exc
    return body.decode("utf-8", errors="replace")


def _is_audio_content_type(raw: Optional[str]) -> bool:
    """Whether a response's ``Content-Type`` may be written as track audio.

    A missing or empty type passes: plenty of servers omit it on a file range,
    and the upload route takes the same view of a browser that sends nothing.
    What this exists to catch is a type that is positively something ELSE —
    the HTML sign-in page or JSON error a misconfigured server returns with a
    200, which would otherwise be saved as a "track" and fail minutes later
    inside the separator with nothing pointing back to here.
    """
    from karaoke_backend.api.separate import ACCEPTED_AUDIO_TYPES

    value = (raw or "").split(";", 1)[0].strip().lower()
    if not value:
        return True
    return value.startswith("audio/") or value in ACCEPTED_AUDIO_TYPES


async def _stream_to(url: str, dest: Path, *, headers: Optional[dict],
                     max_bytes: int, require_audio: bool = False) -> int:
    """Copy ``url`` to ``dest`` in chunks, refusing to exceed ``max_bytes``.

    ``dest`` is expected to be a caller-owned temp name that still carries the
    job-id prefix the uploads reaper matches on (``queue.unlink_uploads_for``
    tests ``name.startswith(f"{job_id}_")``, so ``{job_id}_x.flac.partial`` is
    reaped like any other leftover). A partial file is removed here on the way
    out regardless — the reaper is the backstop, not the plan.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        async with _async_client() as client:
            async with client.stream("GET", url, headers=headers) as resp:
                _raise_for_status(resp, url)
                if require_audio and not _is_audio_content_type(
                    resp.headers.get("content-type")
                ):
                    raise PlexError(
                        f"The media server did not return audio for that track "
                        f"(it answered with "
                        f"{resp.headers.get('content-type', 'no content type')})."
                    )
                with dest.open("wb") as fh:
                    async for chunk in resp.aiter_bytes(_CHUNK_BYTES):
                        written += len(chunk)
                        if written > max_bytes:
                            raise PlexError(
                                f"That track is larger than the "
                                f"{max_bytes // (1024 * 1024)} MB limit."
                            )
                        fh.write(chunk)
    except (httpx.RequestError, httpx.TimeoutException) as exc:
        _unlink_quietly(dest)
        raise _wrap_transport_error(exc, url) from exc
    except BaseException:
        _unlink_quietly(dest)
        raise
    return written


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def _container(data: dict) -> dict:
    container = data.get("MediaContainer")
    return container if isinstance(container, dict) else {}


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parts(entry: dict) -> list[dict]:
    """Every Part of every Media of one metadata entry."""
    out: list[dict] = []
    for media in _as_list(entry.get("Media")):
        if not isinstance(media, dict):
            continue
        for part in _as_list(media.get("Part")):
            if isinstance(part, dict):
                out.append(part)
    return out


def _lyric_streams(entry: dict) -> list[dict]:
    out: list[dict] = []
    for part in _parts(entry):
        for stream in _as_list(part.get("Stream")):
            if isinstance(stream, dict) and _int_or_none(
                stream.get("streamType")
            ) == LYRIC_STREAM_TYPE:
                out.append(stream)
    return out


def parse_track(entry: dict) -> Optional[TrackItem]:
    """One ``Metadata`` entry → a :class:`TrackItem`, or None if unusable.

    A track with no rating key cannot be addressed later and a track with no
    title has nothing to show in a list; either one is a row this UI cannot
    honestly offer, so it is dropped rather than rendered as a blank.
    """
    rating_key = entry.get("ratingKey")
    if rating_key in (None, ""):
        return None
    title = (entry.get("title") or "").strip()
    if not title:
        return None

    parts = _parts(entry)
    first = parts[0] if parts else {}
    container = first.get("container") or entry.get("container")
    if not container and first.get("file"):
        container = Path(str(first["file"])).suffix.lstrip(".")

    return TrackItem(
        rating_key=str(rating_key),
        title=title,
        artist=(entry.get("grandparentTitle") or "").strip() or "Unknown Artist",
        album=(entry.get("parentTitle") or "").strip() or None,
        duration_ms=_int_or_none(entry.get("duration")),
        part_key=first.get("key") or None,
        file_path=first.get("file") or None,
        container=str(container).lower() if container else None,
        has_lyrics=bool(_lyric_streams(entry)),
    )


def strip_lrc_timestamps(text: str) -> str:
    """Turn LRC into plain lines.

    Plain text is what the aligner wants as a reference — the ticket measured
    plain against synced and plain won — so an LRC sidecar is reduced to its
    words here rather than parsed for its timings. Header tags (``[ar:…]``)
    are whole lines and go entirely; timing tags are stripped in place, since
    one line may carry several when the same words repeat.
    """
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _LRC_META_LINE.match(line):
            continue
        line = _LRC_TIME_TAG.sub("", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _looks_like_lrc(text: str) -> bool:
    return bool(_LRC_TIME_TAG.search(text))


def _pick_lyric_stream(streams: list[dict]) -> Optional[dict]:
    """Prefer a plain-text lyric stream over a timed one.

    ``txt`` first because the reference the aligner wants is words, and a txt
    stream is already exactly that; an lrc stream is the same words wearing
    timings this pipeline will discard anyway. Order within a format is the
    server's.
    """
    def fmt(stream: dict) -> str:
        return str(stream.get("format") or stream.get("codec") or "").lower()

    for wanted in ("txt", "lrc"):
        for stream in streams:
            if fmt(stream) == wanted:
                return stream
    return streams[0] if streams else None


# ---------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------


def _filter_value(raw: Optional[str]) -> Optional[str]:
    """What to actually send for one Plex filter field — None means "omit it".

    Two upstream behaviours, both measured against a live Plex 1.43.3 server,
    make the operator's raw string unsafe to forward as typed:

    * **A blank value is a filter that matches everything.** ``title=`` came
      back with all 62,948 rows. Omitting the parameter and sending it empty
      are not the same request, and only the first one means "no filter".
    * **A comma is an OR separator, and there is no escape for it.**
      ``artist.title=joel,action`` returned 101 rows — the 74 matching "joel"
      plus the 27 matching "action". An operator typing an artist that
      contains a comma ("Emerson, Lake & Palmer") would silently get a much
      wider result than they asked for, with no way to say otherwise.

    So a value containing a comma is reduced to its LONGEST fragment: the most
    selective single term available, and always a SUPERSET of what was asked
    for. Superset is the direction to fail in for a picker — extra rows are on
    screen and ignorable, whereas a row filtered away is invisible and reads
    as "the server does not have it".
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    if "," not in value:
        return value
    fragments = [part.strip() for part in value.split(",")]
    longest = max(fragments, key=len)
    return longest or None


class PlexClient:
    """Read-only access to one media server.

    Cheap to construct and holds no connection: every call opens its own
    short-lived ``httpx.AsyncClient``, matching ``lyrics_worker`` and keeping
    a worker from pinning a socket across a fifteen-minute separation.
    """

    def __init__(self, base_url: str, token: str = "") -> None:
        self.base_url = (base_url or "").rstrip("/")
        self._token = token or ""

    # -- URL building --------------------------------------------------

    def _url(self, path: str) -> str:
        if not self.base_url:
            raise PlexError(
                "No media server URL is configured — set one in the import "
                "dialog first."
            )
        return f"{self.base_url}/{path.lstrip('/')}"

    @property
    def _hdrs(self) -> dict[str, str]:
        return _headers(self._token)

    # -- Reads ---------------------------------------------------------

    async def list_libraries(self) -> list[PlexLibrary]:
        """The server's MUSIC libraries. Other section types are not listed."""
        data = await _get(self._url("/library/sections"), headers=self._hdrs)
        out: list[PlexLibrary] = []
        for entry in _as_list(_container(data).get("Directory")):
            if not isinstance(entry, dict):
                continue
            if entry.get("type") != MUSIC_SECTION_TYPE:
                continue
            key = entry.get("key")
            if key in (None, ""):
                continue
            out.append(
                PlexLibrary(key=str(key), title=(entry.get("title") or "").strip())
            )
        return out

    async def list_tracks(
        self,
        section_key: str,
        *,
        offset: int = 0,
        limit: int = DEFAULT_PAGE_SIZE,
        title: Optional[str] = None,
        artist: Optional[str] = None,
    ) -> TrackPage:
        """One page of tracks from a music library, plus the matching total.

        Paged server-side via Plex's container window rather than fetched whole
        and sliced here: a real music library is tens of thousands of tracks,
        and a request that returns all of them is one that times out on the
        operator's first try.

        **Filtering is server-side too, and has to be.** ``title`` and
        ``artist`` become Plex's own ``title`` and ``artist.title`` filters —
        substring, case-insensitive, AND-combined when both are given, and
        paged normally with a ``totalSize`` that counts the MATCHES rather than
        the library. Filtering the fetched page instead was the bug this
        replaced: against a library of sixty thousand tracks, page one is an
        alphabetical accident and an artist filter over it essentially never
        matched anything.

        Three more properties of the upstream API shape what callers can ask
        for. There is no OR form across FIELDS (so "title or artist" is not
        expressible in one request, and the UI asks for the two fields
        separately). ``/search?query=`` is title-only, so it is not a shortcut
        to the same place. And a blank value is not a no-op: sending
        ``title=`` matches EVERYTHING (measured: 62,948 rows, the whole
        library), so blanks are omitted here rather than passed through — see
        :func:`_filter_value`, which also handles the comma problem. Verified
        against Plex 1.43.3.
        """
        url = self._url(f"/library/sections/{quote(str(section_key), safe='')}/all")
        params: dict[str, object] = {
            "type": TRACK_TYPE,
            "X-Plex-Container-Start": max(0, int(offset)),
            "X-Plex-Container-Size": max(1, int(limit)),
        }
        title_value = _filter_value(title)
        if title_value:
            params["title"] = title_value
        artist_value = _filter_value(artist)
        if artist_value:
            params["artist.title"] = artist_value
        data = await _get(url, params=params, headers=self._hdrs)
        container = _container(data)
        items: list[TrackItem] = []
        for entry in _as_list(container.get("Metadata")):
            if not isinstance(entry, dict):
                continue
            track = parse_track(entry)
            if track is not None:
                items.append(track)
        total = _int_or_none(container.get("totalSize"))
        if total is None:
            total = _int_or_none(container.get("size")) or len(items)
        return TrackPage(items=items, total=total)

    async def _metadata_entry(self, rating_key: str) -> Optional[dict]:
        """The ``Metadata`` entry for one track, or None.

        One helper because two callers need the same document: the lyric fetch
        wants its streams, and :meth:`track_media` wants its part. Keeping it
        in one place is also what keeps the two from drifting into disagreeing
        about which track they are talking about.
        """
        url = self._url(f"/library/metadata/{quote(str(rating_key), safe='')}")
        data = await _get(url, headers=self._hdrs)
        entries = _as_list(_container(data).get("Metadata"))
        if not entries or not isinstance(entries[0], dict):
            return None
        return entries[0]

    async def track_media(self, rating_key: str) -> Optional[TrackMedia]:
        """Ask the SERVER where a track's file is. Authoritative; never a hint.

        The import job resolves through here rather than trusting the path the
        browser posted back, because the browser is not a trustworthy source
        for a filesystem path this process will open. A client that echoes a
        doctored ``file_path`` would otherwise get an arbitrary readable file
        on this machine copied into the library and served as a song.

        The rating key IS trusted, and has to be: it is an opaque id the server
        resolves in its own namespace, so the worst a doctored one can name is
        a different track on the same server the operator configured.
        """
        entry = await self._metadata_entry(rating_key)
        if entry is None:
            return None
        parts = _parts(entry)
        first = parts[0] if parts else {}
        container = first.get("container") or entry.get("container")
        if not container and first.get("file"):
            container = Path(str(first["file"])).suffix.lstrip(".")
        return TrackMedia(
            rating_key=str(rating_key),
            part_key=first.get("key") or None,
            file_path=first.get("file") or None,
            container=str(container).lower() if container else None,
            title=(entry.get("title") or "").strip() or None,
            artist=(entry.get("grandparentTitle") or "").strip() or None,
            has_lyrics=bool(_lyric_streams(entry)),
        )

    async def fetch_plain_lyrics(self, rating_key: str) -> Optional[str]:
        """Plain reference lyrics for one track, or None if it has none.

        Gated: raises :class:`PlexLyricsDisabledError` BEFORE any network call
        when the opt-in is off. That ordering is the whole contract — "off"
        has to mean the request never happens, not that the result is ignored.

        Missing lyrics are not an error (None). A server that cannot be reached
        is (:class:`PlexError`).
        """
        if not plex_lyrics_enabled():
            raise PlexLyricsDisabledError(
                f"Reading lyrics from the media server is off. "
                f"Set {PLEX_LYRICS_ENV}=1 to enable it."
            )

        entry = await self._metadata_entry(rating_key)
        if entry is None:
            return None

        stream = _pick_lyric_stream(_lyric_streams(entry))
        if stream is None:
            return None
        key = stream.get("key")
        if not key:
            return None

        text = await _get_text(self._url(str(key)), headers=self._hdrs)
        if not text.strip():
            return None
        if _looks_like_lrc(text):
            text = strip_lrc_timestamps(text)
        else:
            text = "\n".join(
                line.strip() for line in text.splitlines() if line.strip()
            )
        return text or None

    async def fetch_part_to(self, part_key: str, dest: Path) -> int:
        """Copy one track's media file from the server to ``dest``.

        The fallback for when this install cannot see the library's storage
        directly. Capped by the same ``MAX_FILE_SIZE_MB`` the upload route
        enforces — imported audio lands in the same uploads directory and is
        processed by the same pipeline, so it answers to the same limit.
        """
        if not part_key:
            raise PlexError("That track has no playable media file on the server.")
        # Imported here, not at module import: api.separate pulls in the whole
        # route graph, and this module is imported from inside it.
        from karaoke_backend.api.separate import MAX_FILE_SIZE_MB

        max_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
        written = await _stream_to(
            self._url(str(part_key)),
            dest,
            headers=self._hdrs,
            max_bytes=max_bytes,
            require_audio=True,
        )
        logger.info(
            "Copied %d MB from the media server into %s",
            written // 1024 // 1024, os.path.basename(dest),
        )
        return written
