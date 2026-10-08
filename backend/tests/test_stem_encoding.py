# SPDX-License-Identifier: AGPL-3.0-only
import asyncio
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from karaoke_backend import stem_encoding as encoding


def audio(path, rate, channels, frames=None, silent=False):
    samples = np.zeros((frames or rate, channels), dtype=np.float32)
    if not silent:
        samples[rate // 3:rate // 3 + 300] = .5
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(rate),
                    "-ac", str(channels), "-i", "pipe:0", "-c:a", "pcm_f32le", str(path)],
                   input=samples.tobytes(), check=True)
    return samples


@pytest.mark.asyncio
@pytest.mark.parametrize("format", ["mp3", "flac"])
@pytest.mark.parametrize("rate,channels", [(44100, 2), (48000, 1)])
async def test_real_codec_preserves_timing_and_audio_shape(tmp_path, format, rate, channels):
    source = tmp_path / "input.wav"
    original = audio(source, rate, channels)
    target = tmp_path / f"stem.{format}"
    await encoding.encode_stem(source, target)
    info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(target)]))["streams"][0]
    assert int(info["sample_rate"]) == rate
    assert info["channels"] == channels
    if format == "flac":
        assert info["bits_per_raw_sample"] == "16"
    else:
        assert int(info["bit_rate"]) == 256000
    decoded = np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(target), "-f", "f32le", "pipe:1"]), dtype=np.float32).reshape(-1, channels)
    assert decoded.shape == original.shape
    assert np.argmax(decoded[:, 0] > .25) == rate // 3
    assert source.exists()


def test_format_default_and_invalid_setting(monkeypatch):
    monkeypatch.delenv("STEM_FORMAT", raising=False)
    assert encoding.stem_format() == "mp3"
    monkeypatch.setenv("STEM_FORMAT", "flac")
    assert encoding.stem_format() == "flac"
    monkeypatch.setenv("STEM_FORMAT", "wav")
    with pytest.raises(ValueError, match="STEM_FORMAT"):
        encoding.stem_format()


@pytest.mark.asyncio
async def test_failed_batch_retains_every_source(monkeypatch, tmp_path):
    for base in encoding.PLAYABLE_BASES:
        (tmp_path / f"{base}.wav").write_bytes(b"source")
    async def fail(source, target):
        if source.stem == "instrumental":
            raise RuntimeError("encoding failed")
        target.write_bytes(b"encoded")
    monkeypatch.setattr(encoding, "encode_stem", fail)
    with pytest.raises(RuntimeError, match="encoding failed"):
        await encoding.finalize_stems(tmp_path)
    assert len(list(tmp_path.glob("*.wav"))) == 4


@pytest.mark.asyncio
async def test_encoder_failure_preserves_existing_target_and_source(tmp_path):
    source = tmp_path / "input.wav"; source.write_bytes(b"invalid audio")
    target = tmp_path / "output.mp3"; target.write_bytes(b"old")
    with pytest.raises(Exception):
        await encoding.encode_stem(source, target)
    assert target.read_bytes() == b"old"
    assert source.read_bytes() == b"invalid audio"
    assert not list(tmp_path.glob(".*.tmp"))


@pytest.mark.asyncio
async def test_cancellation_waits_for_owned_child_and_cleans_temp(monkeypatch, tmp_path):
    started, reaped = asyncio.Event(), asyncio.Event()
    async def child(cmd, timeout):
        Path(cmd[-1]).write_bytes(b"partial")
        started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            reaped.set()
            raise
    monkeypatch.setattr(encoding, "_await_subprocess", child)
    source = tmp_path / "input.wav"; source.write_bytes(b"source")
    task = asyncio.create_task(encoding.encode_stem(source, tmp_path / "output.mp3"))
    await started.wait(); task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert reaped.is_set() and source.exists()
    assert not list(tmp_path.glob(".*.tmp"))


@pytest.mark.asyncio
@pytest.mark.parametrize("frames,silent", [(44137, False), (44137, True), (733, True)])
async def test_mp3_gapless_lengths_including_silent_and_partial_frames(tmp_path, frames, silent):
    source = tmp_path / "input.wav"
    audio(source, 44100, 2, frames=frames, silent=silent)
    target = tmp_path / "stem.mp3"
    await encoding.encode_stem(source, target)
    decoded = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(target), "-f", "f32le", "pipe:1"])
    assert len(decoded) == frames * 2 * 4


def test_marker_refuses_missing_recorded_artifacts(tmp_path):
    from karaoke_backend.jobs.ingest import write_separation_marker, separation_is_complete
    for base in ("lead_vocals", "instrumental", "karaoke"):
        (tmp_path / f"{base}.mp3").write_bytes(b"encoded")
    write_separation_marker(tmp_path)
    assert separation_is_complete(tmp_path)
    (tmp_path / "karaoke.mp3").unlink()
    assert not separation_is_complete(tmp_path)


@pytest.mark.asyncio
async def test_all_recognized_lanes_are_finalized_and_old_formats_retired(tmp_path, monkeypatch):
    names = ("lead_vocals", "backing_vocals", "instrumental", "karaoke",
             "lead_vocals_2", "backing_vocals_3", "vocal_7+8")
    monkeypatch.setenv("STEM_FORMAT", "flac")
    for base in names:
        (tmp_path / f"{base}.wav").write_bytes(b"new")
        (tmp_path / f"{base}.mp3").write_bytes(b"stale")
    intermediate = tmp_path / "vocals.wav"
    intermediate.write_bytes(b"separator intermediate")

    async def encode(source, target):
        target.write_bytes(source.read_bytes())

    monkeypatch.setattr(encoding, "encode_stem", encode)
    await encoding.finalize_stems(tmp_path)
    assert intermediate.read_bytes() == b"separator intermediate"
    assert not list(tmp_path.glob("*.mp3"))
    assert sorted(p.stem for p in tmp_path.glob("*.flac")) == sorted(names)
    assert list(tmp_path.glob("*.wav")) == [intermediate]


@pytest.mark.parametrize("payload", [[], None, {"artifacts": [1]},
                                      {"artifacts": ["../lead_vocals.wav"]}])
def test_malformed_marker_is_incomplete(tmp_path, payload):
    from karaoke_backend.jobs.ingest import separation_is_complete
    (tmp_path / ".separation-complete").write_text(json.dumps(payload))
    assert not separation_is_complete(tmp_path)
