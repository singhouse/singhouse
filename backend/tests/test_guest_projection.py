# SPDX-License-Identifier: AGPL-3.0-only
"""Core-side coverage for the guest projection on the song list.

The projection (`_GUEST_SONG_FIELDS`, `_to_guest_summary`) is core code and
will ship in the public repo, so it needs a test that ships with it. Its
end-to-end behaviour is exercised in the multi-user suite, because the "scoped
but unauthenticated" caller it defends against is a multi-tenant state: in
single-host mode a locked gate refuses to resolve a host scope at all, so there
is no such caller to serve. That makes an HTTP-level test impossible here and a
direct one necessary — otherwise core ships a security control with no test.
"""

import pytest
from httpx import AsyncClient

from karaoke_backend.api.songs import (
    _GUEST_SONG_FIELDS,
    SongSummary,
    _to_guest_summary,
)

GATE_PW = "test-gate-pw"


def _full_summary() -> SongSummary:
    """A row with every provenance channel populated."""
    return SongSummary(
        id=1,
        artist="Artist",
        title="Title",
        filename="acme-6422.dat",
        duration=180.0,
        status="ready",
        created_at="2026-01-01T00:00:00",
        lyrics_synced=True,
        phase="done",
        progress=100,
        message="Queued acme import for Artist – Title",
        external_provider="acme",
        lyrics_format_version=2,
        external_id="6422",
    )


def test_projection_withholds_every_provenance_channel():
    """Neither the named provenance fields nor the job-derived ones survive."""
    guest = _to_guest_summary(_full_summary())

    for field in (
        "filename",
        "external_provider",
        "external_id",
        "lyrics_format_version",
        "phase",
        "progress",
        "message",
    ):
        assert getattr(guest, field) is None, f"{field} survived the projection"

    # Serialized form carries no vendor-derived substring either — the point is
    # the value, not the field name it arrived under.
    body = guest.model_dump_json()
    assert "acme" not in body
    assert "6422" not in body


def test_projection_keeps_what_the_join_page_needs():
    """Withholding is not the only requirement; the picker still has to work."""
    guest = _to_guest_summary(_full_summary())

    assert guest.id == 1
    assert guest.artist == "Artist"
    assert guest.title == "Title"
    assert guest.status == "ready"
    assert guest.duration == 180.0


def test_allowlist_excludes_importer_authored_free_text():
    """A guard against re-adding the job-derived fields.

    `message` is composed by whatever code created the job, and the import path
    writes a provider's display label into it. Any field whose contents are
    free text an importer authored can carry provenance regardless of what the
    field is called, which is the one way an allowlist keyed on names fails.
    """
    for field in ("message", "phase", "progress"):
        assert field not in _GUEST_SONG_FIELDS, (
            f"{field!r} is job-derived free text or its metadata — it must not "
            f"be served to an unauthenticated caller"
        )


def test_allowlist_is_a_subset_of_the_model():
    """A typo'd field name would silently withhold a field nobody meant to."""
    assert _GUEST_SONG_FIELDS <= set(SongSummary.model_fields)


@pytest.mark.asyncio
async def test_provider_discovery_closed_behind_a_locked_gate(
    client: AsyncClient, monkeypatch
):
    """`/api/catalog/providers` follows the gate like the rest of the surface.

    Without a gate password every core caller is the Host, so this is the only
    posture in which core can show the `require_user` dependency does anything.
    """
    monkeypatch.setenv("KARAOKE_GATE_PASSWORD", GATE_PW)
    assert (await client.get("/api/catalog/providers")).status_code == 401

    await client.post("/api/auth/gate", json={"password": GATE_PW})
    assert (await client.get("/api/catalog/providers")).status_code == 200
