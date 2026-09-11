# SPDX-License-Identifier: MIT
"""Fixtures for lyricsync tests."""

import numpy as np
import pytest
from lyricsync._types import TimedWord


@pytest.fixture
def sample_words():
    """A simple list of timed words for testing alignment."""
    return [
        TimedWord(text="hello", start=0.0, end=0.5),
        TimedWord(text="world", start=0.6, end=1.0),
        TimedWord(text="this", start=1.1, end=1.4),
        TimedWord(text="is", start=1.5, end=1.7),
        TimedWord(text="a", start=1.8, end=1.9),
        TimedWord(text="test", start=2.0, end=2.5),
    ]


@pytest.fixture
def sample_audio():
    """Generate a short sine-wave audio sample for VAD testing."""
    sample_rate = 16000
    duration = 2.0
    t = np.linspace(0, duration, int(sample_rate * duration), dtype=np.float32)
    # 440Hz sine wave at moderate volume
    audio = (np.sin(2 * np.pi * 440 * t) * 0.3).astype(np.float32)
    return audio, sample_rate


@pytest.fixture
def sample_audio_with_silence():
    """Audio with silence gaps for VAD segmentation testing."""
    sample_rate = 16000
    # 1s silence + 2s signal + 2s silence + 2s signal + 1s silence
    silence = np.zeros(sample_rate, dtype=np.float32)
    signal = (np.sin(2 * np.pi * 440 * np.linspace(0, 2, sample_rate * 2)) * 0.5).astype(np.float32)
    audio = np.concatenate([silence, signal, silence * 2, signal, silence])
    return audio, sample_rate
