# SPDX-License-Identifier: AGPL-3.0-only
"""Application-owned offline entry point for an attested local separator.

Upstream's console script embeds its build interpreter and its CLI has no
device selector. Keep the legacy CLI elsewhere; managed workers use this fixed
adapter with explicit device selection and an already provisioned model cache.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


def disable_mps_fallback():
    # Package __init__ loads cwd .env before this module is entered. Refuse an
    # enabled setting here, before torch can cache it at import; changing an
    # already imported torch module's environment would not disable fallback.
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0") != "0":
        raise RuntimeError("Managed separation requires PYTORCH_ENABLE_MPS_FALLBACK=0")
    if "torch" in sys.modules:
        raise RuntimeError("Managed separation must configure fallback before importing torch")
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"


def deny_network(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
        raise RuntimeError("Managed separation is offline; repair the local model cache before retrying")


def separator_type(device, torch, ort, separator_base):
    if device not in {"cpu", "cuda", "mps"}:
        raise ValueError("Invalid managed separation device")
    provider = {"cpu": "CPUExecutionProvider", "cuda": "CUDAExecutionProvider", "mps": "CoreMLExecutionProvider"}[device]

    class ManagedSeparator(separator_base):
        def setup_torch_device(self, system_info):
            if ((device == "cuda" and not torch.cuda.is_available())
                    or (device == "mps" and not torch.backends.mps.is_available())):
                raise RuntimeError("The attested separation device is unavailable")
            self.torch_device_cpu = torch.device("cpu")
            self.torch_device = torch.device(device)
            self.torch_device_mps = self.torch_device if device == "mps" else None
            # PyTorch-only checkpoints do not need an accelerated ONNX provider.
            # The strict session class below checks it if an ONNX model is used.
            self.onnx_execution_provider = [provider]

        def download_file_if_not_exists(self, url, output_path):
            path = Path(output_path)
            root = Path(self.model_file_dir).resolve()
            if not path.is_file() or not path.resolve().is_relative_to(root):
                raise RuntimeError("Managed separation model data is missing; repair the local model cache before retrying")

    return ManagedSeparator


def strict_session_type(device, ort):
    provider = {"cpu": "CPUExecutionProvider", "cuda": "CUDAExecutionProvider", "mps": "CoreMLExecutionProvider"}[device]

    class ManagedSession(ort.InferenceSession):
        def __init__(self, path_or_bytes, sess_options=None, providers=None, provider_options=None, **kwargs):
            if provider not in ort.get_available_providers():
                raise RuntimeError("The attested ONNX separation provider is unavailable")
            if providers is not None and providers != [provider]:
                raise RuntimeError("ONNX separation provider differs from the attested device")
            options = sess_options if sess_options is not None else ort.SessionOptions()
            if device != "cpu":
                options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
            super().__init__(path_or_bytes, sess_options=options, providers=[provider],
                             provider_options=provider_options, **kwargs)
            self.disable_fallback()
            if self.get_providers()[0] != provider:
                raise RuntimeError("ONNX separation substituted an unattested provider")

    return ManagedSession


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model_filename", required=True)
    parser.add_argument("--model_file_dir", required=True)
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("--output_format", choices=["WAV"], default="WAV")
    parser.add_argument("--device", choices=["cpu", "cuda", "mps"], required=True)
    args = parser.parse_args(argv)
    if Path(args.model_filename).name != args.model_filename or args.model_filename in {".", ".."}:
        raise ValueError("Invalid managed separation model filename")
    disable_mps_fallback()
    sys.addaudithook(deny_network)
    from karaoke_backend.workers.memory_admission import admit, guarded, ROFORMER_PARAMETERS
    model = "karaoke-roformer" if args.model_filename == "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt" else args.model_filename
    bounded = guarded(args.device)
    with admit(model, args.device, [args.audio]) as device:
        import torch
        import onnxruntime as ort
        # Install the strict class before architecture modules import ORT sessions.
        ort.InferenceSession = strict_session_type(device, ort)
        from audio_separator.separator import Separator
        # The bounded profile is part of the measured CUDA policy only.
        # Unguarded CPU and Metal runtimes keep audio-separator defaults.
        profile = (dict(use_soundfile=True, use_autocast=device == "cuda",
                        mdxc_params=dict(ROFORMER_PARAMETERS)) if bounded else {})
        selected = separator_type(device, torch, ort, Separator)(
            model_file_dir=args.model_file_dir, output_dir=args.output_dir,
            output_format=args.output_format, **profile)
        selected.load_model(model_filename=args.model_filename)
        selected.separate(args.audio)


if __name__ == "__main__":
    main()
