# SPDX-License-Identifier: AGPL-3.0-only
"""Validation for the native desktop's managed processing attestation."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

FIELDS = {"runtimeManifestId", "pythonPath", "pythonSha256", "probePassed",
          "accelerator", "components", "verifiedCapabilities", "capabilitiesReady"}


class InvalidAttestation(RuntimeError):
    pass


def heart_model_status() -> dict[str, Any] | None:
    """Report the desktop's selected local checkpoint, without exposing paths.

    This is model availability only; it never grants runtime capabilities.
    The desktop verifies the immutable inventory before providing these values.
    """
    raw = os.getenv("KARAOKE_HEART_MODEL_STATUS_JSON")
    if raw is None and not os.getenv("KARAOKE_DESKTOP_PROCESSING_JSON"):
        return None
    missing = {"installed": False, "modelId": "heart", "revision": None}
    try:
        value = json.loads(raw or "{}")
        if (not isinstance(value, dict)
                or set(value) != {"installed", "modelId", "revision"}
                or type(value["installed"]) is not bool
                or not isinstance(value["modelId"], str)
                or not isinstance(value["revision"], str)):
            return missing
        checkpoint = os.getenv("KARAOKE_HEART_CKPT", "")
        return {**value, "installed": bool(value["installed"] and checkpoint
                                           and Path(checkpoint).is_dir())}
    except (ValueError, OSError):
        return missing


def require_transcription_model(model: str = "heart", *, allow_wait: bool = False) -> None:
    """Validate model admission; durable callers may wait for desktop setup."""
    from karaoke_backend.workers import modal_offload
    if modal_offload.is_enabled():
        return
    if model != "heart":
        if heart_model_status() is not None:
            from fastapi import HTTPException
            raise HTTPException(409, detail={
                "code": "transcription_model_unavailable",
                "message": "The selected transcription model is not installed for this managed runtime.",
            })
        return
    status = heart_model_status()
    if allow_wait and status is not None:
        # Admission to the durable queue is safe; claiming still requires the
        # verified runtime and model inventory, never this permission alone.
        return
    if status is not None and not status["installed"]:
        from fastapi import HTTPException
        raise HTTPException(409, detail={
            "code": "heart_model_missing",
            "message": "Set up the Heart transcription model in the desktop app, then reopen and retry.",
        })
    if status is not None:
        try:
            if accelerator_device(capability="transcription") is None:
                raise InvalidAttestation("No verified processing runtime")
        except InvalidAttestation:
            from fastapi import HTTPException
            raise HTTPException(409, detail={
                "code": "heart_runtime_unavailable",
                "message": "Heart model is installed, but no qualified local transcription runtime is ready.",
            }) from None


def require_heart_model(model: str = "heart", *, allow_wait: bool = False) -> None:
    """Compatibility name for existing admission callers."""
    require_transcription_model(model, allow_wait=allow_wait)


def validated_attestation() -> dict[str, Any] | None:
    """Return a verified managed-desktop attestation, or None in legacy mode."""
    raw = os.getenv("KARAOKE_DESKTOP_PROCESSING_JSON", "").strip()
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise InvalidAttestation("Invalid desktop processing attestation") from exc
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise InvalidAttestation("Invalid desktop processing attestation schema")
    if (not all(type(value[k]) is str and value[k] for k in
                ("runtimeManifestId", "pythonPath", "pythonSha256", "accelerator"))
            or type(value["probePassed"]) is not bool
            or type(value["capabilitiesReady"]) is not bool
            or not isinstance(value["components"], dict)
            or not all(type(k) is str and k and type(v) is str and v
                       for k, v in value["components"].items())
            or type(value["verifiedCapabilities"]) is not list
            or not all(type(item) is str and item in {"transcription", "separation"}
                       for item in value["verifiedCapabilities"])
            or len(set(value["verifiedCapabilities"])) != len(value["verifiedCapabilities"])):
        raise InvalidAttestation("Invalid desktop processing attestation types")
    if (not value["probePassed"]
            or value["accelerator"] not in {"cpu", "metal", "mps", "cuda"}
            or len(value["pythonSha256"] or "") != 64
            or any(c not in "0123456789abcdef" for c in value["pythonSha256"] or "")):
        raise InvalidAttestation("Managed processing attestation is incomplete")
    path = Path(value["pythonPath"])
    try:
        if not path.is_file() or not os.access(path, os.X_OK):
            raise InvalidAttestation("Managed Python is not an executable regular file")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
    except OSError as exc:
        raise InvalidAttestation("Managed Python cannot be verified") from exc
    if digest != value["pythonSha256"]:
        raise InvalidAttestation("Managed Python hash does not match attestation")
    return value


MODEL_CAPABILITIES = {"heart-transcriptor": "transcription", "demucs-mdx-extra": "separation", "karaoke-roformer": "separation"}
DEFAULT_MODEL_SETS = {"transcription": {"heart-transcriptor"}, "separation": {"demucs-mdx-extra", "karaoke-roformer"}}


def validated_model_sets(runtime: dict[str, Any]) -> dict[str, Any]:
    """Validate the desktop's separate verified checkpoint inventory evidence."""
    try:
        value = json.loads(os.environ.get("KARAOKE_DESKTOP_MODEL_SETS_JSON", ""))
    except (TypeError, ValueError) as exc:
        raise InvalidAttestation("Managed model inventory is unavailable") from exc
    if (not isinstance(value, dict) or set(value) != {"schema", "runtimeManifestId", "modelManifestId", "requiredModels", "verifiedModelIds"}
            or type(value["schema"]) is not int or value["schema"] != 1
            or value["runtimeManifestId"] != runtime["runtimeManifestId"]
            or not isinstance(value["requiredModels"], dict)
            or set(value["requiredModels"]) != set(DEFAULT_MODEL_SETS)
            or not isinstance(value["verifiedModelIds"], list)
            or any(type(model) is not str or model not in MODEL_CAPABILITIES for model in value["verifiedModelIds"])
            or len(set(value["verifiedModelIds"])) != len(value["verifiedModelIds"])):
        raise InvalidAttestation("Invalid managed model inventory schema")
    model_manifest = value["modelManifestId"]
    if ((model_manifest is None and value["verifiedModelIds"])
            or (model_manifest is not None and (not isinstance(model_manifest, str) or len(model_manifest) != 64
                or any(char not in "0123456789abcdef" for char in model_manifest)))):
        raise InvalidAttestation("Invalid managed model manifest identity")
    for capability, models in value["requiredModels"].items():
        if (not isinstance(models, list) or any(type(model) is not str or MODEL_CAPABILITIES.get(model) != capability for model in models)
                or len(set(models)) != len(models)
                or (models and capability not in runtime["verifiedCapabilities"])):
            raise InvalidAttestation("Invalid managed model requirements")
    return value


def model_set_ready(capability: str, runtime: dict[str, Any]) -> bool:
    try:
        value = validated_model_sets(runtime)
        required = set(value["requiredModels"][capability])
        return (DEFAULT_MODEL_SETS[capability] <= required
                and required <= set(value["verifiedModelIds"]))
    except (InvalidAttestation, KeyError):
        return False


def require_selected_models(capability: str, selected: list[str]) -> None:
    runtime = validated_attestation()
    if runtime is None:
        if heart_model_status() is not None:
            raise InvalidAttestation("Managed processing runtime is unavailable")
        return
    if (capability not in DEFAULT_MODEL_SETS or not selected
            or any(MODEL_CAPABILITIES.get(model) != capability for model in selected)
            or not model_set_ready(capability, runtime)):
        raise InvalidAttestation("The selected local processing model set is not installed")
    inventory = validated_model_sets(runtime)
    if not set(selected) <= set(inventory["requiredModels"][capability]) & set(inventory["verifiedModelIds"]):
        raise InvalidAttestation("The selected local processing model set is not installed")


def accelerator_device(*, capability: str | None = None) -> str | None:
    value = validated_attestation()
    if value is None:
        return None
    if not value["capabilitiesReady"]:
        raise InvalidAttestation("Managed processing capabilities are not ready")
    if capability and capability not in value["verifiedCapabilities"]:
        raise InvalidAttestation(f"Managed runtime lacks {capability} capability")
    if capability and not model_set_ready(capability, value):
        raise InvalidAttestation("The selected local processing model set is not installed")
    declared = os.getenv("KARAOKE_PROCESSING_ACCELERATOR", "").strip()
    if declared != value["accelerator"]:
        raise InvalidAttestation("Managed accelerator does not match attestation")
    if os.getenv("KARAOKE_PROCESSING_PYTHON", "").strip() != value["pythonPath"]:
        raise InvalidAttestation("Managed Python path does not match attestation")
    return {"cpu": "cpu", "metal": "mps", "mps": "mps", "cuda": "cuda"}[
        value["accelerator"]
    ]


def deferred_job_kinds() -> frozenset[str]:
    """Kinds that must stay durably queued until desktop setup is ready.

    This uses the same evidence as execution. Installing files or saving a
    setup preference cannot release jobs; a new verified desktop boot can.
    Other deployments and configured Modal workers retain their normal policy.
    """
    from karaoke_backend.models.song import JobKind
    from karaoke_backend.workers import modal_offload

    status = heart_model_status()
    if status is None or modal_offload.is_enabled():
        return frozenset()
    missing = set()
    for capability in ("transcription", "separation"):
        try:
            ready = accelerator_device(capability=capability) is not None
        except InvalidAttestation:
            ready = False
        if capability == "transcription":
            ready = ready and status["installed"]
        if not ready:
            missing.add(capability)
    requirements = {
        JobKind.INGEST.value: {"transcription", "separation"},
        JobKind.PLEX_IMPORT.value: {"transcription", "separation"},
        JobKind.RETRANSCRIBE.value: {"transcription"},
        # Realignment constructs the same attested transcription pipeline.
        JobKind.REALIGN.value: {"transcription"},
        JobKind.RESPLIT.value: {"separation"},
    }
    return frozenset(kind for kind, required in requirements.items() if required & missing)
