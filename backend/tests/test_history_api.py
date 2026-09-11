# SPDX-License-Identifier: AGPL-3.0-only
"""Core flat play-history router coverage.

Covers the HTTP contract pinned in models/history.py + api/history.py: a row per
▶ Sing, snapshot fields that survive song deletion (ON DELETE SET NULL), the
idempotent complete flip, newest-first list/search/pagination with an
unpaginated total, single + bulk clear, the plain retention setting, and the
retention purge (0 = keep forever). Core assembly only — in multi-user assembly
the router never mounts (premium's venue history supersedes it).
"""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from karaoke_backend.api.identity import SINGLE_HOST_ID


async def _seed_song(title: str = "T", artist: str = "A") -> int:
    """Insert a song owned by the single Host — history snapshots off it."""
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import Song

    async with AsyncSessionLocal() as db:
        song = Song(
            owner_id=SINGLE_HOST_ID,
            artist=artist,
            title=title,
            filename=f"{title}.mp3",
            status="ready",
        )
        db.add(song)
        await db.commit()
        return song.id


async def _record(client: AsyncClient, song_id: int, singer: str | None = None) -> dict:
    resp = await client.post(
        "/api/history", json={"song_id": song_id, "singer_name": singer}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _list(client: AsyncClient, **params) -> dict:
    resp = await client.get("/api/history", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# Record a play
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_record_snapshots_song_and_starts_incomplete(client: AsyncClient):
    song_id = await _seed_song(title="Heroes", artist="Bowie")
    row = await _record(client, song_id, "Alice")

    assert isinstance(row["id"], int)
    assert row["song_id"] == song_id
    assert row["title"] == "Heroes"
    assert row["artist"] == "Bowie"
    assert row["singer_name"] == "Alice"
    assert row["completed"] is False


@pytest.mark.asyncio
async def test_record_blank_singer_normalises_to_null(client: AsyncClient):
    song_id = await _seed_song()
    row = await _record(client, song_id, "   ")
    assert row["singer_name"] is None


@pytest.mark.asyncio
async def test_record_missing_song_404(client: AsyncClient):
    resp = await client.post("/api/history", json={"song_id": 424242})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_repeat_sings_are_separate_rows(client: AsyncClient):
    song_id = await _seed_song()
    a = await _record(client, song_id, "A")
    b = await _record(client, song_id, "A")
    assert a["id"] != b["id"]
    assert (await _list(client))["total"] == 2


# ---------------------------------------------------------------------------
# Snapshot survives song deletion (ON DELETE SET NULL)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_snapshot_survives_song_deletion(client: AsyncClient):
    song_id = await _seed_song(title="Gone", artist="Deleted Band")
    await _record(client, song_id, "Sam")

    resp = await client.delete(f"/api/songs/{song_id}")
    assert resp.status_code == 200, resp.text

    data = await _list(client)
    assert data["total"] == 1
    row = data["entries"][0]
    assert row["song_id"] is None            # FK nulled, not cascaded away
    assert row["title"] == "Gone"            # snapshot intact
    assert row["artist"] == "Deleted Band"
    assert row["singer_name"] == "Sam"


# ---------------------------------------------------------------------------
# Complete flip (player `ended`)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_complete_is_idempotent(client: AsyncClient):
    song_id = await _seed_song()
    row = await _record(client, song_id)

    first = await client.post(f"/api/history/{row['id']}/complete")
    assert first.status_code == 200
    assert first.json() == {"ok": True}

    # Second call is a no-op, still 200.
    second = await client.post(f"/api/history/{row['id']}/complete")
    assert second.status_code == 200

    entries = (await _list(client))["entries"]
    assert entries[0]["completed"] is True


@pytest.mark.asyncio
async def test_complete_unknown_id_404(client: AsyncClient):
    resp = await client.post("/api/history/424242/complete")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# List: ordering, search, pagination
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_is_newest_first(client: AsyncClient):
    song_id = await _seed_song()
    a = await _record(client, song_id, "A")
    b = await _record(client, song_id, "B")
    c = await _record(client, song_id, "C")

    ids = [r["id"] for r in (await _list(client))["entries"]]
    # played_at desc, id desc — most recently recorded first.
    assert ids == [c["id"], b["id"], a["id"]]


@pytest.mark.asyncio
async def test_search_matches_title_artist_singer_case_insensitively(client: AsyncClient):
    bowie = await _seed_song(title="Heroes", artist="Bowie")
    queen = await _seed_song(title="Bohemian Rhapsody", artist="Queen")
    await _record(client, bowie, "Alice")
    await _record(client, queen, "Bob")

    # by artist (lowercased)
    by_artist = await _list(client, search="bowie")
    assert by_artist["total"] == 1
    assert by_artist["entries"][0]["artist"] == "Bowie"

    # by title fragment
    by_title = await _list(client, search="rhaps")
    assert by_title["total"] == 1
    assert by_title["entries"][0]["title"] == "Bohemian Rhapsody"

    # by singer
    by_singer = await _list(client, search="alice")
    assert by_singer["total"] == 1
    assert by_singer["entries"][0]["singer_name"] == "Alice"


@pytest.mark.asyncio
async def test_pagination_total_is_unpaginated_count(client: AsyncClient):
    song_id = await _seed_song()
    for name in ("A", "B", "C"):
        await _record(client, song_id, name)

    page1 = await _list(client, limit=2, offset=0)
    assert len(page1["entries"]) == 2
    assert page1["total"] == 3   # total ignores the page window

    page2 = await _list(client, limit=2, offset=2)
    assert len(page2["entries"]) == 1
    assert page2["total"] == 3

    # No overlap between pages.
    assert {r["id"] for r in page1["entries"]}.isdisjoint(
        {r["id"] for r in page2["entries"]}
    )


# ---------------------------------------------------------------------------
# Delete one + clear all
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_one_entry(client: AsyncClient):
    song_id = await _seed_song()
    a = await _record(client, song_id, "A")
    b = await _record(client, song_id, "B")

    resp = await client.delete(f"/api/history/{a['id']}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    ids = [r["id"] for r in (await _list(client))["entries"]]
    assert ids == [b["id"]]


@pytest.mark.asyncio
async def test_delete_unknown_entry_404(client: AsyncClient):
    resp = await client.delete("/api/history/424242")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_clear_reports_count(client: AsyncClient):
    song_id = await _seed_song()
    await _record(client, song_id, "A")
    await _record(client, song_id, "B")

    resp = await client.delete("/api/history")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["cleared"] == 2
    assert (await _list(client))["total"] == 0


# ---------------------------------------------------------------------------
# Retention setting
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retention_setting_default_and_update(client: AsyncClient):
    # Default with no row present.
    resp = await client.get("/api/history/settings")
    assert resp.status_code == 200
    assert resp.json()["retention_days"] == 30

    # Set to 7, read back 7.
    put = await client.put("/api/history/settings", json={"retention_days": 7})
    assert put.status_code == 200
    assert put.json()["retention_days"] == 7
    assert (await client.get("/api/history/settings")).json()["retention_days"] == 7

    # 0 = keep forever, allowed.
    put0 = await client.put("/api/history/settings", json={"retention_days": 0})
    assert put0.status_code == 200
    assert put0.json()["retention_days"] == 0

    # Negative rejected by validation.
    bad = await client.put("/api/history/settings", json={"retention_days": -1})
    assert bad.status_code == 422

    # Above the ceiling rejected too — the purge turns this into a timedelta,
    # which overflows for absurd values.
    from karaoke_backend.models.settings import MAX_RETENTION_DAYS

    at_max = await client.put(
        "/api/history/settings", json={"retention_days": MAX_RETENTION_DAYS}
    )
    assert at_max.status_code == 200
    over = await client.put(
        "/api/history/settings", json={"retention_days": MAX_RETENTION_DAYS + 1}
    )
    assert over.status_code == 422


@pytest.mark.asyncio
async def test_out_of_range_stored_retention_does_not_crash(client: AsyncClient):
    """A hand-edited AppSetting past the ceiling must not 500 list/record.

    PUT validates the bound, but the value is read straight back from the DB on
    every purge — so the purge clamps defensively rather than letting an absurd
    ``timedelta(days=...)`` overflow and take down the whole history surface.
    """
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.settings import AppSetting, HISTORY_RETENTION_KEY

    async with AsyncSessionLocal() as db:
        db.add(AppSetting(key=HISTORY_RETENTION_KEY, value="999999999999"))
        await db.commit()

    song_id = await _seed_song()
    rec = await client.post("/api/history", json={"song_id": song_id})
    assert rec.status_code == 201            # record ran its purge without overflowing
    listed = await client.get("/api/history")
    assert listed.status_code == 200          # list ran its purge without overflowing


# ---------------------------------------------------------------------------
# Retention purge
# ---------------------------------------------------------------------------


async def _insert_old_row(days_ago: int, title: str = "Old") -> int:
    """Insert a PlayHistory row aged `days_ago` days, bypassing the API."""
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.history import PlayHistory

    played = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days_ago)
    async with AsyncSessionLocal() as db:
        row = PlayHistory(
            song_id=None,
            title=title,
            artist="Ancient",
            singer_name=None,
            played_at=played,
            completed=False,
        )
        db.add(row)
        await db.commit()
        return row.id


@pytest.mark.asyncio
async def test_expired_rows_are_pruned_on_read(client: AsyncClient):
    # 30-day window (the default).
    old_id = await _insert_old_row(days_ago=40)
    song_id = await _seed_song(title="Fresh", artist="Now")
    fresh = await _record(client, song_id)

    data = await _list(client)
    ids = [r["id"] for r in data["entries"]]
    assert old_id not in ids            # aged past 30 days → pruned
    assert fresh["id"] in ids           # inside the window → kept
    assert data["total"] == 1


@pytest.mark.asyncio
async def test_zero_retention_keeps_forever(client: AsyncClient):
    await client.put("/api/history/settings", json={"retention_days": 0})
    old_id = await _insert_old_row(days_ago=40)

    data = await _list(client)
    ids = [r["id"] for r in data["entries"]]
    assert old_id in ids                # 0 = keep forever, nothing pruned
    assert data["total"] == 1
