# SPDX-License-Identifier: AGPL-3.0-only
"""Cache-Control on the SPA static mount.

Deploys publish with rsync --delete, so files the current build dropped really
are gone from the served tree. That makes a heuristically cached index.html a
404 generator rather than a stale-but-working page, which is why every stable
name revalidates and only the content-hashed assets/ names are cacheable
forever. These tests pin the two rules and the 404-fallback path between them.
"""

from typing import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from karaoke_backend.main import SPAStaticFiles

IMMUTABLE = "public, max-age=31536000, immutable"


@pytest_asyncio.fixture
async def static_client(tmp_path) -> AsyncGenerator[AsyncClient, None]:
    """A mount over a miniature build output: hashed assets + stable names."""
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>app</title>")
    (tmp_path / "assets" / "chunk-abc123.js").write_text("export const x = 1\n")
    (tmp_path / "pitch-processor.js").write_text("// worklet\n")

    app = FastAPI()
    app.mount("/", SPAStaticFiles(directory=str(tmp_path), html=True), name="static")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest.mark.asyncio
async def test_index_revalidates(static_client: AsyncClient):
    response = await static_client.get("/")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
async def test_hashed_assets_are_immutable(static_client: AsyncClient):
    response = await static_client.get("/assets/chunk-abc123.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == IMMUTABLE


@pytest.mark.asyncio
async def test_spa_fallback_serves_index_and_revalidates(static_client: AsyncClient):
    """The router route that only exists client-side still must not be cached."""
    response = await static_client.get("/some/spa/route")
    assert response.status_code == 200
    assert "<title>app</title>" in response.text
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
async def test_unhashed_root_files_revalidate(static_client: AsyncClient):
    response = await static_client.get("/pitch-processor.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
async def test_missing_asset_falls_back_to_index_and_revalidates(
    static_client: AsyncClient,
):
    """A pruned asset must fall back as index.html, NOT as an immutable asset.

    This is the case the deploy prune actually creates: a stale index.html
    still references chunk names the new build deleted. The fallback re-serves
    index.html, and the cache rule keys off the name we SERVED ("index.html"),
    not the name that was asked for — get that backwards and the fallback body
    ships with `immutable`, freezing the wrong page into the browser forever.
    """
    response = await static_client.get("/assets/gone-deadbeef.js")
    assert response.status_code == 200
    assert "<title>app</title>" in response.text
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
async def test_conditional_requests_keep_cache_control_on_304(
    static_client: AsyncClient,
):
    """304s carry the rule too, or the browser re-learns nothing from them.

    A 304 replaces the cached response's headers. If it arrives without
    Cache-Control, the client keeps whatever policy it stored last time — so
    both the immutable promise on assets and the no-cache obligation on
    index.html would decay to heuristic caching after the first revalidation.
    """
    for path, expected in (("/assets/chunk-abc123.js", IMMUTABLE), ("/", "no-cache")):
        first = await static_client.get(path)
        assert first.status_code == 200
        assert first.headers["cache-control"] == expected

        revalidated = await static_client.get(
            path, headers={"If-None-Match": first.headers["etag"]}
        )
        assert revalidated.status_code == 304, path
        assert revalidated.headers["cache-control"] == expected, path


@pytest.mark.asyncio
async def test_traversal_out_of_assets_is_not_immutable(static_client: AsyncClient):
    """`assets/../index.html` resolves to index.html, so it revalidates.

    The immutable rule trusts a name prefix, and the path is normalised before
    the rule sees it — this pins that ordering. Were the rule applied to the
    raw request path, index.html would be cacheable for a year via a URL any
    page can link to.
    """
    response = await static_client.get("/assets/../index.html")
    assert response.status_code == 200
    assert "<title>app</title>" in response.text
    assert response.headers["cache-control"] == "no-cache"
