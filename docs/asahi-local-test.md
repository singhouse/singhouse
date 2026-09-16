# Asahi Linux local qualification

Run this procedure only with a versioned Linux ARM64 candidate, its release
receipt, and its published SHA-256. If those files are not supplied, record the
test as untested; a historical prototype is not a release candidate.

Before launch, record:

```sh
uname -a
uname -m
getconf PAGESIZE
cat /etc/os-release
free -h
df -h .
printf 'desktop=%s session=%s\n' "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE"
lspci -nn 2>/dev/null || true
```

Record the Apple hardware model, RAM, kernel, distribution release, desktop
and session type, external display resolution/connection, audio output and
connection, and available disk. Hash the exact download and compare it
character for character with the supplied checksum:

```sh
sha256sum /path/to/Singhouse-linux-arm64-download
```

Use a new local user or equivalent clean application-data root. Do not install
system Python or populate developer caches. Disconnect networking before the
first prepared-media test.

1. Install or extract the candidate and launch it normally. Record any loader,
   sandbox, AppImage, page-size, or permissions message.
2. Import user-owned prepared media and confirm playback, visible timed words,
   and audible output. Quit, relaunch offline, and confirm the library and
   settings remain.
3. Attempt a second simultaneous launch and confirm it does not create a second
   library owner. Interrupt one startup, then relaunch and confirm recovery.
4. Run four continuous hours at 1080p. Move only the host to an inactive
   workspace for at least 15 seconds while the projector stays visible. Repeat
   with host minimization. Exercise seek, pause/resume, track transitions,
   projector close/reopen, fullscreen, physical display reconnect, audio output
   selection, and physical audio reconnect.
5. Record every audible dropout, frozen projector frame, crash, or catch-up
   jump with wall-clock time and the action immediately before it.
6. Uninstall application files using the candidate's documented method. Confirm
   whether the library remains. Reinstall the same candidate and verify the
   retained library. Do not delete retained data until it is backed up.

If an AppImage is supplied, test it separately from the archive. AppImage
updates and standalone recovery remain unqualified unless the candidate also
supplies and passes outer-image anchor verification. Do not infer that archive
success proves AppImage recovery.

Return the command output, artifact checksum, application logs, exact result
for every step, and photos or local notes sufficient to establish physical
audio/display connections. Redact private media names and paths before sharing.
