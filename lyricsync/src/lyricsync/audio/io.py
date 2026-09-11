# SPDX-License-Identifier: MIT
from __future__ import annotations

import wave
from typing import Tuple

import numpy as np


def read_wav_mono(path: str) -> Tuple[np.ndarray, int]:
    """Read a WAV file and return (samples_float32, sample_rate)."""
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
