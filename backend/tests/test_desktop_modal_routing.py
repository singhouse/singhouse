# SPDX-License-Identifier: AGPL-3.0-only
from types import SimpleNamespace
import sys

import pytest

from karaoke_backend.workers import modal_offload


@pytest.fixture(autouse=True)
def restore_desktop_globals(monkeypatch):
    for name in ("APP_NAME", "_ENABLED", "_DESKTOP"):
        monkeypatch.setattr(modal_offload, name, getattr(modal_offload, name))


def test_desktop_disables_ambient_configuration(monkeypatch):
    source_app_name = modal_offload.APP_NAME
    monkeypatch.setattr(modal_offload, "_ENABLED", True)
    monkeypatch.setattr(modal_offload, "_DESKTOP", None)
    modal_offload.configure_desktop({"enabled": False, "publicStatus": {
        "configured": False, "ready": False, "releaseSupported": False}})
    assert not modal_offload.is_enabled()
    assert modal_offload.APP_NAME == source_app_name
    assert modal_offload.readiness()["desktop_qualified"] is False
    with pytest.raises(RuntimeError, match="not ready"):
        modal_offload._lookup("separate_remote")
    with pytest.raises(RuntimeError, match="already configured"):
        modal_offload.configure_desktop({})


def test_desktop_routes_only_fixed_functions_to_pinned_account_version(monkeypatch):
    calls = []
    client = object()
    def credentials(token_id, token_secret):
        calls.append(("credentials", token_id, token_secret))
        return client
    def function(app, name, **kwargs):
        calls.append(("function", app, name, kwargs))
        return "handle"
    monkeypatch.setitem(sys.modules, "modal", SimpleNamespace(
        Client=SimpleNamespace(from_credentials=credentials), Function=SimpleNamespace(from_name=function)))
    monkeypatch.setattr(modal_offload, "_DESKTOP", None)
    descriptor = {"enabled": True, "publicStatus": {"configured": True, "ready": True},
        "config": {"app": "owned", "environment": "private", "version": 4,
                   "tokenId": "ak_fixture", "tokenSecret": "as_fixture"},
        "functions": {"separation": "separate_" + "a" * 64, "transcription": "transcribe_" + "a" * 64}}
    modal_offload.configure_desktop(descriptor)
    assert modal_offload.is_enabled()
    assert modal_offload.APP_NAME == "owned"
    assert modal_offload._lookup("separate_remote") == "handle"
    assert calls[-1] == ("function", "owned", descriptor["functions"]["separation"],
                         {"environment_name": "private", "version": 4, "client": client})
    with pytest.raises(RuntimeError, match="Unsupported"):
        modal_offload._lookup("unapproved_function")
    assert "as_fixture" not in str(modal_offload.readiness())
