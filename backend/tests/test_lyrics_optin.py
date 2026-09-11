# SPDX-License-Identifier: AGPL-3.0-only
"""The built-in lyrics provider is opt-in and OFF by default — a project bright line.

A stock install must never contact lrclib.net. These tests pin the three
things that make that true: the flag defaults to off, the single choke point
refuses before any network call, and no caller reaches the network around it.

Note the sibling suite ``test_lyrics.py`` patches ``api.lyrics.fetch_lyrics``
and so deliberately exercises the route's response mapping with the choke
point stubbed out. This file is the other half: the choke point itself.
"""

import inspect
import re
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from karaoke_backend import branding
from karaoke_backend.api.auth import hash_password
from karaoke_backend.workers import lyrics_worker
from karaoke_backend.workers.lyrics_worker import (
    LRCLIB_ENV,
    LyricsProviderDisabledError,
    LyricsServiceError,
    fetch_lyrics,
    fetch_lyrics_by_provider,
    lrclib_enabled,
)

GATE_PW = "correct horse"


@pytest.fixture(autouse=True)
def _lookup_off_by_default(monkeypatch):
    """Neutralize any ambient opt-in from the developer's own environment.

    Without this the suite would pass on a machine that has KARAOKE_LRCLIB
    exported — which is exactly the machine this feature exists to protect
    everyone else from.
    """
    monkeypatch.delenv(LRCLIB_ENV, raising=False)


# ---------------------------------------------------------------------------
# The flag
# ---------------------------------------------------------------------------


def test_disabled_by_default():
    assert lrclib_enabled() is False


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", " On "])
def test_grant_values(monkeypatch, value):
    monkeypatch.setenv(LRCLIB_ENV, value)
    assert lrclib_enabled() is True


@pytest.mark.parametrize(
    "value", ["", "0", "false", "no", "off", "maybe", "2", "enabled", "y"]
)
def test_non_grant_values_are_off(monkeypatch, value):
    """Only the documented grant values count.

    A typo must not be an authorization to query a third-party lyrics
    database, so anything unrecognized — including near-misses like "y" and
    "enabled" — reads as off.
    """
    monkeypatch.setenv(LRCLIB_ENV, value)
    assert lrclib_enabled() is False


def test_flag_is_read_at_call_time(monkeypatch):
    """No import-time snapshot: a drop-in edit takes effect on restart, and a
    test can flip it without reimporting the module."""
    assert lrclib_enabled() is False
    monkeypatch.setenv(LRCLIB_ENV, "1")
    assert lrclib_enabled() is True
    monkeypatch.delenv(LRCLIB_ENV)
    assert lrclib_enabled() is False


# ---------------------------------------------------------------------------
# The choke point
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_lyrics_refuses_without_touching_the_network():
    """The refusal must precede the HTTP call, not merely discard its result."""
    with patch.object(lyrics_worker, "_async_get", new=AsyncMock()) as net:
        with pytest.raises(LyricsProviderDisabledError):
            await fetch_lyrics(artist="Radiohead", title="Creep")
    net.assert_not_called()


@pytest.mark.asyncio
async def test_fetch_lyrics_proceeds_when_enabled(monkeypatch):
    monkeypatch.setenv(LRCLIB_ENV, "1")
    payload = {
        "artistName": "Radiohead",
        "trackName": "Creep",
        "albumName": "Pablo Honey",
        "duration": 238.0,
        "plainLyrics": "When you were here before",
        "syncedLyrics": "[00:01.00] When you were here before",
    }
    with patch.object(lyrics_worker, "_async_get", new=AsyncMock(return_value=payload)) as net:
        result = await fetch_lyrics(artist="Radiohead", title="Creep")
    net.assert_awaited()
    assert result.artist == "Radiohead"
    assert result.source == "lrclib.net"


@pytest.mark.asyncio
async def test_builtin_name_routes_through_the_choke_point():
    """`fetch_lyrics_by_provider` must not be a way around the opt-in."""
    for name in (None, "", "lrclib"):
        with pytest.raises(LyricsProviderDisabledError):
            await fetch_lyrics_by_provider(name, "Radiohead", "Creep")


def test_disabled_error_is_a_service_error():
    """Subclassing is load-bearing: callers that already degrade gracefully on
    a service error (ingest, reference_mode=auto) inherit correct behavior
    without a new branch each."""
    assert issubclass(LyricsProviderDisabledError, LyricsServiceError)


#: Modules allowed to name the lrclib transport, each because it owns a gated
#: fetch. Anything else naming it is a bypass. Keep this list short — every
#: entry is a second place the opt-in has to be re-proved.
_LRCLIB_TRANSPORT_OWNERS = {
    "backend/src/karaoke_backend/workers/lyrics_worker.py",
    "backend/tests/test_lyrics_optin.py",
}

#: Anything that *addresses* the service, as opposed to merely naming it.
#: Matching a constructed URL — not just our own identifiers — is what makes
#: this catch a module that hand-rolls its own client, which is exactly how
#: the historical bypass survived. The bare hostname is deliberately NOT matched:
#: it is the user-visible source label and appears legitimately in error
#: copy, docstrings and assertions.
_LRCLIB_TRANSPORT = re.compile(
    r"https?://lrclib\.net|lrclib\.net/api|LRCLIB_BASE|_async_get"
)


def _repo_root() -> Path:
    root = Path(lyrics_worker.__file__).resolve().parents[4]
    assert (root / ".git").exists(), (
        f"{root} is not a git repo root — this guard scans the whole "
        f"repository and must fail closed rather than scan a subtree"
    )
    return root


def test_no_caller_reaches_the_network_around_the_choke_point():
    """Structural guard: only the gated fetchers may touch the lrclib transport.

    The opt-in holds because every request funnels through a function that
    checks the flag first. A module that builds its own client silently
    reopens the bypass — which is not hypothetical: a since-deleted utility
    package once carried a complete second fetch implementation, ungated, and
    an earlier version of this guard could not see it because it scanned
    only the backend package.

    So: scan the whole repository, match the hostname as well as our own
    identifiers, and fail closed if the scan finds nothing to look at.
    """
    root = _repo_root()
    tracked = subprocess.run(
        ["git", "ls-files", "-z", "*.py"],
        cwd=root, capture_output=True, text=True, check=True,
    ).stdout.split("\0")

    scanned = 0
    offenders = []
    for rel in tracked:
        if not rel:
            continue
        path = root / rel
        if not path.exists():
            continue
        scanned += 1
        if rel in _LRCLIB_TRANSPORT_OWNERS:
            continue
        if _LRCLIB_TRANSPORT.search(path.read_text(errors="replace")):
            offenders.append(rel)

    assert scanned > 50, (
        f"only {scanned} files scanned — the guard is not looking at the "
        f"repository and would pass vacuously"
    )
    assert offenders == [], (
        f"These modules reach the lrclib transport directly, bypassing the "
        f"opt-in check in lyrics_worker.fetch_lyrics: {offenders}"
    )


def test_no_stale_brand_reaches_third_parties():
    """No outbound identifier may carry the pre-rebrand product name."""
    root = _repo_root()
    tracked = subprocess.run(
        ["git", "ls-files", "-z", "*.py"],
        cwd=root, capture_output=True, text=True, check=True,
    ).stdout.split("\0")
    # Split so this file is not its own match. Every retired name stays on
    # the list forever — a rebrand appends, never replaces.
    stale = ["KaraokeSuite" + "/", "Song" + "haus" + "/"]
    offenders = [
        rel for rel in tracked
        if rel and (root / rel).exists()
        and any(s in (root / rel).read_text(errors="replace") for s in stale)
    ]
    assert offenders == [], f"stale User-Agent brand in: {offenders}"


def test_user_agent_identifies_the_product():
    """Outbound requests must not carry the pre-rebrand identifier."""
    assert lyrics_worker.USER_AGENT == branding.USER_AGENT
    assert lyrics_worker.USER_AGENT.startswith(branding.PRODUCT_NAME + "/")
    assert "KaraokeSuite" not in lyrics_worker.USER_AGENT
    # Pin the WHOLE shape, not a fragment. RFC 9110 is
    # ``product *( RWS ( product / comment ) )`` — the space before the comment
    # is required, and a substring check for "(url)" would accept both a UA with
    # no space and a version string that itself contains whitespace (which then
    # parses as a second product token).
    # Referenced, never spelled: this file is not on the brand allowlist.
    assert re.fullmatch(
        rf"{re.escape(branding.PRODUCT_NAME)}/\S+ \({re.escape(branding.REPO_URL)}\)",
        lyrics_worker.USER_AGENT,
    ), lyrics_worker.USER_AGENT
    # The brand gate allowlists branding.py for the WHOLE brand pattern, and the
    # stale-name sweep above is case-sensitive — so a REPO_URL typed with a
    # retired codename would be invisible to both and ship on every request.
    # Tying the URL to the slug is what closes that gap. It also covers the one
    # malformation the pattern above cannot see: an empty REPO_URL yields a bare
    # "()", which is a structurally valid comment and matches.
    assert branding.PRODUCT_SLUG in branding.REPO_URL


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lyrics_route_503_when_off(client: AsyncClient):
    """Unpatched: the real choke point answers, so this is the stock-install
    response for the explicit lookup endpoint."""
    resp = await client.get(
        "/api/lyrics", params={"artist": "Radiohead", "title": "Creep"}
    )
    assert resp.status_code == 503
    assert "turned off" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_lyrics_route_200_when_on(monkeypatch, client: AsyncClient):
    monkeypatch.setenv(LRCLIB_ENV, "1")
    payload = {
        "artistName": "Radiohead",
        "trackName": "Creep",
        "albumName": None,
        "duration": None,
        "plainLyrics": "When you were here before",
        "syncedLyrics": None,
    }
    with patch.object(lyrics_worker, "_async_get", new=AsyncMock(return_value=payload)):
        resp = await client.get(
            "/api/lyrics", params={"artist": "Radiohead", "title": "Creep"}
        )
    assert resp.status_code == 200
    assert resp.json()["source"] == "lrclib.net"


@pytest.mark.asyncio
async def test_features_reports_off_then_on(monkeypatch, client: AsyncClient):
    resp = await client.get("/api/features")
    assert resp.status_code == 200
    feature = resp.json()["lyrics_lookup"]
    assert feature["enabled"] is False
    assert feature["provider"] == "lrclib"
    assert feature["label"] == "lrclib.net"

    monkeypatch.setenv(LRCLIB_ENV, "1")
    resp = await client.get("/api/features")
    assert resp.json()["lyrics_lookup"]["enabled"] is True


@pytest.mark.asyncio
async def test_lyrics_and_features_fail_closed_behind_a_locked_gate(
    monkeypatch, client: AsyncClient
):
    """Both routes sit behind require_user.

    /api/lyrics makes an outbound third-party request on the caller's behalf,
    and /api/features describes the operator's deployment posture. With a gate
    password set and no unlocked session, neither may answer. This is the
    gating api/gate.py deferred to this track.
    """
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD_HASH", hash_password(GATE_PW))
    monkeypatch.setenv(LRCLIB_ENV, "1")

    resp = await client.get(
        "/api/lyrics", params={"artist": "Radiohead", "title": "Creep"}
    )
    assert resp.status_code == 401

    resp = await client.get("/api/features")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------


def test_ingest_checks_the_flag_before_announcing_a_lookup():
    """The ingest path branches on the flag itself, not just on the raised error.

    Absorbing ``LyricsProviderDisabledError`` downstream would already produce
    a correct alignment, so what this pins is the operator-facing half:
    announcing "Looking up lyrics…" for a lookup that cannot happen
    misdescribes the run, and "off" must be distinguishable from "found
    nothing".

    This is a source-structure smoke check, not a behavioral one — driving
    ``run_ingest`` needs the whole separation pipeline. It anchors on the
    ``set_phase`` call rather than on any prose, because an earlier version
    of this test matched the word "announcing" inside the very comment that
    explains the branch, and so compared two lines that always move together.
    """
    from karaoke_backend.jobs import ingest

    source = inspect.getsource(ingest.run_ingest)

    # Polarity, not just presence: `elif lrclib_enabled():` would swap the two
    # phase messages while still containing the call.
    assert "elif not lrclib_enabled():" in source, (
        "ingest must take the skip branch when the lookup is OFF"
    )

    disabled_branch = source.index("elif not lrclib_enabled():")
    announce = source.index("JobPhase.FETCHING_LYRICS.value, 0,")
    assert disabled_branch < announce, (
        "the opt-in check must precede the 'Looking up lyrics' set_phase call"
    )
