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


def accelerator_device(*, capability: str | None = None) -> str | None:
    value = validated_attestation()
    if value is None:
        return None
    if not value["capabilitiesReady"]:
        raise InvalidAttestation("Managed processing capabilities are not ready")
    if capability and capability not in value["verifiedCapabilities"]:
        raise InvalidAttestation(f"Managed runtime lacks {capability} capability")
    declared = os.getenv("KARAOKE_PROCESSING_ACCELERATOR", "").strip()
    if declared != value["accelerator"]:
        raise InvalidAttestation("Managed accelerator does not match attestation")
    if os.getenv("KARAOKE_PROCESSING_PYTHON", "").strip() != value["pythonPath"]:
        raise InvalidAttestation("Managed Python path does not match attestation")
    return {"cpu": "cpu", "metal": "mps", "mps": "mps", "cuda": "cuda"}[
        value["accelerator"]
    ]
