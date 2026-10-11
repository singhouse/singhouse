# SPDX-License-Identifier: AGPL-3.0-only
"""Guarded separation input, device notices, and whole-ingest deadlines.

Policies here are synthetic fixtures, not measured model requirements.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from karaoke_backend.jobs.worker import run_queued_jobs_once
from karaoke_backend.workers import memory_admission, modal_worker

FFMPEG = shutil.which("ffmpeg") is not None
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg is required for decode fixtures")


def policy(duration=60):
    envelope = {"maxDurationSeconds": duration, "maxSampleRate": 48000, "maxChannels": 2,
                "devices": {"cuda": {"ramBytes": 1, "vramBytes": 1}, "cpu": {"ramBytes": 1}}}
    return {"schema": 1, "executionProfile": "bounded-v1", "evidenceReference": "synthetic-test-only",
            "models": {model: dict(envelope) for model in modal_worker.WORKFLOW_MODELS}}


@pytest.fixture
def guarded_policy(monkeypatch, tmp_path):
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy()))
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))


def encode(path: Path, *options: str, seconds: float = 1.0) -> Path:
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"sine=frequency=440:duration={seconds}", *options, str(path)], check=True)
    return path


@needs_ffmpeg
@pytest.mark.parametrize("name,options", [
    ("aac.m4a", ["-ar", "48000", "-c:a", "aac"]),
    ("alac.m4a", ["-ar", "44100", "-c:a", "alac"]),
    ("hires.flac", ["-ar", "96000", "-c:a", "flac"]),
    ("surround.flac", ["-ar", "48000", "-af", "aformat=channel_layouts=5.1", "-c:a", "flac"]),
])
@pytest.mark.asyncio
async def test_prepared_input_is_admitted_under_the_existing_envelope(guarded_policy, monkeypatch, tmp_path, name, options):
    import soundfile
    source = encode(tmp_path / name, *options)
    prepared = await modal_worker._prepare_guarded_input(source, tmp_path / "_input")
    info = soundfile.info(prepared)
    assert (info.samplerate, info.channels, info.subtype) == (44100, 2, "FLOAT")
    assert abs(info.duration - 1.0) < 0.05
    assert prepared.stem == source.stem  # Demucs output stays under the upload's stem
    monkeypatch.setattr(memory_admission, "available_ram", lambda: 10)
    monkeypatch.setattr(memory_admission, "cuda_free", lambda: 10)
    with memory_admission.admit("demucs-mdx-extra", "cuda", [str(prepared)]) as device:
        assert device == "cuda"


@needs_ffmpeg
@pytest.mark.asyncio
async def test_long_track_refusal_states_the_device_independent_limit(monkeypatch, tmp_path):
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy(duration=2)))
    source = encode(tmp_path / "long.mp3", "-c:a", "libmp3lame", seconds=4) if _has_encoder("libmp3lame") \
        else encode(tmp_path / "long.flac", "-c:a", "flac", seconds=4)
    with pytest.raises(modal_worker.UnsupportedAudioError) as refused:
        await modal_worker._prepare_guarded_input(source, tmp_path / "_input")
    message = str(refused.value)
    assert "longer than 0:02" in message and "on the GPU and the CPU alike" in message


def gapped(path: Path, before: float, after: float, gap: float) -> Path:
    """Audio whose packet timestamps jump forward by ``gap`` seconds after ``before`` seconds."""
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"sine=frequency=440:sample_rate=8000:duration={before + after}",
                    "-af", f"asetpts='if(gte(T,{before}),PTS+{gap}/TB,PTS)'", "-c:a", "flac", str(path)], check=True)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                           capture_output=True, text=True, check=True)
    assert float(probe.stdout) > before + after + gap - 1  # the fixture really carries the gap
    return path


@needs_ffmpeg
@pytest.mark.asyncio
async def test_timestamp_gap_cannot_hide_audio_past_the_limit(monkeypatch, tmp_path):
    # 20 s of audio with a 700 s forward timestamp jump after 10 s. A timestamp
    # limit (-t) would keep only the first 10 s and admit the truncated copy.
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy(duration=15)))
    source = gapped(tmp_path / "gapped.mka", before=10, after=10, gap=700)
    with pytest.raises(modal_worker.UnsupportedAudioError, match="longer than 0:15"):
        await modal_worker._prepare_guarded_input(source, tmp_path / "_input")


@needs_ffmpeg
@pytest.mark.asyncio
async def test_timestamp_gap_keeps_every_decoded_sample(guarded_policy, tmp_path):
    import soundfile
    source = gapped(tmp_path / "gapped.mka", before=10, after=10, gap=700)
    prepared = await modal_worker._prepare_guarded_input(source, tmp_path / "_input")
    # Samples are kept back to back, as Demucs's own decode of the upload did.
    assert abs(soundfile.info(prepared).duration - 20) < 0.05


@needs_ffmpeg
@pytest.mark.asyncio
async def test_overlong_decode_stops_at_the_byte_bound(monkeypatch, tmp_path):
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy(duration=2)))
    source = encode(tmp_path / "long.flac", "-c:a", "flac", seconds=30)
    with pytest.raises(modal_worker.UnsupportedAudioError):
        await modal_worker._prepare_guarded_input(source, tmp_path / "_input")
    written = (tmp_path / "_input" / "long.wav").stat().st_size
    # ffmpeg checks the bound after buffered writes; the overshoot is a fixed
    # buffer, not proportional to the track, and far short of a full decode.
    assert written <= modal_worker._prepared_size_limit(2) + 1024 * 1024
    assert written < 30 * 44100 * 2 * 4 / 4


def test_size_bound_holds_one_second_past_the_limit():
    assert modal_worker._prepared_size_limit(600) == 601 * 44100 * 2 * 4 + modal_worker.WAV_HEADER_ALLOWANCE


@needs_ffmpeg
@pytest.mark.asyncio
async def test_large_metadata_cannot_end_an_overlong_decode_early(monkeypatch, tmp_path):
    # 20 s of audio carrying a 4 MiB comment tag. Copied into the WAV, the tag
    # used most of a 15 s byte bound and left a short copy that was admitted.
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(policy(duration=15)))
    metadata = tmp_path / "metadata.txt"
    metadata.write_text(";FFMETADATA1\ncomment=" + "A" * (4 * 1024 * 1024) + "\n")
    source = tmp_path / "tagged.flac"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=20", "-i", str(metadata), "-map_metadata", "1",
                    "-c:a", "flac", str(source)], check=True)
    assert source.stat().st_size > 4 * 1024 * 1024  # the fixture really carries the tag
    with pytest.raises(modal_worker.UnsupportedAudioError, match="longer than 0:15"):
        await modal_worker._prepare_guarded_input(source, tmp_path / "_input")


@needs_ffmpeg
@pytest.mark.asyncio
async def test_prepared_wav_carries_no_metadata(guarded_policy, tmp_path):
    source = tmp_path / "tagged.flac"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=1", "-metadata", "title=" + "T" * 10000,
                    "-c:a", "flac", str(source)], check=True)
    prepared = await modal_worker._prepare_guarded_input(source, tmp_path / "_input")
    duration, offset = modal_worker._wav_layout(prepared)
    assert abs(duration - 1) < 0.05
    assert offset <= 128
    assert b"LIST" not in prepared.read_bytes()[:offset]


@pytest.mark.asyncio
async def test_oversized_wav_header_is_refused(guarded_policy, monkeypatch, tmp_path):
    def write(command, timeout, **options):
        # A RIFF file whose metadata chunk precedes the data past the allowance.
        payload = b"\0" * (44100 * 2 * 4)
        fmt = (3).to_bytes(2, "little") + (2).to_bytes(2, "little") + (44100).to_bytes(4, "little") \
            + (44100 * 8).to_bytes(4, "little") + (8).to_bytes(2, "little") + (32).to_bytes(2, "little")
        body = (b"WAVE" + b"fmt " + len(fmt).to_bytes(4, "little") + fmt
                + b"LIST" + (8192).to_bytes(4, "little") + b"\0" * 8192
                + b"data" + len(payload).to_bytes(4, "little") + payload)
        Path(command[-1]).write_bytes(b"RIFF" + len(body).to_bytes(4, "little") + body)

    monkeypatch.setattr(modal_worker, "_await_subprocess", AsyncMock(side_effect=write))
    source = tmp_path / "upload.flac"
    source.touch()
    with pytest.raises(modal_worker.UnsupportedAudioError, match="could not be decoded"):
        await modal_worker._prepare_guarded_input(source, tmp_path / "_input")


@pytest.mark.parametrize("value", [
    "",
    "not json",
    json.dumps({"schema": 1}),
    "partial",
])
@pytest.mark.asyncio
async def test_missing_policy_refuses_before_ffmpeg_runs(monkeypatch, tmp_path, value):
    if value == "partial":
        partial = policy()
        del partial["models"]["karaoke-roformer"]
        value = json.dumps(partial)
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", value)
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", "cuda")
    runner = AsyncMock(side_effect=AssertionError("ffmpeg must not run without a measured policy"))
    monkeypatch.setattr(modal_worker, "_await_subprocess", runner)
    source = tmp_path / "upload.flac"
    source.touch()
    with pytest.raises(modal_worker.ProcessingRefusedError) as refused:
        await modal_worker._prepare_guarded_input(source, tmp_path / "_input")
    assert not isinstance(refused.value, modal_worker.UnsupportedAudioError)
    assert str(refused.value) == modal_worker.MISSING_POLICY_MESSAGE
    assert "no measured memory policy" in str(refused.value)
    runner.assert_not_awaited()
    assert not (tmp_path / "_input").exists()


def _has_encoder(name):
    listing = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return f" {name} " in listing


def test_limit_wording_for_the_measured_envelope():
    assert modal_worker._format_duration(600) == "10 minutes"
    assert modal_worker._format_duration(60) == "1 minute"
    assert modal_worker._format_duration(90) == "1:30"


def test_duration_limit_is_the_shortest_workflow_envelope(monkeypatch):
    value = policy(duration=600)
    value["models"]["heart-transcriptor"]["maxDurationSeconds"] = 300
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(value))
    assert modal_worker.workflow_duration_limit() == 300
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", "")
    assert modal_worker.workflow_duration_limit() is None
    del value["models"]["demucs-mdx-extra"]
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", json.dumps(value))
    assert modal_worker.workflow_duration_limit() is None  # every workflow model needs a policy


@needs_ffmpeg
@pytest.mark.asyncio
async def test_undecodable_upload_is_a_clear_refusal(guarded_policy, tmp_path):
    source = tmp_path / "broken.m4a"
    source.write_bytes(b"not audio at all" * 64)
    with pytest.raises(modal_worker.UnsupportedAudioError, match="could not be decoded"):
        await modal_worker._prepare_guarded_input(source, tmp_path / "_input")


def _managed(monkeypatch, tmp_path, device):
    interpreter = tmp_path / "python"
    interpreter.touch()
    monkeypatch.setattr(modal_worker, "DEMUCS_PYTHON", interpreter)
    monkeypatch.setattr(modal_worker.modal_offload, "is_enabled", lambda: False)
    monkeypatch.setattr(modal_worker, "configured_accelerator", lambda: device)
    monkeypatch.setattr(modal_worker, "require_selected_models", lambda *_: None)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", "managed")


@pytest.mark.asyncio
async def test_prepared_copy_feeds_demucs_and_is_removed(guarded_policy, monkeypatch, tmp_path):
    _managed(monkeypatch, tmp_path, "cuda")
    stems = tmp_path / "stems"
    seen = {}

    async def prepare(source, work):
        work.mkdir(parents=True)
        target = work / f"{source.stem}.wav"
        target.write_bytes(b"prepared")
        return target

    async def run(cmd, timeout, **options):
        seen["input"] = Path(cmd[-1])
        seen["existed"] = Path(cmd[-1]).is_file()
        seen["options"] = options
        raise modal_worker.StemSeparationError("stop after Pass 1 launch")

    monkeypatch.setattr(modal_worker, "_prepare_guarded_input", prepare)
    monkeypatch.setattr(modal_worker, "_await_subprocess", run)
    with pytest.raises(modal_worker.StemSeparationError, match="stop after"):
        await modal_worker.separate_stems(tmp_path / "upload.m4a", stems, "job")
    assert seen["input"] == stems / "_input" / "upload.wav" and seen["existed"]
    assert "on_stderr_line" in seen["options"]
    assert not (stems / "_input").exists()


@pytest.mark.asyncio
async def test_unguarded_runtime_keeps_original_input_and_runner(monkeypatch, tmp_path):
    _managed(monkeypatch, tmp_path, "cpu")
    monkeypatch.delenv("KARAOKE_PROCESSING_MEMORY_JSON", raising=False)
    prepare = AsyncMock()
    monkeypatch.setattr(modal_worker, "_prepare_guarded_input", prepare)
    launch = AsyncMock(side_effect=modal_worker.StemSeparationError("stop"))
    monkeypatch.setattr(modal_worker, "_await_subprocess", launch)
    with pytest.raises(modal_worker.StemSeparationError):
        await modal_worker.separate_stems(tmp_path / "upload.mp3", tmp_path / "stems", "job")
    prepare.assert_not_awaited()
    assert launch.call_args.args[0][-1] == str(tmp_path / "upload.mp3")
    assert set(launch.call_args.kwargs) == {"timeout"}


@pytest.mark.asyncio
async def test_device_line_becomes_job_progress_text(guarded_policy, monkeypatch, tmp_path):
    _managed(monkeypatch, tmp_path, "cuda")
    monkeypatch.setattr(modal_worker, "_prepare_guarded_input", AsyncMock(side_effect=lambda p, _w: p))

    async def run(cmd, timeout, on_stderr_line):
        await on_stderr_line("Downloading nothing; plain progress text")
        await on_stderr_line(memory_admission.device_line("demucs-mdx-extra", "cuda", "cpu", "insufficient-vram"))
        raise modal_worker.StemSeparationError("stop")

    monkeypatch.setattr(modal_worker, "_await_subprocess", run)
    messages = []

    async def progress(_status, pct, message):
        messages.append((pct, message))

    with pytest.raises(modal_worker.StemSeparationError):
        await modal_worker.separate_stems(tmp_path / "upload.wav", tmp_path / "stems", "job", on_progress=progress)
    assert (10, "Separating vocals and accompaniment on the CPU because there is not enough free GPU "
                "memory; this is slower") in messages
    assert not any("plain progress" in message for _pct, message in messages)


@pytest.mark.asyncio
async def test_pass2_device_line_is_surfaced(guarded_policy, monkeypatch, tmp_path):
    monkeypatch.setattr(modal_worker, "configured_pass2_device", lambda: "cuda")
    monkeypatch.setattr(modal_worker, "require_selected_models", lambda *_: None)

    async def run(cmd, timeout, on_stderr_line):
        await on_stderr_line(memory_admission.device_line("karaoke-roformer", "cuda", "cuda", "requested"))

    monkeypatch.setattr(modal_worker, "_await_subprocess", run)
    messages = []

    async def progress(_status, pct, message):
        messages.append((pct, message))

    await modal_worker.run_pass2(tmp_path / "vocals.wav", tmp_path / "out", "fixture", progress)
    assert (50, "Splitting lead and backing vocals on the GPU") in messages


@pytest.mark.asyncio
async def test_runner_streams_stderr_lines_while_the_child_runs(tmp_path):
    marker = tmp_path / "seen"
    line = memory_admission.device_line("demucs-mdx-extra", "cuda", "cpu", "insufficient-vram")
    script = (
        "import os, sys, time\n"
        "sys.stderr.write('bar\\r' * 20000)\n"
        f"sys.stderr.write({line!r} + '\\n'); sys.stderr.flush()\n"
        "deadline = time.monotonic() + 10\n"
        f"while not os.path.exists({str(marker)!r}) and time.monotonic() < deadline: time.sleep(0.02)\n"
        "print('x' * 200000)\n"
    )
    received = []

    async def on_line(text):
        record = memory_admission.parse_device_line(text)
        if record:
            received.append(record)
            marker.touch()  # the child exits only after this arrives

    result = await modal_worker._run_subprocess([sys.executable, "-c", script], timeout=20, on_stderr_line=on_line)
    assert [record["device"] for record in received] == ["cpu"]
    assert len(result.stdout.strip()) == 200000
    assert result.stderr.count("bar") == 20000


@pytest.mark.asyncio
async def test_failed_notice_callback_reaps_the_child(tmp_path):
    if os.name != "posix":
        pytest.skip("POSIX process-group contract")
    pid_file = tmp_path / "child.pid"
    script = f"import os,sys,time; open({str(pid_file)!r},'w').write(str(os.getpid())); sys.stderr.write('x\\n'); sys.stderr.flush(); time.sleep(30)"

    async def on_line(_text):
        raise RuntimeError("lease lost")

    with pytest.raises(RuntimeError, match="lease lost"):
        await modal_worker._run_subprocess([sys.executable, "-c", script], timeout=20, on_stderr_line=on_line)
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


# ---------------------------------------------------------------------------
# Ingest level
# ---------------------------------------------------------------------------

WAV = (
    b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    b"\x44\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
)


@pytest.fixture
def clean_dirs():
    """STEMS_DIR and UPLOADS_DIR outlive the per-test database, so song ids
    restart over another test's leftovers (including separation markers)."""
    for var in ("STEMS_DIR", "UPLOADS_DIR"):
        for child in Path(os.environ[var]).iterdir():
            shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()


async def _queue_upload(client: AsyncClient) -> str:
    resp = await client.post("/api/separate", files={"file": ("t.wav", io.BytesIO(WAV), "audio/wav")},
                             data={"artist": "Test", "title": "Envelope"})
    assert resp.status_code == 202
    return resp.json()["job_id"]


@pytest.mark.asyncio
async def test_ingest_uses_the_guarded_whole_separation_deadline(clean_dirs, client: AsyncClient, monkeypatch):
    job_id = await _queue_upload(client)
    # The worker, not the upload route, sees the guarded CUDA runtime here.
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", "managed")
    monkeypatch.setattr(modal_worker.modal_offload, "is_enabled", lambda: False)
    monkeypatch.setattr(modal_worker, "configured_accelerator", lambda: "cuda")
    deadlines = []
    real_wait_for = asyncio.wait_for

    async def recording_wait_for(awaitable, timeout):
        deadlines.append(timeout)
        return await real_wait_for(awaitable, timeout)

    with patch("karaoke_backend.jobs.ingest.separate_stems",
               new=AsyncMock(side_effect=modal_worker.StemSeparationError("stop"))), \
            patch("karaoke_backend.jobs.ingest.asyncio.wait_for", new=recording_wait_for), \
            patch("karaoke_backend.jobs.ingest.asyncio.sleep", new=AsyncMock()):
        assert await run_queued_jobs_once() == 1
    expected = (modal_worker.INPUT_PREPARATION_TIMEOUT + 2 * modal_worker.MANAGED_STAGE_TIMEOUT
                + modal_worker.MIXING_TIMEOUT)
    assert deadlines and set(deadlines) == {expected}
    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "failed"


@pytest.mark.asyncio
async def test_ingest_shows_audio_refusal_and_does_not_retry(clean_dirs, client: AsyncClient):
    job_id = await _queue_upload(client)
    message = ("This track is longer than 10 minutes. Local processing supports tracks up to 10 minutes long, "
               "on the GPU and the CPU alike, so it was not processed.")
    separate = AsyncMock(side_effect=modal_worker.UnsupportedAudioError(message))
    with patch("karaoke_backend.jobs.ingest.separate_stems", new=separate), \
            patch("karaoke_backend.jobs.ingest.asyncio.sleep", new=AsyncMock()):
        assert await run_queued_jobs_once() == 1
    assert separate.await_count == 1
    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "failed"
    assert job["message"] == message


@pytest.mark.asyncio
async def test_ingest_shows_missing_policy_refusal_and_does_not_retry(clean_dirs, client: AsyncClient):
    job_id = await _queue_upload(client)
    separate = AsyncMock(side_effect=modal_worker.ProcessingRefusedError(modal_worker.MISSING_POLICY_MESSAGE))
    with patch("karaoke_backend.jobs.ingest.separate_stems", new=separate), \
            patch("karaoke_backend.jobs.ingest.asyncio.sleep", new=AsyncMock()):
        assert await run_queued_jobs_once() == 1
    assert separate.await_count == 1
    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["status"] == "failed"
    assert job["message"] == modal_worker.MISSING_POLICY_MESSAGE


@pytest.mark.asyncio
async def test_transcription_device_notice_reaches_the_job_message(clean_dirs, client: AsyncClient):
    from karaoke_backend.jobs import ingest
    job_id = await _queue_upload(client)
    stems_seen = {}

    async def separated(*, stems_dir, **_kwargs):
        stems_dir.mkdir(parents=True, exist_ok=True)
        for name in ingest.SEPARATION_ARTIFACTS:
            (stems_dir / name).write_bytes(WAV)
        stems_seen["dir"] = stems_dir
        return {}

    async def transcribe(**kwargs):
        notice = kwargs["device_notice_fn"]
        await asyncio.to_thread(notice, "Transcribing vocals on the CPU because there is not enough free GPU "
                                        "memory; this is slower")
        job = (await client.get(f"/api/jobs/{job_id}")).json()
        stems_seen["message"] = job["message"]
        return None

    with patch("karaoke_backend.jobs.ingest.separate_stems", new=separated), \
            patch("karaoke_backend.jobs.ingest.generate_word_sync", new=transcribe):
        assert await run_queued_jobs_once() == 1
    assert "dir" in stems_seen
    assert stems_seen["message"].startswith("Transcribing vocals on the CPU because there is not enough")


@pytest.mark.asyncio
async def test_historical_runner_replacement_still_runs_without_notices(guarded_policy, monkeypatch, tmp_path):
    monkeypatch.setattr(modal_worker, "configured_pass2_device", lambda: "cuda")
    monkeypatch.setattr(modal_worker, "require_selected_models", lambda *_: None)
    seen = []

    async def run(cmd, timeout):
        seen.append(timeout)

    monkeypatch.setattr(modal_worker, "_await_subprocess", run)
    await modal_worker.run_pass2(tmp_path / "vocals.wav", tmp_path / "out", "fixture", AsyncMock())
    assert seen == [modal_worker.MANAGED_STAGE_TIMEOUT]
