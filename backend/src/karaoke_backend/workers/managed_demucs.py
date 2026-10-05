# SPDX-License-Identifier: AGPL-3.0-only
"""Offline managed Demucs entry point with explicit float WAV output.

TorchAudio 2.10 delegates writing to optional TorchCodec and ignores Demucs'
float32/encoding request. Use the pinned soundfile implementation for this
application's WAV-only route, preserving upstream clipping semantics.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys


def save_float_wav(wav, path, samplerate, bitrate=320, clip="rescale",
                   bits_per_sample=16, as_float=False, preset=2):
    if not as_float or Path(path).suffix.lower() != ".wav":
        raise ValueError("Managed Demucs writes float32 WAV files only")
    import torch
    import soundfile
    from demucs.audio import prevent_clip
    if wav.ndim != 2 or not torch.isfinite(wav).all().item():
        raise ValueError("Invalid managed Demucs waveform")
    output = prevent_clip(wav, mode=clip).detach().cpu().float().transpose(0, 1).numpy()
    soundfile.write(str(path), output, samplerate, format="WAV", subtype="FLOAT")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("-n", "--name", required=True)
    parser.add_argument("--device", choices=["cpu", "cuda", "mps"], required=True)
    parser.add_argument("--float32", action="store_true", required=True)
    parser.add_argument("-o", "--out", required=True)
    parser.add_argument("tracks", nargs="+")
    args = parser.parse_args(argv)
    from karaoke_backend.workers.managed_audio_separator import disable_mps_fallback, deny_network
    disable_mps_fallback()
    sys.addaudithook(deny_network)
    from karaoke_backend.workers.memory_admission import admit, guarded, DEMUCS_SEGMENT_SECONDS
    # The bounded profile is part of the measured CUDA policy only. Unguarded
    # CPU and Metal runtimes keep upstream Demucs segmentation.
    profile = (["--segment", str(DEMUCS_SEGMENT_SECONDS), "--jobs", "0"]
               if guarded(args.device) else [])
    with admit("demucs-mdx-extra" if args.name == "mdx_extra" else args.name, args.device, args.tracks) as device:
        import torch
        import demucs.separate
        # Refuse unavailable selected hardware before loading a checkpoint. MPS
        # fallback was disabled before torch import, so this cannot silently use CPU.
        torch.empty(1, device=device)
        original_save = demucs.separate.save_audio
        demucs.separate.save_audio = save_float_wav
        try:
            demucs.separate.main(["-n", args.name, "--device", device, *profile,
                                  "--float32", "-o", args.out, *args.tracks])
        finally:
            demucs.separate.save_audio = original_save


if __name__ == "__main__":
    main()
