# SPDX-License-Identifier: AGPL-3.0-only
"""The bounded execution profile applies only under guarded admission.

Unguarded CPU and Metal runtimes must keep upstream Demucs and audio-separator
settings when a pack is rebuilt from this tree. No model is loaded here.
"""
from contextlib import contextmanager
import sys
from types import ModuleType, SimpleNamespace

import pytest

from karaoke_backend.workers import managed_audio_separator, managed_demucs, memory_admission

ROFORMER = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"


@pytest.fixture
def worker_boundary(monkeypatch):
    """Neutralize process-wide guards and record admission calls."""
    monkeypatch.setattr(managed_audio_separator, "disable_mps_fallback", lambda: None)
    monkeypatch.setattr(sys, "addaudithook", lambda _hook: None)
    calls = []

    def configure(selected):
        @contextmanager
        def admit(model, requested, paths, **kwargs):
            calls.append((model, requested, list(paths)))
            yield selected
        monkeypatch.setattr(memory_admission, "admit", admit)

    configure(None)
    for name in ("KARAOKE_PROCESSING_MEMORY_JSON", "KARAOKE_PROCESSING_ACCELERATOR"):
        monkeypatch.delenv(name, raising=False)
    return SimpleNamespace(calls=calls, select=configure)


def install(monkeypatch, name, **attributes):
    module = ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)
    return module


def fake_demucs(monkeypatch):
    argv = []
    separate = install(monkeypatch, "demucs.separate", main=lambda args: argv.extend(args), save_audio=object())
    install(monkeypatch, "demucs", separate=separate)
    install(monkeypatch, "torch", empty=lambda *a, **k: None)
    return argv


@pytest.mark.parametrize("accelerator,policy,requested,selected,bounded", [
    ("cuda", "", "cuda", "cuda", True),
    ("cuda", "", "cuda", "cpu", True),         # measured CPU fallback inside a CUDA runtime
    ("cpu", "", "cpu", "cpu", False),          # existing CPU pack
    ("metal", "", "mps", "mps", False),        # existing Metal pack
    ("cpu", "{\"schema\": 1}", "cpu", "cpu", True),  # a CPU runtime that carries policy
])
def test_demucs_segment_profile_only_when_guarded(monkeypatch, worker_boundary, accelerator, policy,
                                                 requested, selected, bounded):
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", accelerator)
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", policy)
    worker_boundary.select(selected)
    argv = fake_demucs(monkeypatch)
    managed_demucs.main(["-n", "mdx_extra", "--device", requested, "--float32", "-o", "out", "track.wav"])
    profile = ["--segment", str(memory_admission.DEMUCS_SEGMENT_SECONDS), "--jobs", "0"]
    expected = ["-n", "mdx_extra", "--device", selected, *(profile if bounded else []),
                "--float32", "-o", "out", "track.wav"]
    assert argv == expected
    assert worker_boundary.calls == [("demucs-mdx-extra", requested, ["track.wav"])]


def fake_separator(monkeypatch):
    seen = {}

    class Separator:
        def __init__(self, **kwargs):
            seen["kwargs"] = kwargs

        def load_model(self, model_filename):
            seen["model"] = model_filename

        def separate(self, audio):
            seen["audio"] = audio

    install(monkeypatch, "torch", device=lambda name: name,
            cuda=SimpleNamespace(is_available=lambda: True),
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: True)))
    install(monkeypatch, "onnxruntime", InferenceSession=object, get_available_providers=lambda: [])
    install(monkeypatch, "audio_separator")
    install(monkeypatch, "audio_separator.separator", Separator=Separator)
    return seen


@pytest.mark.parametrize("accelerator,requested,selected,bounded,autocast", [
    ("cuda", "cuda", "cuda", True, True),
    ("cuda", "cuda", "cpu", True, False),
    ("cpu", "cpu", "cpu", False, None),
    ("metal", "mps", "mps", False, None),
])
def test_roformer_profile_only_when_guarded(monkeypatch, worker_boundary, accelerator, requested, selected,
                                           bounded, autocast):
    monkeypatch.setenv("KARAOKE_PROCESSING_ACCELERATOR", accelerator)
    worker_boundary.select(selected)
    seen = fake_separator(monkeypatch)
    managed_audio_separator.main(["vocals.wav", "--model_filename", ROFORMER, "--model_file_dir", "models",
                                  "--output_dir", "out", "--device", requested])
    base = {"model_file_dir": "models", "output_dir": "out", "output_format": "WAV"}
    if bounded:
        assert seen["kwargs"] == {**base, "use_soundfile": True, "use_autocast": autocast,
                                  "mdxc_params": {"segment_size": 256, "override_model_segment_size": True,
                                                  "batch_size": 1, "overlap": 8, "pitch_shift": 0}}
    else:
        assert seen["kwargs"] == base  # audio-separator defaults, as before the bounded profile
    assert (seen["model"], seen["audio"]) == (ROFORMER, "vocals.wav")
    assert worker_boundary.calls == [("karaoke-roformer", requested, ["vocals.wav"])]
