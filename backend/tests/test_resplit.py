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

import asyncio
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
from karaoke_backend.jobs import resplit as resplit_job
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


@pytest.fixture(autouse=True)
def fake_final_encoding(monkeypatch):
    # Handler fixtures deliberately use sentinel bytes, not decodable audio.
    async def encode(source, target):
        shutil.copy2(source, target)
    monkeypatch.setenv("STEM_FORMAT", "mp3")
    monkeypatch.setattr("karaoke_backend.stem_encoding.encode_stem", encode)


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
    assert "lead" in detail and "backing" in detail


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
            "stems_root": str(stems_dir),
            "expected_generation": None,
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
@pytest.mark.parametrize("source_format", ["wav", "flac", "mp3"])
@pytest.mark.parametrize("output_format", ["mp3", "flac"])
async def test_a_successful_resplit_replaces_the_three_stems_and_clears_the_cache(
    client: AsyncClient, local_separation, monkeypatch, source_format, output_format
):
    monkeypatch.setenv("STEM_FORMAT", output_format)
    song_id, stems_dir = await _ready_song_with_stems(client)
    for path in stems_dir.glob("*.wav"):
        path.rename(path.with_suffix(f".{source_format}"))
    (stems_dir / "vocals.wav").write_bytes(WAV + b"vocals")
    instrumental_before = (stems_dir / f"instrumental.{source_format}").read_bytes()
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

    async with AsyncSessionLocal() as db:
        song = await db.get(Song, song_id)
        assert song.active_stem_generation == f"resplit-{job_id}"
        published = stems_dir / ".generations" / song.active_stem_generation
    assert (published / f"lead_vocals.{output_format}").read_bytes() == b"NEW-LEAD"
    assert (published / f"backing_vocals.{output_format}").read_bytes() == b"NEW-BACKING"
    assert (published / f"karaoke.{output_format}").read_bytes() == b"NEW-KARAOKE"
    for base in ("lead_vocals", "backing_vocals", "karaoke"):
        assert [p.name for p in published.glob(f"{base}.*")] == [f"{base}.{output_format}"]
    # Pass 1's output is not re-run and must not be touched.
    assert (published / f"instrumental.{source_format}").read_bytes() == instrumental_before
    assert (stems_dir / f"lead_vocals.{source_format}").read_bytes() != b"NEW-LEAD"

    # The marker is the queue's proof that separation finished; a re-split
    # rewrites it so it describes the files that are actually there now.
    marker = json.loads((published / ".separation-complete").read_text())
    assert set(marker["artifacts"]) == {
        f"lead_vocals.{output_format}", f"backing_vocals.{output_format}",
        f"instrumental.{source_format}", f"karaoke.{output_format}"
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


def test_generation_durability_flushes_files_before_directory(monkeypatch, tmp_path):
    from karaoke_backend.jobs import resplit
    generation = tmp_path / "generation"
    generation.mkdir()
    (generation / "lead.wav").write_bytes(b"lead")
    events = []
    real_open = os.open
    monkeypatch.setattr(resplit.os, "fsync", lambda fd: events.append(fd))
    monkeypatch.setattr(resplit.os, "open", lambda path, flags: (events.append("directory"), real_open(path, flags))[1])
    resplit._sync_generation(generation)
    assert events[-2] == "directory"
    assert isinstance(events[0], int)

@pytest.mark.asyncio
async def test_durability_barrier_flushes_generation_parent_and_root(monkeypatch, tmp_path):
    generation = tmp_path / ".generations" / "resplit-job"
    events = []
    async def inline(fn, path): events.append((fn.__name__, path))
    monkeypatch.setattr(resplit_job.asyncio, "to_thread", inline)
    await resplit_job._durability_barrier(generation, tmp_path)
    assert events == [("_sync_generation", generation),
        ("_sync_directory", generation.parent), ("_sync_directory", tmp_path)]


def test_generation_directory_sync_failure_is_fatal(monkeypatch, tmp_path):
    generation = tmp_path / ".generations" / "resplit-deadbeef"
    generation.mkdir(parents=True)
    (generation / "lead_vocals.wav").write_bytes(WAV)
    monkeypatch.setattr(resplit_job.os, "open", lambda *_a, **_k: (_ for _ in ()).throw(OSError("unsupported")))
    with pytest.raises(RuntimeError, match="Cannot durably sync directory"):
        resplit_job._sync_generation(generation)


def test_windows_directory_sync_uses_backup_semantics_and_closes(tmp_path):
    calls = []
    class Kernel32:
        def CreateFileW(self, *args): calls.append(("open", args)); return 123
        def FlushFileBuffers(self, handle): calls.append(("flush", handle)); return 1
        def CloseHandle(self, handle): calls.append(("close", handle)); return 1
    resplit_job._sync_directory_windows(tmp_path, Kernel32())
    assert calls[0][1][1:6] == (0x80000000 | 0x40000000, 7, None, 3, 0x02000000)
    assert calls[1:] == [("flush", 123), ("close", 123)]


def test_windows_directory_sync_fails_closed_but_still_closes(tmp_path):
    closed = []
    class Kernel32:
        def CreateFileW(self, *args): return 123
        def FlushFileBuffers(self, handle): return 0
        def CloseHandle(self, handle): closed.append(handle); return 1
    with pytest.raises(RuntimeError, match="durably sync"):
        resplit_job._sync_directory_windows(tmp_path, Kernel32())
    assert closed == [123]


@pytest.mark.asyncio
@pytest.mark.parametrize("device", ["cpu", "cuda", "mps"])
async def test_pass2_forwards_managed_audio_separator_device(monkeypatch, tmp_path, device):
    seen = []
    async def run(cmd, timeout): seen.extend(cmd)
    selected_python = tmp_path / "managed-pack" / "python"
    monkeypatch.setattr(modal_worker, "DEMUCS_PYTHON", selected_python)
    monkeypatch.setattr(modal_worker, "configured_pass2_device", lambda: device)
    monkeypatch.setattr(modal_worker, "_await_subprocess", run)
    await modal_worker.run_pass2(tmp_path / "vocals.wav", tmp_path / "out", "model.ckpt",
                                 AsyncMock(), allow_alphabetical_fallback=False)
    assert seen[:5] == [str(selected_python), "-I", "-B", "-m",
                        "karaoke_backend.workers.managed_audio_separator"]
    assert seen[5] == str(tmp_path / "vocals.wav")
    assert seen[-2:] == ["--device", device]


@pytest.mark.asyncio
async def test_pass2_legacy_mode_does_not_force_a_device(monkeypatch, tmp_path):
    seen = []
    async def run(cmd, timeout): seen.extend(cmd)
    monkeypatch.setattr(modal_worker, "configured_pass2_device", lambda: None)
    monkeypatch.setattr(modal_worker, "_await_subprocess", run)
    await modal_worker.run_pass2(tmp_path / "vocals.wav", tmp_path / "out", "model.ckpt",
                                 AsyncMock(), allow_alphabetical_fallback=False)
    assert seen[0] == str(modal_worker.DEMUCS_PYTHON.parent / "audio-separator")
    assert "--device" not in seen

def test_only_a_complete_generation_is_reusable(tmp_path):
    generation = tmp_path / "generation"; generation.mkdir()
    for name in (*resplit_job.REPLACEMENTS, "instrumental.wav"):
        (generation / name).write_bytes(name.encode())
    assert not resplit_job._complete_generation(generation)
    from karaoke_backend.jobs.ingest import write_separation_marker
    write_separation_marker(generation)
    assert resplit_job._complete_generation(generation)
    (generation / "karaoke.wav").unlink()
    assert not resplit_job._complete_generation(generation)

def test_publication_cas_requires_expected_generation_and_live_lease():
    import inspect
    source = inspect.getsource(resplit_job._publish)
    assert "expected_clause" in source
    assert "Job.lease_expires_at > now" in source
    assert "Job.claimed_by == ctx.worker_id" in source


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
    async with AsyncSessionLocal() as db:
        generation = (await db.get(Song, song_id)).active_stem_generation
    assert (stems_dir / ".generations" / generation / "lead_vocals.mp3").read_bytes() == b"NEW-LEAD"


@pytest.mark.asyncio
async def test_cancelling_vocal_rebuild_waits_for_child_cleanup(monkeypatch, tmp_path):
    """The re-split task cannot release queue capacity ahead of ffmpeg."""
    started = asyncio.Event()
    reaped = asyncio.Event()

    async def owned_child(cmd, timeout):
        started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            # This stands at the owned-child seam after kill + wait completed.
            reaped.set()
            raise

    monkeypatch.setattr(modal_worker, "_await_subprocess", owned_child)
    task = asyncio.create_task(resplit_job._mix_vocals(
        tmp_path / "lead.wav", tmp_path / "backing.wav", tmp_path / "vocals.wav"
    ))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert reaped.is_set()


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


@pytest.mark.asyncio
@pytest.mark.parametrize("managed", [True, False])
async def test_demucs_launch_uses_managed_adapter_only_for_desktop(monkeypatch, tmp_path, local_separation, managed):
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", "fixture" if managed else "")
    monkeypatch.setattr(modal_worker.modal_offload, "is_enabled", lambda: False)
    monkeypatch.setattr(modal_worker, "configured_accelerator", lambda: "cpu")
    monkeypatch.setattr(modal_worker, "require_selected_models", lambda *args: None)
    seen = []
    async def capture(cmd, timeout):
        seen.extend(cmd)
        raise RuntimeError("captured dispatch")
    monkeypatch.setattr(modal_worker, "_await_subprocess", capture)
    with pytest.raises(RuntimeError, match="captured dispatch"):
        await modal_worker.separate_stems(tmp_path / "input.wav", tmp_path / "output", "fixture")
    prefix = ([str(local_separation), "-I", "-B", "-m", "karaoke_backend.workers.managed_demucs"]
              if managed else [str(local_separation), "-m", "demucs.separate"])
    assert seen[:len(prefix)] == prefix
    assert "--float32" in seen
    assert seen[seen.index("--device") + 1] == "cpu"


@pytest.fixture
def managed_ingest(monkeypatch, local_separation):
    import hashlib
    local_separation.chmod(0o700)
    monkeypatch.setattr(modal_worker.modal_offload, "is_enabled", lambda: False)
    monkeypatch.setenv("KARAOKE_PROCESSING_PYTHON", str(local_separation))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cpu")
    monkeypatch.setenv("KARAOKE_AUDIO_SEPARATOR_DEVICE", "cpu")
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", json.dumps({
        "runtimeManifestId": "a" * 64, "pythonPath": str(local_separation),
        "pythonSha256": hashlib.sha256(local_separation.read_bytes()).hexdigest(),
        "probePassed": True, "accelerator": "cpu", "components": {"demucs": "4.0.1"},
        "verifiedCapabilities": ["separation"], "capabilitiesReady": True}))
    monkeypatch.setenv("KARAOKE_DESKTOP_MODEL_SETS_JSON", json.dumps({
        "schema": 1, "runtimeManifestId": "a" * 64, "modelManifestId": "b" * 64,
        "requiredModels": {"transcription": [], "separation": ["demucs-mdx-extra", "karaoke-roformer"]},
        "verifiedModelIds": ["demucs-mdx-extra", "karaoke-roformer"]}))
    return local_separation


@pytest.mark.asyncio
@pytest.mark.parametrize("choice", ["mdxnet_kara2", "unknown-queued-model"])
async def test_managed_ingest_preflights_both_models_before_demucs(monkeypatch, tmp_path, managed_ingest, choice):
    launch = AsyncMock()
    monkeypatch.setattr(modal_worker, "_await_subprocess", launch)
    with pytest.raises(modal_worker.StemSeparationError, match="model set"):
        await modal_worker.separate_stems(tmp_path / "input.wav", tmp_path / "stems", "job", karaoke_model=choice)
    launch.assert_not_called()
    assert not (tmp_path / "stems").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("managed", [True, False])
@pytest.mark.parametrize("failure", ["error", "missing-lead", "missing-backing", "missing-both"])
async def test_managed_ingest_refuses_pass2_degradation_but_legacy_preserves_fallback(
    monkeypatch, tmp_path, managed_ingest, managed, failure
):
    if not managed:
        monkeypatch.delenv("KARAOKE_DESKTOP_PROCESSING_JSON")
    stems = tmp_path / "stems"
    async def demucs(cmd, timeout):
        output = Path(cmd[cmd.index("-o") + 1]) / "mdx_extra" / "input"
        output.mkdir(parents=True)
        for name in ("vocals", "drums", "bass", "other"):
            (output / (name + ".wav")).write_bytes(name.encode())
    monkeypatch.setattr(modal_worker, "_await_subprocess", demucs)
    lead, backing = tmp_path / "lead.wav", tmp_path / "backing.wav"
    lead.write_bytes(b"lead"); backing.write_bytes(b"backing")
    split = AsyncMock(side_effect=modal_worker.StemSeparationError("separator failed")) if failure == "error" else AsyncMock(
        return_value=(None if failure in {"missing-lead", "missing-both"} else lead,
                      None if failure in {"missing-backing", "missing-both"} else backing))
    monkeypatch.setattr(modal_worker, "run_pass2", split)
    silence = lambda output, source: output.write_bytes(b"silence")
    monkeypatch.setattr(modal_worker, "_create_silent_wav", silence)
    finalize = AsyncMock(return_value={"lead_vocals": stems / "lead_vocals.wav"})
    monkeypatch.setattr(modal_worker, "_mix_and_finalize", finalize)
    if managed:
        with pytest.raises(modal_worker.StemSeparationError, match="separator failed|did not produce"):
            await modal_worker.separate_stems(tmp_path / "input.wav", stems, "job")
        finalize.assert_not_called()
        assert not (stems / "lead_vocals.wav").exists()
        assert not (stems / "backing_vocals.wav").exists()
    else:
        await modal_worker.separate_stems(tmp_path / "input.wav", stems, "job")
        finalize.assert_awaited_once()
        assert (stems / "lead_vocals.wav").is_file()
        assert (stems / "backing_vocals.wav").is_file()
    assert split.call_args.kwargs["allow_alphabetical_fallback"] is (not managed)


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["drums", "bass", "other"])
async def test_managed_ingest_requires_all_demucs_stems(monkeypatch, tmp_path, managed_ingest, missing):
    async def demucs(cmd, timeout):
        output = Path(cmd[cmd.index("-o") + 1]) / "mdx_extra" / "input"
        output.mkdir(parents=True)
        for name in {"vocals", "drums", "bass", "other"} - {missing}:
            (output / (name + ".wav")).write_bytes(name.encode())
    monkeypatch.setattr(modal_worker, "_await_subprocess", demucs)
    split = AsyncMock()
    monkeypatch.setattr(modal_worker, "run_pass2", split)
    with pytest.raises(modal_worker.StemSeparationError, match="complete stem set"):
        await modal_worker.separate_stems(tmp_path / "input.wav", tmp_path / "stems", "job")
    split.assert_not_called()
