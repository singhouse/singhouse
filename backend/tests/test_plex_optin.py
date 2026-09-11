# SPDX-License-Identifier: AGPL-3.0-only
"""Reading lyrics off the media server is opt-in and OFF by default.

The audio half of a Plex import is unconditional — it is the operator's own
file, on the operator's own server. The LYRIC half is not: Plex can populate
lyrics from a licensed metadata supplier, and whether that text may be reused
as an alignment reference is a provenance question nobody here can answer from
a JSON field. So it is gated, and these tests pin the same three properties
``test_lyrics_optin.py`` pins for lrclib: the flag defaults off, only the
documented values grant it, and the choke point refuses BEFORE any network
call — asserted by patching the module's single JSON entry point and proving
it was never reached.
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from karaoke_backend.plex import client as plex_client
from karaoke_backend.plex.client import PlexClient, PlexLyricsDisabledError
from karaoke_backend.plex.config import PLEX_LYRICS_ENV, plex_lyrics_enabled


@pytest.fixture(autouse=True)
def _lyrics_off_by_default(monkeypatch):
    """Neutralize any ambient opt-in from the developer's own environment.

    Without this the suite would pass on a machine that exports the flag —
    exactly the machine the default exists to protect everyone else from.
    """
    monkeypatch.delenv(PLEX_LYRICS_ENV, raising=False)


# ---------------------------------------------------------------------------
# The flag
# ---------------------------------------------------------------------------


def test_disabled_by_default():
    assert plex_lyrics_enabled() is False


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", " On "])
def test_grant_values(monkeypatch, value):
    monkeypatch.setenv(PLEX_LYRICS_ENV, value)
    assert plex_lyrics_enabled() is True


@pytest.mark.parametrize(
    "value", ["", "0", "false", "no", "off", "maybe", "2", "enabled", "y"]
)
def test_non_grant_values_are_off(monkeypatch, value):
    """A typo is not an authorization. Only the documented values grant."""
    monkeypatch.setenv(PLEX_LYRICS_ENV, value)
    assert plex_lyrics_enabled() is False


def test_flag_is_read_at_call_time(monkeypatch):
    """No import-time snapshot: a drop-in edit takes effect on restart, and a
    test can flip it without reimporting the module."""
    assert plex_lyrics_enabled() is False
    monkeypatch.setenv(PLEX_LYRICS_ENV, "1")
    assert plex_lyrics_enabled() is True
    monkeypatch.delenv(PLEX_LYRICS_ENV)
    assert plex_lyrics_enabled() is False


# ---------------------------------------------------------------------------
# The choke point
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_refuses_before_any_network_call():
    """Off means the request never happens, not that the answer is discarded."""
    with patch.object(plex_client, "_get", new=AsyncMock()) as get:
        client = PlexClient("http://plex.lan:32400", "tok")
        with pytest.raises(PlexLyricsDisabledError):
            await client.fetch_plain_lyrics("1234")
    get.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_error_is_a_plex_error():
    """Callers that already absorb "no lyrics came back" absorb the opt-out too."""
    assert issubclass(PlexLyricsDisabledError, plex_client.PlexError)


@pytest.mark.asyncio
async def test_enabled_reaches_the_choke_point(monkeypatch):
    monkeypatch.setenv(PLEX_LYRICS_ENV, "1")
    metadata = {
        "MediaContainer": {
            "Metadata": [
                {
                    "ratingKey": "1234",
                    "Media": [
                        {"Part": [{"Stream": [
                            {"streamType": 4, "format": "txt", "key": "/library/streams/9"}
                        ]}]}
                    ],
                }
            ]
        }
    }
    with patch.object(plex_client, "_get", new=AsyncMock(return_value=metadata)) as get:
        with patch.object(
            plex_client, "_get_text", new=AsyncMock(return_value="a line\n")
        ):
            client = PlexClient("http://plex.lan:32400", "tok")
            assert await client.fetch_plain_lyrics("1234") == "a line"
    get.assert_called_once()


# ---------------------------------------------------------------------------
# The reported capability
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_features_reports_plex_lyrics_off(client: AsyncClient):
    res = await client.get("/api/features")
    assert res.status_code == 200
    assert res.json()["plex_lyrics"]["enabled"] is False


@pytest.mark.asyncio
async def test_features_reports_plex_lyrics_on(client: AsyncClient, monkeypatch):
    monkeypatch.setenv(PLEX_LYRICS_ENV, "yes")
    res = await client.get("/api/features")
    assert res.json()["plex_lyrics"]["enabled"] is True


@pytest.mark.asyncio
async def test_plex_settings_reports_the_flag(client: AsyncClient, monkeypatch):
    monkeypatch.setenv(PLEX_LYRICS_ENV, "1")
    res = await client.get("/api/plex/settings")
    assert res.status_code == 200
    assert res.json()["lyrics_enabled"] is True
