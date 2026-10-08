# SPDX-License-Identifier: MIT
"""Pipeline hook for the acoustic re-timing stage, with fake aligners (no torch)."""

import json
import sys
import threading
from dataclasses import replace

import pytest
from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment
from lyricsync.alignment.ctc_aligner import METADATA_KEY, apply_acoustic_alignment

from lyricsync import (
    AcousticAligner,
    AcousticAlignmentError,
    AcousticSpans,
    AsyncPipeline,
    CtcFusionAligner,
    PipelineConfig,
    SyncPipeline,
)

AUDIO = "/dev/null"  # exists; the fake aligners never read it

# Invented text only.
WORDS = [
    ("Paper", 0.5, 0.9), ("lanterns", 1.0, 1.6), ("drift", 1.7, 2.1),
    ("over", 4.0, 4.4), ("quiet", 4.5, 4.9), ("water", 5.0, 5.6),
]
PLAIN = "Paper lanterns drift\nover quiet water"
SYNCED = "[00:00.50]Paper lanterns drift\n[00:04.00]over quiet water"


class MockTranscriber:
    def __init__(self, words):
        self._words = words

    def transcribe(self, audio_path, language=None):
        return _transcription(self._words)


def _transcription(words):
    tw = [TimedWord(text=t, start=s, end=e) for t, s, e in words]
    return TranscriptionResult(
        segments=[
            TranscriptionSegment(start=tw[0].start, end=tw[2].end, text="", words=tw[:3]),
            TranscriptionSegment(start=tw[3].start, end=tw[-1].end, text="", words=tw[3:]),
        ],
        language="en",
    )


class ShiftAligner:
    """Every model reports the input word times shifted by ``shift`` seconds."""

    def __init__(self, shift=0.5, models=("hubl", "w2v2l", "hubxl", "phon"), failed=None):
        self.shift = shift
        self.models = models
        self.failed = failed or {}
        self.calls = []
        self.reference = None  # word times to shift, set by the test

    def align_words(self, audio_paths, words):
        self.calls.append((list(audio_paths), list(words)))
        ref = self.reference
        spans = {m: [(s + self.shift, e + self.shift) for s, e in ref] for m in self.models}
        return AcousticSpans(spans=spans, models_failed=dict(self.failed), device="cuda",
                             info={"engine": "fake"})


class FailingAligner:
    def __init__(self, exc):
        self.exc = exc
        self.calls = 0

    def align_words(self, audio_paths, words):
        self.calls += 1
        raise self.exc


def _structure(result):
    return [[w.text for w in line] for line in result.lines]


def _times(result):
    return [(w.start, w.end) for line in result.lines for w in line]


def _seg_times(result):
    return [(w["start"], w["end"]) for seg in result.segments for w in seg["words"]]


def _run(mode, aligner, enabled=True, use_align_only=False, **kw):
    config = PipelineConfig(acoustic_alignment=enabled)
    pipe = SyncPipeline(MockTranscriber(WORDS), config=config, acoustic_aligner=aligner)
    lyrics = {"plain": {"plain_lyrics": PLAIN}, "synced": {"synced_lyrics": SYNCED}, "none": {}}
    if use_align_only:
        return pipe.align_only(_transcription(WORDS), audio_path=kw.pop("audio_path", AUDIO),
                               **lyrics[mode], **kw)
    return pipe.run(AUDIO, **lyrics[mode], **kw)


def _baseline(mode, use_align_only=False):
    return _run(mode, None, enabled=False, use_align_only=use_align_only)


MODES = ["plain", "synced", "none"]


def test_fake_aligner_satisfies_protocol():
    assert isinstance(ShiftAligner(), AcousticAligner)
    assert isinstance(CtcFusionAligner(sys.executable), AcousticAligner)


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("use_align_only", [False, True])
def test_enabled_retimes_and_keeps_structure(mode, use_align_only):
    base = _baseline(mode, use_align_only)
    al = ShiftAligner(shift=0.5)
    al.reference = _times(base)
    res = _run(mode, al, use_align_only=use_align_only)

    assert len(al.calls) == 1
    assert al.calls[0][0] == [AUDIO]
    assert al.calls[0][1] == [w.text for line in base.lines for w in line]
    assert _structure(res) == _structure(base)
    assert [len(s["words"]) for s in res.segments] == [len(s["words"]) for s in base.segments]
    assert [w["text"] for s in res.segments for w in s["words"]] == \
        [w["text"] for s in base.segments for w in s["words"]]

    new, old = _times(res), _times(base)
    # Four models at +0.5 s outvote the existing timing; then the -0.02 s shift.
    for (ns, ne), (os_, _) in zip(new, old, strict=True):
        assert ns == pytest.approx(os_ + 0.48)
        assert ne >= ns
    starts = [s for s, _ in new]
    assert starts == sorted(starts)
    assert _seg_times(res) == new

    meta = res.metadata.extra[METADATA_KEY]
    assert meta["applied"] is True
    assert meta["engine"] == "ctc-fusion-1"
    assert meta["models_used"] == ["hubl", "w2v2l", "hubxl", "phon"]
    assert meta["models_skipped"] == {}
    assert meta["params"] == {"start_shift": -0.02, "join_gap": 0.0, "tail_extend": 0.2,
                              "flag_threshold": 0.2}
    assert meta["flagged_count"] == 0 and meta["flagged_words"] == []
    assert meta["device"] == "cuda"
    # Existing metadata is untouched.
    assert res.metadata.method == base.metadata.method
    assert res.metadata.words_total == base.metadata.words_total
    assert res.metadata.extra["starts_trimmed_to_onset"] == \
        base.metadata.extra["starts_trimmed_to_onset"]
    json.dumps(meta)  # serialisable for the stored metadata


@pytest.mark.parametrize("mode", MODES)
def test_disabled_does_not_call_aligner(mode):
    base = _baseline(mode)
    al = ShiftAligner()
    al.reference = _times(base)
    res = _run(mode, al, enabled=False)
    assert al.calls == []
    assert _times(res) == _times(base)
    assert METADATA_KEY not in res.metadata.extra


def test_enabled_without_aligner_is_a_no_op():
    base = _baseline("plain")
    res = _run("plain", None, enabled=True)
    assert _times(res) == _times(base)
    assert METADATA_KEY not in res.metadata.extra


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("exc", [
    AcousticAlignmentError("CTC worker timed out after 5s"),
    AcousticAlignmentError("CTC worker error: CUDA is not available"),
    ValueError("unexpected"),
])
def test_failure_keeps_original_times(mode, exc):
    base = _baseline(mode)
    al = FailingAligner(exc)
    res = _run(mode, al)
    assert al.calls == 1
    assert res is not None
    assert _structure(res) == _structure(base)
    assert _times(res) == _times(base)
    assert _seg_times(res) == _seg_times(base)
    meta = res.metadata.extra[METADATA_KEY]
    assert meta["applied"] is False
    assert str(exc) in meta["reason"]


@pytest.mark.parametrize("mode", MODES)
def test_too_few_character_models_keeps_times(mode):
    base = _baseline(mode)
    al = ShiftAligner(models=("hubl", "phon"),
                      failed={"w2v2l": "OutOfMemoryError: x", "hubxl": "OutOfMemoryError: y"})
    al.reference = _times(base)
    res = _run(mode, al)
    assert _times(res) == _times(base)
    meta = res.metadata.extra[METADATA_KEY]
    assert meta["applied"] is False
    assert "character model" in meta["reason"]
    assert meta["models_used"] == ["hubl", "phon"]
    assert set(meta["models_skipped"]) == {"w2v2l", "hubxl"}


def test_extra_audio_paths_are_passed(tmp_path):
    backing = tmp_path / "backing.wav"
    backing.write_bytes(b"")
    base = _baseline("plain")
    al = ShiftAligner()
    al.reference = _times(base)
    _run("plain", al, extra_audio_paths=[str(backing)])
    assert al.calls[0][0] == [AUDIO, str(backing)]


def test_missing_extra_audio_falls_back(tmp_path):
    base = _baseline("plain")
    al = ShiftAligner()
    al.reference = _times(base)
    res = _run("plain", al, extra_audio_paths=[str(tmp_path / "missing.wav")])
    assert al.calls == []
    assert _times(res) == _times(base)
    assert "audio not found" in res.metadata.extra[METADATA_KEY]["reason"]


def test_align_only_without_audio_falls_back():
    base = _baseline("plain", use_align_only=True)
    al = ShiftAligner()
    al.reference = _times(base)
    res = _run("plain", al, use_align_only=True, audio_path=None)
    assert al.calls == []
    assert _times(res) == _times(base)
    assert res.metadata.extra[METADATA_KEY]["reason"] == "no audio available"


def test_flagged_words_recorded():
    base = _baseline("plain")
    ref = _times(base)

    class Disagree(ShiftAligner):
        def align_words(self, audio_paths, words):
            out = super().align_words(audio_paths, words)
            # word 2: two models put it 1 s late
            for m in ("hubxl", "phon"):
                out.spans[m][2] = (ref[2][0] + 1.0, ref[2][1] + 1.0)
            return out

    al = Disagree(shift=0.0)
    al.reference = ref
    res = _run("plain", al)
    meta = res.metadata.extra[METADATA_KEY]
    assert meta["applied"] is True
    assert meta["flagged_words"] == [2]
    assert meta["flagged_count"] == 1


def test_custom_parameters_recorded():
    base = _baseline("plain")
    al = ShiftAligner(shift=0.0)
    al.reference = _times(base)
    config = replace(PipelineConfig(acoustic_alignment=True), acoustic_start_shift=-0.05,
                     acoustic_join_gap=0.3, acoustic_tail_extend=0.1)
    pipe = SyncPipeline(MockTranscriber(WORDS), config=config, acoustic_aligner=al)
    res = pipe.run(AUDIO, plain_lyrics=PLAIN)
    meta = res.metadata.extra[METADATA_KEY]
    assert meta["params"]["start_shift"] == -0.05
    assert meta["params"]["join_gap"] == 0.3
    assert meta["params"]["tail_extend"] == 0.1
    assert _times(res)[0][0] == pytest.approx(_times(base)[0][0] - 0.05)


def test_structure_mismatch_is_refused():
    base = _baseline("plain")
    base.segments[0]["words"].pop()
    al = ShiftAligner()
    al.reference = _times(base)
    before = _times(base)
    meta = apply_acoustic_alignment(base, al, [AUDIO])
    assert al.calls == []
    assert meta["applied"] is False
    assert "structure" in meta["reason"]
    assert _times(base) == before


async def test_async_pipeline_passes_aligner_and_extra_paths(tmp_path):
    backing = tmp_path / "backing.wav"
    backing.write_bytes(b"")
    base = _baseline("plain")
    al = ShiftAligner()
    al.reference = _times(base)
    pipe = AsyncPipeline(MockTranscriber(WORDS), config=PipelineConfig(acoustic_alignment=True),
                         acoustic_aligner=al)
    res = await pipe.run(AUDIO, plain_lyrics=PLAIN, extra_audio_paths=[str(backing)])
    assert al.calls[0][0] == [AUDIO, str(backing)]
    assert res.metadata.extra[METADATA_KEY]["applied"] is True


# ---- CtcFusionAligner subprocess handling, with a stand-in worker script (no torch) ----

def _write_worker(tmp_path, body):
    p = tmp_path / "worker.py"
    p.write_text(
        "import json, sys, time\n"
        "args = sys.argv[1:]\n"
        "inp, out = args[args.index('--input') + 1], args[args.index('--output') + 1]\n"
        "req = json.load(open(inp))\n" + body
    )
    return p


def test_worker_result_is_parsed(tmp_path):
    script = _write_worker(tmp_path, (
        "n = len(req['words'])\n"
        "spans = {m: [[i * 1.0, i + 0.5] for i in range(n)] for m in ('hubl', 'w2v2l')}\n"
        "spans['hubl'][0] = [None, None]\n"
        "json.dump({'engine': 'ctc-worker-1', 'device': 'cpu', 'models_run': ['hubl', 'w2v2l'],"
        " 'models_failed': {'phon': 'no espeak'}, 'spans': spans,"
        " 'allow_cpu': req['allow_cpu']}, open(out, 'w'))\n"
    ))
    al = CtcFusionAligner(sys.executable, script_path=script, allow_cpu=True)
    res = al.align_words([AUDIO], ["a", "b", "c"])
    assert res.device == "cpu"
    assert res.models_failed == {"phon": "no espeak"}
    assert res.spans["w2v2l"] == [(0.0, 0.5), (1.0, 1.5), (2.0, 2.5)]
    a, b = res.spans["hubl"][0]
    assert a != a and b != b  # NaN


def test_worker_error_is_raised(tmp_path):
    script = _write_worker(tmp_path, (
        "json.dump({'error': 'CUDA is not available'}, open(out, 'w'))\nsys.exit(1)\n"
    ))
    al = CtcFusionAligner(sys.executable, script_path=script)
    with pytest.raises(AcousticAlignmentError, match="CUDA is not available"):
        al.align_words([AUDIO], ["a"])


def test_worker_crash_is_raised(tmp_path):
    script = _write_worker(tmp_path, "sys.stderr.write('boom\\n'); sys.exit(3)\n")
    al = CtcFusionAligner(sys.executable, script_path=script)
    with pytest.raises(AcousticAlignmentError, match="exit 3"):
        al.align_words([AUDIO], ["a"])


def test_worker_timeout(tmp_path):
    script = _write_worker(tmp_path, "time.sleep(30)\n")
    al = CtcFusionAligner(sys.executable, script_path=script, timeout=1)
    with pytest.raises(AcousticAlignmentError, match="timed out"):
        al.align_words([AUDIO], ["a"])


def test_worker_cancel(tmp_path):
    script = _write_worker(tmp_path, "time.sleep(30)\n")
    ev = threading.Event()
    ev.set()
    al = CtcFusionAligner(sys.executable, script_path=script, cancel_event=ev, timeout=60)
    with pytest.raises(AcousticAlignmentError, match="cancelled"):
        al.align_words([AUDIO], ["a"])


def test_missing_interpreter(tmp_path):
    al = CtcFusionAligner(tmp_path / "nope" / "python")
    with pytest.raises(AcousticAlignmentError, match="not found"):
        al.align_words([AUDIO], ["a"])


def test_bundled_worker_script_exists():
    assert CtcFusionAligner(sys.executable).script_path.name == "_ctc_worker.py"
    assert CtcFusionAligner(sys.executable).script_path.exists()
