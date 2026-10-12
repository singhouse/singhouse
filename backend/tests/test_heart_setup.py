# SPDX-License-Identifier: AGPL-3.0-only
import json

import pytest
from fastapi import HTTPException

from karaoke_backend.workers import managed_processing, modal_offload


@pytest.fixture(autouse=True)
def clean_desktop(monkeypatch):
    for name in ("KARAOKE_HEART_MODEL_STATUS_JSON", "KARAOKE_DESKTOP_PROCESSING_JSON",
                 "KARAOKE_HEART_CKPT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(modal_offload, "is_enabled", lambda: False)


def test_legacy_and_alternative_model_do_not_require_setup(monkeypatch):
    managed_processing.require_heart_model()
    assert managed_processing.heart_model_status() is None
    managed_processing.require_heart_model("tiny")
    monkeypatch.setenv("KARAOKE_HEART_MODEL_STATUS_JSON", "{}")
    with pytest.raises(HTTPException) as caught:
        managed_processing.require_transcription_model("tiny")
    assert caught.value.detail["code"] == "transcription_model_unavailable"
    monkeypatch.setattr(modal_offload, "is_enabled", lambda: True)
    managed_processing.require_heart_model()


@pytest.mark.parametrize("raw", ["invalid", "[]", "{}", '{"installed":true}',
                                     '{"installed":"true","modelId":"heart","revision":"abc"}'])
def test_invalid_status_fails_closed_without_paths(monkeypatch, raw):
    monkeypatch.setenv("KARAOKE_HEART_MODEL_STATUS_JSON", raw)
    assert managed_processing.heart_model_status()["installed"] is False
    with pytest.raises(HTTPException) as caught:
        managed_processing.require_heart_model()
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "heart_model_missing"


def test_checkpoint_and_runtime_are_independent(monkeypatch, tmp_path):
    status = {"installed": True, "modelId": "heart", "revision": "abc"}
    monkeypatch.setenv("KARAOKE_HEART_MODEL_STATUS_JSON", json.dumps(status))
    monkeypatch.setenv("KARAOKE_HEART_CKPT", str(tmp_path / "missing"))
    assert managed_processing.heart_model_status()["installed"] is False
    monkeypatch.setenv("KARAOKE_HEART_CKPT", str(tmp_path))
    assert managed_processing.heart_model_status() == status
    with pytest.raises(HTTPException) as caught:
        managed_processing.require_heart_model()
    assert caught.value.detail["code"] == "heart_runtime_unavailable"
    monkeypatch.setattr(managed_processing, "accelerator_device", lambda **kw: "cpu")
    managed_processing.require_heart_model()


@pytest.mark.asyncio
async def test_managed_transcription_validates_song_while_setup_waits(client, monkeypatch):
    monkeypatch.setenv("KARAOKE_HEART_MODEL_STATUS_JSON", "{}")
    response = await client.post("/api/songs/999/lyrics/transcribe", json={"whisper_model": "heart"})
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_managed_upload_waits_durably_for_setup(client, monkeypatch):
    monkeypatch.setenv("KARAOKE_HEART_MODEL_STATUS_JSON", "{}")
    response = await client.post("/api/separate", files={"file": ("song.wav", b"audio", "audio/wav")})
    assert response.status_code == 202
    from karaoke_backend.jobs import queue
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import Job
    assert await queue.claim_next("waiting-worker") is None
    async with AsyncSessionLocal() as db:
        job = await db.get(Job, response.json()["job_id"])
        assert job.status == "queued"
        assert job.attempts == 0
        assert job.claimed_by is None
        assert job.message == "Waiting for desktop processing setup"


@pytest.mark.asyncio
async def test_managed_media_server_import_validates_configuration_while_setup_waits(client, monkeypatch):
    monkeypatch.setenv("KARAOKE_HEART_MODEL_STATUS_JSON", "{}")
    response = await client.post("/api/plex/import", json={"tracks": [{"rating_key": "123", "title": "Song"}]})
    assert response.status_code == 400
    assert "heart_model_missing" not in response.text


@pytest.mark.asyncio
async def test_managed_alternate_model_refuses_before_queue_or_reference(client, monkeypatch):
    monkeypatch.setenv("KARAOKE_HEART_MODEL_STATUS_JSON", "{}")
    response = await client.post("/api/songs/999/lyrics/transcribe", json={"whisper_model": "tiny"})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "transcription_model_unavailable"
