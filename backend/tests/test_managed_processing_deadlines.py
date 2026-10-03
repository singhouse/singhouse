# SPDX-License-Identifier: AGPL-3.0-only
"""Parent deadlines accommodate a child choosing the measured CPU fallback."""
import asyncio
import threading
from unittest.mock import AsyncMock, Mock

import pytest

from karaoke_backend.workers import modal_worker, word_sync_worker


@pytest.mark.parametrize("device,policy,expected", [
    ("cuda", "", 3600), ("cpu", "measured-policy", 3600),
    ("cpu", "", 600), ("mps", "", 600), (None, "", 600), (None, "ambient", 600),
])
def test_heart_deadline_preserves_legacy_and_cancellation(monkeypatch, device, policy, expected):
    monkeypatch.setattr(word_sync_worker.modal_offload, "is_enabled", lambda: False)
    monkeypatch.setattr(word_sync_worker, "_attested_accelerator", lambda *_: device)
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", policy)
    cancel = threading.Event()
    transcriber = word_sync_worker._make_transcriber("heart", use_vad=True, cancel_event=cancel)
    assert transcriber.timeout == expected
    assert transcriber.cancel_event is cancel


def test_cloud_heart_does_not_receive_local_deadline(monkeypatch):
    monkeypatch.setattr(word_sync_worker.modal_offload, "is_enabled", lambda: True)
    constructor = Mock()
    monkeypatch.setattr(word_sync_worker.modal_offload, "ModalHeartTranscriber", constructor)
    word_sync_worker._make_transcriber("heart", use_vad=True)
    assert "timeout" not in constructor.call_args.kwargs


@pytest.mark.parametrize("device,policy,expected", [
    ("cuda", "", 3600), ("cpu", "measured-policy", 3600),
    ("cpu", "", 600), ("mps", "", 600), (None, "", 600),
])
@pytest.mark.asyncio
async def test_roformer_passes_bounded_deadline_to_existing_runner(monkeypatch, tmp_path, device, policy, expected):
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", policy)
    monkeypatch.setattr(modal_worker, "configured_pass2_device", lambda: device)
    monkeypatch.setattr(modal_worker, "require_selected_models", lambda *_: None)
    launch = AsyncMock()
    monkeypatch.setattr(modal_worker, "_await_subprocess", launch)
    await modal_worker.run_pass2(tmp_path / "input.wav", tmp_path / "out", "fixture", AsyncMock())
    assert launch.call_args.kwargs["timeout"] == expected
    launch.assert_awaited_once()


@pytest.mark.parametrize("device,policy,expected", [
    ("cuda", "", 3600), ("cpu", "measured-policy", 3600),
    ("cpu", "", 900), ("mps", "", 900),
])
@pytest.mark.asyncio
async def test_demucs_deadline_and_timeout_message(monkeypatch, tmp_path, device, policy, expected):
    interpreter = tmp_path / "python"
    interpreter.touch()
    monkeypatch.setattr(modal_worker, "DEMUCS_PYTHON", interpreter)
    monkeypatch.setattr(modal_worker.modal_offload, "is_enabled", lambda: False)
    monkeypatch.setattr(modal_worker, "configured_accelerator", lambda: device)
    monkeypatch.setattr(modal_worker, "require_selected_models", lambda *_: None)
    monkeypatch.setenv("KARAOKE_DESKTOP_PROCESSING_JSON", "managed")
    monkeypatch.setenv("KARAOKE_PROCESSING_MEMORY_JSON", policy)
    launch = AsyncMock(side_effect=asyncio.TimeoutError)
    monkeypatch.setattr(modal_worker, "_await_subprocess", launch)
    with pytest.raises(modal_worker.StemSeparationError, match=f"after {expected // 60} minutes"):
        await modal_worker.separate_stems(tmp_path / "input.wav", tmp_path / "stems", "job")
    assert launch.call_args.kwargs["timeout"] == expected
    launch.assert_awaited_once()
