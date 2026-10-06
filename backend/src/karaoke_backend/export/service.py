# SPDX-License-Identifier: AGPL-3.0-only
"""Assembling a single song's CD+G / MP3+G export.

``export_song`` is the whole surface: it resolves the song, its word-synced
lyrics, and its audio stem, encodes the .cdg stream (and, for MP3+G, the MP3),
and returns the finished bytes with a filename. Failures raise the typed
exceptions below — HTTP status mapping belongs to the router, not here.

Contract points:

* Word sync resolves through a fallback chain: an explicitly requested lyrics
  set (which must belong to the song), else the song's active set, else the
  lowest-id set with word-level sync, else the legacy per-song column.
* The MP3 is fed by a stem. An explicitly requested mix is honoured or
  refused, like a requested lyrics set; when the caller expresses no
  preference, the karaoke mix is preferred with the instrumental as fallback
  (flac before wav either way).
* Duration comes from probing the audio with ffprobe, falling back to the
  song's recorded duration; a CDG-only export with no stem on disk may run on
  the recorded duration alone.
* The attribution card obeys the stored operator setting unless the caller
  overrides it for the request. When the card is on, a registered card
  provider may substitute its own art; a provider failure falls back to the
  standard card rather than failing the export.
* This module performs zero database writes.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend import cdg, stem_layout, stem_storage
from karaoke_backend.branding import EXPORT_ID_PREFIX
from karaoke_backend.export import raster
from karaoke_backend.export.card_provider import get_card_provider
from karaoke_backend.models.settings import (
    CDG_CARD_KEY,
    DEFAULT_CDG_CARD,
    AppSetting,
)
from karaoke_backend.models.song import LyricsSet, Song

logger = logging.getLogger(__name__)

# Same resolution as the songs router: an explicit stems_path wins, else the
# conventional per-song directory under STEMS_DIR.
STEMS_DIR = Path(os.getenv("STEMS_DIR", "stems"))

MP3_BITRATE = "192k"
_PROBE_TIMEOUT = 120
_ENCODE_TIMEOUT = 300
_CDG_ENCODE_TIMEOUT = 120
MAX_EXPORT_WORDS = 20_000


# ---------------------------------------------------------------------------
# Typed failures — the router maps these to HTTP statuses.
# ---------------------------------------------------------------------------


class ExportError(Exception):
    """Base export failure. ``str(exc)`` is safe to show a client."""


class ExportNotFound(ExportError):
    """The song, or the requested lyrics set, does not exist for this owner."""


class ExportConflict(ExportError):
    """The song exists but cannot be exported as asked."""


class RasterUnavailable(ExportError):
    """The optional text rasteriser is not installed."""


@dataclass(frozen=True)
class ExportResult:
    filename: str
    media_type: str
    content: bytes


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


async def get_attribution_card_setting(db: AsyncSession) -> bool:
    """Read the attribution-card toggle, falling back to the default.

    Stored as "true"/"false" text, parsed case-insensitively; a missing row or
    an unparseable value both mean "operator hasn't set a valid override".
    """
    row = await db.get(AppSetting, CDG_CARD_KEY)
    if row is None:
        return DEFAULT_CDG_CARD
    value = (row.value or "").strip().lower()
    if value == "true":
        return True
    if value == "false":
        return False
    return DEFAULT_CDG_CARD


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------


def _sanitize(part: str) -> str:
    """Make one name component filesystem-safe while keeping it readable.

    Only characters that are unusable in filenames (plus control characters)
    are replaced; other punctuation is deliberately kept, because hosting
    software commonly parses the artist and title back out of the filename.
    """
    part = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", part or "")
    return re.sub(r"\s+", " ", part).strip(" .")


def filename_base(song_id: int, artist: Optional[str], title: Optional[str]) -> str:
    """The "<id> - <artist> - <title>" base shared by every exported file.

    The id prefix plus zero-padded database id gives each export a stable,
    unique key in the hosting-software filename convention.
    """
    artist_part = _sanitize(artist or "") or "Unknown Artist"
    title_part = _sanitize(title or "") or "Untitled"
    return f"{EXPORT_ID_PREFIX}{song_id:04d} - {artist_part} - {title_part}"


# ---------------------------------------------------------------------------
# Resolution helpers
# ---------------------------------------------------------------------------


def _stems_dir(song: Song) -> Path:
    return stem_storage.active_stems_dir(song, STEMS_DIR)


def _find_audio(stems_dir: Path, audio: Optional[str]) -> Optional[Path]:
    """The stem feeding the MP3 (flac before wav).

    An explicit ``audio`` names the only acceptable mix — a missing stem is
    the caller's refusal to handle, never a silent substitution (the exported
    file travels into other players' libraries, so it must be what was asked
    for). ``None`` means no preference was expressed: karaoke mix first,
    instrumental as fallback.
    """
    resolvers = {
        "karaoke": stem_layout.karaoke_filename,
        "instrumental": stem_layout.instrumental_filename,
    }
    order = ("karaoke", "instrumental") if audio is None else (audio,)
    if not stems_dir.is_dir():
        return None
    for kind in order:
        name = resolvers[kind](stems_dir)
        if name:
            return stems_dir / name
    return None


def missing_stem_message(audio: Optional[str]) -> str:
    """The refusal shown when the requested (or any) stem is missing."""
    if audio == "karaoke":
        return "No karaoke mix found for this song; try Instrumental"
    if audio == "instrumental":
        return "No instrumental stem found for this song; try Karaoke mix"
    return "No audio stem found for this song"


async def _resolve_word_sync(
    db: AsyncSession, song: Song, lyrics_set_id: Optional[int]
) -> str:
    """Raw word-sync JSON text for the song, via the fallback chain.

    An explicitly requested set is honoured or refused — never silently
    substituted. Without one: the active set if it carries word sync, else the
    lowest-id set that does, else the legacy per-song column kept from before
    lyrics sets existed.
    """
    if lyrics_set_id is not None:
        row = (
            await db.execute(
                select(LyricsSet).where(
                    LyricsSet.id == lyrics_set_id, LyricsSet.song_id == song.id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ExportNotFound(
                f"Lyrics set {lyrics_set_id} not found for song {song.id}"
            )
        if not row.word_sync_json:
            raise ExportConflict(
                f"Lyrics set {lyrics_set_id} has no word-level sync"
            )
        return row.word_sync_json

    if song.active_lyrics_id is not None:
        row = await db.get(LyricsSet, song.active_lyrics_id)
        if row is not None and row.song_id == song.id and row.word_sync_json:
            return row.word_sync_json

    row = (
        await db.execute(
            select(LyricsSet)
            .where(
                LyricsSet.song_id == song.id,
                LyricsSet.word_sync_json.is_not(None),
            )
            .order_by(LyricsSet.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is not None and row.word_sync_json:
        return row.word_sync_json

    if song.word_sync_json:
        return song.word_sync_json

    raise ExportConflict("Song has no word-synced lyrics to export")


async def _probe_duration(path: Path) -> Optional[float]:
    """Audio duration in seconds via ffprobe, or None if the probe fails."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        str(path),
    ]
    try:
        proc = await asyncio.to_thread(
            subprocess.run, cmd,
            capture_output=True, text=True, timeout=_PROBE_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("ffprobe failed for %s: %s", path, exc)
        return None
    if proc.returncode != 0:
        logger.warning("ffprobe failed for %s: %s", path, proc.stderr.strip()[-500:])
        return None
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------


def _encode_cdg(doc: dict, duration: float, card: cdg.Card | bool) -> bytes:
    """Word-sync document to .cdg stream. Runs in a worker thread (CPU-bound)."""
    lines, page_defs = cdg.normalize_doc(doc)
    if not page_defs:
        raise ExportConflict("Word sync has no usable lines")
    # Rasterisation cost scales with word count and word sync is hand-editable
    # data, so an implausible document is refused before any drawing happens
    # rather than burning the request thread. Real songs run a few hundred
    # words; the cap leaves two orders of magnitude of headroom.
    word_count = sum(len(line) for line in lines if line)
    if word_count > MAX_EXPORT_WORDS:
        raise ExportConflict(
            f"Word sync has {word_count} words; "
            f"the export limit is {MAX_EXPORT_WORDS}"
        )
    pages = cdg.build_pages(lines, page_defs, raster.render_line)
    if not pages:
        raise ExportConflict("Word sync has no usable lines")
    return cdg.build_stream(pages, duration, card=card)


async def _encode_mp3(src: Path) -> bytes:
    """Encode the source stem to MP3 bytes via ffmpeg in a temp directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        dst = Path(tmpdir) / "audio.mp3"
        cmd = [
            "ffmpeg", "-y", "-i", str(src),
            "-vn", "-map_metadata", "-1",
            "-codec:a", "libmp3lame", "-b:a", MP3_BITRATE,
            str(dst),
        ]
        try:
            proc = await asyncio.to_thread(
                subprocess.run, cmd,
                capture_output=True, text=True, timeout=_ENCODE_TIMEOUT,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            logger.error("ffmpeg mp3 encode failed for %s: %s", src, exc)
            raise ExportConflict("Audio encoding failed") from exc
        # The client gets a short generic detail; the full stderr goes to the
        # server log only.
        if proc.returncode != 0 or not dst.is_file():
            logger.error(
                "ffmpeg mp3 encode failed for %s: %s", src, proc.stderr[-2000:]
            )
            raise ExportConflict("Audio encoding failed")
        return dst.read_bytes()


# ---------------------------------------------------------------------------
# The export
# ---------------------------------------------------------------------------


async def export_song(
    db: AsyncSession,
    *,
    song_id: int,
    owner_id: int,
    fmt: str,
    audio: Optional[str],
    card: Optional[bool],
    lyrics_set_id: Optional[int],
) -> ExportResult:
    """Export one song as MP3+G (``fmt="mp3g"``) or a bare CDG (``"cdg"``)."""
    if not raster.raster_available():
        raise RasterUnavailable(
            "CD+G export needs the optional text rasteriser; install the "
            "backend with the export extra (karaoke-backend[export])"
        )

    song = (
        await db.execute(
            select(Song).where(Song.id == song_id, Song.owner_id == owner_id)
        )
    ).scalar_one_or_none()
    if song is None:
        raise ExportNotFound(f"Song {song_id} not found")
    if song.status != "ready":
        raise ExportConflict(
            f"Song {song_id} is not ready yet (status: {song.status})"
        )

    sync_text = await _resolve_word_sync(db, song, lyrics_set_id)
    try:
        doc = json.loads(sync_text)
    except ValueError as exc:
        raise ExportConflict("Stored word sync is not valid JSON") from exc
    if not isinstance(doc, dict):
        raise ExportConflict("Stored word sync is not a usable document")

    audio_path = _find_audio(_stems_dir(song), audio)
    if fmt == "mp3g" and audio_path is None:
        raise ExportConflict(missing_stem_message(audio))

    duration: Optional[float] = None
    if audio_path is not None:
        duration = await _probe_duration(audio_path)
    if duration is None:
        duration = song.duration
    if duration is None or duration <= 0:
        raise ExportConflict("Song duration is unknown; cannot size the stream")

    card_flag = card if card is not None else await get_attribution_card_setting(db)

    # The toggle governs whether a card is shown at all; a registered provider
    # only ever changes which card. A provider failure must never fail the
    # export -- the standard attribution card is the fallback.
    card_arg: cdg.Card | bool = card_flag
    if card_flag:
        provider = get_card_provider()
        if provider is not None:
            try:
                custom = await provider.card_for(db, owner_id)
            except Exception:
                logger.exception("card provider failed; using the standard card")
                custom = None
            # "Never fail the export" covers a provider that returns garbage
            # the same as one that raises; anything but a Card is discarded.
            if custom is not None and not isinstance(custom, cdg.Card):
                logger.error(
                    "card provider returned %s, not a Card; "
                    "using the standard card",
                    type(custom).__name__,
                )
                custom = None
            if custom is not None:
                card_arg = custom

    try:
        # The word-count cap above bounds the work; the timeout is the
        # backstop so a pathological document can never pin the request
        # forever (the thread itself is not killable, only abandoned).
        stream = await asyncio.wait_for(
            asyncio.to_thread(_encode_cdg, doc, duration, card_arg),
            timeout=_CDG_ENCODE_TIMEOUT,
        )
    except TimeoutError as exc:
        logger.error("CDG encode timed out for song %s", song_id)
        raise ExportConflict("Export took too long to encode") from exc
    except ValueError as exc:
        # The encoder refuses unusable durations and timings by ValueError.
        raise ExportConflict(f"Cannot encode stream: {exc}") from exc

    base = filename_base(song.id, song.artist, song.title)

    if fmt == "cdg":
        return ExportResult(
            filename=f"{base}.cdg",
            media_type="application/octet-stream",
            content=stream,
        )

    mp3_bytes = await _encode_mp3(audio_path)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        # The identical base name on both entries IS the MP3+G pairing
        # contract: players match the .cdg to the .mp3 by name. The MP3 is
        # already compressed, so deflating it again is wasted CPU; the CDG
        # stream compresses well and gets deflate.
        archive.writestr(
            f"{base}.mp3", mp3_bytes, compress_type=zipfile.ZIP_STORED
        )
        archive.writestr(
            f"{base}.cdg", stream, compress_type=zipfile.ZIP_DEFLATED
        )
    return ExportResult(
        filename=f"{base}.zip",
        media_type="application/zip",
        content=buffer.getvalue(),
    )
