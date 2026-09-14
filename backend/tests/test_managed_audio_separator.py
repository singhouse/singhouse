# SPDX-License-Identifier: AGPL-3.0-only
"""Managed separator device and offline boundaries, without model fixtures."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from karaoke_backend.workers import managed_audio_separator as adapter


def fake_torch():
    return SimpleNamespace(device=lambda name: name,
                           cuda=SimpleNamespace(is_available=lambda: True),
                           backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: True)))


@pytest.mark.parametrize("device,provider", [("cpu", "CPUExecutionProvider"),
                                            ("cuda", "CUDAExecutionProvider"),
                                            ("mps", "CoreMLExecutionProvider")])
def test_device_is_explicit_even_with_other_accelerators_available(device, provider):
    selected = adapter.separator_type(device, fake_torch(), None, object)()
    selected.setup_torch_device(None)
    assert selected.torch_device == device
    assert selected.torch_device_cpu == "cpu"
    assert selected.onnx_execution_provider == [provider]


@pytest.mark.parametrize("device", ["cuda", "mps"])
def test_missing_attested_device_fails_without_cpu_fallback(device):
    torch = fake_torch()
    torch.cuda.is_available = lambda: False
    torch.backends.mps.is_available = lambda: False
    selected = adapter.separator_type(device, torch, None, object)()
    with pytest.raises(RuntimeError, match="unavailable"):
        selected.setup_torch_device(None)


def test_model_metadata_must_already_exist_in_selected_cache(tmp_path):
    selected = adapter.separator_type("cpu", fake_torch(), None, object)()
    selected.model_file_dir = str(tmp_path / "cache")
    cache = Path(selected.model_file_dir)
    cache.mkdir()
    cached = cache / "download_checks.json"
    cached.write_text("{}")
    selected.download_file_if_not_exists("https://unused.invalid", cached)
    with pytest.raises(RuntimeError, match="repair the local model cache"):
        selected.download_file_if_not_exists("https://unused.invalid", cache / "missing.yaml")
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    with pytest.raises(RuntimeError, match="repair the local model cache"):
        selected.download_file_if_not_exists("https://unused.invalid", outside)


def fake_ort(available, actual):
    class Session:
        def __init__(self, model, **kwargs):
            self.arguments = kwargs
            self.disable_fallback = Mock()

        def get_providers(self):
            return actual

    return SimpleNamespace(InferenceSession=Session,
                           SessionOptions=lambda: SimpleNamespace(add_session_config_entry=Mock()),
                           get_available_providers=lambda: available)


def test_onnx_enforces_requested_provider_and_disables_fallback():
    ort = fake_ort(["CUDAExecutionProvider", "CPUExecutionProvider"], ["CUDAExecutionProvider", "CPUExecutionProvider"])
    session = adapter.strict_session_type("cuda", ort)(b"model", providers=["CUDAExecutionProvider"])
    assert session.arguments["providers"] == ["CUDAExecutionProvider"]
    session.arguments["sess_options"].add_session_config_entry.assert_called_once_with("session.disable_cpu_ep_fallback", "1")
    session.disable_fallback.assert_called_once()
    with pytest.raises(RuntimeError, match="differs"):
        adapter.strict_session_type("cuda", ort)(b"model", providers=["CPUExecutionProvider"])


def test_onnx_rejects_missing_or_substituted_accelerator():
    with pytest.raises(RuntimeError, match="unavailable"):
        adapter.strict_session_type("cuda", fake_ort(["CPUExecutionProvider"], ["CPUExecutionProvider"]))(b"model")
    with pytest.raises(RuntimeError, match="substituted"):
        adapter.strict_session_type("cuda", fake_ort(["CUDAExecutionProvider"], ["CPUExecutionProvider"]))(b"model")


@pytest.mark.parametrize("event", ["socket.connect", "socket.getaddrinfo", "socket.sendto"])
def test_network_attempt_has_actionable_offline_error(event):
    with pytest.raises(RuntimeError, match="repair the local model cache"):
        adapter.deny_network(event, ())


@pytest.mark.parametrize("source", ["inherited", "dotenv"])
def test_mps_fallback_is_rejected_before_torch_import_after_package_dotenv(tmp_path, source):
    import os
    import subprocess
    import sys
    environment = {key: value for key, value in os.environ.items()
                   if key not in {"PYTORCH_ENABLE_MPS_FALLBACK", "PYTHONPATH"}}
    if source == "inherited":
        environment["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    else:
        (tmp_path / ".env").write_text("PYTORCH_ENABLE_MPS_FALLBACK=1\n")
    package_source = str(Path(adapter.__file__).resolve().parents[2])
    # Match -m's package-before-module ordering in a source checkout under -I.
    code = ("import runpy, sys; sys.path.insert(0, " + repr(package_source) + "); "
            "sys.argv = ['managed_audio_separator', 'input.wav', '--model_filename', 'model.ckpt', "
            "'--model_file_dir', 'cache', '--output_dir', 'out', '--device', 'mps']; "
            "runpy.run_module('karaoke_backend.workers.managed_audio_separator', run_name='__main__')")
    result = subprocess.run([sys.executable, "-I", "-B", "-c", code], cwd=tmp_path,
                            env=environment, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert "requires PYTORCH_ENABLE_MPS_FALLBACK=0" in result.stderr
    assert "No module named 'torch'" not in result.stderr


def test_mps_fallback_cannot_be_reconfigured_after_torch_import(monkeypatch):
    import sys
    monkeypatch.setenv("PYTORCH_ENABLE_MPS_FALLBACK", "0")
    monkeypatch.setitem(sys.modules, "torch", object())
    with pytest.raises(RuntimeError, match="before importing torch"):
        adapter.disable_mps_fallback()


def test_explicit_fallback_zero_prevents_package_dotenv_override(tmp_path):
    import os
    import subprocess
    import sys
    (tmp_path / ".env").write_text("PYTORCH_ENABLE_MPS_FALLBACK=1\n")
    environment = {**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "0"}
    package_source = str(Path(adapter.__file__).resolve().parents[2])
    code = ("import sys; sys.path.insert(0, " + repr(package_source) + "); "
            "from karaoke_backend.workers.managed_audio_separator import disable_mps_fallback; "
            "disable_mps_fallback(); import os; "
            "assert os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] == '0'")
    result = subprocess.run([sys.executable, "-I", "-B", "-c", code], cwd=tmp_path,
                            env=environment, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
