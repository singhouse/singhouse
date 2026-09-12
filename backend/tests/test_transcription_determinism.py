# SPDX-License-Identifier: AGPL-3.0-only
"""The first transcription pass is reproducible; the ladder is the rescue path.

Whisper's temperature fallback re-decodes a chunk at successively higher
temperatures whenever the logprob/compression checks reject the previous
attempt. That is exactly what makes two runs of the same audio disagree, so it
is off by default and re-armed only by the manual re-transcribe action.

There are three execution backends and they must agree, or "deterministic"
becomes a property of which machine happened to pick the job up: the local
subprocess, the Modal container, and faster-whisper. These
tests pin the temperature each of them decodes with, and pin that the flag
travels from the constructor to the wire (subprocess argv / Modal call args).
"""

from __future__ import annotations

import inspect
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

LADDER = (0.0, 0.1, 0.2, 0.4)


# ---------------------------------------------------------------------------
# The standalone Heart scripts
# ---------------------------------------------------------------------------


def _script_modules():
    """The Heart runner modules, by the name they are known by operationally."""
    from lyricsync.transcription import _heart_script

    from karaoke_backend.workers import heart_transcriptor

    return {
        "local": heart_transcriptor,
        "lyricsync-bundled": _heart_script,
    }


@pytest.mark.parametrize("name", ["local", "lyricsync-bundled"])
def test_a_heart_decode_is_greedy_unless_the_ladder_is_asked_for(name: str):
    module = _script_modules()[name]

    default = module.build_generate_kwargs("en")
    assert default["temperature"] == 0.0, (
        f"{name} runner: the first pass must decode greedily or it is not reproducible"
    )

    rescue = module.build_generate_kwargs("en", temperature_fallback=True)
    assert rescue["temperature"] == LADDER

    # Nothing else about the decode may differ between the two paths — the flag
    # is a temperature policy, not a second configuration.
    assert {k: v for k, v in default.items() if k != "temperature"} == {
        k: v for k, v in rescue.items() if k != "temperature"
    }


@pytest.mark.parametrize("name", ["local", "lyricsync-bundled"])
def test_every_heart_runner_accepts_the_temperature_fallback_flag(name: str):
    """The helper is only reachable if argparse actually declares the flag.

    ``--help`` exits before the torch import, so this costs milliseconds and
    still proves the CLI surface the transcribers shell out to.
    """
    module = _script_modules()[name]
    proc = subprocess.run(
        [sys.executable, module.__file__, "--help"],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-500:]
    assert "--temperature-fallback" in proc.stdout


# ---------------------------------------------------------------------------
# Constructor → wire
# ---------------------------------------------------------------------------


def _heart_subprocess_argv(*, allow_temperature_fallback: bool, tmp_path: Path):
    """Run ``HeartTranscriber.transcribe`` with the subprocess stubbed out."""
    from lyricsync.transcription import heart as heart_mod

    python_path = tmp_path / "python"
    python_path.write_text("")
    script_path = tmp_path / "script.py"
    script_path.write_text("")

    transcriber = heart_mod.HeartTranscriber(
        python_path=python_path,
        script_path=script_path,
        use_vad=False,
        allow_temperature_fallback=allow_temperature_fallback,
    )

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"segments": [], "language": "en", "full_text": ""}', stderr=""
        )

    with patch.object(heart_mod.subprocess, "run", side_effect=fake_run):
        transcriber.transcribe(str(tmp_path / "audio.wav"))
    return captured["cmd"]


def test_the_local_heart_subprocess_only_gets_the_flag_when_it_was_asked_for(tmp_path: Path):
    off = _heart_subprocess_argv(allow_temperature_fallback=False, tmp_path=tmp_path)
    assert "--temperature-fallback" not in off

    on = _heart_subprocess_argv(allow_temperature_fallback=True, tmp_path=tmp_path)
    assert "--temperature-fallback" in on


def test_the_modal_container_is_told_which_temperature_policy_to_use(tmp_path: Path):
    """Modal takes the option as a call argument, not a CLI flag."""
    from karaoke_backend.workers import modal_offload

    audio = tmp_path / "lead_vocals.wav"
    audio.write_bytes(b"audio")

    class _Fn:
        def __init__(self):
            self.args = None

        def remote(self, *args):
            self.args = args
            return {"segments": [], "language": "en", "full_text": ""}

    for want in (False, True):
        fn = _Fn()
        transcriber = modal_offload.ModalHeartTranscriber(
            use_vad=False, allow_temperature_fallback=want
        )
        with patch.object(modal_offload, "_lookup", return_value=fn):
            transcriber.transcribe(str(audio))
        assert fn.args[-1] is want


# ---------------------------------------------------------------------------
# faster-whisper
# ---------------------------------------------------------------------------


def _faster_whisper_temperature(*, allow_temperature_fallback: bool):
    """Read the temperature a FasterWhisperTranscriber would decode with.

    Built without ``__init__`` on purpose: loading a real large-v3 model to
    inspect one kwarg would make this a GPU test.
    """
    from lyricsync.transcription import faster_whisper as fw_mod

    transcriber = object.__new__(fw_mod.FasterWhisperTranscriber)
    transcriber.allow_temperature_fallback = allow_temperature_fallback

    captured: dict = {}

    class _Model:
        def transcribe(self, audio, **kwargs):
            captured.update(kwargs)
            return iter(()), object()

    transcriber._model = _Model()

    with patch.object(fw_mod, "read_wav_mono", return_value=([0.0] * 16000, 16000)), \
            patch.object(fw_mod, "rms_vad_segments", return_value=[(0.0, 1.0)]):
        transcriber.transcribe("ignored.wav", language="en")

    return captured["temperature"]


def test_faster_whisper_never_inherits_the_library_temperature_ladder():
    """Unset, faster-whisper silently walks 0.0 → 1.0. We always say which."""
    assert _faster_whisper_temperature(allow_temperature_fallback=False) == 0.0
    assert _faster_whisper_temperature(allow_temperature_fallback=True) == LADDER


def test_the_faster_whisper_constructor_actually_takes_the_option():
    """The test above builds the object without ``__init__`` (a real model load
    would make it a GPU test), so on its own it would still pass if the
    constructor stopped accepting the option entirely. Pin the signature."""
    from lyricsync.transcription import faster_whisper as fw_mod

    params = inspect.signature(fw_mod.FasterWhisperTranscriber.__init__).parameters
    assert "allow_temperature_fallback" in params, (
        "the option is gone from the constructor — nothing can set it any more"
    )
    assert params["allow_temperature_fallback"].default is False, (
        "the default decode must be greedy without anyone having to ask"
    )


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def test_the_worker_forwards_the_option_to_the_built_in_transcriber():
    """``_make_transcriber`` is where the option meets the dispatch chain."""
    from karaoke_backend.workers import word_sync_worker

    default = word_sync_worker._make_transcriber("heart", use_vad=True)
    assert default.allow_temperature_fallback is False

    rescue = word_sync_worker._make_transcriber(
        "heart", use_vad=True, allow_temperature_fallback=True
    )
    assert rescue.allow_temperature_fallback is True


def test_the_whisper_branch_of_the_dispatch_chain_forwards_it_too():
    """``heart`` is not the only built-in: the whisper names fall through to a
    separate constructor call, which is its own chance to drop the option."""
    from karaoke_backend.workers import word_sync_worker

    seen: list[dict] = []

    def _fake_ctor(**kwargs):
        seen.append(kwargs)
        return object()

    for want in (False, True):
        with patch.object(
            word_sync_worker, "FasterWhisperTranscriber", side_effect=_fake_ctor
        ):
            word_sync_worker._make_transcriber(
                "large-v3", use_vad=True, allow_temperature_fallback=want
            )

    # Keyword name included: it is positional-compatible with `device`, so a
    # dropped keyword would be a silent misconfiguration, not a TypeError.
    assert seen == [
        {"model": "large-v3", "allow_temperature_fallback": False},
        {"model": "large-v3", "allow_temperature_fallback": True},
    ]


def test_a_transcriber_plugin_is_never_handed_the_option():
    """It is a constructor option on the built-ins, NOT part of the protocol.

    Third-party transcribers implement ``Transcriber``; widening that contract
    would break every one of them. A plugin keeps whatever decoding policy it
    already had, which is why the built-in chain is the only thing that changes.
    """
    from karaoke_backend.workers import word_sync_worker

    seen: list[dict] = []

    class _Provider:
        models = ("pluginmodel",)

        def is_enabled(self):
            return True

        def create(self, model, **kwargs):
            seen.append(kwargs)
            return object()

    with patch.object(
        word_sync_worker.plugins,
        "instantiate_group",
        return_value=[("fake", _Provider())],
    ):
        word_sync_worker._make_transcriber(
            "pluginmodel", use_vad=True, allow_temperature_fallback=True
        )

    assert seen == [{"use_vad": True}]


# ---------------------------------------------------------------------------
# Saying which policy produced a result
# ---------------------------------------------------------------------------


def _word_data_for(*, allow_temperature_fallback: bool, tmp_path: Path) -> dict:
    """Run the blocking core with the pipeline stubbed, return its word_data."""
    from lyricsync import PipelineConfig
    from lyricsync._types import SyncMetadata, SyncResult

    from karaoke_backend.workers import word_sync_worker

    vocals = tmp_path / "lead_vocals.wav"
    vocals.write_bytes(b"audio")

    class _Pipeline:
        def __init__(self):
            class _T:
                def transcribe(inner_self, *a, **k):  # noqa: N805
                    return object()

            self.transcriber = _T()

        def align_only(self, **kwargs):
            return SyncResult(segments=[], lines=[], metadata=SyncMetadata())

    with patch.object(word_sync_worker, "_make_pipeline", return_value=_Pipeline()):
        return word_sync_worker._run_blocking(
            vocals_path=str(vocals),
            artist="A",
            title="B",
            plain_lyrics=None,
            synced_lyrics=None,
            whisper_model="heart",
            language=None,
            use_vad=True,
            song_id=None,  # no song_id, so this touches no cache
            pipeline_config=PipelineConfig(),
            allow_temperature_fallback=allow_temperature_fallback,
        )


def test_the_stored_metadata_records_which_temperature_policy_produced_it(
    tmp_path: Path,
):
    """Without this you cannot tell a real regression from a reroll after the
    fact, which is the entire reason the first pass was pinned to greedy."""
    off = _word_data_for(allow_temperature_fallback=False, tmp_path=tmp_path)
    assert off["metadata"]["temperature_fallback"] is False

    on = _word_data_for(allow_temperature_fallback=True, tmp_path=tmp_path)
    assert on["metadata"]["temperature_fallback"] is True


def test_a_rescue_produced_lyrics_set_is_labelled_as_one():
    """Same visibility one level up: in the set picker, not just the metadata."""
    from karaoke_backend.jobs.transcribe import _label_for_set

    assert _label_for_set("heart-vad", "none", realigned=False) == "heart-vad"
    assert (
        _label_for_set("heart-vad", "none", realigned=False, rescue=True)
        == "heart-vad-rescue"
    )
    assert (
        _label_for_set("heart-vad", "plain", realigned=False, rescue=True)
        == "heart-vad-plain-rescue"
    )
    # Unanchored stays the unlabelled baseline for non-rescue runs.
    assert (
        _label_for_set("heart-vad", "synced", realigned=True)
        == "heart-vad-synced-realigned"
    )
