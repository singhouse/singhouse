# SPDX-License-Identifier: AGPL-3.0-only
"""Response security headers.

Written as pure ASGI rather than ``@app.middleware("http")`` because the latter
installs ``BaseHTTPMiddleware``, which routes every response body through an
extra task and memory stream — this service streams stem downloads and serves
the SPA through StaticFiles, and a static header does not justify making all of
that pay for a wrapper. These tests pin that shape, not just the header value.
"""

import pytest
from httpx import AsyncClient

from karaoke_backend.main import SecurityHeaders


@pytest.mark.asyncio
async def test_responses_suppress_the_referer_header(client: AsyncClient):
    response = await client.get("/health")
    assert response.headers["referrer-policy"] == "no-referrer"


@pytest.mark.asyncio
async def test_a_route_may_override_the_referrer_policy():
    async def inner(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"referrer-policy", b"same-origin")],
            }
        )

    sent = []

    async def send(message):
        sent.append(message)

    await SecurityHeaders(inner)({"type": "http"}, None, send)
    assert dict(sent[0]["headers"])[b"referrer-policy"] == b"same-origin"


@pytest.mark.asyncio
async def test_start_message_without_headers_is_tolerated():
    """ASGI permits it; a raw mounted app need not set one.

    ``MutableHeaders(scope=message)`` raises KeyError without the key, so this
    is the difference between a provider-contributed ASGI app working and 500ing.
    """

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 204})

    sent = []

    async def send(message):
        sent.append(message)

    await SecurityHeaders(inner)({"type": "http"}, None, send)
    assert dict(sent[0]["headers"])[b"referrer-policy"] == b"no-referrer"


@pytest.mark.asyncio
async def test_non_http_scopes_are_passed_through_unwrapped():
    """The wrapper must not be installed on websocket/lifespan traffic."""
    captured = {}

    async def inner(scope, receive, send):
        captured["send"] = send
        captured["receive"] = receive

    sentinel_send, sentinel_receive = object(), object()
    await SecurityHeaders(inner)(
        {"type": "websocket"}, sentinel_receive, sentinel_send
    )
    assert captured["send"] is sentinel_send
    assert captured["receive"] is sentinel_receive
