# SPDX-License-Identifier: AGPL-3.0-only
"""Export router coverage.

Covers the HTTP contract pinned in api/export.py + export/service.py: the
attribution-card setting (default true, "true"/"false" text round-trip,
unparseable stored value falls back), the export route's error mapping (404
unknown/foreign song and foreign lyrics set, 409 not-ready / no word sync /
no audio stem, 501 without the rasteriser, 422 for unknown enum values, 401
behind a locked gate), the features flag, and the happy paths: a real tiny
WAV stem through ffmpeg into an MP3+G zip whose paired entries share one base
name, with the .cdg decoded back to prove ink lands at a word's active time,
and the per-request card override in both directions. Plus the card-provider
seam: a registered provider's card replaces the standard one on the wire, a
raising provider falls back to the standard card without failing the export,
and a card=false request never consults the provider at all.
"""

from __future__ import annotations

import json
import shutil
import wave
import zipfile
from io import BytesIO
from pathlib import Path

import pytest
from httpx import AsyncClient

from karaoke_backend.api.identity import SINGLE_HOST_ID
from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.export import raster, service
from karaoke_backend.models.settings import AppSetting, CDG_CARD_KEY
from karaoke_backend.models.song import LyricsSet, Song

_HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None

# Word-sync fixture (v1 shape). Words start late enough that the intro has
# room for the attribution card and the page paints before the first word.
_WORD_SYNC = {
    "lines": [
        [
            {"text": "Hello", "start": 8.0, "end": 8.5},
            {"text": "world", "start": 8.6, "end": 9.0},
        ]
    ]
}


async def _seed_song(
    *,
    status: str = "ready",
    stems_path: str | None = None,
    duration: float | None = None,
    word_sync: dict | None = _WORD_SYNC,
    artist: str = "Artist",
    title: str = "Title",
) -> int:
    async with AsyncSessionLocal() as db:
        song = Song(
            owner_id=SINGLE_HOST_ID,
            artist=artist,
            title=title,
            filename="t.mp3",
            status=status,
            stems_path=stems_path,
            duration=duration,
        )
        db.add(song)
        await db.commit()
        if word_sync is not None:
            lyrics = LyricsSet(
                owner_id=SINGLE_HOST_ID,
                song_id=song.id,
                word_sync_json=json.dumps(word_sync),
            )
            db.add(lyrics)
            await db.commit()
            song.active_lyrics_id = lyrics.id
            await db.commit()
        return song.id


def _write_silence_wav(path: Path, seconds: float = 12.0) -> None:
    """A real (silent) WAV via the stdlib, small but probe- and encodable."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * int(8000 * seconds))


@pytest.fixture
def raster_ok(monkeypatch):
    """Pretend the rasteriser is installed — for paths that fail before it."""
    monkeypatch.setattr(raster, "raster_available", lambda: True)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_settings_default_true(client: AsyncClient):
    resp = await client.get("/api/export/settings")
    assert resp.status_code == 200
    assert resp.json() == {"attribution_card": True}


@pytest.mark.asyncio
async def test_settings_put_round_trip(client: AsyncClient):
    put = await client.put("/api/export/settings", json={"attribution_card": False})
    assert put.status_code == 200
    assert put.json() == {"attribution_card": False}
    assert (await client.get("/api/export/settings")).json() == {
        "attribution_card": False
    }

    put = await client.put("/api/export/settings", json={"attribution_card": True})
    assert put.status_code == 200
    assert (await client.get("/api/export/settings")).json() == {
        "attribution_card": True
    }


@pytest.mark.asyncio
async def test_settings_unparseable_row_falls_back_to_default(client: AsyncClient):
    async with AsyncSessionLocal() as db:
        db.add(AppSetting(key=CDG_CARD_KEY, value="banana"))
        await db.commit()
    resp = await client.get("/api/export/settings")
    assert resp.status_code == 200
    assert resp.json() == {"attribution_card": True}


@pytest.mark.asyncio
async def test_settings_body_must_be_a_bool(client: AsyncClient):
    # "banana" is beyond even lax bool coercion ("yes"/"true"/"1" are not).
    resp = await client.put(
        "/api/export/settings", json={"attribution_card": "banana"}
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Auth + error mapping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_locked_gate_fails_closed(client: AsyncClient, monkeypatch):
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", "export-test-pw")
    assert (await client.get("/api/export/settings")).status_code == 401
    assert (
        await client.put("/api/export/settings", json={"attribution_card": True})
    ).status_code == 401
    assert (await client.get("/api/export/songs/1")).status_code == 401


@pytest.mark.asyncio
async def test_unknown_song_404(client: AsyncClient, raster_ok):
    resp = await client.get("/api/export/songs/424242")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_foreign_owner_song_404(client: AsyncClient, raster_ok):
    async with AsyncSessionLocal() as db:
        song = Song(
            owner_id=SINGLE_HOST_ID + 1,
            artist="A",
            title="T",
            filename="t.mp3",
            status="ready",
        )
        db.add(song)
        await db.commit()
        song_id = song.id
    resp = await client.get(f"/api/export/songs/{song_id}")
    assert resp.status_code == 404  # indistinguishable from missing


@pytest.mark.asyncio
async def test_foreign_lyrics_set_404(client: AsyncClient, raster_ok):
    other = await _seed_song()
    async with AsyncSessionLocal() as db:
        row = (
            await db.get(Song, other)
        )
        foreign_set = row.active_lyrics_id
    song_id = await _seed_song()
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"lyrics_set": foreign_set}
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_not_ready_song_409(client: AsyncClient, raster_ok):
    song_id = await _seed_song(status="processing")
    resp = await client.get(f"/api/export/songs/{song_id}")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_no_word_sync_anywhere_409(client: AsyncClient, raster_ok):
    song_id = await _seed_song(word_sync=None)
    resp = await client.get(f"/api/export/songs/{song_id}")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_no_audio_stem_409_for_mp3g(client: AsyncClient, raster_ok, tmp_path):
    song_id = await _seed_song(stems_path=str(tmp_path))  # dir exists, no stems
    resp = await client.get(f"/api/export/songs/{song_id}")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_rasteriser_unavailable_501_names_the_extra(
    client: AsyncClient, monkeypatch
):
    monkeypatch.setattr(raster, "raster_available", lambda: False)
    song_id = await _seed_song()
    resp = await client.get(f"/api/export/songs/{song_id}")
    assert resp.status_code == 501
    assert "karaoke-backend[export]" in resp.json()["detail"]
    # The bare-CDG format needs the rasteriser just the same.
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert resp.status_code == 501


@pytest.mark.asyncio
async def test_unknown_enum_values_422(client: AsyncClient):
    assert (
        await client.get("/api/export/songs/1", params={"format": "wav"})
    ).status_code == 422
    assert (
        await client.get("/api/export/songs/1", params={"audio": "vocals"})
    ).status_code == 422


# ---------------------------------------------------------------------------
# Features flag
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_features_reports_raster_availability(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(raster, "raster_available", lambda: True)
    resp = await client.get("/api/features")
    assert resp.status_code == 200
    assert resp.json()["cdg_export"] is True

    monkeypatch.setattr(raster, "raster_available", lambda: False)
    resp = await client.get("/api/features")
    assert resp.json()["cdg_export"] is False


# ---------------------------------------------------------------------------
# Download headers
# ---------------------------------------------------------------------------


def test_content_disposition_ascii_only():
    from karaoke_backend.api.export import _content_disposition

    header = _content_disposition("plain name.zip")
    assert header == 'attachment; filename="plain name.zip"'


def test_content_disposition_non_ascii_gets_rfc5987_form():
    from karaoke_backend.api.export import _content_disposition

    header = _content_disposition("Tïtle.zip")
    assert header.startswith('attachment; filename="T?tle.zip"')
    assert "filename*=UTF-8''T%C3%AFtle.zip" in header


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------


def _interior(screen):
    from karaoke_backend.cdg.spec import SCREEN_H, SCREEN_W, TILE_H, TILE_W

    return screen[TILE_H : SCREEN_H - TILE_H, TILE_W : SCREEN_W - TILE_W]


@pytest.mark.asyncio
@pytest.mark.skipif(not _HAVE_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
async def test_mp3g_export_pairs_mp3_and_cdg(client: AsyncClient, tmp_path):
    pytest.importorskip("PIL")
    from karaoke_backend.cdg import decode_at
    from karaoke_backend.cdg.spec import HILITE, TEXT

    _write_silence_wav(tmp_path / "karaoke.wav")
    song_id = await _seed_song(stems_path=str(tmp_path))

    resp = await client.get(f"/api/export/songs/{song_id}")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    disposition = resp.headers["content-disposition"]
    assert disposition.startswith("attachment;")

    base = service.filename_base(song_id, "Artist", "Title")
    assert f"{base}.zip" in disposition

    archive = zipfile.ZipFile(BytesIO(resp.content))
    assert sorted(archive.namelist()) == sorted([f"{base}.mp3", f"{base}.cdg"])
    mp3_bytes = archive.read(f"{base}.mp3")
    assert len(mp3_bytes) > 0

    # Round-trip the graphics: at t=8.55 "Hello" (8.0-8.5) is fully sung and
    # "world" (8.6-9.0) is painted but not yet highlighted.
    cdg_bytes = archive.read(f"{base}.cdg")
    screen = decode_at(cdg_bytes, 8.55).framebuffer
    pixels = set(_interior(screen).flatten().tolist())
    assert HILITE in pixels
    assert TEXT in pixels


@pytest.mark.asyncio
async def test_cdg_export_runs_on_recorded_duration_without_stems(
    client: AsyncClient,
):
    pytest.importorskip("PIL")
    from karaoke_backend.cdg import decode_at
    from karaoke_backend.cdg.spec import HILITE, PACKET_BYTES

    song_id = await _seed_song(duration=12.0)  # no stems anywhere

    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/octet-stream"
    base = service.filename_base(song_id, "Artist", "Title")
    assert f"{base}.cdg" in resp.headers["content-disposition"]
    assert len(resp.content) % PACKET_BYTES == 0

    screen = decode_at(resp.content, 8.55).framebuffer
    assert HILITE in set(_interior(screen).flatten().tolist())


@pytest.mark.asyncio
async def test_explicit_audio_choice_is_refused_when_missing(
    client: AsyncClient, tmp_path, raster_ok
):
    # An explicitly chosen mix is honoured or refused, never silently
    # substituted — the exported file travels into other players' libraries,
    # so it must be what was asked for.
    _write_silence_wav(tmp_path / "karaoke.wav")
    song_id = await _seed_song(stems_path=str(tmp_path))
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"audio": "instrumental"}
    )
    assert resp.status_code == 409, resp.text
    assert "instrumental" in resp.json()["detail"].lower()


@pytest.mark.asyncio
@pytest.mark.skipif(not _HAVE_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
async def test_omitted_audio_falls_back_across_mixes(
    client: AsyncClient, tmp_path
):
    pytest.importorskip("PIL")
    # No explicit choice expressed: only an instrumental on disk still
    # exports (karaoke preference, instrumental fallback).
    _write_silence_wav(tmp_path / "instrumental.wav")
    song_id = await _seed_song(stems_path=str(tmp_path))
    resp = await client.get(f"/api/export/songs/{song_id}")
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_hostile_metadata_cannot_inject_headers(
    client: AsyncClient, raster_ok
):
    pytest.importorskip("PIL")
    # CR/LF and quotes in artist/title must never reach the response header.
    song_id = await _seed_song(
        duration=12.0,
        artist='Evil\r\nSet-Cookie: x="1"',
        title='T"itle\nInjected',
    )
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert resp.status_code == 200, resp.text
    disposition = resp.headers["content-disposition"]
    assert "\r" not in disposition and "\n" not in disposition
    assert "set-cookie" not in resp.headers
    # The quoted ASCII filename parameter stays a single well-formed token.
    assert disposition.count('"') == 2


# ---------------------------------------------------------------------------
# Attribution-card override
# ---------------------------------------------------------------------------


def _card_visible(cdg_bytes: bytes) -> bool:
    """Whether anything is painted inside the border at t=2s.

    The first page shows at 6s (words start at 8), so early ink can only be
    the attribution card.
    """
    from karaoke_backend.cdg import decode_at
    from karaoke_backend.cdg.spec import BG

    screen = decode_at(cdg_bytes, 2.0).framebuffer
    return bool((_interior(screen) != BG).any())


@pytest.mark.asyncio
async def test_card_param_overrides_stored_false(client: AsyncClient):
    pytest.importorskip("PIL")
    song_id = await _seed_song(duration=12.0)
    await client.put("/api/export/settings", json={"attribution_card": False})

    stored = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert not _card_visible(stored.content)

    overridden = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg", "card": "true"}
    )
    assert _card_visible(overridden.content)


@pytest.mark.asyncio
async def test_card_param_overrides_stored_true(client: AsyncClient):
    pytest.importorskip("PIL")
    song_id = await _seed_song(duration=12.0)
    await client.put("/api/export/settings", json={"attribution_card": True})

    stored = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert _card_visible(stored.content)

    overridden = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg", "card": "false"}
    )
    assert not _card_visible(overridden.content)


# ---------------------------------------------------------------------------
# Card provider seam
# ---------------------------------------------------------------------------


def _custom_card():
    """A synthetic card in ink 7 -- an index the standard card never uses."""
    import numpy as np

    from karaoke_backend.cdg import Card
    from karaoke_backend.cdg.spec import SCREEN_H, SCREEN_W, TILE_H, TILE_W

    pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
    pixels[TILE_H : TILE_H + 6, TILE_W : TILE_W + 30] = 7
    return Card(pixels=pixels, palette={7: (15, 0, 15)})


@pytest.fixture
def provider_slot():
    """Guarantees the process-global provider slot is cleared afterwards."""
    from karaoke_backend.export import card_provider

    try:
        yield card_provider
    finally:
        card_provider.clear_card_provider()


def _early_inks(cdg_bytes: bytes) -> set[int]:
    """Palette indices painted inside the border at t=2s (card territory)."""
    from karaoke_backend.cdg import decode_at
    from karaoke_backend.cdg.spec import BG

    screen = decode_at(cdg_bytes, 2.0).framebuffer
    return set(_interior(screen).flatten().tolist()) - {BG}


@pytest.mark.asyncio
async def test_provider_card_replaces_the_standard_one(
    client: AsyncClient, provider_slot
):
    pytest.importorskip("PIL")
    from karaoke_backend.cdg import card_asset

    class Provider:
        async def card_for(self, db, owner_id):
            return _custom_card()

    provider_slot.set_card_provider(Provider())
    song_id = await _seed_song(duration=12.0)
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert resp.status_code == 200, resp.text
    inks = _early_inks(resp.content)
    assert 7 in inks
    assert inks.isdisjoint(card_asset.PALETTE)


@pytest.mark.asyncio
async def test_provider_returning_none_means_the_standard_card(
    client: AsyncClient, provider_slot
):
    pytest.importorskip("PIL")
    from karaoke_backend.cdg import card_asset

    class Provider:
        async def card_for(self, db, owner_id):
            return None

    provider_slot.set_card_provider(Provider())
    song_id = await _seed_song(duration=12.0)
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert resp.status_code == 200, resp.text
    assert _early_inks(resp.content) & set(card_asset.PALETTE)


@pytest.mark.asyncio
async def test_provider_failure_falls_back_to_the_standard_card(
    client: AsyncClient, provider_slot
):
    pytest.importorskip("PIL")
    from karaoke_backend.cdg import card_asset

    class Provider:
        async def card_for(self, db, owner_id):
            raise RuntimeError("provider exploded")

    provider_slot.set_card_provider(Provider())
    song_id = await _seed_song(duration=12.0)
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert resp.status_code == 200, resp.text
    assert _early_inks(resp.content) & set(card_asset.PALETTE)


@pytest.mark.asyncio
async def test_provider_returning_garbage_falls_back_to_the_standard_card(
    client: AsyncClient, provider_slot
):
    # A provider that returns something other than a Card is the same failure
    # class as one that raises: discarded, standard card, export succeeds.
    pytest.importorskip("PIL")
    from karaoke_backend.cdg import card_asset

    class Provider:
        async def card_for(self, db, owner_id):
            return {"pixels": "definitely", "palette": "not a Card"}

    provider_slot.set_card_provider(Provider())
    song_id = await _seed_song(duration=12.0)
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg"}
    )
    assert resp.status_code == 200, resp.text
    assert _early_inks(resp.content) & set(card_asset.PALETTE)


@pytest.mark.asyncio
async def test_card_off_never_consults_the_provider(
    client: AsyncClient, provider_slot
):
    pytest.importorskip("PIL")
    calls = []

    class Provider:
        async def card_for(self, db, owner_id):
            calls.append(owner_id)
            return _custom_card()

    provider_slot.set_card_provider(Provider())
    song_id = await _seed_song(duration=12.0)
    resp = await client.get(
        f"/api/export/songs/{song_id}", params={"format": "cdg", "card": "false"}
    )
    assert resp.status_code == 200, resp.text
    assert calls == []
    assert not _card_visible(resp.content)
