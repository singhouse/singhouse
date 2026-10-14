# Windows x64 NVIDIA CUDA Hardware Test Guide

This guide covers testing the experimental Windows x64 CUDA processing candidate (`private-test` channel).

* **Candidate Runtime Lock SHA-256:** `e1cc796d0ce99ab182083427dddd15eaacffd91a750d397df434ef5d842c6d59`
* **Scope:** Experimental Windows GPU candidate (`hardware-test` scope). This build embeds only the CUDA test catalog (no CPU pack), so machines without a supported NVIDIA GPU will be refused before downloading.

## 1. Hardware & System Requirements

* **OS:** Windows 11 x64.
* **GPU Architecture:** NVIDIA Turing (`sm_75`, GTX 16-series / RTX 20-series) or newer (RTX 30, 40, and 50-series; PyTorch 2.10 + CUDA 12.8 compiles `sm_70` through `sm_120`). GTX 10-series (Pascal, `sm_6x`) and older are not supported.
* **Driver:** NVIDIA Driver **570 or newer** (CUDA 12.8 branch).
* **Memory Envelopes (Guarded Admission):**
  * **VRAM:** ~2 GiB free for Demucs, ~4 GiB for RoFormer, and ~6 GiB for Heart (use an **8 GB+ GPU** with other GPU apps closed).
  * **System RAM:** ~8–10 GiB of *currently available* RAM is required per GPU stage (24–32 GB installed system RAM recommended; 16 GB machines may be refused if free RAM is below threshold).

## 2. Pre-Test Recording

In PowerShell, record your hardware specs and verify the installer SHA-256:

```powershell
winver
nvidia-smi
Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
Get-FileHash -Algorithm SHA256 -LiteralPath '<path-to-installer.exe>'
```

## 3. Test Procedure

1. **Install & Launch:** Run the installer, launch Singhouse, and record any SmartScreen prompt (use per-application approval only; do not disable system-wide security).
2. **Setup Wizard:** Select **On this computer (Experimental)** → **Continue**. Review the experimental notice, download sizes, and model terms, then click **Install tools and models**. Record setup duration and let the on-device CUDA probe finish.
3. **Restart:** Click **Restart singhouse** when prompted and confirm local processing reports ready.
4. **Process a Song:** Open **Upload**, select an ordinary stereo audio file (not CDG or pre-made video), keep **Backing vocals** set to **Roformer**, leave LLM options off, and click **Upload**.
5. **Observe Stages:** Confirm Demucs Pass 1, RoFormer Pass 2, and Heart transcription all complete. Record elapsed time per stage, peak GPU/VRAM usage, and any CPU fallback messages.
6. **Verify Playback:** Play the finished song, check stem mixer sliders and word-level lyric highlighting, then quit and relaunch Singhouse to confirm persistence.
7. **Low-VRAM Check (Optional):** With a controlled background GPU workload reducing free VRAM below 6 GiB, submit a second song and verify whether Heart cleanly falls back to CPU (when free RAM permits) or refuses the job cleanly without breaking existing playback.

## 4. Reporting Results

Return the installer SHA-256, `nvidia-smi` output, installed RAM, audio file properties (duration, sample rate, channels), stage timings, and a sanitized log captured per [Support Diagnostics](../../docs/support-diagnostics.md). Never attach song audio, stems, lyrics, or personal paths.
