# Windows NVIDIA hardware test

This is an experimental Windows x64 CUDA candidate, not a qualified release.
Windows GPU inference is awaiting testing. An 8 GB GPU remains a target, not a
qualified minimum; a successful run on a larger GPU does not qualify 8 GB cards.
Use a test installation and audio from your own library that you may process.

The candidate runtime lock is:
`e1cc796d0ce99ab182083427dddd15eaacffd91a750d397df434ef5d842c6d59`.
Use the installer and checksum supplied with this candidate; do not substitute
an older installer or runtime pack.

## Before installation

- Use Windows x64 with an NVIDIA GPU and a compatible NVIDIA system driver.
  The processing pack supplies Python and CUDA user-space libraries. You do not
  need to install Python or the CUDA development toolkit manually.
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

1. Install and launch Singhouse. Choose **On this computer**, then **Continue**.
   To reopen setup later, use **Set up song processing** in the library.
2. Read the experimental hardware-test warning, download sizes, storage needs,
   sources, and terms. Choose **Install tools and models** only after reviewing
   them. Record setup duration and any error; let the device checks finish.
3. Choose **Restart Singhouse** when prompted. A failed CUDA device check must
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
