# SPDX-License-Identifier: AGPL-3.0-only
import pytest
from fastapi import HTTPException
from karaoke_backend.api.auth import get_current_user, get_host_id
from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.main import app
from karaoke_backend.models.song import Song


@pytest.mark.asyncio
async def test_artist_browse_scopes_groups_and_pages(client):
    async with AsyncSessionLocal() as db:
        for i, (artist, title, owner, status) in enumerate([
            ('Bowie', 'Zebra', 1, 'ready'), ('Bowie', 'Alpha', 1, 'ready'),
            ('Bowie & Friends', 'Duet', 1, 'ready'), ('bowie', 'Lower', 1, 'ready'),
            ('Other', 'Private', 2, 'ready'), ('Pending', 'Soon', 1, 'processing'),
            ('100% Artist', 'Literal', 1, 'ready'),
        ]):
            db.add(Song(artist=artist, title=title, owner_id=owner, status=status, filename=f'{i}.wav'))
        await db.commit()
    app.dependency_overrides[get_current_user] = lambda: None
    app.dependency_overrides[get_host_id] = lambda: 1
    try:
        r = await client.get('/api/songs/artists', params={'search': 'bowie', 'page_size': 1})
        assert r.status_code == 200
        assert r.json() == {'items': [{'artist': 'Bowie', 'count': 2}], 'total': 3, 'page': 1, 'page_size': 1}
        r = await client.get('/api/songs/artists', params={'search': 'bowie', 'page_size': 1, 'page': 2})
        assert r.json()['items'] == [{'artist': 'bowie', 'count': 1}]
        r = await client.get('/api/songs/artists', params={'search': '%'})
        assert r.json()['items'] == [{'artist': '100% Artist', 'count': 1}]
        r = await client.get('/api/songs', params={'artist_exact': 'Bowie', 'status': 'ready', 'page_size': 1})
        assert r.json()['total'] == 2
        assert r.json()['songs'][0]['title'] == 'Alpha'
        r = await client.get('/api/songs', params={'artist_exact': 'Bowie', 'search': 'Zebra'})
        assert r.json()['total'] == 1
        r = await client.get('/api/songs/artists', params={'host': 2})
        assert 'Other' not in [a['artist'] for a in r.json()['items']]
        assert 'Pending' not in [a['artist'] for a in r.json()['items']]
        app.dependency_overrides[get_host_id] = lambda: 2
        r = await client.get('/api/songs/artists')
        assert r.json()['items'] == [{'artist': 'Other', 'count': 1}]
        def denied():
            raise HTTPException(status_code=401)
        app.dependency_overrides[get_host_id] = denied
        assert (await client.get('/api/songs/artists')).status_code == 401
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_host_id, None)


@pytest.mark.asyncio
async def test_song_pages_are_stable_when_added_times_match(client):
    from datetime import datetime, timezone

    added = datetime(2026, 1, 1, tzinfo=timezone.utc)
    async with AsyncSessionLocal() as db:
        songs = [Song(artist="One artist", title="Same title", owner_id=1,
                      status="ready", filename=f"song-{i}.wav", created_at=added)
                 for i in range(4)]
        db.add_all(songs)
        await db.commit()
        ids = [song.id for song in songs]

    async def page_ids(params):
        response = await client.get('/api/songs', params=params)
        assert response.status_code == 200
        return [song['id'] for song in response.json()['songs']]

    first = await page_ids({'page': 1, 'page_size': 2})
    second = await page_ids({'page': 2, 'page_size': 2})
    assert first + second == list(reversed(ids))
    first = await page_ids({'artist_exact': 'One artist', 'page': 1, 'page_size': 2})
    second = await page_ids({'artist_exact': 'One artist', 'page': 2, 'page_size': 2})
    assert first + second == ids
