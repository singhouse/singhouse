# SPDX-License-Identifier: AGPL-3.0-only
"""The Plex library source: settings, parsing, browse, import, and the job.

Four things are load-bearing enough to pin here.

1. **The token never comes back out.** It is a credential for the operator's
   whole media library. It is stored outside the database at mode 0600, it is
   absent from every response body, and the only fact any route reports about
   it is whether one exists.
2. **Parsing is done against canned server JSON**, not against a live server,
   so the shapes this code claims to understand are written down.
3. **The import route writes rows and returns** — the ``/api/separate``
   contract, with the cap and the ownership check that go with it.
4. **The job materialises audio and then delegates**, under the ``{job_id}_``
   upload name the reaper depends on, and never touches the library file
   except to read it.
"""

from __future__ import annotations

import json
import stat
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs import registry
from karaoke_backend.jobs.base import JobContext
from karaoke_backend.models.song import Job, JobKind, Song
from karaoke_backend.plex import client as plex_client
from karaoke_backend.plex import config as plex_config
from karaoke_backend.plex.client import (
    MAX_TEXT_BYTES,
    PlexAuthError,
    PlexClient,
    PlexError,
    parse_track,
    strip_lrc_timestamps,
)
from karaoke_backend.plex.config import (
    PLEX_LYRICS_ENV,
    PLEX_PATH_MAP_ENV,
    PLEX_TOKEN_ENV,
    PLEX_URL_ENV,
    PlexConfigError,
)

SERVER = "http://plex.lan:32400"


@pytest.fixture(autouse=True)
def _clean_plex_env(monkeypatch):
    """No ambient Plex configuration, and no token left over from a sibling test."""
    for name in (PLEX_URL_ENV, PLEX_TOKEN_ENV, PLEX_LYRICS_ENV, PLEX_PATH_MAP_ENV):
        monkeypatch.delenv(name, raising=False)
    plex_config.clear_stored_token()
    yield
    plex_config.clear_stored_token()


# ---------------------------------------------------------------------------
# Canned server JSON
# ---------------------------------------------------------------------------

SECTIONS_JSON = {
    "MediaContainer": {
        "size": 3,
        "Directory": [
            {"key": "1", "type": "movie", "title": "Films"},
            {"key": "2", "type": "artist", "title": "Music"},
            {"key": "3", "type": "artist", "title": "Live sets"},
        ],
    }
}

TRACKS_JSON = {
    "MediaContainer": {
        "size": 2,
        "totalSize": 4210,
        "Metadata": [
            {
                "ratingKey": "5501",
                "title": "Zither Blues",
                "grandparentTitle": "Ackerman",
                "parentTitle": "Long Player",
                "duration": 214000,
                "Media": [
                    {
                        "container": "flac",
                        "Part": [
                            {
                                "key": "/library/parts/9001/1/file.flac",
                                "file": "/srv/music/Ackerman/Long Player/01 Zither Blues.flac",
                                "container": "flac",
                                "Stream": [
                                    {"streamType": 2, "codec": "flac"},
                                    {"streamType": 4, "format": "lrc",
                                     "key": "/library/streams/77"},
                                ],
                            }
                        ],
                    }
                ],
            },
            {
                "ratingKey": "5502",
                "title": "Second Take",
                "grandparentTitle": "Ackerman",
                "duration": 190000,
                "Media": [
                    {
                        "Part": [
                            {
                                "key": "/library/parts/9002/1/file.mp3",
                                "file": "/srv/music/Ackerman/Long Player/02 Second Take.mp3",
                                "container": "mp3",
                                "Stream": [{"streamType": 2, "codec": "mp3"}],
                            }
                        ]
                    }
                ],
            },
        ],
    }
}

METADATA_JSON = {
    "MediaContainer": {
        "Metadata": [
            {
                "ratingKey": "5501",
                "title": "Zither Blues",
                "Media": [
                    {
                        "Part": [
                            {
                                "Stream": [
                                    {"streamType": 4, "format": "lrc",
                                     "key": "/library/streams/77"},
                                    {"streamType": 4, "format": "txt",
                                     "key": "/library/streams/78"},
                                ]
                            }
                        ]
                    }
                ],
            }
        ]
    }
}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_settings_default_shape(client: AsyncClient):
    res = await client.get("/api/plex/settings")
    assert res.status_code == 200
    assert res.json() == {
        "url": "",
        "token_set": False,
        "source": "settings",
        "lyrics_enabled": False,
    }


@pytest.mark.asyncio
async def test_settings_round_trip(client: AsyncClient):
    res = await client.put(
        "/api/plex/settings", json={"url": f"{SERVER}/", "token": "sekrit"}
    )
    assert res.status_code == 200
    body = res.json()
    # Trailing slash normalised off so callers can join paths with one slash.
    assert body["url"] == SERVER
    assert body["token_set"] is True

    again = await client.get("/api/plex/settings")
    assert again.json()["url"] == SERVER
    assert again.json()["token_set"] is True


@pytest.mark.asyncio
async def test_token_never_appears_in_any_settings_body(client: AsyncClient):
    put = await client.put("/api/plex/settings", json={"url": SERVER, "token": "sekrit"})
    get = await client.get("/api/plex/settings")
    assert "sekrit" not in put.text
    assert "sekrit" not in get.text
    assert "token" not in get.json()


@pytest.mark.asyncio
async def test_token_file_is_0600(client: AsyncClient):
    await client.put("/api/plex/settings", json={"token": "sekrit"})
    path = plex_config.token_path()
    assert path.is_file()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert path.read_text(encoding="utf-8") == "sekrit"


@pytest.mark.asyncio
async def test_token_file_stays_0600_when_rewritten(client: AsyncClient):
    await client.put("/api/plex/settings", json={"token": "first"})
    plex_config.token_path().chmod(0o644)      # a laxer earlier version, say
    await client.put("/api/plex/settings", json={"token": "second"})
    path = plex_config.token_path()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert path.read_text(encoding="utf-8") == "second"


@pytest.mark.asyncio
async def test_empty_token_deletes_the_file(client: AsyncClient):
    await client.put("/api/plex/settings", json={"token": "sekrit"})
    assert plex_config.token_path().is_file()
    res = await client.put("/api/plex/settings", json={"token": ""})
    assert res.json()["token_set"] is False
    assert not plex_config.token_path().exists()


@pytest.mark.asyncio
async def test_omitted_token_leaves_the_stored_one_alone(client: AsyncClient):
    await client.put("/api/plex/settings", json={"token": "sekrit"})
    res = await client.put("/api/plex/settings", json={"url": SERVER})
    assert res.json()["token_set"] is True
    assert plex_config.token_path().read_text(encoding="utf-8") == "sekrit"


@pytest.mark.asyncio
async def test_url_must_carry_an_http_scheme(client: AsyncClient):
    res = await client.put("/api/plex/settings", json={"url": "plex.lan:32400"})
    assert res.status_code == 400
    assert "http" in res.json()["detail"]


@pytest.mark.asyncio
async def test_env_override_makes_the_settings_read_only(
    client: AsyncClient, monkeypatch
):
    monkeypatch.setenv(PLEX_URL_ENV, "http://pinned.lan:32400/")
    monkeypatch.setenv(PLEX_TOKEN_ENV, "from-env")

    get = await client.get("/api/plex/settings")
    assert get.json()["source"] == "env"
    assert get.json()["url"] == "http://pinned.lan:32400"
    assert get.json()["token_set"] is True
    assert "from-env" not in get.text

    put = await client.put("/api/plex/settings", json={"url": SERVER})
    assert put.status_code == 409


@pytest.mark.asyncio
async def test_env_url_alone_pins_the_settings(client: AsyncClient, monkeypatch):
    """Half-pinned configuration is the state with no coherent reading."""
    monkeypatch.setenv(PLEX_URL_ENV, SERVER)
    assert (await client.get("/api/plex/settings")).json()["source"] == "env"
    assert (await client.put("/api/plex/settings", json={"url": SERVER})).status_code == 409


def test_normalize_url_rejects_a_missing_host():
    with pytest.raises(PlexConfigError):
        plex_config.normalize_url("http://")


def test_normalize_url_passes_empty_through():
    assert plex_config.normalize_url("  ") == ""


# ---------------------------------------------------------------------------
# Client parsing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_libraries_keeps_only_music_sections():
    with patch.object(plex_client, "_get", new=AsyncMock(return_value=SECTIONS_JSON)):
        libraries = await PlexClient(SERVER, "tok").list_libraries()
    assert [(lib.key, lib.title) for lib in libraries] == [
        ("2", "Music"), ("3", "Live sets")
    ]


@pytest.mark.asyncio
async def test_list_tracks_parses_a_page():
    get = AsyncMock(return_value=TRACKS_JSON)
    with patch.object(plex_client, "_get", new=get):
        page = await PlexClient(SERVER, "tok").list_tracks("2", offset=40, limit=25)

    assert page.total == 4210
    first, second = page.items
    assert first.rating_key == "5501"
    assert first.artist == "Ackerman"
    assert first.album == "Long Player"
    assert first.duration_ms == 214000
    assert first.part_key == "/library/parts/9001/1/file.flac"
    assert first.file_path.endswith("01 Zither Blues.flac")
    assert first.container == "flac"
    assert first.has_lyrics is True
    assert second.has_lyrics is False

    # The container window is what pages, not a client-side slice.
    _url, kwargs = get.call_args[0], get.call_args[1]
    assert kwargs["params"]["X-Plex-Container-Start"] == 40
    assert kwargs["params"]["X-Plex-Container-Size"] == 25
    assert kwargs["params"]["type"] == 10


@pytest.mark.asyncio
async def test_the_token_travels_as_a_header_not_a_query_param():
    get = AsyncMock(return_value=SECTIONS_JSON)
    with patch.object(plex_client, "_get", new=get):
        await PlexClient(SERVER, "sekrit").list_libraries()
    url = get.call_args[0][0]
    assert "sekrit" not in url
    assert get.call_args[1]["headers"]["X-Plex-Token"] == "sekrit"


def test_parse_track_drops_rows_it_cannot_address():
    assert parse_track({"title": "No key"}) is None
    assert parse_track({"ratingKey": "1", "title": "   "}) is None


def test_parse_track_falls_back_to_the_file_extension_for_the_container():
    track = parse_track({
        "ratingKey": "9", "title": "T", "grandparentTitle": "A",
        "Media": [{"Part": [{"file": "/srv/music/A/t.OGG"}]}],
    })
    assert track.container == "ogg"


def test_strip_lrc_timestamps():
    lrc = (
        "[ar:Ackerman]\n"
        "[ti:Zither Blues]\n"
        "[00:12.30]first line\n"
        "[00:15.00][01:02.50]repeated line\n"
        "\n"
        "[01:30.10]last line\n"
    )
    assert strip_lrc_timestamps(lrc) == "first line\nrepeated line\nlast line"


@pytest.mark.asyncio
async def test_fetch_plain_lyrics_prefers_txt_over_lrc(monkeypatch):
    monkeypatch.setenv(PLEX_LYRICS_ENV, "1")
    get_text = AsyncMock(return_value="plain words\n")
    with patch.object(plex_client, "_get", new=AsyncMock(return_value=METADATA_JSON)):
        with patch.object(plex_client, "_get_text", new=get_text):
            out = await PlexClient(SERVER, "tok").fetch_plain_lyrics("5501")
    assert out == "plain words"
    assert get_text.call_args[0][0].endswith("/library/streams/78")


@pytest.mark.asyncio
async def test_fetch_plain_lyrics_strips_an_lrc_stream(monkeypatch):
    monkeypatch.setenv(PLEX_LYRICS_ENV, "1")
    lrc_only = json.loads(json.dumps(METADATA_JSON))
    streams = lrc_only["MediaContainer"]["Metadata"][0]["Media"][0]["Part"][0]["Stream"]
    del streams[1]  # leave only the lrc stream
    with patch.object(plex_client, "_get", new=AsyncMock(return_value=lrc_only)):
        with patch.object(
            plex_client, "_get_text",
            new=AsyncMock(return_value="[00:01.00]only line\n"),
        ):
            out = await PlexClient(SERVER, "tok").fetch_plain_lyrics("5501")
    assert out == "only line"


@pytest.mark.asyncio
async def test_fetch_plain_lyrics_returns_none_when_the_track_has_none(monkeypatch):
    """Missing lyrics are not an error — every song may ingest without them."""
    monkeypatch.setenv(PLEX_LYRICS_ENV, "1")
    bare = {"MediaContainer": {"Metadata": [{"ratingKey": "5502", "Media": []}]}}
    with patch.object(plex_client, "_get", new=AsyncMock(return_value=bare)):
        assert await PlexClient(SERVER, "tok").fetch_plain_lyrics("5502") is None


@pytest.mark.asyncio
async def test_client_without_a_url_refuses_rather_than_guessing():
    with pytest.raises(PlexError):
        await PlexClient("", "tok").list_libraries()


# ---------------------------------------------------------------------------
# Browse + test routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_test_route_reports_the_libraries(client: AsyncClient):
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    with patch.object(plex_client, "_get", new=AsyncMock(return_value=SECTIONS_JSON)):
        res = await client.post("/api/plex/test")
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert [lib["title"] for lib in res.json()["libraries"]] == ["Music", "Live sets"]


@pytest.mark.asyncio
async def test_test_route_reports_a_rejected_token_without_a_401(client: AsyncClient):
    """A rejected media-server token must not read as a rejected SESSION.

    401 here would trip the frontend's auth interceptor and bounce the operator
    to the unlock gate for mistyping a third-party credential.
    """
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "bad"})
    with patch.object(
        plex_client, "_get", new=AsyncMock(side_effect=PlexAuthError("nope"))
    ):
        res = await client.post("/api/plex/test")
    assert res.status_code == 400
    assert "rejected the token" in res.json()["detail"]


@pytest.mark.asyncio
async def test_browse_without_a_url_is_a_400(client: AsyncClient):
    res = await client.get("/api/plex/libraries")
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_track_listing_passes_both_filters_to_the_server(client: AsyncClient):
    """The filters are the SERVER's, over the whole library.

    Filtering the fetched page was the bug this replaced: against a library of
    tens of thousands of tracks, page one is an alphabetical accident, so an
    artist filter applied to it essentially never matched.
    """
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    get = AsyncMock(return_value=TRACKS_JSON)
    with patch.object(plex_client, "_get", new=get):
        res = await client.get(
            "/api/plex/libraries/2/tracks",
            params={"artist": "ackerman", "title": "zither", "offset": 200},
        )
    assert res.status_code == 200
    params = get.call_args[1]["params"]
    assert params["artist.title"] == "ackerman"
    assert params["title"] == "zither"
    assert params["X-Plex-Container-Start"] == 200

    body = res.json()
    # Nothing is dropped locally any more: whatever the server returned for
    # the filtered window is the page.
    assert [t["title"] for t in body["tracks"]] == ["Zither Blues", "Second Take"]
    # And `total` is the server's count of the MATCHES, passed straight through.
    assert body["total"] == 4210


@pytest.mark.asyncio
async def test_track_listing_omits_absent_filters(client: AsyncClient):
    """An unset filter is not sent at all.

    Omitting and sending blank are different requests: measured against Plex
    1.43.3, ``title=`` matches EVERYTHING (all 62,948 rows), so a blank that
    slipped through would read as "no filter" while costing a full-library
    scan and an honest-looking total.
    """
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    get = AsyncMock(return_value=TRACKS_JSON)
    with patch.object(plex_client, "_get", new=get):
        await client.get("/api/plex/libraries/2/tracks", params={"artist": "  "})
    params = get.call_args[1]["params"]
    assert "title" not in params
    assert "artist.title" not in params


@pytest.mark.asyncio
async def test_track_listing_sends_only_the_filter_given(client: AsyncClient):
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    get = AsyncMock(return_value=TRACKS_JSON)
    with patch.object(plex_client, "_get", new=get):
        await client.get("/api/plex/libraries/2/tracks", params={"artist": "ackerman"})
    params = get.call_args[1]["params"]
    assert params["artist.title"] == "ackerman"
    assert "title" not in params


@pytest.mark.asyncio
async def test_track_filters_are_length_capped(client: AsyncClient):
    """A filter is something a person typed; anything longer is not a term."""
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    res = await client.get(
        "/api/plex/libraries/2/tracks", params={"title": "x" * 201}
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_client_strips_filter_whitespace():
    get = AsyncMock(return_value=TRACKS_JSON)
    with patch.object(plex_client, "_get", new=get):
        await PlexClient(SERVER, "tok").list_tracks(
            "2", offset=0, limit=10, title="  zither  ", artist="  ackerman  "
        )
    params = get.call_args[1]["params"]
    assert params["title"] == "zither"
    assert params["artist.title"] == "ackerman"


@pytest.mark.asyncio
async def test_a_comma_in_a_filter_is_narrowed_to_its_longest_term():
    """A comma is Plex's OR, with no escape — so send only one fragment.

    Measured on a live 1.43.3 server: ``artist.title=joel,action`` returned
    101 rows, the 74 for "joel" plus the 27 for "action". Forwarding the raw
    string would silently widen "Emerson, Lake & Palmer" into three unrelated
    searches. The longest fragment is the most selective single term, and its
    result is always a superset of what was asked for.
    """
    get = AsyncMock(return_value=TRACKS_JSON)
    with patch.object(plex_client, "_get", new=get):
        await PlexClient(SERVER, "tok").list_tracks(
            "2", artist="Emerson, Lake & Palmer", title="one, three"
        )
    params = get.call_args[1]["params"]
    assert params["artist.title"] == "Lake & Palmer"
    assert params["title"] == "three"
    # Never the raw string: that would be an OR the operator did not ask for.
    assert "," not in str(params["artist.title"])


@pytest.mark.asyncio
async def test_a_filter_of_only_commas_is_omitted():
    get = AsyncMock(return_value=TRACKS_JSON)
    with patch.object(plex_client, "_get", new=get):
        await PlexClient(SERVER, "tok").list_tracks("2", artist=" , , ")
    assert "artist.title" not in get.call_args[1]["params"]


# ---------------------------------------------------------------------------
# Import route
# ---------------------------------------------------------------------------


def _track(rating_key="5501", title="Zither Blues"):
    return {
        "rating_key": rating_key,
        "title": title,
        "artist": "Ackerman",
        "part_key": "/library/parts/9001/1/file.flac",
        "file_path": "/srv/music/Ackerman/Long Player/01 Zither Blues.flac",
        "container": "flac",
        "has_lyrics": True,
    }


@pytest.mark.asyncio
async def test_import_creates_song_and_job_rows(client: AsyncClient, host_user: dict):
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    res = await client.post("/api/plex/import", json={"tracks": [_track()]})
    assert res.status_code == 202
    job = res.json()["jobs"][0]
    assert job["title"] == "Zither Blues"

    async with AsyncSessionLocal() as db:
        song = await db.get(Song, job["song_id"])
        assert song.status == "processing"
        assert song.artist == "Ackerman"
        assert song.job_id == job["job_id"]
        assert song.owner_id == host_user["id"]

        row = (
            await db.execute(select(Job).where(Job.id == job["job_id"]))
        ).scalar_one()
        assert row.kind == JobKind.PLEX_IMPORT.value
        assert row.status == "queued"
        payload = json.loads(row.payload)
        assert payload["rating_key"] == "5501"
        assert payload["artist"] == "Ackerman"
        assert payload["title"] == "Zither Blues"
        assert payload["has_lyrics"] is True
        assert payload["karaoke_model"]      # defaulted, never absent


@pytest.mark.asyncio
async def test_import_caps_the_batch(client: AsyncClient):
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    tracks = [_track(str(i), f"Track {i}") for i in range(201)]
    res = await client.post("/api/plex/import", json={"tracks": tracks})
    assert res.status_code == 400
    assert "200" in res.json()["detail"]

    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(Song))).scalars().all() == []


@pytest.mark.asyncio
async def test_import_refuses_an_empty_selection(client: AsyncClient):
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    assert (await client.post("/api/plex/import", json={"tracks": []})).status_code == 400


@pytest.mark.asyncio
async def test_import_refuses_before_a_server_is_configured(client: AsyncClient):
    res = await client.post("/api/plex/import", json={"tracks": [_track()]})
    assert res.status_code == 400
    async with AsyncSessionLocal() as db:
        assert (await db.execute(select(Song))).scalars().all() == []


@pytest.mark.asyncio
async def test_every_plex_route_requires_the_host(monkeypatch):
    """No guest surface. Core single-host proves it through the gate: with a
    password set and no session, every route answers 401."""
    from karaoke_backend.api.auth import hash_password
    from karaoke_backend.main import app

    monkeypatch.setenv("KARAOKE_GATE_PASSWORD_HASH", hash_password("correct horse"))

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as anon:
        for method, path in (
            ("get", "/api/plex/settings"),
            ("put", "/api/plex/settings"),
            ("post", "/api/plex/test"),
            ("get", "/api/plex/libraries"),
            ("get", "/api/plex/libraries/2/tracks"),
            ("post", "/api/plex/import"),
        ):
            call = getattr(anon, method)
            res = await call(path, json={}) if method != "get" else await call(path)
            assert res.status_code == 401, f"{method.upper()} {path} was not gated"


# ---------------------------------------------------------------------------
# The job kind + handler
# ---------------------------------------------------------------------------


def test_plex_import_is_a_registered_kind():
    spec = registry.get_spec(JobKind.PLEX_IMPORT.value)
    assert spec is not None
    assert spec.target == "karaoke_backend.jobs.plex_import:run_plex_import"
    # The job IS the song's creation, so a failure must drag the song with it.
    assert spec.mirrors_song_status is True
    assert spec.handler is not None


def _ctx(job_id="job-1", payload=None) -> JobContext:
    return JobContext(
        job_id=job_id,
        kind=JobKind.PLEX_IMPORT.value,
        worker_id="worker-1",
        owner_id=1,
        song_id=7,
        payload=payload or {},
    )


def _media_json(file_path, *, part_key="/library/parts/9001/1/file.flac",
                lyrics=False):
    """A ``/library/metadata/{key}`` document naming one part."""
    stream = [{"streamType": 4, "format": "txt", "key": "/library/streams/78"}] \
        if lyrics else []
    return {
        "MediaContainer": {
            "Metadata": [
                {
                    "ratingKey": "5501",
                    "title": "Zither Blues",
                    "grandparentTitle": "Ackerman",
                    "Media": [
                        {"Part": [{
                            "key": part_key,
                            "file": file_path,
                            "container": "flac",
                            "Stream": stream,
                        }]}
                    ],
                }
            ]
        }
    }


@pytest.fixture
def ingest_spy(monkeypatch):
    """Patch out the pipeline and the lease, and record the delegated context.

    Also configures a server URL: the handler now resolves every track's media
    through the server before it opens anything, so a configured URL is a
    precondition of the job rather than of the network path alone.
    """
    from karaoke_backend.jobs import plex_import

    monkeypatch.setenv(PLEX_URL_ENV, SERVER)
    seen: dict = {}

    async def fake_run_ingest(ctx):
        seen["ctx"] = ctx
        return "Ingest complete"

    monkeypatch.setattr(plex_import, "run_ingest", fake_run_ingest)
    monkeypatch.setattr(
        plex_import.queue, "update_progress", AsyncMock(return_value=True)
    )
    return seen


@pytest.mark.asyncio
async def test_handler_copies_the_library_file_and_delegates(
    tmp_path, monkeypatch, ingest_spy
):
    """The local-storage path: copy off disk, hand a normal ingest payload on.

    The library file must still be there afterwards, byte-identical. This job
    reads the operator's collection; it never rearranges it.
    """
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import plex_import

    library_file = tmp_path / "01 Zither Blues.flac"
    library_file.write_bytes(b"AUDIO-BYTES")

    ctx = _ctx(payload={
        "rating_key": "5501",
        "artist": "Ackerman",
        "title": "Zither Blues",
        "has_lyrics": True,
        "llm_paging": False,
        "karaoke_model": "some-model",
    })

    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json(str(library_file), lyrics=True)),
    ):
        assert await plex_import.run_plex_import(ctx) == "Ingest complete"

    upload = UPLOADS_DIR / "job-1_01 Zither Blues.flac"
    assert upload.is_file()
    assert upload.read_bytes() == b"AUDIO-BYTES"
    assert library_file.read_bytes() == b"AUDIO-BYTES"   # untouched original
    # The rename left nothing behind.
    assert not (UPLOADS_DIR / "job-1_01 Zither Blues.flac.partial").exists()

    delegated = ingest_spy["ctx"]
    assert delegated.job_id == ctx.job_id
    assert delegated.song_id == ctx.song_id
    assert delegated.worker_id == ctx.worker_id
    assert delegated.payload == {
        "upload_path": "job-1_01 Zither Blues.flac",
        "artist": "Ackerman",
        "title": "Zither Blues",
        # The track HAS lyrics on the server, but the opt-in is off.
        "pasted_lyrics": None,
        "llm_paging": False,
        "karaoke_model": "some-model",
    }
    upload.unlink()


@pytest.mark.asyncio
async def test_handler_ignores_a_client_supplied_file_path(
    tmp_path, monkeypatch, ingest_spy
):
    """The request body is not an authority on this machine's filesystem.

    A payload that names a readable file outside the library must not get it
    copied into the song library. Only the path the SERVER reports for the
    rating key is opened — and that is what lands.
    """
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import plex_import

    planted = tmp_path / "not-in-the-library.flac"
    planted.write_bytes(b"SECRET-BYTES")
    real = tmp_path / "01 Zither Blues.flac"
    real.write_bytes(b"AUDIO-BYTES")

    ctx = _ctx(job_id="job-9", payload={
        "rating_key": "5501",
        "artist": "Ackerman",
        "title": "Zither Blues",
        # Whatever a doctored client might send, alongside the real key.
        "file_path": str(planted),
        "part_key": "/library/parts/evil/file.flac",
    })

    with patch.object(
        plex_client, "_get", new=AsyncMock(return_value=_media_json(str(real)))
    ):
        await plex_import.run_plex_import(ctx)

    upload = UPLOADS_DIR / "job-9_01 Zither Blues.flac"
    assert upload.read_bytes() == b"AUDIO-BYTES"
    assert not (UPLOADS_DIR / "job-9_not-in-the-library.flac").exists()
    # The planted file was never read, and nothing anywhere holds its bytes.
    assert ingest_spy["ctx"].payload["upload_path"] == "job-9_01 Zither Blues.flac"
    upload.unlink()


@pytest.mark.asyncio
async def test_import_route_keeps_paths_out_of_the_payload(client: AsyncClient):
    """The durable payload carries a rating key, not a filesystem path."""
    await client.put("/api/plex/settings", json={"url": SERVER, "token": "tok"})
    res = await client.post("/api/plex/import", json={"tracks": [_track()]})
    job = res.json()["jobs"][0]

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(Job).where(Job.id == job["job_id"]))
        ).scalar_one()
        payload = json.loads(row.payload)

    assert payload["rating_key"] == "5501"
    for banned in ("file_path", "part_key", "container"):
        assert banned not in payload, f"{banned} must not reach the worker"


@pytest.mark.asyncio
async def test_handler_carries_lyrics_only_when_opted_in(
    tmp_path, monkeypatch, ingest_spy
):
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import plex_import

    monkeypatch.setenv(PLEX_LYRICS_ENV, "1")
    library_file = tmp_path / "t.mp3"
    library_file.write_bytes(b"AUDIO")

    ctx = _ctx(job_id="job-2", payload={
        "rating_key": "5501", "artist": "Ackerman",
        "title": "Zither Blues", "has_lyrics": True,
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json(str(library_file), lyrics=True)),
    ):
        with patch.object(
            plex_client, "_get_text", new=AsyncMock(return_value="plain words\n")
        ):
            await plex_import.run_plex_import(ctx)

    assert ingest_spy["ctx"].payload["pasted_lyrics"] == "plain words"
    (UPLOADS_DIR / "job-2_t.mp3").unlink()


@pytest.mark.asyncio
async def test_handler_streams_when_the_library_file_is_not_visible(
    monkeypatch, ingest_spy
):
    """The fallback path, and the upload naming the reaper depends on."""
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import plex_import

    seen: dict = {}

    async def fake_fetch_part_to(self, part_key, dest):
        # The handler streams into the `.partial` name and renames after.
        assert str(dest).endswith(".partial")
        Path(dest).write_bytes(b"STREAMED")
        seen["part_key"] = part_key
        return 8

    monkeypatch.setattr(PlexClient, "fetch_part_to", fake_fetch_part_to)

    ctx = _ctx(job_id="job-3", payload={
        "rating_key": "5502", "artist": "Ackerman", "title": "Second Take",
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json(
            "/srv/music/not/visible/here.mp3",
            part_key="/library/parts/9002/1/file.mp3",
        )),
    ):
        await plex_import.run_plex_import(ctx)

    # The part key came off the server document, not the request.
    assert seen["part_key"] == "/library/parts/9002/1/file.mp3"
    upload = UPLOADS_DIR / "job-3_here.mp3"
    assert upload.is_file()
    assert not (UPLOADS_DIR / "job-3_here.mp3.partial").exists()
    assert ingest_spy["ctx"].payload["upload_path"] == "job-3_here.mp3"
    upload.unlink()


@pytest.mark.asyncio
async def test_handler_maps_the_library_path(tmp_path, monkeypatch, ingest_spy):
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import plex_import

    local = tmp_path / "mapped.mp3"
    local.write_bytes(b"AUDIO")
    monkeypatch.setenv(PLEX_PATH_MAP_ENV, f"/media=>{tmp_path}")

    ctx = _ctx(job_id="job-4", payload={
        "rating_key": "1", "artist": "A", "title": "T",
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json("/media/mapped.mp3")),
    ):
        await plex_import.run_plex_import(ctx)

    upload = UPLOADS_DIR / "job-4_mapped.mp3"
    assert upload.read_bytes() == b"AUDIO"
    upload.unlink()


@pytest.mark.asyncio
async def test_handler_failure_leaves_no_upload_behind(monkeypatch, ingest_spy):
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import base, plex_import

    async def boom(self, part_key, dest):
        Path(dest).write_bytes(b"PARTIAL")
        raise PlexError("the server went away")

    monkeypatch.setattr(PlexClient, "fetch_part_to", boom)

    ctx = _ctx(job_id="job-5", payload={
        "rating_key": "1", "artist": "A", "title": "T",
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json("/srv/music/absent.mp3")),
    ):
        with pytest.raises(base.JobFailure) as excinfo:
            await plex_import.run_plex_import(ctx)

    assert "server went away" in str(excinfo.value)
    assert not (UPLOADS_DIR / "job-5_absent.mp3").exists()
    assert not (UPLOADS_DIR / "job-5_absent.mp3.partial").exists()


@pytest.mark.asyncio
async def test_handler_reuses_an_upload_a_previous_attempt_finished(
    monkeypatch, ingest_spy
):
    """Re-entry: the bytes are already here, so nothing is asked of the server."""
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import plex_import

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    existing = UPLOADS_DIR / "job-6_already.flac"
    existing.write_bytes(b"AUDIO")

    ctx = _ctx(job_id="job-6", payload={
        "rating_key": "1", "artist": "A", "title": "T",
    })
    with patch.object(plex_client, "_get", new=AsyncMock()) as network:
        await plex_import.run_plex_import(ctx)
    network.assert_not_called()

    assert ingest_spy["ctx"].payload["upload_path"] == "job-6_already.flac"
    existing.unlink()


@pytest.mark.asyncio
async def test_handler_ignores_a_partial_left_by_a_dead_attempt(
    tmp_path, monkeypatch, ingest_spy
):
    """A `.partial` is a copy that did NOT finish — reusing it feeds the
    separator a truncated track, so it is re-fetched rather than adopted."""
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import plex_import

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    stale = UPLOADS_DIR / "job-7_t.mp3.partial"
    stale.write_bytes(b"TRUNC")
    library_file = tmp_path / "t.mp3"
    library_file.write_bytes(b"WHOLE-AUDIO")

    ctx = _ctx(job_id="job-7", payload={
        "rating_key": "1", "artist": "A", "title": "T",
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json(str(library_file))),
    ):
        await plex_import.run_plex_import(ctx)

    upload = UPLOADS_DIR / "job-7_t.mp3"
    assert upload.read_bytes() == b"WHOLE-AUDIO"
    assert not stale.exists()
    upload.unlink()


@pytest.mark.asyncio
async def test_an_ingest_failure_releases_the_copy_this_import_made(
    tmp_path, monkeypatch, ingest_spy
):
    """Where this job's upload rule diverges from ingest's, and why.

    ``jobs.ingest`` now RETAINS the upload it is handed on a permanent failure,
    so ``POST /api/songs/{id}/retry`` can replay phase 1 from it. A Plex import
    must not inherit that: a retry of one re-downloads the track from the
    operator's server, so the copy this job made would be read by nobody and
    collected by nothing. It is dropped by the job that made it — the only code
    that knows it was a copy rather than the operator's own file.
    """
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import base, plex_import

    library_file = tmp_path / "orphan.flac"
    library_file.write_bytes(b"AUDIO-BYTES")

    async def failing_ingest(ctx):
        raise base.JobFailure("Stem separation failed", "gpu said no")

    monkeypatch.setattr(plex_import, "run_ingest", failing_ingest)

    ctx = _ctx(job_id="job-11", payload={
        "rating_key": "1", "artist": "A", "title": "T",
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json(str(library_file))),
    ):
        with pytest.raises(base.JobFailure) as excinfo:
            await plex_import.run_plex_import(ctx)

    assert "Stem separation failed" in str(excinfo.value)
    assert not (UPLOADS_DIR / "job-11_orphan.flac").exists()
    # The operator's library is untouched, as on every other path here.
    assert library_file.read_bytes() == b"AUDIO-BYTES"


@pytest.mark.asyncio
async def test_a_lost_lease_inside_ingest_leaves_the_copy_alone(
    tmp_path, monkeypatch, ingest_spy
):
    """The other half of the rule: a lapsed claim is not this job's failure.

    Whoever holds the job now re-enters through ``_existing_upload`` and reuses
    these exact bytes, so deleting them here would be aimed at somebody else's
    work — and would cost a second download of a track already on disk.
    """
    from karaoke_backend.api.separate import UPLOADS_DIR
    from karaoke_backend.jobs import base, plex_import

    library_file = tmp_path / "kept.flac"
    library_file.write_bytes(b"AUDIO-BYTES")

    async def lease_lost_ingest(ctx):
        raise base.LeaseLost(ctx.job_id)

    monkeypatch.setattr(plex_import, "run_ingest", lease_lost_ingest)

    ctx = _ctx(job_id="job-12", payload={
        "rating_key": "1", "artist": "A", "title": "T",
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value=_media_json(str(library_file))),
    ):
        with pytest.raises(base.LeaseLost):
            await plex_import.run_plex_import(ctx)

    upload = UPLOADS_DIR / "job-12_kept.flac"
    assert upload.is_file()
    upload.unlink()


@pytest.mark.asyncio
async def test_handler_skips_materialisation_once_separation_is_complete(
    monkeypatch, ingest_spy
):
    """The stems are the artifact — re-fetching the source would be work
    done to throw away, and ingest's own marker check skips past it anyway."""
    from karaoke_backend.api.separate import STEMS_DIR
    from karaoke_backend.jobs import plex_import
    from karaoke_backend.jobs.ingest import write_separation_marker

    stems_dir = STEMS_DIR / "7"
    stems_dir.mkdir(parents=True, exist_ok=True)
    write_separation_marker(stems_dir)
    try:
        ctx = _ctx(job_id="job-8", payload={
            "rating_key": "1", "artist": "A", "title": "T",
        })
        with patch.object(plex_client, "_get", new=AsyncMock()) as network:
            assert await plex_import.run_plex_import(ctx) == "Ingest complete"
        network.assert_not_called()
        # None, not a name for a file that was never written: ingest reads
        # this only when its marker is absent.
        assert ingest_spy["ctx"].payload["upload_path"] is None
    finally:
        (stems_dir / ".separation-complete").unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_handler_fails_cleanly_when_the_track_is_gone(monkeypatch, ingest_spy):
    from karaoke_backend.jobs import base, plex_import

    ctx = _ctx(job_id="job-10", payload={
        "rating_key": "404", "artist": "A", "title": "T",
    })
    with patch.object(
        plex_client, "_get",
        new=AsyncMock(return_value={"MediaContainer": {"Metadata": []}}),
    ):
        with pytest.raises(base.JobFailure) as excinfo:
            await plex_import.run_plex_import(ctx)
    assert "no longer in the media server's library" in str(excinfo.value)


# ---------------------------------------------------------------------------
# The transport itself — exercised through httpx.MockTransport, so the bytes
# and the headers are real without a socket being involved.
# ---------------------------------------------------------------------------


def _mock_client_factory(handler, recorder=None):
    """A drop-in for ``plex_client._async_client`` backed by a mock transport."""
    def factory(**kwargs):
        def wrapped(request):
            if recorder is not None:
                recorder.append(request)
            return handler(request)
        return httpx.AsyncClient(
            transport=httpx.MockTransport(wrapped),
            timeout=kwargs.get("timeout", 5),
            # Mirrors the real factory's invariant: never follow a redirect.
            follow_redirects=False,
        )
    return factory


@pytest.mark.asyncio
async def test_stream_refuses_a_body_over_the_cap(tmp_path):
    dest = tmp_path / "big.flac"

    def handler(_request):
        return httpx.Response(
            200, headers={"content-type": "audio/flac"}, content=b"x" * 4096
        )

    with patch.object(plex_client, "_async_client", _mock_client_factory(handler)):
        with pytest.raises(PlexError) as excinfo:
            await plex_client._stream_to(
                f"{SERVER}/library/parts/1/file.flac", dest,
                headers={}, max_bytes=1024,
            )
    assert "larger than" in str(excinfo.value)
    # The refusal takes its own partial bytes with it.
    assert not dest.exists()


@pytest.mark.asyncio
async def test_stream_unlinks_on_a_transport_failure(tmp_path):
    dest = tmp_path / "gone.flac"

    def handler(request):
        raise httpx.ConnectError("connection reset", request=request)

    with patch.object(plex_client, "_async_client", _mock_client_factory(handler)):
        with pytest.raises(PlexError):
            await plex_client._stream_to(
                f"{SERVER}/library/parts/1/file.flac", dest,
                headers={}, max_bytes=1024 * 1024,
            )
    assert not dest.exists()


@pytest.mark.asyncio
async def test_stream_maps_a_401_to_plex_auth_error(tmp_path):
    dest = tmp_path / "denied.flac"

    def handler(_request):
        return httpx.Response(401, content=b"")

    with patch.object(plex_client, "_async_client", _mock_client_factory(handler)):
        with pytest.raises(PlexAuthError):
            await plex_client._stream_to(
                f"{SERVER}/library/parts/1/file.flac", dest,
                headers={}, max_bytes=1024 * 1024,
            )
    assert not dest.exists()


@pytest.mark.asyncio
async def test_a_redirect_never_carries_the_token_to_another_host(tmp_path):
    """The credential rides in a header, and httpx replays headers onto a
    redirect target — so a 3xx is refused rather than followed."""
    dest = tmp_path / "redirected.flac"
    seen: list = []

    def handler(_request):
        return httpx.Response(302, headers={"location": "https://elsewhere.example/x"})

    factory = _mock_client_factory(handler, recorder=seen)
    with patch.object(plex_client, "_async_client", factory):
        with pytest.raises(PlexError) as excinfo:
            await plex_client._stream_to(
                f"{SERVER}/library/parts/1/file.flac", dest,
                headers={"X-Plex-Token": "sekrit"}, max_bytes=1024 * 1024,
            )

    assert "redirect" in str(excinfo.value).lower()
    # Exactly one request, to the configured host, and nothing reached the
    # redirect target at all.
    assert len(seen) == 1
    assert seen[0].url.host == "plex.lan"
    assert not any(r.url.host == "elsewhere.example" for r in seen)
    assert not dest.exists()


@pytest.mark.asyncio
async def test_stream_refuses_a_non_audio_body(tmp_path):
    """An HTML sign-in page answered with a 200 is not a track."""
    dest = tmp_path / "login.flac"

    def handler(_request):
        return httpx.Response(
            200, headers={"content-type": "text/html"}, content=b"<html>sign in</html>"
        )

    with patch.object(plex_client, "_async_client", _mock_client_factory(handler)):
        with pytest.raises(PlexError) as excinfo:
            await plex_client._stream_to(
                f"{SERVER}/library/parts/1/file.flac", dest,
                headers={}, max_bytes=1024 * 1024, require_audio=True,
            )
    assert "did not return audio" in str(excinfo.value)
    assert not dest.exists()


@pytest.mark.parametrize(
    "content_type",
    ["audio/flac", "audio/mpeg", "application/octet-stream", "audio/mp4; charset=x", ""],
)
@pytest.mark.asyncio
async def test_stream_accepts_the_audio_types_the_upload_route_accepts(
    tmp_path, content_type
):
    dest = tmp_path / f"ok-{content_type.replace('/', '_') or 'none'}.flac"

    def handler(_request):
        headers = {"content-type": content_type} if content_type else {}
        return httpx.Response(200, headers=headers, content=b"AUDIO")

    with patch.object(plex_client, "_async_client", _mock_client_factory(handler)):
        written = await plex_client._stream_to(
            f"{SERVER}/library/parts/1/file.flac", dest,
            headers={}, max_bytes=1024 * 1024, require_audio=True,
        )
    assert written == 5
    assert dest.read_bytes() == b"AUDIO"


@pytest.mark.asyncio
async def test_get_text_caps_the_body():
    def handler(_request):
        return httpx.Response(200, content=b"y" * (MAX_TEXT_BYTES + 1))

    with patch.object(plex_client, "_async_client", _mock_client_factory(handler)):
        with pytest.raises(PlexError) as excinfo:
            await plex_client._get_text(f"{SERVER}/library/streams/1", headers={})
    assert "larger than" in str(excinfo.value)


@pytest.mark.asyncio
async def test_get_text_returns_a_body_under_the_cap():
    def handler(_request):
        return httpx.Response(200, content="a line\n".encode("utf-8"))

    with patch.object(plex_client, "_async_client", _mock_client_factory(handler)):
        assert await plex_client._get_text(
            f"{SERVER}/library/streams/1", headers={}
        ) == "a line\n"


# ---------------------------------------------------------------------------
# Path mapping
# ---------------------------------------------------------------------------


def test_path_map_leaves_paths_alone_when_unset(monkeypatch):
    monkeypatch.delenv(PLEX_PATH_MAP_ENV, raising=False)
    assert plex_config.map_library_path("/srv/music/a.mp3") == "/srv/music/a.mp3"


def test_path_map_first_matching_rule_wins(monkeypatch):
    monkeypatch.setenv(PLEX_PATH_MAP_ENV, "/media=>/srv/music; /data=>/srv/other")
    assert plex_config.map_library_path("/data/x.mp3") == "/srv/other/x.mp3"
    assert plex_config.map_library_path("/media/x.mp3") == "/srv/music/x.mp3"
    assert plex_config.map_library_path("/elsewhere/x.mp3") == "/elsewhere/x.mp3"
