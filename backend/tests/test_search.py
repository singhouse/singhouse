# SPDX-License-Identifier: AGPL-3.0-only
"""Search behavior, SQL connection registration, and API privacy/pagination."""

import pytest
from sqlalchemy import create_engine, literal, select
from sqlalchemy.ext.asyncio import create_async_engine

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.db.sqlite import install_sqlite_pragmas
from karaoke_backend.models.song import Song
from karaoke_backend.search import normalized_search, search_predicate


@pytest.mark.parametrize("query,fields,expected", [
    ("dont stop", ("Don't Stop Believin'",), 1),
    ("don't stop", ("Don’t Stop Believin’",), 1),
    ("don", ("Don't Stop",), 1),
    ("stop journey", ("Don't Stop", "Journey"), 1),
    ("acdc", ("AC/DC",), 1),
    ("ac/dc", ("AC DC",), 1),
    ("hello world", ("Hello,World",), 1),
    ("hello,world", ("Hello World",), 1),
    ("rock roll", ("Rock & Roll",), 1),
    ("  stop\t  dont ", ("Don't\nStop",), 1),
    ("BEYONCE", ("Beyoncé",), 1),
    ("beyonce", ("𝐁𝐞𝐲𝐨𝐧𝐜é",), 1),
    ("𝐁𝐄𝐘𝐎𝐍𝐂𝐄", ("Beyoncé",), 1),
    ("dont dont stop stop", ("Don't Stop",), 1),
    ("beyonce", ("Beyonce\u0301",), 1),
    ("STRASSE", ("Straße",), 1),
    ("%", ("100% Love",), 1),
    ("%", ("Any song",), 0),
    ("_", ("under_score",), 1),
    ("_", ("under score",), 0),
    ("+", ("Any song",), 0),
    ("stop missing", ("Don't Stop", "Journey"), 0),
    ("hello", ("hel", "lo"), 0),
    ("title", (None, "Title"), 1),
    ("title", (None, None), 0),
    ("'’.,/", ("Any song",), 0),
    ("\u0301", ("Any song",), 0),
    ("   ", (None,), 1),
])
def test_matching_contract(query, fields, expected):
    assert normalized_search(query, *fields) == expected


def test_registration_on_each_sync_connection(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'search.db'}")
    install_sqlite_pragmas(engine, foreign_keys=True)
    try:
        with engine.connect() as first, engine.connect() as second:
            for conn in (first, second):
                assert conn.scalar(select(search_predicate("dont", literal("Don’t"))))
        engine.dispose()
        with engine.connect() as fresh:
            assert fresh.scalar(select(search_predicate("beyonce", literal("Beyoncé"))))
    finally:
        engine.dispose()


@pytest.mark.asyncio
async def test_registration_on_each_async_connection(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'search-async.db'}")
    install_sqlite_pragmas(engine.sync_engine, foreign_keys=True)
    try:
        async with engine.connect() as first, engine.connect() as second:
            for conn in (first, second):
                assert await conn.scalar(select(search_predicate("dont", literal("Don’t"))))
        await engine.dispose()
        async with engine.connect() as fresh:
            assert await fresh.scalar(select(search_predicate("acdc", literal("AC/DC"))))
    finally:
        await engine.dispose()


async def seed_songs():
    async with AsyncSessionLocal() as db:
        rows = [
            Song(
                owner_id=1,
                title="Don't Stop Believin'",
                artist="Beyoncé",
                filename="secret-code.mp3",
                status="ready",
            ),
            Song(
                owner_id=1,
                title="Don’t Stop Again",
                artist="Beyonce",
                filename="other.mp3",
                status="ready",
            ),
            Song(
                owner_id=1,
                title="Unrelated",
                artist="AC/DC",
                filename="100%_sample.mp3",
                status="ready",
            ),
            Song(
                owner_id=2,
                title="Don't Stop Believin'",
                artist="Beyoncé",
                filename="foreign.mp3",
                status="ready",
            ),
        ]
        db.add_all(rows)
        await db.commit()
        return [row.id for row in rows]


@pytest.mark.asyncio
async def test_library_counts_pages_artist_grouping_and_literal_search(client):
    ids = await seed_songs()
    for page, expected in [(1, ids[1]), (2, ids[0])]:
        response = await client.get(
            "/api/songs",
            params={"search": "beyonce dont stop", "page_size": 1, "page": page},
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["total"] == 2
        assert [song["id"] for song in data["songs"]] == [expected]
    for query, expected in [
        ("%", 1), ("_", 1), ("!!!", 0), ("beyonce missing", 0), ("secretcode", 1),
    ]:
        data = (await client.get("/api/songs", params={"search": query})).json()
        assert data["total"] == expected
    artists = (await client.get(
        "/api/songs/artists", params={"search": "BEYONCE", "page_size": 1},
    )).json()
    assert artists["total"] == 2
    assert len(artists["items"]) == 1
    exact = (await client.get("/api/songs", params={"artist_exact": "Beyoncé"})).json()
    assert [song["id"] for song in exact["songs"]] == [ids[0]]
    for endpoint, params in [
        ("/api/songs", {"artist": "acdc"}),
        ("/api/songs/artists", {"search": "acdc"}),
    ]:
        assert (await client.get(endpoint, params=params)).json()["total"] == 1


@pytest.mark.asyncio
async def test_guest_cannot_search_filename_even_with_title_word(client):
    from karaoke_backend.api.auth import get_current_user, get_host_id
    from karaoke_backend.main import app

    await seed_songs()
    app.dependency_overrides[get_current_user] = lambda: None
    app.dependency_overrides[get_host_id] = lambda: 1
    try:
        for query in ("secretcode", "dont secretcode", "%", "_"):
            response = await client.get("/api/songs", params={"search": query})
            assert response.status_code == 200, response.text
            assert response.json()["total"] == 0
        data = (await client.get("/api/songs", params={"search": "beyonce dont"})).json()
        assert data["total"] == 2
        assert all(song["filename"] is None for song in data["songs"])
    finally:
        app.dependency_overrides.pop(get_current_user)
        app.dependency_overrides.pop(get_host_id)


@pytest.mark.asyncio
async def test_history_shared_matching_count_and_offset(client):
    ids = await seed_songs()
    for song_id, singer in [(ids[0], "Renée"), (ids[1], "Renee"), (ids[2], None)]:
        response = await client.post(
            "/api/history", json={"song_id": song_id, "singer_name": singer},
        )
        assert response.status_code == 201, response.text
    for offset, expected in [(0, ids[1]), (1, ids[0])]:
        data = (await client.get(
            "/api/history",
            params={"search": "renee dont beyonce", "limit": 1, "offset": offset},
        )).json()
        assert data["total"] == 2
        assert [entry["song_id"] for entry in data["entries"]] == [expected]
    for query in ("%", "_", "!!!", "secretcode"):
        assert (await client.get("/api/history", params={"search": query})).json()["total"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint,param", [
    ("/api/songs", "search"),
    ("/api/songs", "artist"),
    ("/api/songs/artists", "search"),
    ("/api/history", "search"),
])
async def test_search_input_length_is_bounded(client, endpoint, param):
    response = await client.get(endpoint, params={param: "x" * 201})
    assert response.status_code == 422
