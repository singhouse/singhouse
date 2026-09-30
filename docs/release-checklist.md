# Desktop release checklist

- [ ] Candidate version and exact clean source revision recorded.
- [ ] Every installer, portable payload, runtime pack, receipt, and checksum is
  immutable and tied to the same candidate inventory.
- [ ] Two clean builds compared; any platform-container nondeterminism is
  explained without weakening modeled payload verification.
- [ ] Actual installer contents include source/license inventory, native
  notices, and all built font licenses/notices.
- [ ] Windows 11 25H2 x86-64, macOS 14+ Apple silicon, Ubuntu 24.04 x86-64,
  Ubuntu 24.04 ARM64, and the actual Asahi show system have explicit results.
- [ ] Downloaded-installer behavior and exact per-artifact signing status are
  recorded beside each download and in install instructions; no global
  security-disable instruction appears.
- [ ] Prepared-media clean install, offline restart, update, interrupted update,
  recovery, uninstall retention, and reinstall have passed on every target.
- [ ] Every advertised processing route passes the fixed 20-song quality,
  timing, stem, memory, speed, interruption, and offline checks.
- [ ] Linux AppImage outer-image anchor creation, rotation, launch, and
  standalone recovery pass substitution tests, or update/recovery remains
  explicitly fail-closed and unavailable for that surface.
- [ ] Four-hour 1080p physical audio/projector show passes on every target,
  including the actual ARM64 show machine.
- [ ] Public files contain no internal planning names, private service
  addresses, credentials, private corpus content, or temporary remote-worker
  setup.
- [ ] Support diagnostics are useful and reviewed for secret/media leakage.
- [ ] Release notes list exact capabilities, failures, and untested rows.
- [ ] Repository visibility, publication, signing enrollment, paid resources,
  hosted contributor intake, and production deployment each have their own
  recorded authorization where applicable.
