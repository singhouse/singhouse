# Asahi Linux (ARM64) Local Qualification Runbook

Run this procedure on physical Apple Silicon hardware running Asahi Linux using a versioned `linux-arm64` release candidate, its `.shapp.receipt.json`, and its published SHA-256 checksum.

## 1. Pre-Test System Inventory

Use a clean user account (or empty application-data root) without system Python developer caches. Record hardware, kernel, page size, and display/audio configuration, and verify the artifact checksum:

```sh
uname -a
uname -m
getconf PAGESIZE
cat /etc/os-release
free -h
df -h .
printf 'desktop=%s session=%s\n' "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE"
lspci -nn 2>/dev/null || true

sha256sum /path/to/Singhouse-linux-arm64-download
```

(If both an AppImage and a `.tar.gz` archive are supplied, test each artifact separately.)

## 2. Verification Steps

Disconnect networking before starting step 1 to verify offline prepared-media operation:

1. **Launch & Sandbox Check:** Extract or run the candidate normally. Record any dynamic loader, 16K page-size, AppImage/FUSE, or Electron sandbox messages.
2. **Offline Prepared Playback:** Import user-owned prepared karaoke media. Confirm audible output, synchronized word highlighting, and stem controls. Quit, relaunch offline, and verify library and settings persistence.
3. **Single-Instance Lock & Recovery:** Attempt to launch a second instance simultaneously and confirm `owner.lock` refuses it cleanly. Interrupt a startup, relaunch, and confirm normal recovery.
4. **4-Hour 1080p Physical Show Test:** Run continuous 1080p playback with an external projector/display connected for **4 hours**:
   * Move the host window to an inactive workspace for ≥ 15s while keeping the projector visible.
   * Minimize and restore the host window.
   * Exercise seek, pause/resume, track transitions, projector close/reopen, fullscreen toggle, physical display unplug/replug, audio output selector changes, and physical audio unplug/replug.
   * Log the wall-clock time and preceding action for any audio dropout, frame freeze, or catch-up jump.
5. **Uninstall & Reinstall Retention:** Remove the application binaries using the documented method, verify the user library remains intact in application data, reinstall the candidate, and confirm the existing library loads cleanly.

## 3. Evidence Package

Attach the command outputs from Step 1, artifact SHA-256, captured terminal logs (redacting personal paths and media titles), step-by-step pass/fail results, and notes/photos confirming physical display and audio connections.
