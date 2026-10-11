# SPDX-License-Identifier: AGPL-3.0-only
"""Focused archive and completion contracts for single-song CD+G import."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.jobs import queue
from karaoke_backend.jobs import cdg_import as cdg_import_job
from karaoke_backend.jobs.base import JobContext, LeaseLost
from karaoke_backend.jobs.cdg_import import (
    CdgImportError,
    MAX_ARCHIVE_ENTRIES,
    MAX_CDG_BYTES,
    _make_audio,
    _probe_duration,
    _run,
    _safe_members,
    _render,
    completed,
)
from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.models.song import Job, JobKind, Song
from karaoke_backend.cdg.spec import NOOP_PACKET

UPLOADS_DIR = Path(os.environ["UPLOADS_DIR"])
STEMS_DIR = Path(os.environ["STEMS_DIR"])


@pytest.fixture(autouse=True)
def clean_media_dirs():
    for root in (UPLOADS_DIR, STEMS_DIR):
        for child in root.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()


def archive(*members: tuple[str, bytes]) -> zipfile.ZipFile:
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as out:
        for name, body in members:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(info, body)
    raw.seek(0)
    return zipfile.ZipFile(raw)


def archive_bytes(*members: tuple[str, bytes]) -> bytes:
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as out:
        for name, body in members:
            out.writestr(name, body)
    return raw.getvalue()


async def submitted(client, name: str, body: bytes, media_type: str) -> dict:
    response = await client.post(
        "/api/import/cdg", files={"file": (name, body, media_type)}
    )
    assert response.status_code == 202
    return response.json()


async def get_song(song_id: int) -> Song:
    async with AsyncSessionLocal() as db:
        song = await db.get(Song, song_id)
        assert song is not None
        return song


async def get_job(job_id: str) -> Job:
    async with AsyncSessionLocal() as db:
        job = await db.get(Job, job_id)
        assert job is not None
        return job


def fake_media(monkeypatch, *, fail_render: bool = False) -> list[bytes | None]:
    audio_sources: list[bytes | None] = []

    def render(cdg_path: Path, dest: Path) -> float:
        assert cdg_path.read_bytes() == NOOP_PACKET
        if fail_render:
            raise CdgImportError("synthetic render failure")
        dest.write_bytes(b"h264 video")
        return 2.0

    def make_audio(source: Path | None, dest: Path, duration: float) -> None:
        assert duration == 2.0
        audio_sources.append(source.read_bytes() if source else None)
        dest.write_bytes(b"16-bit flac")

    def probe(path: Path) -> float:
        return 2.0

    monkeypatch.setattr(cdg_import_job, "_render", render)
    monkeypatch.setattr(cdg_import_job, "_make_audio", make_audio)
    monkeypatch.setattr(cdg_import_job, "_probe_duration", probe)
    return audio_sources


def test_exporter_shaped_same_basename_pair_is_accepted():
    with archive(("SH0001 - Artist - Song.cdg", b"c"),
                 ("SH0001 - Artist - Song.mp3", b"m")) as value:
        cdg, audio = _safe_members(value)
    assert cdg.filename.endswith(".cdg")
    assert audio.filename.endswith(".mp3")


@pytest.mark.parametrize("members", [
    (("song.cdg", b"c"),),
    (("song.cdg", b"c"), ("other.mp3", b"m")),
    (("song.cdg", b"c"), ("song.mp3", b"m"), ("extra.txt", b"x")),
    (("../song.cdg", b"c"), ("song.mp3", b"m")),
    (("song.cdg", b"c"), ("SONG.CDG", b"d"), ("song.mp3", b"m")),
])
def test_unsafe_or_ambiguous_archives_are_refused(members):
    with archive(*members) as value, pytest.raises(CdgImportError):
        _safe_members(value)


def test_entry_count_is_bounded_before_pair_selection():
    members = tuple((f"x{i}.txt", b"") for i in range(MAX_ARCHIVE_ENTRIES + 1))
    with archive(*members) as value, pytest.raises(CdgImportError, match="entries"):
        _safe_members(value)


@pytest.mark.parametrize("hazard", ["encrypted", "symlink", "long-name", "oversize"])
def test_member_metadata_hazards_are_refused(hazard):
    with archive(("song.cdg", b"c"), ("song.mp3", b"m")) as value:
        target = value.infolist()[0]
        if hazard == "encrypted":
            target.flag_bits |= 1
        elif hazard == "symlink":
            target.create_system = 3
            target.external_attr = 0o120777 << 16
        elif hazard == "long-name":
            target.filename = "x" * 256 + ".cdg"
        else:
            target.file_size = 20 * 1024 * 1024
        with pytest.raises(CdgImportError):
            _safe_members(value)


def test_high_cdg_compression_is_not_itself_rejected():
    # CDG streams contain long no-op runs. Their compression ratio is often
    # extreme, so limits apply to uncompressed bytes rather than a ratio.
    with archive(("song.cdg", b"\0" * (1024 * 1024)), ("song.mp3", b"m")) as value:
        cdg, _ = _safe_members(value)
    assert cdg.compress_size < cdg.file_size // 100


def test_completion_requires_video_and_audio(tmp_path):
    assert not completed(tmp_path)
    (tmp_path / "video.mp4").write_bytes(b"v")
    assert not completed(tmp_path)
    (tmp_path / "instrumental.flac").write_bytes(b"a")
    assert completed(tmp_path)


def test_render_watchdog_bounds_the_stdin_write_phase(tmp_path, monkeypatch):
    source = tmp_path / "graphics.cdg"
    source.write_bytes(NOOP_PACKET)

    class Process:
        def __init__(self):
            self.stdin = io.BytesIO()

        def kill(self):
            pass

        def wait(self):
            return -9

        def poll(self):
            return -9

    class ImmediateTimer:
        daemon = False

        def __init__(self, _seconds, callback):
            self.callback = callback

        def start(self):
            self.callback()

        def cancel(self):
            pass

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: Process())
    monkeypatch.setattr("karaoke_backend.jobs.cdg_import.threading.Timer", ImmediateTimer)

    with pytest.raises(CdgImportError, match="timed out"):
        _render(source, tmp_path / "video.mp4")


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="FFmpeg tools are not installed",
)
def test_real_render_produces_one_second_h264_playback_artifact(tmp_path):
    source = tmp_path / "graphics.cdg"
    source.write_bytes(NOOP_PACKET * 300)
    video = tmp_path / "video.mp4"

    assert _render(source, video) == 1.0

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,pix_fmt,width,height,duration",
            "-of",
            "json",
            str(video),
        ],
        capture_output=True,
        check=True,
        text=True,
        timeout=10,
    )
    stream = json.loads(probe.stdout)["streams"][0]
    assert stream["codec_name"] == "h264"
    assert stream["pix_fmt"] == "yuv420p"
    assert (stream["width"], stream["height"]) == (300, 216)
    assert float(stream["duration"]) == pytest.approx(1.0, abs=0.05)


def test_media_subprocess_diagnostics_are_discarded(tmp_path, monkeypatch):
    calls = []

    def run(_cmd, **kwargs):
        calls.append(
            {
                "stdout_is_devnull": kwargs["stdout"] == subprocess.DEVNULL,
                "stdout_is_file": hasattr(kwargs["stdout"], "fileno"),
                "stderr_is_devnull": kwargs["stderr"] == subprocess.DEVNULL,
                "captures_in_memory": "capture_output" in kwargs,
            }
        )
        if kwargs["stdout"] != subprocess.DEVNULL:
            kwargs["stdout"].write(b"2.0\n")
        return Mock(returncode=0)

    monkeypatch.setattr(subprocess, "run", run)
    _run(["ffmpeg"], 1)
    assert _probe_duration(tmp_path / "audio.flac") == 2.0

    assert calls == [
        {
            "stdout_is_devnull": True,
            "stdout_is_file": False,
            "stderr_is_devnull": True,
            "captures_in_memory": False,
        },
        {
            "stdout_is_devnull": False,
            "stdout_is_file": True,
            "stderr_is_devnull": True,
            "captures_in_memory": False,
        },
    ]


@pytest.mark.parametrize("with_source", [False, True])
def test_audio_is_always_16_bit_flac_and_bare_cdg_uses_silence(
    tmp_path, monkeypatch, with_source
):
    seen = []

    def run(cmd, _timeout):
        seen.append(cmd)
        Path(cmd[-1]).write_bytes(b"flac")

    monkeypatch.setattr("karaoke_backend.jobs.cdg_import._run", run)
    source = tmp_path / "source.mp3" if with_source else None
    if source:
        source.write_bytes(b"mp3")
    dest = tmp_path / "instrumental.flac"
    _make_audio(source, dest, 12.5)

    assert dest.read_bytes() == b"flac"
    assert "s16" in seen[0]
    assert ("anullsrc=r=44100:cl=stereo" in seen[0]) is (not with_source)


@pytest.mark.asyncio
async def test_bare_cdg_upload_creates_one_song_and_durable_job(client):
    response = await client.post(
        "/api/import/cdg",
        files={"file": ("Artist - Song.cdg", NOOP_PACKET, "application/x-cdg")},
    )
    assert response.status_code == 202
    body = response.json()
    async with AsyncSessionLocal() as db:
        song = await db.get(Song, body["song_id"])
        job = await db.get(Job, body["job_id"])
    assert (song.artist, song.title, song.status) == ("Artist", "Song", "processing")
    assert job.kind == JobKind.CDG_IMPORT.value
    assert Path(queue.payload_of(job)["upload_name"]).name == queue.payload_of(job)["upload_name"]


@pytest.mark.asyncio
async def test_loose_audio_is_not_accepted_by_cdg_route(client):
    response = await client.post(
        "/api/import/cdg",
        files={"file": ("song.mp3", b"audio", "audio/mpeg")},
    )
    assert response.status_code == 415


@pytest.mark.asyncio
async def test_declared_bare_cdg_over_packet_budget_is_refused_before_read(client):
    response = await client.post(
        "/api/import/cdg",
        headers={"content-length": str(MAX_CDG_BYTES + 1024 * 1024 + 1)},
        files={"file": ("song.cdg", NOOP_PACKET, "application/x-cdg")},
    )
    assert response.status_code == 413
    assert "30-minute" in response.json()["detail"]


@pytest.mark.asyncio
async def test_bare_job_builds_playable_artifacts_and_consumes_upload(client, monkeypatch):
    sources = fake_media(monkeypatch)
    body = await submitted(client, "Artist - Song.cdg", NOOP_PACKET, "application/x-cdg")
    upload = UPLOADS_DIR / queue.payload_of(await get_job(body["job_id"]))["upload_name"]
    assert upload.is_file()

    assert await run_queued_jobs_once() == 1

    stems = STEMS_DIR / str(body["song_id"])
    assert (stems / "video.mp4").read_bytes() == b"h264 video"
    assert (stems / "instrumental.mp3").read_bytes() == b"16-bit flac"
    assert sources == [None]
    song = await get_song(body["song_id"])
    assert (song.status, song.video_filename, song.stems_path) == (
        "ready", "video.mp4", str(stems)
    )
    job = await get_job(body["job_id"])
    assert (job.status, job.phase, job.progress, job.message) == (
        "done", "done", 100, "CD+G import complete"
    )
    assert not upload.exists()


@pytest.mark.asyncio
async def test_mp3g_job_uses_the_archived_audio(client, monkeypatch):
    sources = fake_media(monkeypatch)
    payload = archive_bytes(("Pair.cdg", NOOP_PACKET), ("Pair.mp3", b"source mp3"))
    body = await submitted(client, "Pair.zip", payload, "application/zip")

    assert await run_queued_jobs_once() == 1

    assert sources == [b"source mp3"]
    assert (await get_song(body["song_id"])).status == "ready"
    assert not (STEMS_DIR / str(body["song_id"]) / "source.mp3").exists()


@pytest.mark.asyncio
async def test_permanent_job_failure_mirrors_song_and_retains_upload(client, monkeypatch):
    fake_media(monkeypatch, fail_render=True)
    body = await submitted(client, "broken.cdg", NOOP_PACKET, "application/x-cdg")
    upload = UPLOADS_DIR / queue.payload_of(await get_job(body["job_id"]))["upload_name"]

    assert await run_queued_jobs_once() == 1

    assert (await get_job(body["job_id"])).status == "failed"
    assert (await get_song(body["song_id"])).status == "failed"
    assert upload.is_file(), "a repairable failure must keep the retry source"


@pytest.mark.asyncio
async def test_completed_artifact_reentry_needs_no_upload(client, monkeypatch):
    render = Mock(side_effect=AssertionError("completed import rendered again"))
    monkeypatch.setattr(cdg_import_job, "_render", render)
    monkeypatch.setattr(cdg_import_job, "_probe_duration", lambda _path: 2.0)
    body = await submitted(client, "finished.cdg", NOOP_PACKET, "application/x-cdg")
    upload = UPLOADS_DIR / queue.payload_of(await get_job(body["job_id"]))["upload_name"]
    upload.unlink()
    stems = STEMS_DIR / str(body["song_id"])
    stems.mkdir(parents=True)
    (stems / "video.mp4").write_bytes(b"video")
    (stems / "instrumental.flac").write_bytes(b"audio")

    assert await run_queued_jobs_once() == 1

    assert (await get_job(body["job_id"])).status == "done"
    assert (await get_song(body["song_id"])).status == "ready"
    render.assert_not_called()


@pytest.mark.asyncio
async def test_lease_loss_at_persist_boundary_does_not_ready_the_song(
    client, monkeypatch
):
    fake_media(monkeypatch)
    body = await submitted(client, "lease.cdg", NOOP_PACKET, "application/x-cdg")
    claimed = await queue.claim_next("worker")
    assert claimed is not None
    monkeypatch.setattr(queue, "heartbeat", AsyncMock(return_value=False))
    ctx = JobContext(
        job_id=claimed.id, kind=claimed.kind, worker_id="worker", owner_id=1,
        song_id=body["song_id"], payload=queue.payload_of(claimed),
    )

    with pytest.raises(LeaseLost):
        await cdg_import_job.run_cdg_import(ctx)

    assert (await get_song(body["song_id"])).status == "processing"
    assert (UPLOADS_DIR / queue.payload_of(claimed)["upload_name"]).is_file()


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg unavailable")
@pytest.mark.parametrize("format", ["mp3", "flac"])
def test_real_cdg_audio_preserves_mp3_or_encodes_16_bit(tmp_path, format):
    source = tmp_path / "source.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=0.2", "-c:a", "libmp3lame",
                    "-q:a", "2", str(source)], check=True, timeout=30)
    dest = tmp_path / f"instrumental.{format}"
    _make_audio(source, dest, 0.2)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "stream=codec_name,sample_fmt", "-of", "csv=p=0",
                            str(dest)], capture_output=True, text=True, check=True, timeout=30)
    assert probe.stdout.strip() == ("mp3,fltp" if format == "mp3" else "flac,s16")
    if format == "mp3":
        # Packet payloads are untouched: no second lossy encoding pass.
        def packet_hash(path):
            return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path),
                                   "-c:a", "copy", "-f", "hash", "-"],
                                  capture_output=True, check=True, timeout=30).stdout
        assert packet_hash(source) == packet_hash(dest)
    silence = tmp_path / f"silence.{format}"
    _make_audio(None, silence, 0.2)
    assert _probe_duration(silence) > 0
