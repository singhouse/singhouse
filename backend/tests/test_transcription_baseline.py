# SPDX-License-Identifier: AGPL-3.0-only
"""The deterministic first transcription survives a manual re-transcribe.

The first pass decodes greedily (``temperature=0.0``) and is reproducible; a
manual re-transcribe re-arms the 0.0/0.1/0.2/0.4 rescue ladder, so its output
is not. Overwriting the cache with the re-roll destroyed the only reproducible
artifact, which made "did I break it, or did it just roll differently?"
unanswerable.

So: keep both files, with the newest staying active. The canonical cache
path stays authoritative for every reader, and the pre-overwrite entry is
archived once — the FIRST pass, not the previous one — as a ``.baseline.json``
sibling. These tests pin the write-once property (the interesting half), that
readers still see the newest, and that ingest never creates an archive.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from karaoke_backend.jobs.worker import run_queued_jobs_once


WAV = (
    b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    b"\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
)


def _write_cache(path: Path, full_text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"segments": [], "language": "en", "full_text": full_text})
    )


def _transcribe(
    song_id: int, *, full_text: str, force: bool, tmp_path: Path
) -> Path:
    """Run the blocking transcribe core with a stubbed model; return the cache
    path. The stub "transcribes" to ``full_text`` so which content ends up
    where is directly observable."""
    from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

    from karaoke_backend.workers import transcription_cache, word_sync_worker

    vocals = tmp_path / "lead_vocals.wav"
    vocals.write_bytes(b"audio")

    fresh = TranscriptionResult(
        segments=[
            TranscriptionSegment(
                start=0.0, end=1.0, text=full_text,
                words=[TimedWord(text=full_text, start=0.0, end=1.0)],
            )
        ],
        language="en",
        full_text=full_text,
    )

    class _Pipeline:
        def __init__(self):
            class _T:
                def transcribe(inner_self, *a, **k):  # noqa: N805
                    return fresh

            self.transcriber = _T()

        def align_only(self, **kwargs):
            return None  # enough: the cache/archive writes are what is pinned

    with patch.object(word_sync_worker, "_make_pipeline", return_value=_Pipeline()):
        word_sync_worker._run_blocking(
            vocals_path=str(vocals),
            artist="A",
            title="B",
            plain_lyrics=None,
            synced_lyrics=None,
            whisper_model="heart",
            language=None,
            use_vad=True,
            song_id=song_id,
            pipeline_config=None,
            force_transcribe=force,
        )
    return transcription_cache.cache_path(song_id, "heart-vad")


# ---------------------------------------------------------------------------
# preserve_baseline itself
# ---------------------------------------------------------------------------


def test_the_archive_holds_the_first_pass_and_never_moves_forward(tmp_path: Path):
    """Write-once is the whole point. If a third re-transcribe shifted the
    baseline, the archive would just be "the previous roll of the dice" and
    the comparison it exists for would be meaningless."""
    from karaoke_backend.workers import transcription_cache

    path = tmp_path / "transcription.heart-vad.json"
    baseline = tmp_path / "transcription.heart-vad.baseline.json"

    _write_cache(path, "first")
    assert transcription_cache.preserve_baseline(path) is True
    assert json.loads(baseline.read_text())["full_text"] == "first"

    _write_cache(path, "second")
    assert transcription_cache.preserve_baseline(path) is True
    assert json.loads(baseline.read_text())["full_text"] == "first"

    _write_cache(path, "third")
    assert transcription_cache.preserve_baseline(path) is True
    assert json.loads(baseline.read_text())["full_text"] == "first"

    assert list(tmp_path.glob("*.tmp")) == [], "temp files must not survive"
    assert list(tmp_path.glob("*.baseline.baseline.json")) == [], (
        "an archive must never itself be archived"
    )


def test_nothing_to_preserve_is_not_an_error(tmp_path: Path):
    from karaoke_backend.workers import transcription_cache

    path = tmp_path / "transcription.heart-vad.json"
    assert transcription_cache.preserve_baseline(path) is False
    assert not (tmp_path / "transcription.heart-vad.baseline.json").exists()


def test_a_failed_archive_does_not_take_the_retranscription_down(tmp_path: Path):
    """Losing the baseline is bad; refusing to re-transcribe because the
    archive failed is worse — so the OSError is swallowed, not raised."""
    from karaoke_backend.workers import transcription_cache

    path = tmp_path / "transcription.heart-vad.json"
    _write_cache(path, "first")

    def boom(**kwargs):
        raise OSError("read-only filesystem")

    with patch.object(transcription_cache.tempfile, "mkstemp", new=boom):
        assert transcription_cache.preserve_baseline(path) is False
    assert not (tmp_path / "transcription.heart-vad.baseline.json").exists()


def test_the_archive_path_is_the_canonical_paths_sibling():
    from karaoke_backend.workers import transcription_cache

    assert transcription_cache.baseline_path(5501, "heart-vad") == (
        transcription_cache.cache_path(5501, "heart-vad").with_name(
            "transcription.heart-vad.baseline.json"
        )
    )


# ---------------------------------------------------------------------------
# The worker: archive on the forced path only
# ---------------------------------------------------------------------------


def test_a_forced_retranscribe_archives_the_old_and_publishes_the_new(
    tmp_path: Path,
):
    from karaoke_backend.workers import transcription_cache

    song_id = 5502
    cache_file = transcription_cache.cache_path(song_id, "heart-vad")
    _write_cache(cache_file, "deterministic")

    _transcribe(song_id, full_text="reroll", force=True, tmp_path=tmp_path)

    assert json.loads(cache_file.read_text())["full_text"] == "reroll"
    baseline = transcription_cache.baseline_path(song_id, "heart-vad")
    assert json.loads(baseline.read_text())["full_text"] == "deterministic"


def test_a_broken_archive_still_publishes_the_retranscription(tmp_path: Path):
    """The worker-level half of "archive failure is non-fatal". The unit test
    above only proves `preserve_baseline` returns False; this proves a raising
    archive cannot throw away a transcription that already cost the GPU time.
    Raises a bare Exception, not OSError, so this stays honest even if the
    swallow inside `preserve_baseline` is later narrowed."""
    from karaoke_backend.workers import transcription_cache

    song_id = 5505
    cache_file = transcription_cache.cache_path(song_id, "heart-vad")
    _write_cache(cache_file, "deterministic")

    def boom(_path):
        raise Exception("archive exploded")

    with patch.object(transcription_cache, "preserve_baseline", new=boom):
        _transcribe(song_id, full_text="reroll", force=True, tmp_path=tmp_path)

    assert json.loads(cache_file.read_text())["full_text"] == "reroll"


def test_the_ingest_path_never_creates_a_baseline(tmp_path: Path):
    """Ingest writes into an empty slot — there is nothing to preserve, and a
    baseline appearing there would be a copy of the active transcription."""
    from karaoke_backend.workers import transcription_cache

    song_id = 5503
    _transcribe(song_id, full_text="first", force=False, tmp_path=tmp_path)

    cache_file = transcription_cache.cache_path(song_id, "heart-vad")
    assert json.loads(cache_file.read_text())["full_text"] == "first"
    assert not transcription_cache.baseline_path(song_id, "heart-vad").exists()


def test_a_realign_after_a_forced_retranscribe_uses_the_new_transcription(
    tmp_path: Path,
):
    """The ruling is "newest stays active": the archive must not divert any
    reader. A realign aligns against the canonical path, baseline or not."""
    from karaoke_backend.workers import transcription_cache, word_sync_worker

    song_id = 5504
    _write_cache(transcription_cache.cache_path(song_id, "heart-vad"), "old")
    _transcribe(song_id, full_text="new", force=True, tmp_path=tmp_path)
    assert transcription_cache.baseline_path(song_id, "heart-vad").exists()

    seen = {}

    class _Pipeline:
        def align_only(self, *, whisper_result, **kwargs):
            seen["full_text"] = whisper_result.full_text
            return None

    with patch.object(word_sync_worker, "_make_pipeline", return_value=_Pipeline()):
        word_sync_worker._realign_blocking(
            song_id=song_id,
            artist="A",
            title="B",
            plain_lyrics=None,
            synced_lyrics=None,
            whisper_model="heart",
            use_vad=True,
            pipeline_config=None,
            vocals_path=None,
        )

    assert seen["full_text"] == "new", "realign must consume the newest, not the archive"


# ---------------------------------------------------------------------------
# The cache-status endpoint
# ---------------------------------------------------------------------------


async def _create_song(client: AsyncClient) -> int:
    with patch("karaoke_backend.jobs.ingest.run_ingest", new=AsyncMock()):
        resp = await client.post(
            "/api/separate",
            files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
            data={"artist": "Test", "title": "Baseline"},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1
    return resp.json()["song_id"]


@pytest.mark.asyncio
async def test_cache_status_reports_the_baseline_in_both_states(
    client: AsyncClient,
):
    song_id = await _create_song(client)
    stems_root = Path(os.environ["STEMS_DIR"])
    cache_file = stems_root / str(song_id) / "transcription.heart-vad.json"
    _write_cache(cache_file, "first")

    url = f"/api/songs/{song_id}/lyrics/cache"
    body = (await client.get(url)).json()
    assert body["exists"] is True
    assert body["baseline_exists"] is False
    assert body["baseline_path"] is None

    _write_cache(cache_file.with_name("transcription.heart-vad.baseline.json"), "first")

    body = (await client.get(url)).json()
    # The existing pair keeps pointing at the ACTIVE transcription.
    assert body["exists"] is True
    assert body["path"] == str(cache_file)
    assert body["baseline_exists"] is True
    assert body["baseline_path"].endswith("transcription.heart-vad.baseline.json")
