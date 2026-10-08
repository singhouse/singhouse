# SPDX-License-Identifier: AGPL-3.0-only
"""Acoustic word timing as the default engine in the word-sync worker.

Every test uses a fake transcriber and a fake acoustic aligner (no torch, no
GPU); one cancellation test drives the real ``CtcFusionAligner`` against a
stand-in worker script that just sleeps. Invented lyrics only.
"""

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import pytest
from karaoke_backend.workers import transcription_cache
from karaoke_backend.workers import word_sync_worker as wsw
from karaoke_backend.workers.managed_processing import InvalidAttestation
from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

from lyricsync import AcousticAlignmentError, AcousticSpans, CtcFusionAligner, PipelineConfig

WORDS = [
    ("Paper", 0.5, 0.9), ("lanterns", 1.0, 1.6), ("drift", 1.7, 2.1),
    ("over", 4.0, 4.4), ("quiet", 4.5, 4.9), ("water", 5.0, 5.6),
]
PLAIN = "Paper lanterns drift\nover quiet water"
SYNCED = "[00:00.50]Paper lanterns drift\n[00:04.00]over quiet water"
MODELS = ("hubl", "w2v2l", "hubxl", "phon")


def _transcription() -> TranscriptionResult:
    tw = [TimedWord(text=t, start=s, end=e) for t, s, e in WORDS]
    return TranscriptionResult(
        segments=[
            TranscriptionSegment(start=0.5, end=2.1, text="Paper lanterns drift", words=tw[:3]),
            TranscriptionSegment(start=4.0, end=5.6, text="over quiet water", words=tw[3:]),
        ],
        language="en",
    )


class FakeTranscriber:
    def __init__(self):
        self.calls = 0

    def transcribe(self, audio_path, language=None):
        self.calls += 1
        return _transcription()


class FakeAligner:
    """Every model times word i at (20 + 2i, 20.8 + 2i)."""

    def __init__(self):
        self.calls = []

    def align_words(self, audio_paths, words):
        self.calls.append((list(audio_paths), list(words)))
        spans = [(20.0 + 2 * i, 20.8 + 2 * i) for i in range(len(words))]
        return AcousticSpans(spans={m: list(spans) for m in MODELS}, device="cuda",
                             info={"engine": "fake"})


class FailingAligner:
    def __init__(self):
        self.calls = 0

    def align_words(self, audio_paths, words):
        self.calls += 1
        raise AcousticAlignmentError("CTC worker error: CUDA is not available")


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Acoustic stage on (conftest turns it off suite-wide), legacy runtime,
    a fake transcriber, and a recorder for the aligner the worker builds."""
    monkeypatch.setenv(wsw.ACOUSTIC_ENV, "1")
    monkeypatch.delenv(wsw.ACOUSTIC_CPU_ENV, raising=False)
    monkeypatch.delenv(wsw.ACOUSTIC_TIMEOUT_ENV, raising=False)
    monkeypatch.delenv("KARAOKE_DESKTOP_PROCESSING_JSON", raising=False)
    transcriber = FakeTranscriber()
    monkeypatch.setattr(wsw, "_make_transcriber", lambda *a, **k: transcriber)

    state = {"aligner": FakeAligner(), "built": [], "transcriber": transcriber}

    def make_aligner(*, cancel_event, progress_fn=None):
        state["built"].append({"cancel_event": cancel_event, "progress_fn": progress_fn})
        return wsw._ReportingAligner(state["aligner"], progress_fn)

    monkeypatch.setattr(wsw, "_make_acoustic_aligner", make_aligner)

    stems = tmp_path / "stems"
    stems.mkdir()
    lead = stems / "lead_vocals.wav"
    lead.write_bytes(b"not really audio")  # onset trim skips unreadable audio
    state["lead"] = lead
    state["stems"] = stems
    return state


def _run(lead, **kwargs):
    params = dict(
        vocals_path=str(lead), artist="Nobody", title="Lanterns",
        plain_lyrics=PLAIN, synced_lyrics=None, whisper_model="heart",
        language=None, use_vad=True, song_id=None, pipeline_config=PipelineConfig(),
    )
    params.update(kwargs)
    return wsw._run_blocking(**params)


def _times(word_data):
    return [(w["start"], w["end"]) for line in word_data["lines"] for w in line]


def _baseline(monkeypatch, lead, **kwargs):
    with monkeypatch.context() as m:
        m.setenv(wsw.ACOUSTIC_ENV, "0")
        return _run(lead, **kwargs)


# ── enablement ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", ["0", "false", "off", "OFF", "no"])
def test_env_switch_disables_the_stage(env, monkeypatch, value):
    monkeypatch.setenv(wsw.ACOUSTIC_ENV, value)
    data = _run(env["lead"])
    meta = data["metadata"]["acoustic_alignment"]
    assert meta["enabled"] is False and meta["applied"] is False
    assert wsw.ACOUSTIC_ENV in meta["reason"]
    assert env["built"] == [] and env["aligner"].calls == []
    assert data["metadata"]["pipeline_config"]["acoustic_alignment"] is False


@pytest.mark.parametrize("value", [None, "", "1", "true", "on", "garbage"])
def test_env_switch_defaults_on(env, monkeypatch, value):
    if value is None:
        monkeypatch.delenv(wsw.ACOUSTIC_ENV, raising=False)
    else:
        monkeypatch.setenv(wsw.ACOUSTIC_ENV, value)
    assert wsw.acoustic_disabled_reason("plain") is None


def test_managed_runtime_disables_the_stage(env, monkeypatch):
    monkeypatch.setattr(wsw, "validated_attestation", lambda: {"accelerator": "cuda"})
    data = _run(env["lead"])
    meta = data["metadata"]["acoustic_alignment"]
    assert meta["applied"] is False and "managed" in meta["reason"]
    assert env["built"] == []


def test_invalid_managed_attestation_disables_the_stage(env, monkeypatch):
    def bad():
        raise InvalidAttestation("Invalid desktop processing attestation")

    monkeypatch.setattr(wsw, "validated_attestation", bad)
    assert "managed" in wsw.acoustic_disabled_reason("plain")


@pytest.mark.parametrize("mode", ["plain", "synced"])
def test_plain_and_synced_references_run_the_stage(env, mode):
    kwargs = {"plain_lyrics": PLAIN} if mode == "plain" else {
        "plain_lyrics": None, "synced_lyrics": SYNCED}
    data = _run(env["lead"], **kwargs)
    meta = data["metadata"]["acoustic_alignment"]
    assert data["metadata"]["ref_mode"] == mode
    assert meta["enabled"] is True and meta["applied"] is True, meta
    assert len(env["aligner"].calls) == 1
    assert env["aligner"].calls[0][1] == [w[0] for w in WORDS]
    starts = [s for s, _ in _times(data)]
    assert starts == pytest.approx([19.98 + 2 * i for i in range(len(WORDS))])
    assert data["metadata"]["pipeline_config"]["acoustic_alignment"] is True


def test_no_reference_is_off_in_this_release(env):
    data = _run(env["lead"], plain_lyrics=None)
    meta = data["metadata"]["acoustic_alignment"]
    assert data["metadata"]["ref_mode"] == "none"
    assert meta["enabled"] is False and "none" in meta["reason"]
    assert env["built"] == []


def test_real_aligner_is_gpu_only_by_default(monkeypatch):
    monkeypatch.delenv(wsw.ACOUSTIC_CPU_ENV, raising=False)
    monkeypatch.delenv(wsw.ACOUSTIC_TIMEOUT_ENV, raising=False)
    cancel = threading.Event()
    wrapped = wsw._make_acoustic_aligner(cancel_event=cancel)
    inner = wrapped._inner
    assert isinstance(inner, CtcFusionAligner)
    assert inner.allow_cpu is False
    assert inner.python_path == wsw.DEMUCS_PYTHON
    assert inner.cancel_event is cancel
    assert inner.timeout == wsw.ACOUSTIC_DEFAULT_TIMEOUT


def test_cpu_and_timeout_overrides(monkeypatch):
    monkeypatch.setenv(wsw.ACOUSTIC_CPU_ENV, "1")
    monkeypatch.setenv(wsw.ACOUSTIC_TIMEOUT_ENV, "7200")
    inner = wsw._make_acoustic_aligner(cancel_event=None)._inner
    assert inner.allow_cpu is True and inner.timeout == 7200
    monkeypatch.setenv(wsw.ACOUSTIC_TIMEOUT_ENV, "soon")
    assert wsw._make_acoustic_aligner(cancel_event=None)._inner.timeout == (
        wsw.ACOUSTIC_DEFAULT_TIMEOUT)


def test_cpu_refusal_falls_back(env):
    """Without CUDA the worker refuses; the previous timings stand."""
    env["aligner"] = FailingAligner()
    data = _run(env["lead"])
    meta = data["metadata"]["acoustic_alignment"]
    assert meta["applied"] is False and "CUDA" in meta["reason"]


# ── audio ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("ext", [".wav", ".flac", ".mp3"])
def test_backing_stem_discovered(tmp_path, ext):
    lead = tmp_path / "lead_vocals.wav"
    lead.write_bytes(b"x")
    (tmp_path / f"backing_vocals{ext}").write_bytes(b"x")
    assert wsw.alignment_audio_paths(str(lead)) == (
        str(lead), [str(tmp_path / f"backing_vocals{ext}")])


def test_backing_stem_prefers_flac_and_lead_may_be_flac(tmp_path):
    lead = tmp_path / "lead_vocals.flac"
    lead.write_bytes(b"x")
    for ext in (".mp3", ".wav", ".flac"):
        (tmp_path / f"backing_vocals{ext}").write_bytes(b"x")
    assert wsw.alignment_audio_paths(str(lead))[1] == [str(tmp_path / "backing_vocals.flac")]


def test_full_vocals_stem_and_missing_backing_are_used_alone(tmp_path):
    full = tmp_path / "vocals.wav"
    full.write_bytes(b"x")
    (tmp_path / "backing_vocals.wav").write_bytes(b"x")
    assert wsw.alignment_audio_paths(str(full)) == (str(full), [])
    lone = tmp_path / "solo" / "lead_vocals.wav"
    lone.parent.mkdir()
    lone.write_bytes(b"x")
    assert wsw.alignment_audio_paths(str(lone)) == (str(lone), [])


def test_stage_hears_lead_plus_backing(env):
    backing = env["stems"] / "backing_vocals.flac"
    backing.write_bytes(b"x")
    _run(env["lead"])
    assert env["aligner"].calls[0][0] == [str(env["lead"]), str(backing)]


# ── fallback, metadata, word shape ────────────────────────────────────────


def test_fallback_keeps_previous_timings_and_records_reason(env, monkeypatch):
    baseline = _baseline(monkeypatch, env["lead"])
    env["aligner"] = FailingAligner()
    data = _run(env["lead"])
    assert _times(data) == _times(baseline)
    assert data["segments"] == baseline["segments"]
    meta = data["metadata"]["acoustic_alignment"]
    assert meta["enabled"] is True and meta["applied"] is False
    assert "CTC worker error" in meta["reason"]


def test_metadata_record_is_stored_and_serializable(env):
    data = _run(env["lead"])
    meta = data["metadata"]["acoustic_alignment"]
    for key in ("engine", "applied", "reason", "models_used", "models_skipped",
                "params", "flagged_count", "flagged_words"):
        assert key in meta
    assert meta["models_used"] == list(MODELS)
    assert meta["params"]["start_shift"] == pytest.approx(-0.02)
    # What the job handlers persist as metadata_json / word_sync_json.
    json.dumps(data, allow_nan=False)
    json.dumps(data["metadata"], allow_nan=False)


def test_per_word_keys_unchanged(env, monkeypatch):
    baseline = _baseline(monkeypatch, env["lead"])
    data = _run(env["lead"])
    assert data["metadata"]["acoustic_alignment"]["applied"] is True
    for line in data["lines"]:
        for w in line:
            assert set(w) == {"text", "start", "end"}
    base_keys = [set(w) for seg in baseline["segments"] for w in seg.get("words", [])]
    new_keys = [set(w) for seg in data["segments"] for w in seg.get("words", [])]
    assert new_keys == base_keys
    assert [[w["text"] for w in line] for line in data["lines"]] == [
        [w["text"] for w in line] for line in baseline["lines"]]


def test_cache_keeps_raw_transcription_and_realign_retimes(env, monkeypatch):
    song_id = 98765
    cache_file = transcription_cache.cache_path(song_id, "heart-vad")
    data = _run(env["lead"], song_id=song_id)
    assert data["metadata"]["acoustic_alignment"]["applied"] is True
    cached = transcription_cache.load(cache_file)
    assert [(w.start, w.end) for seg in cached.segments for w in seg.words] == [
        (s, e) for _, s, e in WORDS]

    env["aligner"].calls.clear()
    realigned = wsw._realign_blocking(
        song_id=song_id, artist="Nobody", title="Lanterns", plain_lyrics=PLAIN,
        synced_lyrics=None, whisper_model="heart", use_vad=True,
        pipeline_config=PipelineConfig(), vocals_path=str(env["lead"]),
    )
    assert env["transcriber"].calls == 1  # the realign did not re-transcribe
    assert len(env["aligner"].calls) == 1
    assert realigned["metadata"]["acoustic_alignment"]["applied"] is True
    assert _times(realigned) == _times(data)


def test_realign_without_vocals_falls_back(env):
    song_id = 98766
    transcription_cache.save(transcription_cache.cache_path(song_id, "heart-vad"),
                             _transcription())
    data = wsw._realign_blocking(
        song_id=song_id, artist="", title="", plain_lyrics=PLAIN, synced_lyrics=None,
        whisper_model="heart", use_vad=True, pipeline_config=PipelineConfig(),
        vocals_path=None,
    )
    meta = data["metadata"]["acoustic_alignment"]
    assert meta["applied"] is False and meta["reason"] == "no audio available"


# ── progress and cancellation ─────────────────────────────────────────────


def test_progress_message_reported_when_the_stage_runs(env):
    messages = []
    _run(env["lead"], stage_progress_fn=messages.append)
    assert messages == [wsw.ACOUSTIC_PROGRESS_MESSAGE]


def test_progress_not_reported_when_disabled_and_errors_ignored(env, monkeypatch):
    messages = []
    _run(env["lead"], plain_lyrics=None, stage_progress_fn=messages.append)
    assert messages == []

    def broken(_message):
        raise RuntimeError("db down")

    data = _run(env["lead"], stage_progress_fn=broken)
    assert data["metadata"]["acoustic_alignment"]["applied"] is True


class BlockingAligner:
    """Blocks until the cancel event it was built with is set."""

    def __init__(self, cancel_event):
        self.cancel_event = cancel_event
        self.started = threading.Event()

    def align_words(self, audio_paths, words):
        self.started.set()
        if not self.cancel_event.wait(10):
            raise AssertionError("cancel event never set")
        raise AcousticAlignmentError("CTC worker cancelled")


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["generate", "realign"])
async def test_cancellation_reaches_the_stage(env, monkeypatch, entry):
    built = {}

    def make_aligner(*, cancel_event, progress_fn=None):
        built["aligner"] = BlockingAligner(cancel_event)
        return built["aligner"]

    monkeypatch.setattr(wsw, "_make_acoustic_aligner", make_aligner)
    song_id = 98767 if entry == "generate" else 98768
    if entry == "generate":
        coro = wsw.generate_word_sync(
            vocals_path=str(env["lead"]), artist="", title="", plain_lyrics=PLAIN,
            song_id=song_id,
        )
    else:
        transcription_cache.save(transcription_cache.cache_path(song_id, "heart-vad"),
                                 _transcription())
        coro = wsw.realign_only(
            song_id=song_id, artist="", title="", plain_lyrics=PLAIN,
            vocals_path=str(env["lead"]),
        )
    task = asyncio.create_task(coro)
    for _ in range(200):
        if "aligner" in built and built["aligner"].started.is_set():
            break
        await asyncio.sleep(0.02)
    assert built["aligner"].started.is_set()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert built["aligner"].cancel_event.is_set()


@pytest.mark.asyncio
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc")
async def test_cancel_terminates_the_real_worker_process(env, monkeypatch, tmp_path):
    """End to end through CtcFusionAligner: cancel kills the worker subprocess."""
    pid_file = tmp_path / "worker.pid"
    script = tmp_path / "sleepy_worker.py"
    script.write_text(
        "import os, sys, time\n"
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
        "time.sleep(60)\n"
    )
    monkeypatch.setattr(wsw, "DEMUCS_PYTHON", Path(sys.executable))

    def make_aligner(*, cancel_event, progress_fn=None):
        return wsw._ReportingAligner(
            CtcFusionAligner(python_path=sys.executable, script_path=script,
                             cancel_event=cancel_event, timeout=60),
            progress_fn,
        )

    monkeypatch.setattr(wsw, "_make_acoustic_aligner", make_aligner)
    song_id = 98769
    transcription_cache.save(transcription_cache.cache_path(song_id, "heart-vad"),
                             _transcription())
    task = asyncio.create_task(wsw.realign_only(
        song_id=song_id, artist="", title="", plain_lyrics=PLAIN,
        vocals_path=str(env["lead"]),
    ))
    for _ in range(250):
        if pid_file.exists() and pid_file.read_text():
            break
        await asyncio.sleep(0.02)
    pid = int(pid_file.read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with open(f"/proc/{pid}/stat") as f:
                if f.read().split()[2] == "Z":
                    break
        except FileNotFoundError:
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail("worker process still running after cancel")
