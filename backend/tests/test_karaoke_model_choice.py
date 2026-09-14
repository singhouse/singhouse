# SPDX-License-Identifier: AGPL-3.0-only
"""The Pass-2 lead/backing model choice, from allowlist to worker call.

What is worth pinning here is not that a string travels — it is the three
places this could quietly do the wrong thing:

* an unset choice must produce the EXACT call the pipeline made before the
  picker existed, including honouring a ``KARAOKE_MODEL`` env override;
* the ID must be resolved to a filename once, server-side, so no request
  string ever reaches a subprocess argument;
* every dispatch path (local, remote MPS, Modal) must carry the same resolved
  filename — a path that silently ignored the pick would look like the model
  simply not helping.
"""

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from karaoke_backend.workers import karaoke_models, modal_worker

# ---------------------------------------------------------------------------
# The allowlist itself
# ---------------------------------------------------------------------------


def test_default_choice_is_in_the_allowlist():
    assert karaoke_models.DEFAULT_CHOICE in karaoke_models.CHOICES


def test_default_choice_defers_to_the_configured_model():
    """"roformer" means "whatever KARAOKE_MODEL says", so an operator's env
    override keeps working after the picker landed."""
    assert karaoke_models.CHOICES[karaoke_models.DEFAULT_CHOICE] is None
    assert karaoke_models.resolve("roformer", "custom.ckpt") == "custom.ckpt"
    assert karaoke_models.resolve(None, "custom.ckpt") == "custom.ckpt"
    assert karaoke_models.resolve("", "custom.ckpt") == "custom.ckpt"


def test_named_choice_overrides_the_configured_model():
    assert (
        karaoke_models.resolve("mdxnet_kara2", "custom.ckpt")
        == "UVR_MDXNET_KARA_2.onnx"
    )


def test_unknown_choice_degrades_to_the_configured_model():
    """Reached only by a hand-edited or older payload — the API refuses
    unknown IDs. Degrading beats failing a job that already spent Pass 1."""
    assert karaoke_models.resolve("bogus", "custom.ckpt") == "custom.ckpt"


def test_is_valid_accepts_unset_and_rejects_filenames():
    assert karaoke_models.is_valid(None)
    assert karaoke_models.is_valid("")
    assert karaoke_models.is_valid("mdxnet_kara2")
    assert not karaoke_models.is_valid("UVR_MDXNET_KARA_2.onnx")
    assert not karaoke_models.is_valid("../../etc/passwd")


# ---------------------------------------------------------------------------
# Dispatch: the resolved filename reaches each offload path
# ---------------------------------------------------------------------------


@pytest.fixture
def stems_dir(tmp_path: Path) -> Path:
    d = tmp_path / "stems"
    d.mkdir()
    return d


async def _run_modal(choice, stems_dir: Path):
    """Same, down the Modal branch."""
    raw = {"drums": None, "bass": None, "other": None}
    with patch.object(modal_worker.modal_offload, "is_enabled", return_value=True), \
         patch.object(modal_worker.modal_offload, "modal_separate", return_value=raw) as sep, \
         patch.object(modal_worker, "_mix_and_finalize", new=AsyncMock(return_value={})):
        await modal_worker.separate_stems(
            audio_path=Path("song.wav"),
            stems_dir=stems_dir,
            job_id="j1",
            karaoke_model=choice,
        )
    assert sep.call_count == 1
    return sep.call_args.kwargs


@pytest.mark.asyncio
@pytest.mark.parametrize("runner", [_run_modal])
async def test_pick_reaches_offload_path_as_a_filename(runner, stems_dir: Path):
    kwargs = await runner("mdxnet_kara2", stems_dir)
    assert kwargs["karaoke_model"] == "UVR_MDXNET_KARA_2.onnx"


@pytest.mark.asyncio
@pytest.mark.parametrize("runner", [_run_modal])
async def test_unset_pick_sends_the_configured_model(runner, stems_dir: Path):
    """No pick → the module's KARAOKE_MODEL, i.e. the original behaviour."""
    kwargs = await runner(None, stems_dir)
    assert kwargs["karaoke_model"] == modal_worker.KARAOKE_MODEL


# ---------------------------------------------------------------------------
# Plugin seam: offered, never forced
# ---------------------------------------------------------------------------


class _OldPlugin:
    """A separator written before the keyword existed (plugin seam)."""

    def __init__(self):
        self.calls = []

    async def separate(self, audio_path, stems_dir, job_id, on_progress):
        self.calls.append({})
        return {"ok": Path("x")}


class _NewPlugin:
    def __init__(self):
        self.calls = []

    async def separate(self, audio_path, stems_dir, job_id, on_progress, karaoke_model=None):
        self.calls.append({"karaoke_model": karaoke_model})
        return {"ok": Path("x")}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "plugin_cls,expected",
    [(_OldPlugin, [{}]), (_NewPlugin, [{"karaoke_model": "UVR_MDXNET_KARA_2.onnx"}])],
)
async def test_plugin_separator_is_offered_the_pick_only_if_it_takes_one(
    plugin_cls, expected, stems_dir: Path
):
    """A plugin that never grew the keyword must still be called — ONCE.

    The old implementation retried on TypeError, which would have separated the
    track twice had the plugin raised TypeError from its own body.
    """
    plugin = plugin_cls()
    with patch.object(modal_worker, "_plugin_separator", return_value=plugin):
        await modal_worker.separate_stems(
            audio_path=Path("song.wav"),
            stems_dir=stems_dir,
            job_id="j1",
            karaoke_model="mdxnet_kara2",
        )
    assert plugin.calls == expected
