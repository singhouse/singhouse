# SPDX-License-Identifier: AGPL-3.0-only
"""Prepare consented, release-qualified Modal routing before backend import.

Call only from the private desktop bootstrap, before its event loop starts.
The bootstrap owns environment/profile isolation and SDK output suppression.
This module never invokes a processing function or manufactures qualification.
"""
import asyncio
from copy import deepcopy
import importlib
import re

from modal_check import check_metadata, valid_config, valid_contract

_FIELDS = {"app", "environment", "version", "tokenId", "tokenSecret"}
_REFERENCE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def qualified_contract(contract):
    if not valid_contract(contract):
        return False
    evidence = contract.get("qualification")
    return (isinstance(evidence, dict) and evidence.get("passed") is True
            and evidence.get("protocolSha256") == contract["protocolSha256"]
            and isinstance(evidence.get("evidenceReference"), str)
            and bool(_REFERENCE.fullmatch(evidence["evidenceReference"])))


def prepare_modal_runtime(config, contract, sdk=None):
    """Return an internal descriptor; expose only ``publicStatus`` to clients.

    The release-owned contract must come from trusted application resources,
    never from renderer input or the saved private credential configuration.
    Disabled descriptors contain no credentials or executable routing data.
    """
    public = {"schema": 1, "configured": isinstance(config, dict),
              "accessChecked": False, "compatible": False, "qualified": False, "ready": False,
              "releaseSupported": qualified_contract(contract)}

    def disabled(code):
        return {"enabled": False, "publicStatus": {**public, "errorCode": code}}

    if not isinstance(config, dict) or set(config) != _FIELDS | {"consent"}:
        return disabled("invalid-config")
    private = {key: config[key] for key in _FIELDS}
    if not valid_config(private):
        return disabled("invalid-config")
    consent = config.get("consent")
    if (not isinstance(consent, dict) or set(consent) != {"uploads", "usage"}
            or consent.get("uploads") is not True or consent.get("usage") is not True):
        return disabled("consent-required")
    if not valid_contract(contract):
        return disabled("release-contract-unavailable")
    if not public["releaseSupported"]:
        return disabled("release-qualification-unavailable")
    # Qualification is a release-owner attestation validated structurally. The
    # metadata check below establishes current access and compatibility only.
    public["qualified"] = True
    try:
        if sdk is None:
            sdk = importlib.import_module("modal")
            if sdk.__version__ != "1.5.5":
                return disabled("sdk-unavailable")
        # This API is for synchronous pre-import bootstrap, not a request route.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            return disabled("bootstrap-context-invalid")
        metadata = asyncio.run(check_metadata(private, contract, sdk, timeout=25))
    except Exception:
        return disabled("metadata-check-failed")
    public["accessChecked"] = metadata.get("accessChecked") is True
    public["compatible"] = metadata.get("compatible") is True
    if not public["accessChecked"] or not public["compatible"]:
        # Do not propagate SDK messages or arbitrary metadata properties.
        return disabled("metadata-check-failed")
    public["ready"] = True
    return {"enabled": True, "publicStatus": public,
            "config": {**deepcopy(private), "consent": {"uploads": True, "usage": True}},
            "functions": deepcopy(contract["functions"]), "protocolSha256": contract["protocolSha256"]}
