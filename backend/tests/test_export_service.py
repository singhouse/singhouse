# SPDX-License-Identifier: AGPL-3.0-only
"""Export service coverage below the HTTP surface.

Pins the pieces of the ``export.service`` contract that do not need the
router: the packaged font resolving through the same mechanism the rasteriser
uses (catches package-data misconfiguration), the filename sanitizer (unsafe
characters replaced, other punctuation kept for hosting software that parses
metadata back out of the name), the attribution-card setting parse discipline,
and the word-sync fallback chain (explicit set honoured or refused, active
set, lowest-id set with sync, legacy column).
"""

from __future__ import annotations

import importlib.resources
import json

import pytest

from karaoke_backend.api.identity import SINGLE_HOST_ID
from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.export import raster, service
from karaoke_backend.models.settings import AppSetting, CDG_CARD_KEY
from karaoke_backend.models.song import LyricsSet, Song


# ---------------------------------------------------------------------------
# Packaging: the vendored font must resolve for a wheel, not just this repo
# ---------------------------------------------------------------------------


def test_font_resolves_and_is_non_empty():
    path = raster.font_path()
    assert path.is_file()
    assert path.stat().st_size > 100_000  # a real TrueType file, not a stub


def test_font_is_reachable_as_package_data():
    resource = (
        importlib.resources.files("karaoke_backend.export")
        / "fonts"
        / "DejaVuSans-Bold.ttf"
    )
    assert resource.is_file()
    assert len(resource.read_bytes()) > 100_000


def test_raster_module_imports_without_pillow_being_touched():
    # The module was imported at collection time; the probe is the only place
    # Pillow enters, and it reports rather than raises.
    assert raster.raster_available() in (True, False)


# ---------------------------------------------------------------------------
# Filename sanitizer
# ---------------------------------------------------------------------------


def test_sanitizer_replaces_unsafe_characters_and_keeps_punctuation():
    assert service._sanitize("AC/DC") == "AC_DC"
    assert service._sanitize('a\\b:c*d?e"f<g>h|i') == "a_b_c_d_e_f_g_h_i"
    assert service._sanitize("Don't Stop Me Now!") == "Don't Stop Me Now!"
    assert service._sanitize("dots and spaces .. ") == "dots and spaces"
    assert service._sanitize("collapse    whitespace") == "collapse whitespace"
    # Control characters (tabs included) are unsafe, replaced before collapse.
    assert service._sanitize("ctrl\x00\x1fchars") == "ctrl__chars"


def test_filename_base_shape_and_fallbacks():
    from karaoke_backend.branding import EXPORT_ID_PREFIX as P

    assert service.filename_base(13, "Artist", "Title") == f"{P}0013 - Artist - Title"
    assert service.filename_base(7, None, None) == f"{P}0007 - Unknown Artist - Untitled"
    assert service.filename_base(12345, "A", "B") == f"{P}12345 - A - B"


# ---------------------------------------------------------------------------
# Attribution-card setting parse discipline
# ---------------------------------------------------------------------------


async def _set_raw_setting(value: str) -> None:
    async with AsyncSessionLocal() as db:
        db.add(AppSetting(key=CDG_CARD_KEY, value=value))
        await db.commit()


@pytest.mark.asyncio
async def test_card_setting_defaults_true_when_missing():
    async with AsyncSessionLocal() as db:
        assert await service.get_attribution_card_setting(db) is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stored", "expected"),
    [("true", True), ("TRUE", True), ("false", False), ("False", False)],
)
async def test_card_setting_parses_case_insensitively(stored, expected):
    await _set_raw_setting(stored)
    async with AsyncSessionLocal() as db:
        assert await service.get_attribution_card_setting(db) is expected


@pytest.mark.asyncio
async def test_card_setting_unparseable_falls_back_to_default():
    await _set_raw_setting("banana")
    async with AsyncSessionLocal() as db:
        assert await service.get_attribution_card_setting(db) is True


# ---------------------------------------------------------------------------
# Word-sync fallback chain
# ---------------------------------------------------------------------------


_SYNC = json.dumps(
    {"lines": [[{"text": "la", "start": 1.0, "end": 2.0}]]}
)


async def _seed_song(**kwargs) -> int:
    async with AsyncSessionLocal() as db:
        song = Song(
            owner_id=SINGLE_HOST_ID,
            artist="A",
            title="T",
            filename="t.mp3",
            status="ready",
            **kwargs,
        )
        db.add(song)
        await db.commit()
        return song.id


async def _seed_set(song_id: int, word_sync: str | None, marker: str) -> int:
    async with AsyncSessionLocal() as db:
        row = LyricsSet(
            owner_id=SINGLE_HOST_ID,
            song_id=song_id,
            label=marker,
            word_sync_json=word_sync,
        )
        db.add(row)
        await db.commit()
        return row.id


async def _resolve(song_id: int, lyrics_set_id: int | None) -> str:
    async with AsyncSessionLocal() as db:
        song = await db.get(Song, song_id)
        return await service._resolve_word_sync(db, song, lyrics_set_id)


def _tagged(marker: str) -> str:
    return json.dumps(
        {"lines": [[{"text": marker, "start": 1.0, "end": 2.0}]]}
    )


@pytest.mark.asyncio
async def test_explicit_set_is_honoured():
    song_id = await _seed_song()
    set_id = await _seed_set(song_id, _tagged("explicit"), "explicit")
    await _seed_set(song_id, _tagged("other"), "other")
    assert "explicit" in await _resolve(song_id, set_id)


@pytest.mark.asyncio
async def test_explicit_set_of_another_song_is_not_found():
    song_a = await _seed_song()
    foreign = await _seed_set(song_a, _SYNC, "foreign")
    song_b = await _seed_song()
    with pytest.raises(service.ExportNotFound):
        await _resolve(song_b, foreign)


@pytest.mark.asyncio
async def test_explicit_set_without_sync_conflicts_rather_than_substituting():
    song_id = await _seed_song()
    bare = await _seed_set(song_id, None, "bare")
    await _seed_set(song_id, _SYNC, "synced")
    with pytest.raises(service.ExportConflict):
        await _resolve(song_id, bare)


@pytest.mark.asyncio
async def test_active_set_wins_when_no_explicit_id_is_given():
    song_id = await _seed_song()
    await _seed_set(song_id, _tagged("first"), "first")
    active = await _seed_set(song_id, _tagged("active"), "active")
    async with AsyncSessionLocal() as db:
        song = await db.get(Song, song_id)
        song.active_lyrics_id = active
        await db.commit()
    assert "active" in await _resolve(song_id, None)


@pytest.mark.asyncio
async def test_no_active_set_falls_back_to_lowest_id_with_sync():
    song_id = await _seed_song()
    await _seed_set(song_id, None, "no-sync")
    await _seed_set(song_id, _tagged("lowest"), "lowest")
    await _seed_set(song_id, _tagged("later"), "later")
    assert "lowest" in await _resolve(song_id, None)


@pytest.mark.asyncio
async def test_legacy_column_is_the_last_resort():
    song_id = await _seed_song(word_sync_json=_tagged("legacy"))
    assert "legacy" in await _resolve(song_id, None)


@pytest.mark.asyncio
async def test_nothing_anywhere_conflicts():
    song_id = await _seed_song()
    await _seed_set(song_id, None, "bare")
    with pytest.raises(service.ExportConflict):
        await _resolve(song_id, None)


@pytest.mark.asyncio
async def test_dangling_active_pointer_never_serves_another_songs_lyrics():
    # An active_lyrics_id pointing at a different song's set (dangling data)
    # must be skipped, not followed — the chain falls through to this song's
    # own lowest-id synced set.
    song_a = await _seed_song()
    foreign = await _seed_set(song_a, _tagged("foreign"), "foreign")
    song_b = await _seed_song()
    await _seed_set(song_b, _tagged("own"), "own")
    async with AsyncSessionLocal() as db:
        song = await db.get(Song, song_b)
        song.active_lyrics_id = foreign
        await db.commit()
    resolved = await _resolve(song_b, None)
    assert "own" in resolved
    assert "foreign" not in resolved


# ---------------------------------------------------------------------------
# Stem choice: explicit is strict, omitted prefers the karaoke mix
# ---------------------------------------------------------------------------


def test_find_audio_prefers_karaoke_when_no_choice_expressed(tmp_path):
    (tmp_path / "karaoke.flac").write_bytes(b"k")
    (tmp_path / "instrumental.flac").write_bytes(b"i")
    chosen = service._find_audio(tmp_path, None)
    assert chosen is not None and chosen.name == "karaoke.flac"


def test_find_audio_omitted_falls_back_to_instrumental(tmp_path):
    (tmp_path / "instrumental.flac").write_bytes(b"i")
    chosen = service._find_audio(tmp_path, None)
    assert chosen is not None and chosen.name == "instrumental.flac"


def test_find_audio_explicit_choice_is_never_substituted(tmp_path):
    (tmp_path / "karaoke.flac").write_bytes(b"k")
    assert service._find_audio(tmp_path, "instrumental") is None
    assert service._find_audio(tmp_path, "karaoke").name == "karaoke.flac"
