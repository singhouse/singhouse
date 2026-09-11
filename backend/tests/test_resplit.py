# SPDX-License-Identifier: AGPL-3.0-only
"""Re-running the Pass-2 lead/backing split on an existing song.

The Pass-2 model pick used to be permanent: the upload is deleted once
separation finishes and ingest short-circuits on the ``.separation-complete``
marker, so nothing could split those vocals again. What is worth pinning about
the fix is not that a job runs — it is that the job is SAFE to run on a song
people are already singing:

* every refusal is synchronous, so a caller learns "this song has no
  separated vocals" instead of watching a job fail a minute later;
* the replacements are staged and renamed into place, so a failure at any
  point leaves the existing stems byte-identical;
* the transcription cache goes with them, because it is a transcription of a
  lead stem that no longer exists.
"""

import io
import json
import os
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import update

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Song
from karaoke_backend.workers import modal_worker


WAV = (
    b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    b"\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
)



@pytest.fixture(autouse=True)
def clean_stems_root():
    """A song directory per test, not per session.

    ``STEMS_DIR`` is one temp directory for the whole run while the database
    is recreated per test, so song ids restart at 1 and every test would
    inherit the previous one's stem files under the same path.
    """
    root = Path(os.environ["STEMS_DIR"])
    for child in root.iterdir():
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()
    yield


async def _create_song(client: AsyncClient) -> int:
    with patch("karaoke_backend.jobs.ingest.run_ingest", new=AsyncMock()):
        resp = await client.post(
            "/api/separate",
            files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
            data={"artist": "Test", "title": "Resplit"},
        )
        assert resp.status_code == 202
        assert await run_queued_jobs_once() == 1
    return resp.json()["song_id"]


async def _mark_ready(song_id: int) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(status="ready"))
        await db.commit()


def _stems_dir(song_id: int) -> Path:
    return Path(os.environ["STEMS_DIR"]) / str(song_id)


def _write_stems(song_id: int, *, names=None) -> Path:
    """Put a full standard stem set on disk with distinguishable contents."""
    d = _stems_dir(song_id)
    d.mkdir(parents=True, exist_ok=True)
    for name in names or ("lead_vocals.wav", "backing_vocals.wav", "instrumental.wav",
                          "karaoke.wav"):
        (d / name).write_bytes(WAV + name.encode())
    return d


async def _ready_song_with_stems(client: AsyncClient) -> tuple[int, Path]:
    song_id = await _create_song(client)
    await _mark_ready(song_id)
    return song_id, _write_stems(song_id)


@pytest.fixture
def local_separation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Make the route's two 503 guards pass: no plugin, a demucs venv present."""
    monkeypatch.setattr(modal_worker, "_plugin_separator", lambda: None)
    fake_python = tmp_path / "demucs-venv" / "bin" / "python"
    fake_python.parent.mkdir(parents=True)
    fake_python.write_text("#!/bin/false\n")
    monkeypatch.setattr(modal_worker, "DEMUCS_PYTHON", fake_python)
    return fake_python


# ---------------------------------------------------------------------------
# Route guards
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_model_is_400(client: AsyncClient, local_separation):
    """A filename would be a request string handed to a subprocess. Only IDs
    from the allowlist are accepted, and the refusal names them."""
    song_id, _ = await _ready_song_with_stems(client)
    for bad in ("UVR_MDXNET_KARA_2.onnx", "", "../../etc/passwd"):
        resp = await client.post(
            f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": bad}
        )
        assert resp.status_code == 400, bad
        assert "mdxnet_kara2" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_a_song_that_is_not_ready_is_409(client: AsyncClient, local_separation):
    song_id = await _create_song(client)
    _write_stems(song_id)
    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 409
    assert "not ready" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_a_song_without_separated_vocals_is_409(
    client: AsyncClient, local_separation
):
    """Also what excludes a video import: it has an instrumental and no
    vocal pair, so there is nothing to split again."""
    song_id = await _create_song(client)
    await _mark_ready(song_id)
    _write_stems(song_id, names=("instrumental.wav",))

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "lead_vocals.wav" in detail and "backing_vocals.wav" in detail


@pytest.mark.asyncio
async def test_a_separator_plugin_is_503(
    client: AsyncClient, local_separation, monkeypatch: pytest.MonkeyPatch
):
    """A plugin owns both passes; there is no built-in Pass 2 to re-run."""
    song_id, _ = await _ready_song_with_stems(client)
    monkeypatch.setattr(modal_worker, "_plugin_separator", lambda: object())

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Re-split is not available with a separator plugin"


@pytest.mark.asyncio
async def test_a_missing_demucs_venv_is_503_with_the_install_hint(
    client: AsyncClient, local_separation, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    song_id, _ = await _ready_song_with_stems(client)
    monkeypatch.setattr(modal_worker, "DEMUCS_PYTHON", tmp_path / "nope" / "python")

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 503
    assert "uv venv .venv-demucs" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_accepted_request_enqueues_the_job_and_claims_the_song(
    client: AsyncClient, local_separation
):
    song_id, stems_dir = await _ready_song_with_stems(client)

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    async with AsyncSessionLocal() as db:
        from karaoke_backend.models.song import Job

        job = await db.get(Job, job_id)
        assert job.kind == "resplit"
        assert json.loads(job.payload) == {
            "stems_dir": str(stems_dir),
            "karaoke_model": "mdxnet_kara2",
        }
        song = await db.get(Song, song_id)
        # The library row has to point at the live job or it keeps reporting
        # whatever the previous one finished doing.
        assert song.job_id == job_id
        assert song.status == "ready"


# ---------------------------------------------------------------------------
# The handler
# ---------------------------------------------------------------------------


def _fake_pass2(lead_bytes: bytes = b"NEW-LEAD", backing_bytes: bytes = b"NEW-BACKING"):
    """Stand in for audio-separator: write two outputs, return their paths."""

    async def run_pass2(vocals_src, out_dir, pass2_model, progress, **kw):
        out_dir.mkdir(parents=True, exist_ok=True)
        lead = out_dir / "vocals_(Vocals).wav"
        backing = out_dir / "vocals_(Instrumental).wav"
        lead.write_bytes(lead_bytes)
        backing.write_bytes(backing_bytes)
        await progress("processing", 70, "Lead/backing split complete")
        return lead, backing

    return run_pass2


async def _fake_mix_karaoke(instrumental_path, backing_path, karaoke_path):
    karaoke_path.write_bytes(b"NEW-KARAOKE")
    return True


@pytest.mark.asyncio
async def test_a_successful_resplit_replaces_the_three_stems_and_clears_the_cache(
    client: AsyncClient, local_separation
):
    song_id, stems_dir = await _ready_song_with_stems(client)
    (stems_dir / "vocals.wav").write_bytes(WAV + b"vocals")
    instrumental_before = (stems_dir / "instrumental.wav").read_bytes()
    (stems_dir / "transcription.heart-vad.json").write_text("{}")
    (stems_dir / "transcription.heart-vad.baseline.json").write_text("{}")

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    with patch.object(modal_worker, "run_pass2", new=_fake_pass2()), \
         patch.object(modal_worker, "mix_karaoke", new=_fake_mix_karaoke), \
         patch.object(modal_worker, "_ensure_s16", lambda path: None):
        assert await run_queued_jobs_once() == 1

    assert (stems_dir / "lead_vocals.wav").read_bytes() == b"NEW-LEAD"
    assert (stems_dir / "backing_vocals.wav").read_bytes() == b"NEW-BACKING"
    assert (stems_dir / "karaoke.wav").read_bytes() == b"NEW-KARAOKE"
    # Pass 1's output is not re-run and must not be touched.
    assert (stems_dir / "instrumental.wav").read_bytes() == instrumental_before

    # The marker is the queue's proof that separation finished; a re-split
    # rewrites it so it describes the files that are actually there now.
    marker = json.loads((stems_dir / ".separation-complete").read_text())
    assert set(marker["artifacts"]) == {
        "lead_vocals.wav", "instrumental.wav", "karaoke.wav"
    }

    # The lead stem changed, so every cached transcription describes audio
    # that no longer exists — baseline included.
    assert not list(stems_dir.glob("transcription.*.json"))
    assert not list(stems_dir.glob("_resplit-*"))

    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "done"
    assert "transcription cache cleared" in job["message"]

    # A re-split must never knock a song out of the library.
    async with AsyncSessionLocal() as db:
        assert (await db.get(Song, song_id)).status == "ready"


@pytest.mark.asyncio
async def test_a_pass_2_failure_leaves_every_original_file_byte_identical(
    client: AsyncClient, local_separation
):
    """The whole reason the job stages its output. Ingest degrades to full
    vocals as lead when Pass 2 fails; doing that here would overwrite stems
    that already work."""
    song_id, stems_dir = await _ready_song_with_stems(client)
    (stems_dir / "vocals.wav").write_bytes(WAV + b"vocals")
    before = {p.name: p.read_bytes() for p in stems_dir.iterdir() if p.is_file()}

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    job_id = resp.json()["job_id"]

    async def boom(vocals_src, out_dir, pass2_model, progress, **kw):
        raise modal_worker.StemSeparationError("audio-separator exploded")

    with patch.object(modal_worker, "run_pass2", new=boom):
        assert await run_queued_jobs_once() == 1

    assert {p.name: p.read_bytes() for p in stems_dir.iterdir() if p.is_file()} == before
    assert not list(stems_dir.glob("_resplit-*"))

    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "failed"
    assert "stems are unchanged" in job["message"]
    async with AsyncSessionLocal() as db:
        assert (await db.get(Song, song_id)).status == "ready"


@pytest.mark.asyncio
async def test_an_unidentifiable_pass_2_output_fails_rather_than_guessing(
    client: AsyncClient, local_separation
):
    song_id, stems_dir = await _ready_song_with_stems(client)
    (stems_dir / "vocals.wav").write_bytes(WAV + b"vocals")
    before = (stems_dir / "lead_vocals.wav").read_bytes()

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    job_id = resp.json()["job_id"]

    async def half(vocals_src, out_dir, pass2_model, progress, **kw):
        return None, None

    with patch.object(modal_worker, "run_pass2", new=half):
        assert await run_queued_jobs_once() == 1

    assert (stems_dir / "lead_vocals.wav").read_bytes() == before
    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "failed"


@pytest.mark.asyncio
async def test_without_a_pass_1_vocals_stem_the_pair_is_summed_back_together(
    client: AsyncClient, local_separation
):
    """Songs separated before re-split existed keep no `vocals.wav`, which is most of the
    library — the lead and backing are summed back into the signal Pass 2
    was given the first time."""
    song_id, stems_dir = await _ready_song_with_stems(client)
    assert not (stems_dir / "vocals.wav").exists()

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 202

    seen = {}

    async def record_source(vocals_src, out_dir, pass2_model, progress, **kw):
        seen["vocals_src"] = Path(vocals_src)
        seen["model"] = pass2_model
        return await _fake_pass2()(vocals_src, out_dir, pass2_model, progress)

    with patch.object(modal_worker, "run_pass2", new=record_source), \
         patch.object(modal_worker, "mix_karaoke", new=_fake_mix_karaoke), \
         patch.object(modal_worker, "_ensure_s16", lambda path: None):
        assert await run_queued_jobs_once() == 1

    # Rebuilt inside the scratch directory, never beside the published stems.
    assert seen["vocals_src"].parent.name.startswith("_resplit-")
    # The ID is resolved to a checkpoint filename server-side.
    assert seen["model"] == "UVR_MDXNET_KARA_2.onnx"
    assert (stems_dir / "lead_vocals.wav").read_bytes() == b"NEW-LEAD"


@pytest.mark.asyncio
async def test_a_second_resplit_is_refused_while_the_first_is_in_flight(
    client: AsyncClient, local_separation
):
    """Two re-splits of one song race for the same three filenames, and the
    loser publishes a lead/backing pair the karaoke mix beside it was not made
    from. The queue's own terminal set decides what "in flight" means."""
    song_id, _ = await _ready_song_with_stems(client)

    first = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert first.status_code == 202

    second = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "roformer"}
    )
    assert second.status_code == 409
    assert first.json()["job_id"] in second.json()["detail"]

    # Once the first reaches a terminal status the song is free again.
    with patch.object(modal_worker, "run_pass2", new=_fake_pass2()), \
         patch.object(modal_worker, "mix_karaoke", new=_fake_mix_karaoke), \
         patch.object(modal_worker, "_ensure_s16", lambda path: None):
        assert await run_queued_jobs_once() == 1

    third = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "roformer"}
    )
    assert third.status_code == 202


@pytest.mark.asyncio
async def test_a_third_vocal_lane_is_refused(client: AsyncClient, local_separation):
    """Re-split produces exactly one lead and one backing, because that is what
    Pass 2 produces. A song with more lanes would come out of it with the extras
    orphaned beside a freshly split pair, and nothing would say so."""
    song_id, stems_dir = await _ready_song_with_stems(client)
    (stems_dir / "lead_vocals_2.wav").write_bytes(WAV + b"second-lead")

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    # The refusal names the roster it actually found, not just "unsupported".
    assert "lead_2" in detail and "backing" in detail


@pytest.mark.asyncio
async def test_another_jobs_scratch_directory_is_left_alone(
    client: AsyncClient, local_separation
):
    """Scratch is named per job. A shared name would make a directory left by a
    killed worker something a later job deletes out from under a live one."""
    song_id, stems_dir = await _ready_song_with_stems(client)
    (stems_dir / "vocals.wav").write_bytes(WAV + b"vocals")
    sibling = stems_dir / "_resplit-someone-elses-job"
    sibling.mkdir()
    (sibling / "in-progress.wav").write_bytes(b"MID-RUN")

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    assert resp.status_code == 202

    with patch.object(modal_worker, "run_pass2", new=_fake_pass2()), \
         patch.object(modal_worker, "mix_karaoke", new=_fake_mix_karaoke), \
         patch.object(modal_worker, "_ensure_s16", lambda path: None):
        assert await run_queued_jobs_once() == 1

    assert (sibling / "in-progress.wav").read_bytes() == b"MID-RUN"


@pytest.mark.asyncio
async def test_real_pass_2_does_not_guess_a_pair_from_sort_order(
    client: AsyncClient, local_separation
):
    """The alphabetical fallback is off for a re-split, so this runs the REAL
    ``run_pass2`` over a separator whose output names say nothing. On an ingest
    a guessed pair beats no song; here it would swap the lead and backing of a
    song that was already correct."""
    song_id, stems_dir = await _ready_song_with_stems(client)
    (stems_dir / "vocals.wav").write_bytes(WAV + b"vocals")
    before = {p.name: p.read_bytes() for p in stems_dir.iterdir() if p.is_file()}

    resp = await client.post(
        f"/api/songs/{song_id}/stems/resplit", json={"karaoke_model": "mdxnet_kara2"}
    )
    job_id = resp.json()["job_id"]

    def fake_separator(cmd, timeout=None):
        out_dir = Path(cmd[cmd.index("--output_dir") + 1])
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "aaa_stem_one.wav").write_bytes(WAV + b"one")
        (out_dir / "zzz_stem_two.wav").write_bytes(WAV + b"two")
        return ""

    with patch.object(modal_worker, "_run_subprocess", new=fake_separator):
        assert await run_queued_jobs_once() == 1

    assert {p.name: p.read_bytes() for p in stems_dir.iterdir() if p.is_file()} == before
    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "failed"
    assert "stems are unchanged" in job["message"]


@pytest.mark.asyncio
async def test_ingest_still_guesses_that_pair(tmp_path: Path):
    """The other half of the same knob: ``separate_stems`` keeps the fallback,
    so a first ingest with the same unhelpful output still yields a song."""
    out_dir = tmp_path / "pass2"

    def fake_separator(cmd, timeout=None):
        d = Path(cmd[cmd.index("--output_dir") + 1])
        d.mkdir(parents=True, exist_ok=True)
        (d / "aaa_stem_one.wav").write_bytes(WAV + b"one")
        (d / "zzz_stem_two.wav").write_bytes(WAV + b"two")
        return ""

    async def progress(status, pct, msg):
        return None

    with patch.object(modal_worker, "_run_subprocess", new=fake_separator):
        lead, backing = await modal_worker.run_pass2(
            tmp_path / "vocals.wav", out_dir, "UVR_MDXNET_KARA_2.onnx", progress
        )
    assert lead is not None and backing is not None
