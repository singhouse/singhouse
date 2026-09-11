# SPDX-License-Identifier: AGPL-3.0-only
"""BasicManualQueue router coverage.

The model's cascade behaviour is proven in test_queue_model.py; this file
covers the HTTP contract pinned in models/queue.py: ORDER BY position,id,
append = MAX+1, reorder = dense renumber of a full permutation, delete leaves
gaps (legal), dequeue-on-play = DELETE. Core assembly only — in multi-user
assembly the router never mounts (rotation supersedes it), which the premium
suite asserts.
"""

import pytest
from httpx import AsyncClient

GATE_PW = "queue-test-pw"


async def _seed_song(title: str = "T", artist: str = "A") -> int:
    """Insert a song directly — the queue only ever points at library rows."""
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import Song

    async with AsyncSessionLocal() as db:
        song = Song(artist=artist, title=title, filename=f"{title}.mp3", status="ready")
        db.add(song)
        await db.commit()
        return song.id


async def _add(client: AsyncClient, song_id: int, singer: str | None = None) -> dict:
    resp = await client.post(
        "/api/queue", json={"song_id": song_id, "singer_name": singer}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _entries(client: AsyncClient) -> list[dict]:
    resp = await client.get("/api/queue")
    assert resp.status_code == 200, resp.text
    return resp.json()["entries"]


@pytest.mark.asyncio
async def test_empty_queue_lists_empty(client: AsyncClient):
    assert await _entries(client) == []


@pytest.mark.asyncio
async def test_add_appends_and_joins_song_fields(client: AsyncClient):
    song_id = await _seed_song(title="Heroes", artist="Bowie")
    first = await _add(client, song_id, "Alice")
    second = await _add(client, song_id)  # same song twice is legal

    assert first["position"] == 0
    assert second["position"] == 1
    assert second["singer_name"] is None

    rows = await _entries(client)
    assert [r["id"] for r in rows] == [first["id"], second["id"]]
    assert rows[0]["title"] == "Heroes"
    assert rows[0]["artist"] == "Bowie"
    assert rows[0]["singer_name"] == "Alice"
    assert rows[0]["status"] == "ready"


@pytest.mark.asyncio
async def test_add_missing_song_404(client: AsyncClient):
    resp = await client.post("/api/queue", json={"song_id": 424242})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_add_blank_singer_normalises_to_null(client: AsyncClient):
    song_id = await _seed_song()
    row = await _add(client, song_id, "   ")
    assert row["singer_name"] is None


@pytest.mark.asyncio
async def test_add_singer_name_over_80_chars_422(client: AsyncClient):
    song_id = await _seed_song()
    resp = await client.post(
        "/api/queue", json={"song_id": song_id, "singer_name": "x" * 81}
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_delete_dequeues_without_renumbering(client: AsyncClient):
    song_id = await _seed_song()
    a = await _add(client, song_id, "A")
    b = await _add(client, song_id, "B")
    c = await _add(client, song_id, "C")

    resp = await client.delete(f"/api/queue/{b['id']}")
    assert resp.status_code == 200

    rows = await _entries(client)
    # Gap at position 1 is legal — order survives, no renumber on delete.
    assert [(r["id"], r["position"]) for r in rows] == [
        (a["id"], 0),
        (c["id"], 2),
    ]

    # Append after a delete still lands past the max position.
    d = await _add(client, song_id, "D")
    assert d["position"] == 3


@pytest.mark.asyncio
async def test_delete_missing_entry_404(client: AsyncClient):
    resp = await client.delete("/api/queue/424242")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_reorder_renumbers_dense(client: AsyncClient):
    song_id = await _seed_song()
    a = await _add(client, song_id, "A")
    b = await _add(client, song_id, "B")
    c = await _add(client, song_id, "C")
    # Introduce a gap first so the reorder provably restores density.
    await client.delete(f"/api/queue/{a['id']}")

    resp = await client.put(
        "/api/queue/order", json={"entry_ids": [c["id"], b["id"]]}
    )
    assert resp.status_code == 200
    rows = resp.json()["entries"]
    assert [(r["id"], r["position"]) for r in rows] == [
        (c["id"], 0),
        (b["id"], 1),
    ]


@pytest.mark.asyncio
async def test_reorder_stale_ids_409(client: AsyncClient):
    song_id = await _seed_song()
    a = await _add(client, song_id, "A")
    b = await _add(client, song_id, "B")

    # Missing an id, containing a foreign id, and duplicating an id are all
    # the same failure: the client's picture of the queue is stale.
    for bad in ([a["id"]], [a["id"], 424242], [a["id"], a["id"]]):
        resp = await client.put("/api/queue/order", json={"entry_ids": bad})
        assert resp.status_code == 409, bad

    rows = await _entries(client)
    assert [r["id"] for r in rows] == [a["id"], b["id"]]  # untouched


@pytest.mark.asyncio
async def test_clear_empties_queue(client: AsyncClient):
    song_id = await _seed_song()
    await _add(client, song_id, "A")
    await _add(client, song_id, "B")

    resp = await client.delete("/api/queue")
    assert resp.status_code == 200
    assert resp.json()["cleared"] == 2
    assert await _entries(client) == []


def test_rotation_never_mounts_in_core_assembly():
    """Exactly one queue system mounts: here it's /api/queue, not rotation."""
    from karaoke_backend.main import app

    paths = {getattr(r, "path", "") for r in app.routes}
    assert any(p.startswith("/api/queue") for p in paths)
    assert not any(p.startswith("/api/rotation") for p in paths)
    assert not any(p.startswith("/api/show") for p in paths)


@pytest.mark.asyncio
async def test_locked_gate_fails_closed(client: AsyncClient, monkeypatch):
    """Every queue route sits behind require_user — locked gate means 401."""
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)

    assert (await client.get("/api/queue")).status_code == 401
    assert (
        await client.post("/api/queue", json={"song_id": 1})
    ).status_code == 401
    assert (
        await client.put("/api/queue/order", json={"entry_ids": []})
    ).status_code == 401
    assert (await client.delete("/api/queue/1")).status_code == 401
    assert (await client.delete("/api/queue")).status_code == 401

    # Unlocking restores the whole surface.
    unlock = await client.post("/api/auth/gate", json={"password": GATE_PW})
    assert unlock.status_code == 200
    assert (await client.get("/api/queue")).status_code == 200
