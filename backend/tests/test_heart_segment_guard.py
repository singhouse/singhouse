# SPDX-License-Identifier: AGPL-3.0-only
"""One bad VAD segment must not fail a whole Heart transcription.

A hallucinated tail segment can decode into a truncated multibyte character
that makes the HF Whisper tokenizer raise mid word-timestamp split. The local subprocess and Modal container
Heart runners isolate
each segment's decode: the bad segment is skipped and recorded, every other
segment's words come through unchanged. Device/allocator failures
(``RuntimeError``/``MemoryError``) and accelerator OOM still propagate, and a
song where every attempted segment raised, or more than a quarter of them
(at least one always tolerated), still fails.

No GPU, model, torch, or Modal SDK: ``pipe`` is a fake callable.
"""

from __future__ import annotations

import ast
from pathlib import Path

import numpy as np
import pytest

from karaoke_backend.workers import heart_transcriptor

SR = 16000
AUDIO = np.zeros(SR * 40, dtype=np.float32)
GEN_KWARGS = {"language": "en", "task": "transcribe", "temperature": 0.0}

# (start, end) seconds. Index 2 is shorter than 0.1 s and is never attempted.
VAD_SEGS = [[1.0, 4.5], [6.0, 12.25], [13.0, 13.05], [20.0, 23.6], [30.0, 35.0]]

# Canned per-segment pipeline output, keyed by the segment's start time.
CANNED = {
    1.0: {"text": " hello there ", "chunks": [
        {"text": " hello", "timestamp": (0.1, 0.5)},
        {"text": " there", "timestamp": (0.6, None)},
    ]},
    6.0: {"text": " second line", "chunks": [
        {"text": " second", "timestamp": (None, 0.4)},
        {"text": "  ", "timestamp": (0.4, 0.5)},
        {"text": " line", "timestamp": (0.5, 1.2)},
    ]},
    20.0: {"text": " tail", "chunks": [{"text": " tail", "timestamp": (0.2, 0.9)}]},
    30.0: {"text": " last", "chunks": [{"text": " last", "timestamp": (1.0, 2.0)}]},
}


class OutOfMemoryError(RuntimeError):
    """Stands in for torch.cuda.OutOfMemoryError (matched by class name)."""


class FakePipe:
    """Returns canned output per segment; raises for the chosen segment starts."""

    def __init__(self, fail: dict[float, BaseException] | None = None, segs=None):
        self.fail = fail or {}
        self.segs = VAD_SEGS if segs is None else segs
        self.calls: list[dict] = []

    def __call__(self, inputs, *, return_timestamps, generate_kwargs):
        assert return_timestamps == "word"
        assert inputs["sampling_rate"] == SR
        # Recover the segment from its slice length (unique per segment here).
        dur = len(inputs["array"]) / SR
        seg = next(s for s in self.segs
                   if len(AUDIO[int(s[0] * SR):int(s[1] * SR)]) / SR == dur)
        self.calls.append({"start": seg[0], "end": seg[1],
                           "generate_kwargs": dict(generate_kwargs),
                           "dtype": inputs["array"].dtype})
        if seg[0] in self.fail:
            raise self.fail[seg[0]]
        return CANNED.get(seg[0], {"text": " w", "chunks": [{"text": " w", "timestamp": (0.0, 0.5)}]})


def _reference_old_loop(pipe, audio, sr, vad_segs, generate_kwargs, log, *, cap=True):
    """Verbatim loop body from before the per-segment guard: the byte-identity
    oracle for clean segments."""
    full_text_parts, words = [], []
    for seg_i, (seg_start, seg_end) in enumerate(vad_segs):
        s_idx = int(float(seg_start) * sr)
        e_idx = int(float(seg_end) * sr)
        slice_audio = audio[s_idx:e_idx].astype(np.float32)
        if len(slice_audio) < sr * 0.1:
            continue
        seg_kwargs = dict(generate_kwargs)
        if cap:
            seg_kwargs["max_new_tokens"] = max(
                8, min(440, int((float(seg_end) - float(seg_start)) * 12) + 8)
            )
        seg_result = pipe(
            {"array": slice_audio, "sampling_rate": sr},
            return_timestamps="word",
            generate_kwargs=seg_kwargs,
        )
        full_text_parts.append(seg_result.get("text", "").strip())
        for c in seg_result.get("chunks", []):
            text = c.get("text", "").strip()
            if not text:
                continue
            ts = c.get("timestamp", (None, None))
            start = ts[0] if ts[0] is not None else 0.0
            end = ts[1] if ts[1] is not None else start + 0.1
            words.append({
                "word": text,
                "start": float(start) + float(seg_start),
                "end": float(end) + float(seg_start),
            })
        log(
            f"  seg {seg_i+1}/{len(vad_segs)} "
            f"[{float(seg_start):.1f}s-{float(seg_end):.1f}s]: "
            f"{len(seg_result.get('chunks', []))} words\n"
        )
    return words, full_text_parts


def _modal_helper():
    """Load modal_app's top-level functions without the Modal SDK (as
    test_modal_correctness does) and hand back the segment helper."""
    source = Path(__file__).parents[1] / "modal_app.py"
    tree = ast.parse(source.read_text())
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    for node in functions:
        node.decorator_list = []
    namespace: dict = {}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
    fn = namespace["_transcribe_vad_segments"]

    def call(pipe, audio, sr, vad_segs, generate_kwargs, log=None):
        # Modal logs only skips (no per-segment progress line), to stderr.
        return fn(pipe, audio, sr, vad_segs, generate_kwargs)

    return call


RUNNERS = {
    "local": (heart_transcriptor.transcribe_vad_segments, True),
    "modal": (_modal_helper(), True),
}


@pytest.fixture(params=sorted(RUNNERS))
def runner(request):
    fn, cap = RUNNERS[request.param]
    return request.param, fn, cap


def test_clean_run_is_identical_to_the_old_loop(runner):
    name, fn, cap = runner
    new_log, old_log = [], []
    new_pipe, old_pipe = FakePipe(), FakePipe()
    words, parts, skipped = fn(new_pipe, AUDIO, SR, VAD_SEGS, GEN_KWARGS, log=new_log.append)
    ref_words, ref_parts = _reference_old_loop(
        old_pipe, AUDIO, SR, VAD_SEGS, GEN_KWARGS, old_log.append, cap=cap)

    assert skipped == []
    assert words == ref_words
    assert parts == ref_parts
    assert new_pipe.calls == old_pipe.calls
    if name != "modal":
        assert new_log == old_log
    # Global offsets actually applied (spot check).
    assert words[0] == {"word": "hello", "start": 1.0 + 0.1, "end": 1.0 + 0.5}
    # A None end falls back to start + 0.1, then shifts by the segment start.
    assert words[1] == {"word": "there", "start": 1.0 + 0.6, "end": 1.0 + (0.6 + 0.1)}
    # A None start falls back to 0.0 before the shift.
    assert words[2] == {"word": "second", "start": 6.0, "end": 6.0 + 0.4}


def test_bad_segment_is_skipped_and_the_rest_survive(runner, capsys):
    name, fn, cap = runner
    err = IndexError("string index out of range")
    log: list[str] = []
    words, parts, skipped = fn(FakePipe({20.0: err}), AUDIO, SR, VAD_SEGS, GEN_KWARGS,
                               log=log.append)

    # Good segments: exactly what a failure-free run of only those segments yields.
    good = [s for s in VAD_SEGS if s[0] != 20.0]
    ref_words, ref_parts = _reference_old_loop(
        FakePipe(), AUDIO, SR, good, GEN_KWARGS, lambda _: None, cap=cap)
    assert words == ref_words
    assert parts == ref_parts
    assert not any(w["word"] == "tail" for w in words)

    assert skipped == [{"index": 3, "start": 20.0, "end": 23.6,
                        "error": "IndexError: string index out of range"}]
    skip_line = "  seg 4/5 [20.0s-23.6s]: SKIPPED (IndexError: string index out of range)\n"
    if name == "modal":
        assert skip_line in capsys.readouterr().err
    else:
        assert skip_line in log


def test_a_value_error_is_skippable_too(runner):
    _, fn, _ = runner
    words, _, skipped = fn(FakePipe({6.0: ValueError("bad chunk")}), AUDIO, SR, VAD_SEGS,
                           GEN_KWARGS, log=lambda _: None)
    assert [sk["index"] for sk in skipped] == [1]
    assert skipped[0]["error"] == "ValueError: bad chunk"
    assert [w["word"] for w in words] == ["hello", "there", "tail", "last"]


def _even_segs(n):
    # Distinct durations so FakePipe can tell the slices apart.
    # Starts avoid the CANNED keys so every good segment yields exactly one word.
    return [[2.0 * k + 0.25, 2.0 * k + 0.75 + 0.05 * k] for k in range(n)]


@pytest.mark.parametrize("n_attempted, n_failed, raises", [
    (3, 1, False), (3, 2, True), (14, 3, False), (14, 4, True), (4, 1, False), (1, 1, True),
])
def test_skip_threshold(runner, n_attempted, n_failed, raises):
    _, fn, _ = runner
    segs = _even_segs(n_attempted)
    fail = {segs[k][0]: IndexError(f"boom {k}") for k in range(n_failed)}
    pipe = FakePipe(fail, segs=segs)
    if raises:
        pattern = ("All 1 attempted" if n_failed == n_attempted
                   else f"Too many VAD segments failed to decode: {n_failed} of {n_attempted}")
        with pytest.raises(RuntimeError, match=pattern + r".*IndexError: boom 0") as caught:
            fn(pipe, AUDIO, SR, segs, GEN_KWARGS, log=lambda _: None)
        assert isinstance(caught.value.__cause__, IndexError)
        assert str(caught.value.__cause__) == "boom 0"
    else:
        words, _, skipped = fn(pipe, AUDIO, SR, segs, GEN_KWARGS, log=lambda _: None)
        assert len(skipped) == n_failed
        assert len(words) == n_attempted - n_failed


def test_error_message_is_truncated(runner):
    _, fn, _ = runner
    err = ValueError("x" * 1000)
    _, _, skipped = fn(FakePipe({1.0: err}), AUDIO, SR, VAD_SEGS, GEN_KWARGS,
                       log=lambda _: None)
    assert skipped[0]["error"] == "ValueError: " + "x" * 200 + "..."


def test_every_attempted_segment_failing_fails_the_song(runner):
    _, fn, _ = runner
    fail = {s[0]: IndexError(f"boom {s[0]}") for s in VAD_SEGS}
    with pytest.raises(RuntimeError, match=r"All 4 attempted.*IndexError: boom 1\.0") as caught:
        fn(FakePipe(fail), AUDIO, SR, VAD_SEGS, GEN_KWARGS, log=lambda _: None)
    assert isinstance(caught.value.__cause__, IndexError)


def test_no_attempted_segments_keeps_todays_empty_result(runner):
    _, fn, _ = runner
    pipe = FakePipe()
    assert fn(pipe, AUDIO, SR, [[13.0, 13.05]], GEN_KWARGS, log=lambda _: None) == ([], [], [])
    assert fn(pipe, AUDIO, SR, [], GEN_KWARGS, log=lambda _: None) == ([], [], [])
    assert pipe.calls == []


class AcceleratorError(RuntimeError):
    """Stands in for torch.AcceleratorError (sticky device fault)."""


class _OomNotRuntime(Exception):
    pass


_OomNotRuntime.__name__ = "OutOfMemoryError"


@pytest.mark.parametrize("exc", [
    OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB"),
    _OomNotRuntime("allocator gave up"),
    RuntimeError("MPS backend out of memory (MPS allocated: 9 GB)"),
    RuntimeError("CUDA error: device-side assert triggered"),
    AcceleratorError("CUDA error: an illegal memory access was encountered"),
    MemoryError(),
], ids=["cuda-oom", "oom-by-name", "mps-oom", "device-assert", "accelerator-error",
        "memory-error"])
def test_device_and_memory_failures_propagate(runner, exc):
    _, fn, _ = runner
    with pytest.raises(type(exc)) as caught:
        fn(FakePipe({20.0: exc}), AUDIO, SR, VAD_SEGS, GEN_KWARGS, log=lambda _: None)
    assert caught.value is exc


@pytest.mark.parametrize("exc", [KeyboardInterrupt(), SystemExit(1)])
def test_non_exception_base_exceptions_propagate(runner, exc):
    _, fn, _ = runner
    with pytest.raises(type(exc)):
        fn(FakePipe({6.0: exc}), AUDIO, SR, VAD_SEGS, GEN_KWARGS, log=lambda _: None)


def test_max_new_tokens_follows_the_existing_formula(runner):
    _, fn, cap = runner
    pipe = FakePipe({20.0: IndexError("x")})
    fn(pipe, AUDIO, SR, VAD_SEGS, GEN_KWARGS, log=lambda _: None)
    assert [c["start"] for c in pipe.calls] == [1.0, 6.0, 20.0, 30.0]
    for call in pipe.calls:
        kwargs = call["generate_kwargs"]
        if cap:
            expected = max(8, min(440, int((call["end"] - call["start"]) * 12) + 8))
            assert kwargs["max_new_tokens"] == expected
        assert {k: v for k, v in kwargs.items() if k != "max_new_tokens"} == GEN_KWARGS
        assert call["dtype"] == np.float32
    if cap:
        assert [c["generate_kwargs"]["max_new_tokens"] for c in pipe.calls] == [50, 83, 51, 68]
    # The caller's dict is never mutated.
    assert "max_new_tokens" not in GEN_KWARGS


def test_runner_modules_do_not_import_torch_at_module_level():
    # ``--help`` must exit before torch loads (test_transcription_determinism
    # relies on it); the extracted helper must not have pulled torch up top.
    for module in (heart_transcriptor,):
        top = Path(module.__file__).read_text().split("\ndef main():")[0]
        assert "import torch" not in top.split("\ndef _pick_device")[0]
        assert "torch" not in vars(module)


# ---------------------------------------------------------------------------
# Dispatcher side: Modal transcribers surface the skips
# ---------------------------------------------------------------------------

_SKIP_PAYLOAD = {
    "segments": [{"start": 1.0, "end": 1.5, "text": "hello",
                  "words": [{"word": "hello", "start": 1.0, "end": 1.5}]}],
    "language": "en", "transcriber": "heart", "full_text": "hello",
    "skipped_segments": [{"index": 3, "start": 20.0, "end": 23.6,
                          "error": "IndexError: string index out of range"}],
}
_CLEAN_PAYLOAD = {k: v for k, v in _SKIP_PAYLOAD.items() if k != "skipped_segments"}


def _modal_transcribe(monkeypatch, tmp_path, payload):
    from types import SimpleNamespace

    from karaoke_backend.workers import modal_offload

    audio = tmp_path / "lead_vocals.wav"
    audio.write_bytes(b"audio")
    monkeypatch.setattr(modal_offload, "_lookup",
                        lambda _: SimpleNamespace(remote=lambda *a, **k: payload))
    return modal_offload.ModalHeartTranscriber(use_vad=False).transcribe(str(audio))


@pytest.mark.parametrize("name, call, logger_name", [
    ("ModalHeartTranscriber", _modal_transcribe, "karaoke_backend.workers.modal_offload"),
])
def test_dispatcher_warns_on_skipped_segments(monkeypatch, tmp_path, caplog, name, call,
                                              logger_name):
    import logging

    with caplog.at_level(logging.WARNING, logger=logger_name):
        result = call(monkeypatch, tmp_path, _SKIP_PAYLOAD)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    msg = warnings[0].getMessage()
    assert msg.startswith(f"{name}: skipped 1 VAD segment")
    assert "seg 4 [20.0s-23.6s] IndexError: string index out of range" in msg
    assert [w.text for s in result.segments for w in s.words] == ["hello"]
    assert result.full_text == "hello"

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=logger_name):
        clean = call(monkeypatch, tmp_path, _CLEAN_PAYLOAD)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert clean == result


@pytest.mark.parametrize("name, call, logger_name", [
    ("ModalHeartTranscriber", _modal_transcribe, "karaoke_backend.workers.modal_offload"),
])
@pytest.mark.parametrize("bad", [[{"start": 1.0}], [None], ["x"], 7])
def test_dispatcher_warning_never_fails_the_transcription(monkeypatch, tmp_path, caplog,
                                                          name, call, logger_name, bad):
    import logging

    payload = dict(_CLEAN_PAYLOAD, skipped_segments=bad)
    with caplog.at_level(logging.WARNING, logger=logger_name):
        result = call(monkeypatch, tmp_path, payload)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert warnings[0].getMessage().startswith(f"{name}: skipped")
    assert [w.text for s in result.segments for w in s.words] == ["hello"]
