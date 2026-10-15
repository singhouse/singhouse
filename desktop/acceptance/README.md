# Windows Portable Acceptance Build

This archive is an unsigned private test build targeting **Windows 11 x64**. It uses isolated test profiles under `%LOCALAPPDATA%\sh-test` and will not modify an existing Singhouse installation.

## Running the Test Build

1. **Extract All:** Extract the entire `.zip` archive to a folder on a local drive, keeping all files together.
2. **Launch via Script:** Double-click **`Start-CPU.cmd`** or **`Start-CUDA.cmd`** (do not launch the inner `.exe` inside `app/` directly).
3. **Consent & Setup:** On first run, the launcher displays the free disk space check, model download sizes, and upstream links. Type **`YES`** to download and verify the processing runtime and models (no system Python, Node, or CUDA toolkit install is required).
4. **Test Import & Generation:** Once setup and the functional self-test pass, the Singhouse UI opens. Import a song from your library and verify stem separation, word timing, and playback. Subsequent launches via `Start-CPU.cmd` / `Start-CUDA.cmd` reuse the verified environment and open the app immediately.

## Troubleshooting & Repair

* **Logs:** If setup fails, the console window stays open. Save `setup.log` from the `%LOCALAPPDATA%\sh-test` profile path printed in the console along with the build checksums.
* **Repairing in Place:** To force a full re-verification and repair of the test environment without losing your test library, close Singhouse and run:

  ```cmd
  Start-CPU.cmd -Repair
  :: or
  Start-CUDA.cmd -Repair
  ```
