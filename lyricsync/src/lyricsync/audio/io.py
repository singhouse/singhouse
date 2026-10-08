# SPDX-License-Identifier: MIT
from __future__ import annotations

import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Tuple

import numpy as np


def read_wav_mono(path: str) -> Tuple[np.ndarray, int]:
    """Return mono float32 samples and sample rate from WAV, MP3, FLAC, M4A, or WebM.

    PCM WAV keeps its native reader. Compressed stems require ffmpeg on PATH;
    decode to a temporary file to avoid buffering a second full audio stream
    in a subprocess pipe. ffmpeg honors MP3 gapless metadata and retains the
    source sample rate, so VAD and alignment share playback's sample timeline.
    The historical function name remains compatible with existing callers.
    """
    if Path(path).suffix.lower() not in {".mp3", ".flac", ".m4a", ".webm"}:
        return _read_pcm_wav(path)
    with tempfile.TemporaryDirectory(prefix="lyricsync-audio-") as directory:
        decoded = Path(directory) / "decoded.wav"
        try:
            subprocess.run(
                ["ffmpeg", "-nostdin", "-y", "-v", "error", "-xerror",
                 "-i", str(path), "-map", "0:a:0", "-vn",
                 "-c:a", "pcm_s16le", str(decoded)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=True, timeout=600,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg is required to read compressed audio") from exc
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ValueError("Could not decode audio for transcription or alignment") from exc
        return _read_pcm_wav(str(decoded))


def _read_pcm_wav(path: str) -> Tuple[np.ndarray, int]:
    with wave.open(path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sampwidth == 2:
        dtype = np.int16
        max_val = 32768.0
    elif sampwidth == 4:
        dtype = np.int32
        max_val = 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {sampwidth}")

    samples = np.frombuffer(raw, dtype=dtype).astype(np.float32) / max_val

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    return samples, sample_rate
