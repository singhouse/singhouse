# SPDX-License-Identifier: MIT
"""Compressed playback stems retain the sample timeline used by alignment."""
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from lyricsync.audio.io import read_wav_mono


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")
@pytest.mark.parametrize("format", ["wav", "mp3", "flac"])
@pytest.mark.parametrize("rate,channels", [(44100, 2), (48000, 1)])
def test_playback_audio_decode_preserves_timeline(tmp_path, format, rate, channels):
    frames = rate + 137
    samples = np.zeros((frames, channels), dtype=np.int16)
    samples[rate // 3:rate // 3 + 300] = 16000
    source = tmp_path / "source.wav"
    with wave.open(str(source), "wb") as stream:
        stream.setparams((channels, 2, rate, frames, "NONE", "not compressed"))
        stream.writeframes(samples.tobytes())
    target = tmp_path / f"playback.{format}"
    if format == "wav":
        shutil.copyfile(source, target)
    else:
        codec = ["-c:a", "libmp3lame", "-b:a", "256k"] if format == "mp3" else ["-c:a", "flac"]
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), *codec, str(target)], check=True)
    decoded, sample_rate = read_wav_mono(str(target))
    assert sample_rate == rate
    assert decoded.shape == (frames,)
    assert decoded.dtype == np.float32
    assert np.argmax(decoded > .25) == rate // 3
    if format != "mp3":
        np.testing.assert_array_equal(decoded, samples[:, 0].astype(np.float32) / 32768)


@pytest.mark.parametrize("failure", [subprocess.CalledProcessError(1, "ffmpeg"),
                                      subprocess.TimeoutExpired("ffmpeg", 600),
                                      FileNotFoundError("ffmpeg")])
def test_failed_decode_cleans_temporary_audio(monkeypatch, tmp_path, failure):
    source = tmp_path / "source.mp3"
    source.write_bytes(b"original compressed stem")
    temporary = []

    def fail(command, **kwargs):
        destination = Path(command[-1])
        destination.write_bytes(b"partial")
        temporary.append(destination)
        raise failure

    monkeypatch.setattr(subprocess, "run", fail)
    with pytest.raises((ValueError, RuntimeError)):
        read_wav_mono(str(source))
    assert source.read_bytes() == b"original compressed stem"
    assert temporary and not temporary[0].parent.exists()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")
@pytest.mark.parametrize("extension,codec", [
    ("m4a", "aac"), ("webm", "libopus"), ("webm", "libvorbis"),
])
def test_retained_container_decode_uses_playback_timeline(tmp_path, extension, codec):
    source = tmp_path / f"source.{extension}"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", codec, str(source),
    ], check=True, timeout=30)
    original = source.read_bytes()
    # Codec padding may change duration; compare to decoding the retained file,
    # which is the same timeline playback receives, rather than the encoder input.
    reference = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(source), "-map", "0:a:0",
        "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ], timeout=30)
    decoded, rate = read_wav_mono(str(source))
    assert rate == 48000
    assert len(decoded) >= rate
    np.testing.assert_array_equal(decoded, np.frombuffer(reference, dtype=np.int16).astype(np.float32) / 32768)
    assert source.read_bytes() == original
