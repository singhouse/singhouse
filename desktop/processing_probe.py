# SPDX-License-Identifier: AGPL-3.0-only
"""Fixed offline runtime smoke protocol; synthetic tensors, never model weights.

This establishes executable dependency/device readiness, not checkpoint readiness
or transcription/separation quality. The desktop owns the timeout and process
group; the manifest supplies only declared capabilities and import names.
"""
import contextlib
import importlib
import importlib.metadata
import io
import json
import os
import platform
import sys
import tempfile


def deny_network(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
        raise RuntimeError("Runtime smoke checks are offline")


def onnx_add_graph():
    """A fixed float[2] Add graph, encoded without an extra ONNX build dependency."""
    def varint(number):
        result = bytearray()
        while number >= 128:
            result.append((number & 127) | 128)
            number >>= 7
        return bytes(result) + bytes([number])

    def integer(field, number):
        return varint(field << 3) + varint(number)

    def blob(field, value):
        if isinstance(value, str):
            value = value.encode()
        return varint((field << 3) | 2) + varint(len(value)) + value

    def tensor(name):
        shape = blob(1, integer(1, 2))
        tensor_type = integer(1, 1) + blob(2, shape)
        return blob(1, name) + blob(2, blob(1, tensor_type))

    node = blob(1, "x") + blob(1, "x") + blob(2, "y") + blob(4, "Add")
    graph = blob(1, node) + blob(2, "runtime-smoke") + blob(11, tensor("x")) + blob(12, tensor("y"))
    return integer(1, 8) + blob(7, graph) + blob(8, integer(2, 13))


def run(capabilities, accelerator, modules):
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0") != "0":
        raise RuntimeError("Runtime smoke requires PYTORCH_ENABLE_MPS_FALLBACK=0")
    if "torch" in sys.modules:
        raise RuntimeError("Runtime smoke must configure fallback before importing torch")
    # Set before importing the backend package, whose cwd .env fills unset keys.
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"
    if (not capabilities or len(set(capabilities)) != len(capabilities)
            or any(value not in {"transcription", "separation"} for value in capabilities)
            or accelerator not in {"cpu", "cuda", "metal"}):
        raise ValueError("Unsupported runtime smoke request")
    components = {}
    for package in modules:
        imported = importlib.import_module(package)
        components[package] = (getattr(imported, "__version__", None)
                               or importlib.metadata.version(package.split(".")[0].replace("_", "-")))
    import numpy as np
    import torch
    import soundfile
    import librosa

    torch.set_num_threads(1)
    torch.manual_seed(0)
    device = {"metal": "mps"}.get(accelerator, accelerator)
    dtype = torch.float32 if accelerator == "cpu" else torch.float16
    matrix = torch.tensor([[1., 2.], [3., 4.]], device=device, dtype=dtype)
    if not torch.equal((matrix @ matrix).cpu().float(), torch.tensor([[7., 10.], [15., 22.]])):
        raise RuntimeError("Selected device tensor operation failed")
    checks = {"deviceTensor": True}
    audio = np.sin(np.arange(1024, dtype=np.float32) * 0.05) * 0.1
    stream = io.BytesIO()
    soundfile.write(stream, audio, 16000, format="WAV", subtype="FLOAT")
    stream.seek(0)
    decoded, rate = soundfile.read(stream, dtype="float32")
    resampled = librosa.resample(decoded, orig_sr=rate, target_sr=8000)
    if rate != 16000 or not np.array_equal(decoded, audio) or resampled.shape != (512,) or not np.isfinite(resampled).all():
        raise RuntimeError("Native audio round trip failed")
    checks["nativeAudio"] = True

    if "transcription" in capabilities:
        # Resolve the actual worker's lazy dependencies; imports alone previously
        # missed incompatible transformers/torchvision/torchcodec combinations.
        from transformers import WhisperConfig, WhisperForConditionalGeneration, WhisperProcessor, pipeline
        from karaoke_backend.workers.heart_transcriptor import build_generate_kwargs
        import av
        import ctranslate2
        if not callable(WhisperProcessor.from_pretrained) or not callable(pipeline) or build_generate_kwargs("en")["task"] != "transcribe":
            raise RuntimeError("Heart worker dependency route is unavailable")
        frame = av.AudioFrame.from_ndarray(audio.reshape(1, -1), format="flt", layout="mono")
        frame.sample_rate = 16000
        if not av.AudioResampler(format="flt", layout="mono", rate=16000).resample(frame):
            raise RuntimeError("Native transcription audio conversion failed")
        if accelerator != "metal":
            expected_compute = "float16" if accelerator == "cuda" else "int8"
            if expected_compute not in ctranslate2.get_supported_compute_types(device):
                raise RuntimeError("Selected faster-whisper compute type is unavailable")
        config = WhisperConfig(vocab_size=32, num_mel_bins=80, d_model=16,
                               encoder_layers=1, decoder_layers=1, encoder_attention_heads=2,
                               decoder_attention_heads=2, encoder_ffn_dim=32, decoder_ffn_dim=32,
                               max_source_positions=16, max_target_positions=16,
                               pad_token_id=0, bos_token_id=1, eos_token_id=2, decoder_start_token_id=1)
        model = WhisperForConditionalGeneration(config).to(device=device, dtype=dtype).eval()
        with torch.inference_mode():
            output = model(input_features=torch.zeros((1, 80, 32), device=device, dtype=dtype),
                           decoder_input_ids=torch.tensor([[1]], device=device)).logits
        if tuple(output.shape) != (1, 1, 32) or not torch.isfinite(output).all().item():
            raise RuntimeError("Synthetic Heart architecture forward pass failed")
        checks["transcription"] = True

    if "separation" in capabilities:
        from demucs.demucs import Demucs
        from demucs.separate import load_track
        from karaoke_backend.workers.managed_demucs import save_float_wav
        from pathlib import Path
        from audio_separator.separator import Separator
        from audio_separator.separator.uvr_lib_v5.roformer.mel_band_roformer import MelBandRoformer
        import onnxruntime
        if not callable(Separator.separate):
            raise RuntimeError("Audio separator worker dependency route is unavailable")
        model = Demucs(["vocals", "other"], channels=4, depth=2, kernel_size=4,
                       stride=2, dconv_mode=0, resample=False, normalize=False).to(device).eval()
        with torch.inference_mode():
            output = model(torch.zeros((1, 2, 256), device=device))
        if tuple(output.shape) != (1, 2, 2, 256) or not torch.isfinite(output).all().item():
            raise RuntimeError("Synthetic separation forward pass failed")
        # The provisioned separation routes are Demucs and MelBandRoformer,
        # both PyTorch models. Exercise the upstream Roformer selected-device
        # route, including its explicit CPU spectral transforms on MPS. This
        # does not attest complex STFT/ISTFT kernels running on MPS.
        roformer = MelBandRoformer(dim=16, depth=1, stereo=True, num_bands=4,
                                  dim_head=8, heads=2, time_transformer_depth=1,
                                  freq_transformer_depth=1, attn_dropout=0., ff_dropout=0.,
                                  flash_attn=False, stft_n_fft=64, stft_hop_length=16,
                                  stft_win_length=64, match_input_audio_length=True).to(device).eval()
        with torch.inference_mode():
            output = roformer(torch.zeros((1, 2, 256), device=device))
        if tuple(output.shape) != (1, 2, 256) or not torch.isfinite(output).all().item():
            raise RuntimeError("Synthetic Roformer forward pass failed")
        # ORT is an imported library dependency, not the execution engine for
        # these checkpoint routes. This CPU smoke makes no accelerated ONNX
        # claim. The managed adapter separately fails closed on a missing
        # selected ONNX provider if an ONNX model is ever admitted.
        provider = "CPUExecutionProvider"
        if provider not in onnxruntime.get_available_providers():
            raise RuntimeError("Native ONNX library CPU provider is unavailable")
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = onnxruntime.InferenceSession(onnx_add_graph(), sess_options=options, providers=[provider])
        session.disable_fallback()
        if session.get_providers()[0] != provider or not np.array_equal(session.run(None, {"x": np.array([1., 2.], dtype=np.float32)})[0], [2., 4.]):
            raise RuntimeError("Native ONNX library CPU execution failed")
        # Exercise the actual worker's file boundary too: a tiny tensor forward
        # alone missed TorchAudio's optional TorchCodec requirement on save.
        waveform = torch.from_numpy(np.stack([audio, audio * 0.5]))
        with tempfile.TemporaryDirectory(prefix="separation-smoke-", dir=os.environ.get("XDG_CACHE_HOME")) as temporary:
            output_path = Path(temporary) / "smoke.wav"
            save_float_wav(waveform, output_path, 16000, as_float=True)
            info = soundfile.info(output_path)
            restored = load_track(output_path, 2, 16000)
            if (info.subtype != "FLOAT" or info.samplerate != 16000 or info.channels != 2
                    or tuple(restored.shape) != tuple(waveform.shape)
                    or not torch.allclose(restored, waveform, atol=1e-6)):
                raise RuntimeError("Managed separation file round trip failed")
        checks["separation"] = True
    return {"schema": 2, "pythonVersion": platform.python_version(),
            "backendVersion": importlib.metadata.version("karaoke-backend"),
            "lyricsyncVersion": importlib.metadata.version("lyricsync"),
            "capabilities": capabilities, "accelerator": accelerator,
            "hardwareAvailable": True, "components": components, "checks": checks}


if __name__ == "__main__":
    sys.addaudithook(deny_network)
    # Library progress/debug output must not corrupt the bounded JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        result = run(json.loads(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3]))
    print(json.dumps(result))
