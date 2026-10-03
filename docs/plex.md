# Import from your Plex library

If you already run a Plex media server, you can import songs from its music
library instead of uploading files one at a time. Open the
host sidebar's 🎞 button, point it at your server, and pick tracks from your
own collection.

**Setting it up.** Enter your server's base URL (e.g.
`http://plex.lan:32400`) and a Plex token, then press *Test connection*. The
token is a credential for your whole library, so it is never stored in the
database and never sent back to the browser: it is written to a `0600` file
(`.plex_token`) next to `karaoke.db`. Leaving the token box blank on a later
save keeps the one you already stored; clearing it deletes the stored token.

An operator who prefers to configure this outside the UI can set
`KARAOKE_PLEX_URL` and `KARAOKE_PLEX_TOKEN` in the environment instead. When
either is set, the environment wins and the in-app fields become read-only.

**What an import does.** Each selected track becomes a normal song: the audio
is COPIED — never moved, never linked — into this install's uploads folder and
then goes through the same separation and sync pipeline an uploaded file does.
Your library file is only ever read. When this install can see the library's
storage directly (the same box, or the same mount), the copy is taken straight
off disk; otherwise the track is streamed from the server. If the two
disagree about paths — a container's `/media` is the host's `/srv/music` —
`KARAOKE_PLEX_PATH_MAP="/media=>/srv/music"` states the correspondence.

**Lyrics are a separate, opt-in question.** Tracks with lyrics on the server
are marked ♪ in the list, but that text is NOT used as an alignment reference
unless you set `KARAOKE_PLEX_LYRICS=1`. The audio is your own file; lyrics on
a media server may have come from a licensed metadata supplier, and whether
they may be reused here is a call for you to make rather than a default.
