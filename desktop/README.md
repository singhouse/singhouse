# Desktop development prototype

This development shell runs the core interface and its projector in Electron.
It starts a private, temporary native backend from the same source checkout.
It is not an installer. Python and the development dependencies must already be
installed; no model is fetched by this shell.

From the repository root, with Python 3.12 or newer and Node.js 22 installed:

```sh
python3 -m venv .venv-desktop
.venv-desktop/bin/python -m pip install ./lyricsync ./backend
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix desktop ci
KARAOKE_DESKTOP_PYTHON="$PWD/.venv-desktop/bin/python" npm --prefix desktop start
```

Use a fresh environment containing only the core packages. The launcher refuses
backend extension entry points. It imports application source from this checkout,
uses a randomly assigned loopback port, and authenticates a temporary browser
session before opening the interface. It cannot connect to an existing service.

Each launch creates an empty temporary library. Closing the application removes
that library, including files imported into it. Use copies of prepared media you
own. This prototype is unsuitable for keeping a library or operating a real show.

For an explicitly generated test item, append `-- --demo` to the start command.
The test item contains quiet synthesized tones and original timed test words.
This option requires no acquisition, transcription, separation, or model weights.

Use the host's projector button to open the separate display. The native menu
provides projector fullscreen and display placement controls. Closing the host
closes its projector and native backend. While the projector is open, the shell
requests prevention of display sleep; closing it releases that request. Both
windows disable Electron background throttling. Existing playback timing and
projector DOM transport are retained.

The output selector controls the show player's AudioContext and reapplies the
selection when loading another item. Only output devices exposed by the operating
system/browser are listed. No microphone capture is requested to reveal device
labels. Unsupported selection, failures and disconnected outputs appear in the
host. Editor-preview audio uses a separate context and is not routed by this
selector. ASIO and exclusive device access are not provided.

The renderer is sandboxed with context isolation and no Node.js integration.
The native bridge exposes only a desktop marker. Navigation and requests are
restricted to the owned local origin; the projector is the existing same-origin
blank popup. Inline script support remains necessary for its existing lifecycle
watchdog. This shell does not grant arbitrary filesystem or process access to
the renderer.

## Development checks

```sh
npm --prefix desktop test
.venv-desktop/bin/python -m unittest discover -s desktop -p 'test_backend.py'
npm --prefix frontend run test:unit
```

Runtime qualification must cover foreground playback, output switching and device
removal, projector close/reopen, host minimize/restore, workspace switching,
fullscreen, external display removal, and application shutdown. Automated virtual
display checks cannot establish physical speaker routing, audibility, external
monitor behavior, or operating-system workspace behavior.

With the frontend built and `KARAOKE_DESKTOP_PYTHON` set, run
`npm --prefix desktop run test:smoke` on a desktop or under `xvfb-run -a`
on Linux. It uses only the generated demo, exercises available output switching,
records the hidden-host baseline, and checks normal cleanup. An abrupt main-process
kill still removes the backend library through its parent-pipe watchdog; a temporary
Electron cache directory may remain after that abnormal exit.
