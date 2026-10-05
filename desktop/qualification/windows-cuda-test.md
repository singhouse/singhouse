# Windows NVIDIA hardware test

This is an experimental Windows x64 CUDA candidate, not a qualified release.
Windows GPU inference is awaiting testing. An 8 GB GPU remains a target, not a
qualified minimum; a successful run on a larger GPU does not qualify 8 GB cards.
Use a test installation and audio from your own library that you may process.

The candidate runtime lock is:
`e1cc796d0ce99ab182083427dddd15eaacffd91a750d397df434ef5d842c6d59`.
Use the installer and checksum supplied with this candidate; do not substitute
an older installer or runtime pack.

This test build's Windows processing catalog is this CUDA hardware-test pack.
It replaces the earlier Windows CPU smoke-test catalog: the build offers no CPU
pack, so a Windows computer without a supported NVIDIA GPU cannot set up local
processing with it. Setup reports that an NVIDIA GPU is required, before any
download, when it detects none.

## Before installation

- Use Windows x64 with an NVIDIA GPU and a compatible NVIDIA system driver.
  The processing pack supplies Python and CUDA user-space libraries. You do not
  need to install Python or the CUDA development toolkit manually.
- GPU: the pack's PyTorch build (2.10.0 with CUDA 12.8) compiles kernels for
  `sm_70`, `sm_75`, `sm_80`, `sm_86`, `sm_90`, `sm_100` and `sm_120`, so Volta
  (compute capability 7.0) and newer architectures are compiled in. This list
  was read from the Linux build of the same PyTorch release; the setup device
  check on Windows remains authoritative. No GeForce card uses Volta, so for
  consumer GeForce cards that means Turing (7.5): GTX 16-series or RTX 20-series
  and newer, including RTX 30, 40 and 50-series. GTX 10-series (Pascal, 6.x)
  and older cards are not supported and will fail the setup device check.
- Driver: NVIDIA driver 570 or newer (the CUDA 12.8 driver branch). Update an
  older driver before installing; `nvidia-smi` shows the installed version.
- Memory: processing admission checks currently available memory before each
  stage, using estimates carried over from Linux measurements. Demucs and HEART
  on the GPU each need about 10 GiB of available system RAM (Roformer about
  8 GiB), so in practice expect to need 24 to 32 GB of installed RAM with other
  applications closed; a 16 GB computer will probably be refused. Free VRAM
  needed at each stage is about 2 GiB (Demucs), 4 GiB (Roformer) and 6 GiB
  (HEART), so use a GPU with at least 8 GB and close other GPU workloads.
  CPU fallback needs more system RAM (about 10, 12 and 16 GiB respectively).
  These are untested estimates for Windows, not qualified minimums.
- Record the Windows version (`winver`), GPU model, driver, dedicated VRAM,
  and installed system RAM. In PowerShell, run:

  ```powershell
  nvidia-smi
  Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
  Get-FileHash -Algorithm SHA256 -LiteralPath '<downloaded installer path>'
  ```

- Compare the installer hash with the supplied checksum. Record any signing or
  SmartScreen warning; do not disable system-wide security controls.
- Keep internet access available for the consented runtime/model downloads.
  Close unrelated GPU workloads for the first run.

## Install and process one song

1. Install and launch singhouse. Choose **On this computer** (labelled
   **Experimental**), then **Continue**.
   To reopen setup later, use **Set up song processing** in the library.
2. Read the experimental hardware-test warning, download sizes, storage needs,
   sources, and terms. Choose **Install tools and models** only after reviewing
   them. Record setup duration and any error; let the device checks finish.
3. Choose **Restart singhouse** when prompted. A failed CUDA device check must
   leave processing unavailable; do not bypass the check or alter runtime files.
4. Open **Upload**, select one ordinary audio file (not prepared karaoke video
   or CDG), and check its artist/title. Keep **Backing vocals** set to
   **Roformer**. Leave optional LLM controls off and submit the file with its
   **Upload** button. Record audio duration, sample rate, and channel count.
5. Observe processing through separation and transcription. Confirm from the
   job output/logs that Demucs separation, Roformer backing-vocal separation,
   and HEART transcription all complete. Record each stage's elapsed time
   when available, total time, errors, and GPU utilization/free VRAM.
6. Play the completed song. Check that stems play, the instrumental is audible,
   and generated words appear with timing. Reopen the app and confirm the song
   still plays. A completed job alone does not prove lyric or audio quality.

## Memory handling and report

After the ordinary run succeeds, observe a low-free-VRAM case only on a test
machine with a controlled workload. Do not deliberately exhaust system RAM.
CPU fallback is allowed only when its separate RAM requirement is met; record
the fallback message, slower timing, and output. If neither route fits, expect
a useful refusal before processing, with existing songs still playable.
The initial CUDA setup probe must succeed before this pack can activate;
a machine without working CUDA needs a CPU pack instead.

Send the installer hash, runtime lock, hardware/driver details, audio properties,
setup and processing results/timings, exact errors, and whether playback survived.
Include a sanitized reproduction log following [Support diagnostics](../../docs/support-diagnostics.md).
Do not attach song audio, stems, lyrics, credentials, or unreviewed personal paths.
Report unsuccessful stages explicitly; do not label this test release-qualified.
