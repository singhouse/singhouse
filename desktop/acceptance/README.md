# Windows acceptance build

This is an unsigned private test build, not a qualified public release. Windows 11 x64 is the documented target. CUDA additionally requires a supported NVIDIA GPU and driver; the GPU check runs on your computer during setup.

1. Extract the **entire** artifact to a folder on a local drive. Keep its files together.
2. Double-click **Start-CPU.cmd** or **Start-CUDA.cmd**, whichever is included in this download. Use this launcher each time, rather than opening the executable inside `app`.
3. The first run shows the download size, upstream model links and consent prompt. Type `YES` to install. Keep the setup window open while it downloads and verifies processing tools and models. No separate Python, Node or CUDA toolkit installation is needed.
4. The app opens after setup and a real processing check pass. Import your own song and try a generation. Later launches reuse that setup and open the app directly.

Windows may warn because this test build is unsigned. Verify you obtained the artifact from the expected project workflow before running it.

CPU and CUDA use separate test libraries under `%LOCALAPPDATA%\sh-test`. They do not change an existing installed library. Leave substantial disk space for both model caches, processing tools, your songs and generated stems. The launcher shows the exact model download size and free disk space before consent. Keep these profile folders in place after setup.

If setup fails, the window stays open with the error. Keep `setup.log` from the profile folder printed by the launcher, plus the artifact's build evidence and checksums, when reporting the failure. To explicitly recheck and repair using the bundled files, close singhouse, open a terminal in the extracted folder, and run `Start-CPU.cmd -Repair` or `Start-CUDA.cmd -Repair`. This keeps the test library and reruns full tool/model verification with download consent. A setup check passing does not establish generation quality, resource limits, offline recovery, or physical audio/projector qualification.

These builds exercise the current HEART processing path. They do not yet include Qwen3-ASR or the combined aligner model delivery.
