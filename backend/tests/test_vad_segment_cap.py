# SPDX-License-Identifier: AGPL-3.0-only
"""The maximum VAD segment length: device-aware "auto" and fixed caps."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from karaoke_backend.workers import heart_transcriptor as ht

GIB = 1024 ** 3


# ---------------------------------------------------------------------------
# Tier resolution (pure)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "free_bytes, want",
    [
        # ~8 GB card: ~7.5 GiB total, ~1.5 GiB desktop, ~3.5 GiB model.
        (int(2.5 * GIB), 15.0),
        (int(0.5 * GIB), 15.0),
        (0, 15.0),
        # ~12-16 GB cards land in the middle tier.
        (6 * GIB, 20.0),
        (int(10.5 * GIB), 20.0),
        # ~24 GB card with a few GiB in use.
        (12 * GIB, 30.0),
        (17 * GIB, 30.0),
        (40 * GIB, 30.0),
    ],
)
def test_cuda_cap_follows_free_memory(free_bytes, want):
    assert ht.resolve_max_segment_seconds("cuda", free_bytes) == want


def test_cpu_keeps_15s_because_host_ram_is_not_probed():
    assert ht.resolve_max_segment_seconds("cpu", None) == 15.0
    assert ht.resolve_max_segment_seconds("cpu", 64 * GIB) == 15.0


@pytest.mark.parametrize("device_type", ["mps", "xpu", "something-new"])
def test_other_accelerators_keep_the_safe_cap(device_type):
    assert ht.resolve_max_segment_seconds(device_type, 40 * GIB) == 15.0
    assert ht.resolve_max_segment_seconds(device_type, None) == 15.0


def test_unreadable_cuda_memory_keeps_the_safe_cap():
    assert ht.resolve_max_segment_seconds("cuda", None) == 15.0


def test_every_resolved_cap_is_within_the_whisper_window():
    for device_type in ("cuda", "cpu", "mps"):
        for free in (None, 0, 3 * GIB, 8 * GIB, 64 * GIB):
            assert 0 < ht.resolve_max_segment_seconds(device_type, free) <= 30.0


def test_free_memory_probe_failure_returns_none():
    class _Cuda:
        @staticmethod
        def mem_get_info(device):
            raise RuntimeError("no driver")

    class _Torch:
        cuda = _Cuda()

        @staticmethod
        def device(name):
            return name

    assert ht._free_device_bytes(_Torch(), "cuda") is None


def test_free_memory_probe_reads_the_free_half():
    class _Cuda:
        @staticmethod
        def mem_get_info(device):
            return (5 * GIB, 8 * GIB)

    class _Torch:
        cuda = _Cuda()

        @staticmethod
        def device(name):
            return name

    assert ht._free_device_bytes(_Torch(), "cuda") == 5 * GIB


# ---------------------------------------------------------------------------
# Equal re-split (pure)
# ---------------------------------------------------------------------------


def test_segments_within_the_cap_are_unchanged():
    segs = [[0.0, 10.0], [12.0, 27.0], [30.0, 45.0]]
    assert ht.split_segments_to_cap(segs, 15.0) == [(0.0, 10.0), (12.0, 27.0), (30.0, 45.0)]


@pytest.mark.parametrize(
    "length, cap, parts",
    [(30.0, 15.0, 2), (31.0, 15.0, 3), (29.0, 20.0, 2), (30.0, 30.0, 1), (45.0, 15.0, 3),
     (15.000000000001, 15.0, 1), (60.0, 20.0, 3)],
)
def test_long_segments_split_into_equal_parts(length, cap, parts):
    start = 100.0
    out = ht.split_segments_to_cap([(start, start + length)], cap)
    assert len(out) == parts
    lengths = [e - s for s, e in out]
    assert all(seg_len <= cap + 1e-6 for seg_len in lengths)
    assert max(lengths) - min(lengths) < 1e-6, "parts must be equal, no sliver"
    # Coverage preserved: contiguous, same endpoints.
    assert out[0][0] == start
    assert out[-1][1] == start + length
    for (_, prev_end), (next_start, _) in zip(out, out[1:], strict=False):
        assert next_start == pytest.approx(prev_end)


def test_resplit_mixes_split_and_untouched_segments():
    out = ht.split_segments_to_cap([(0.0, 5.0), (10.0, 40.0), (50.0, 52.0)], 15.0)
    assert out == [(0.0, 5.0), (10.0, 25.0), (25.0, 40.0), (50.0, 52.0)]


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


def test_cli_value_parsing():
    assert ht.parse_max_segment_seconds("auto") == ht.AUTO_MAX_SEGMENT
    assert ht.parse_max_segment_seconds("AUTO") == ht.AUTO_MAX_SEGMENT
    assert ht.parse_max_segment_seconds("15.0") == 15.0
    assert ht.parse_max_segment_seconds("22") == 22.0
    for bad in ("0", "-3", "nan", "inf", "soon"):
        with pytest.raises(argparse.ArgumentTypeError):
            ht.parse_max_segment_seconds(bad)


def test_backend_runner_declares_the_flag():
    proc = subprocess.run(
        [sys.executable, ht.__file__, "--help"],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-500:]
    assert "--max-segment-seconds" in proc.stdout


def test_the_backend_runner_is_the_script_heart_jobs_use():
    from karaoke_backend.workers import word_sync_worker

    assert Path(word_sync_worker.HEART_SCRIPT).resolve() == Path(ht.__file__).resolve()


# ---------------------------------------------------------------------------
# Modal takes the 30 s ceiling as is
# ---------------------------------------------------------------------------


def _modal_vad_run(tmp_path: Path, vad_config, samples, sr):
    from karaoke_backend.workers import modal_offload

    sent: dict = {}

    class _Fn:
        def remote(self, *args):
            sent["args"] = args
            return {"segments": [], "language": "en", "full_text": ""}

    audio = tmp_path / "lead_vocals.wav"
    audio.write_bytes(b"audio")
    transcriber = modal_offload.ModalHeartTranscriber(use_vad=True, vad_config=vad_config)
    with patch("lyricsync.audio.io.read_wav_mono", return_value=(samples, sr)), \
            patch.object(modal_offload, "_lookup", return_value=_Fn()):
        transcriber.transcribe(str(audio))
    return next(a for a in sent["args"] if isinstance(a, list))


def test_modal_auto_splits_at_the_30s_ceiling(tmp_path: Path):
    import numpy as np

    sr = 16000
    t = np.arange(int(70 * sr)) / sr
    loud = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    segs = _modal_vad_run(tmp_path, None, loud, sr)
    lengths = [round(e - s, 3) for s, e in segs]
    assert max(lengths) <= 30.0 + 1e-6
    assert any(abs(n - 30.0) < 0.1 for n in lengths)


def test_modal_auto_keeps_15s_window_for_silent_stems(tmp_path: Path):
    import numpy as np

    sr = 16000
    segs = _modal_vad_run(tmp_path, None, np.zeros(int(60 * sr), dtype=np.float32), sr)
    assert [tuple(map(float, s)) for s in segs] == [(0.0, 15.0)]


def test_modal_explicit_cap_is_passed_through(tmp_path: Path):
    import numpy as np
    from lyricsync._config import VadConfig

    sr = 16000
    t = np.arange(int(70 * sr)) / sr
    loud = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    segs = _modal_vad_run(tmp_path, VadConfig(max_segment_duration=12.0), loud, sr)
    assert max(e - s for s, e in segs) <= 12.0 + 1e-6


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


def test_api_vad_default_is_auto():
    from karaoke_backend.api.lyrics_sets import (
        PipelineConfigIn,
        VadConfigIn,
        _to_pipeline_config,
    )

    assert VadConfigIn().max_segment_duration is None
    assert _to_pipeline_config(PipelineConfigIn()).vad.max_segment_duration is None


def test_api_explicit_cap_passes_through():
    from karaoke_backend.api.lyrics_sets import PipelineConfigIn, _to_pipeline_config

    body = PipelineConfigIn.model_validate({"vad": {"max_segment_duration": 18.0}})
    assert _to_pipeline_config(body).vad.max_segment_duration == 18.0


def test_api_rejects_a_non_positive_cap():
    from karaoke_backend.api.lyrics_sets import VadConfigIn
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        VadConfigIn(max_segment_duration=0)


# ---------------------------------------------------------------------------
# The runner end to end, with torch/transformers/librosa faked
# ---------------------------------------------------------------------------


def _run_runner(tmp_path: Path, monkeypatch, capsys, *, extra_args, free_bytes=None,
                cuda=True, segments=((0.0, 30.0), (40.0, 45.0))):
    import json
    import types

    import numpy as np

    calls: list[dict] = []

    class _Cuda:
        @staticmethod
        def is_available():
            return cuda

        @staticmethod
        def mem_get_info(device):
            if free_bytes is None:
                raise RuntimeError("unreadable")
            return (free_bytes, 24 * GIB)

    class _Device:
        def __init__(self, name):
            self.type = str(name).split(":")[0]

    fake_torch = types.SimpleNamespace(
        cuda=_Cuda(), device=_Device, float16="fp16", float32="fp32",
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False)),
    )

    def fake_pipeline(*args, **kwargs):
        def run(inputs, return_timestamps=None, generate_kwargs=None):
            n = len(inputs["array"]) / inputs["sampling_rate"]
            calls.append({
                "seconds": n,
                "samples": len(inputs["array"]),
                "max_new_tokens": generate_kwargs["max_new_tokens"],
            })
            # One word at a local 1.0-1.5 s inside every slice.
            return {"text": "la", "chunks": [{"text": "la", "timestamp": (1.0, 1.5)}]}
        return run

    fake_transformers = types.SimpleNamespace(
        WhisperForConditionalGeneration=types.SimpleNamespace(
            from_pretrained=lambda *a, **k: object()
        ),
        WhisperProcessor=types.SimpleNamespace(
            from_pretrained=lambda *a, **k: types.SimpleNamespace(
                tokenizer=None, feature_extractor=None
            )
        ),
        pipeline=fake_pipeline,
    )
    fake_librosa = types.SimpleNamespace(
        load=lambda path, sr, mono: (np.zeros(int(sr * 60), dtype=np.float32), sr)
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)
    monkeypatch.setitem(sys.modules, "librosa", fake_librosa)

    ckpt = tmp_path / "ckpt"
    ckpt.mkdir()
    vad = tmp_path / "segs.json"
    vad.write_text(json.dumps([list(s) for s in segments]))
    monkeypatch.setattr(sys, "argv", [
        "heart_transcriptor.py", str(tmp_path / "a.wav"), "--model-path", str(ckpt),
        "--vad-segments", str(vad), *extra_args,
    ])
    ht.main()
    captured = capsys.readouterr()
    out = json.loads(captured.out)
    starts = [w["start"] for seg in out["segments"] for w in seg["words"]]
    _run_runner.last_stderr = captured.err
    return calls, starts


def test_runner_without_the_flag_decodes_segments_as_given(tmp_path, monkeypatch, capsys):
    calls, starts = _run_runner(tmp_path, monkeypatch, capsys, extra_args=[], free_bytes=2 * GIB)
    assert [round(c["seconds"], 3) for c in calls] == [30.0, 5.0]
    assert starts == [1.0, 41.0]


def test_runner_auto_on_a_small_card_resplits_to_15s(tmp_path, monkeypatch, capsys):
    calls, starts = _run_runner(
        tmp_path, monkeypatch, capsys, extra_args=["--max-segment-seconds", "auto"],
        free_bytes=int(2.5 * GIB),
    )
    assert [round(c["seconds"], 3) for c in calls] == [15.0, 15.0, 5.0]
    # Word times are offset by each re-split part's own start.
    assert starts == [1.0, 16.0, 41.0]
    # The per-segment token bound follows the re-split length.
    assert [c["max_new_tokens"] for c in calls] == [188, 188, 68]
    assert "auto -> 15.0s" in _run_runner.last_stderr
    assert "2.50 GiB free" in _run_runner.last_stderr


def test_runner_auto_on_a_large_card_keeps_30s(tmp_path, monkeypatch, capsys):
    calls, starts = _run_runner(
        tmp_path, monkeypatch, capsys, extra_args=["--max-segment-seconds", "auto"],
        free_bytes=18 * GIB,
    )
    assert [round(c["seconds"], 3) for c in calls] == [30.0, 5.0]
    assert starts == [1.0, 41.0]


def test_runner_auto_with_unreadable_memory_uses_15s(tmp_path, monkeypatch, capsys):
    calls, _ = _run_runner(
        tmp_path, monkeypatch, capsys, extra_args=["--max-segment-seconds", "auto"],
        free_bytes=None,
    )
    assert [round(c["seconds"], 3) for c in calls] == [15.0, 15.0, 5.0]
    assert "free memory not read" in _run_runner.last_stderr


def test_runner_auto_on_cpu_resplits_to_15s(tmp_path, monkeypatch, capsys):
    calls, _ = _run_runner(
        tmp_path, monkeypatch, capsys, extra_args=["--max-segment-seconds", "auto"],
        cuda=False,
    )
    assert [round(c["seconds"], 3) for c in calls] == [15.0, 15.0, 5.0]


def test_runner_never_cuts_a_slice_longer_than_the_window(tmp_path, monkeypatch, capsys):
    # 30.0001 s at 16 kHz would be 480001+ samples; the HF pipeline would then
    # emit a second strided chunk. Without the flag the segment is decoded as
    # given, so only the clamp keeps it to one window.
    calls, starts = _run_runner(
        tmp_path, monkeypatch, capsys, extra_args=[], segments=((0.0, 30.0001),),
    )
    assert len(calls) == 1
    assert calls[0]["samples"] == ht.WINDOW_SECONDS * 16000
    assert starts == [1.0]


def test_runner_fixed_cap_resplits_equally(tmp_path, monkeypatch, capsys):
    calls, starts = _run_runner(
        tmp_path, monkeypatch, capsys, extra_args=["--max-segment-seconds", "12"],
        free_bytes=18 * GIB,
    )
    assert [round(c["seconds"], 3) for c in calls] == [10.0, 10.0, 10.0, 5.0]
    assert starts == [1.0, 11.0, 21.0, 41.0]
