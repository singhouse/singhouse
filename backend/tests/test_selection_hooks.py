# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for the additive backend-selection hooks.

The invariant under test: with **no plugin installed** every selection path is
byte-for-byte the pre-hook behavior; a plugin is consulted ONLY for a
non-built-in transcriber model, a ``KARAOKE_SEPARATOR``-named separator, or a
non-built-in lyrics provider name — and one bad plugin never breaks dispatch.

The consumers all call ``plugins.instantiate_group`` via
``from karaoke_backend import plugins``, so patching
``plugins.instantiate_group`` (or the env) injects a fake plugin at exactly the
seam the production code uses.
"""

from __future__ import annotations

import pytest

from karaoke_backend import plugins
from karaoke_backend.workers import lyrics_worker, modal_worker, word_sync_worker
from karaoke_backend.workers.lyrics_worker import (
    BUILTIN_LYRICS_PROVIDER,
    LyricsResult,
    LyricsServiceError,
)


def _lyrics(plain: str) -> LyricsResult:
    """Build a valid LyricsResult (all required fields) for the tests."""
    return LyricsResult(
        artist="A",
        title="B",
        album=None,
        duration=None,
        plain_lyrics=plain,
        synced_lyrics=None,
    )


# ---------------------------------------------------------------------------
# Fakes shaped to the per-group factory contracts (plugins.py docstring)
# ---------------------------------------------------------------------------


class _FakeTranscriber:
    def __init__(self, name, models, *, enabled=True, priority=50):
        self.name = name
        self.models = frozenset(models)
        self.priority = priority
        self._enabled = enabled
        self.created = []

    def is_enabled(self):
        return self._enabled

    def create(self, model, *, use_vad):
        self.created.append((model, use_vad))
        return f"transcriber<{self.name}:{model}:vad={use_vad}>"


class _FakeSeparator:
    def __init__(self, name, *, enabled=True, priority=50):
        self.name = name
        self.priority = priority
        self._enabled = enabled

    def is_enabled(self):
        return self._enabled

    async def separate(self, audio_path, stems_dir, job_id, on_progress):
        return {"lead_vocals": "L", "backing_vocals": "B"}


class _FakeLyricsProvider:
    def __init__(self, name, *, enabled=True):
        self.name = name
        self.label = name.title()
        self._enabled = enabled
        self.calls = []

    def is_enabled(self):
        return self._enabled

    async def fetch(self, artist, title):
        self.calls.append((artist, title))
        return _lyrics(f"{artist}-{title}")


def _patch_group(monkeypatch, group, pairs):
    """Make ``instantiate_group(group)`` return ``pairs`` (already priority
    ordered), and every other group empty."""

    def _fake(g):
        return list(pairs) if g == group else []

    monkeypatch.setattr(plugins, "instantiate_group", _fake)


# ---------------------------------------------------------------------------
# Transcriber selection (word_sync_worker)
# ---------------------------------------------------------------------------


def test_available_models_identity_with_no_plugins(monkeypatch) -> None:
    """No plugins → available_models() is EXACTLY the built-in set."""
    monkeypatch.setattr(plugins, "instantiate_group", lambda g: [])
    assert word_sync_worker.available_models() == set(word_sync_worker.ALL_MODELS)


def test_available_models_unions_plugin_names(monkeypatch) -> None:
    fake = _FakeTranscriber("gpu-xl", {"huge", "huge-v2"})
    _patch_group(monkeypatch, plugins.GROUP_TRANSCRIBERS, [("gpu-xl", fake)])
    got = word_sync_worker.available_models()
    assert got == set(word_sync_worker.ALL_MODELS) | {"huge", "huge-v2"}


def test_available_models_builtin_wins_collision(monkeypatch, caplog) -> None:
    """A plugin re-declaring a built-in model name is warned about and the
    name keeps pointing at the built-in (the set is unchanged for it)."""
    fake = _FakeTranscriber("shady", {"heart", "huge"})  # "heart" is built-in
    _patch_group(monkeypatch, plugins.GROUP_TRANSCRIBERS, [("shady", fake)])
    with caplog.at_level("WARNING"):
        got = word_sync_worker.available_models()
    assert got == set(word_sync_worker.ALL_MODELS) | {"huge"}
    assert any("heart" in r.getMessage() for r in caplog.records)


def test_make_transcriber_nonbuiltin_uses_plugin(monkeypatch) -> None:
    fake = _FakeTranscriber("gpu-xl", {"huge"})
    _patch_group(monkeypatch, plugins.GROUP_TRANSCRIBERS, [("gpu-xl", fake)])
    got = word_sync_worker._make_transcriber("huge", use_vad=True)
    assert got == "transcriber<gpu-xl:huge:vad=True>"
    assert fake.created == [("huge", True)]


def test_make_transcriber_nonbuiltin_no_plugin_raises(monkeypatch) -> None:
    monkeypatch.setattr(plugins, "instantiate_group", lambda g: [])
    with pytest.raises(ValueError, match="No transcriber plugin"):
        word_sync_worker._make_transcriber("nope", use_vad=False)


def test_make_transcriber_builtin_never_consults_plugins(monkeypatch) -> None:
    """A built-in model name must not enter the plugin branch at all."""

    def _boom(g):
        raise AssertionError("instantiate_group must not be called for a built-in name")

    monkeypatch.setattr(plugins, "instantiate_group", _boom)
    # Stop before real (heavy) transcriber construction: prove only that the
    # plugin seam is never reached for a built-in name.
    called = {"n": 0}
    monkeypatch.setattr(
        word_sync_worker, "_plugin_transcriber",
        lambda *a, **k: called.__setitem__("n", called["n"] + 1),
    )
    sentinel = object()
    import karaoke_backend.workers.modal_offload as mo
    monkeypatch.setattr(mo, "is_enabled", lambda: False)
    import karaoke_backend.workers.remote as rmt
    monkeypatch.setattr(rmt, "is_enabled", lambda: False)
    monkeypatch.setattr(
        word_sync_worker, "HeartTranscriber", lambda **k: sentinel, raising=False
    )
    got = word_sync_worker._make_transcriber("heart", use_vad=False)
    assert got is sentinel
    assert called["n"] == 0  # plugin seam never touched for a built-in name


# ---------------------------------------------------------------------------
# Separator selection (modal_worker)
# ---------------------------------------------------------------------------


def test_plugin_separator_none_when_env_unset(monkeypatch) -> None:
    """KARAOKE_SEPARATOR unset → None → built-in dispatch untouched."""
    monkeypatch.delenv(modal_worker.SEPARATOR_ENV, raising=False)

    def _boom(g):
        raise AssertionError("no plugin lookup when KARAOKE_SEPARATOR is unset")

    monkeypatch.setattr(plugins, "instantiate_group", _boom)
    assert modal_worker._plugin_separator() is None


def test_plugin_separator_selected_when_named(monkeypatch) -> None:
    fake = _FakeSeparator("gpu-sep")
    monkeypatch.setenv(modal_worker.SEPARATOR_ENV, "gpu-sep")
    _patch_group(monkeypatch, plugins.GROUP_SEPARATORS, [("gpu-sep", fake)])
    assert modal_worker._plugin_separator() is fake


def test_plugin_separator_disabled_falls_back(monkeypatch, caplog) -> None:
    fake = _FakeSeparator("gpu-sep", enabled=False)
    monkeypatch.setenv(modal_worker.SEPARATOR_ENV, "gpu-sep")
    _patch_group(monkeypatch, plugins.GROUP_SEPARATORS, [("gpu-sep", fake)])
    with caplog.at_level("WARNING"):
        assert modal_worker._plugin_separator() is None
    assert any("not enabled" in r.getMessage() for r in caplog.records)


def test_plugin_separator_missing_falls_back(monkeypatch, caplog) -> None:
    monkeypatch.setenv(modal_worker.SEPARATOR_ENV, "ghost")
    _patch_group(monkeypatch, plugins.GROUP_SEPARATORS, [])
    with caplog.at_level("WARNING"):
        assert modal_worker._plugin_separator() is None
    assert any("no installed separator" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# Lyrics selection (lyrics_worker)
# ---------------------------------------------------------------------------


def test_builtin_lyrics_provider_name_unchanged() -> None:
    """lrclib stays the hardcoded built-in default (bright-line guard)."""
    assert BUILTIN_LYRICS_PROVIDER == "lrclib"


@pytest.mark.asyncio
async def test_fetch_by_provider_default_calls_builtin(monkeypatch) -> None:
    seen = {}

    async def _fake_fetch(artist, title):
        seen["args"] = (artist, title)
        return _lyrics("builtin")

    monkeypatch.setattr(lyrics_worker, "fetch_lyrics", _fake_fetch)
    for name in ("lrclib", "", None):
        seen.clear()
        res = await lyrics_worker.fetch_lyrics_by_provider(name, "A", "B")
        assert res.plain_lyrics == "builtin"
        assert seen["args"] == ("A", "B")


@pytest.mark.asyncio
async def test_fetch_by_provider_dispatches_to_plugin(monkeypatch) -> None:
    fake = _FakeLyricsProvider("genius-ish")
    _patch_group(monkeypatch, plugins.GROUP_LYRICS_PROVIDERS, [("genius-ish", fake)])
    res = await lyrics_worker.fetch_lyrics_by_provider("genius-ish", "A", "B")
    assert res.plain_lyrics == "A-B"
    assert fake.calls == [("A", "B")]


@pytest.mark.asyncio
async def test_fetch_by_provider_unknown_raises(monkeypatch) -> None:
    _patch_group(monkeypatch, plugins.GROUP_LYRICS_PROVIDERS, [])
    with pytest.raises(LyricsServiceError, match="No lyrics provider"):
        await lyrics_worker.fetch_lyrics_by_provider("ghost", "A", "B")


@pytest.mark.asyncio
async def test_fetch_by_provider_disabled_raises(monkeypatch) -> None:
    fake = _FakeLyricsProvider("off-prov", enabled=False)
    _patch_group(monkeypatch, plugins.GROUP_LYRICS_PROVIDERS, [("off-prov", fake)])
    with pytest.raises(LyricsServiceError, match="not enabled"):
        await lyrics_worker.fetch_lyrics_by_provider("off-prov", "A", "B")
