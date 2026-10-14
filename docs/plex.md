# Importing from Your Plex Library

If you run a Plex Media Server, you can import songs directly from your Plex music library instead of uploading files one by one. Click the **🎞 (Plex)** button in the host sidebar, connect your server, and pick tracks from your collection.

## Setup

1. Open the Plex import panel in the sidebar.
2. Enter your server's base URL (e.g., `http://plex.lan:32400`) and your Plex token, then click **Test connection**.
3. **Token security:** Because a Plex token grants access to your media server, Singhouse never stores it in `karaoke.db` and never returns it to the browser. Instead, it is saved to a `0600` file (`.plex_token`) next to the database. Leaving the token field blank on later saves preserves the existing token; clearing it deletes the file.

## Environment Variables

Operators who prefer configuring Plex via environment variables instead of the UI can set the following:

| Variable | Default | Description |
| --- | --- | --- |
| `KARAOKE_PLEX_URL` | unset | Plex server base URL. Setting either URL or token makes the in-app settings read-only. |
| `KARAOKE_PLEX_TOKEN` | unset | Plex authentication token (overrides `.plex_token`). |
| `PLEX_TOKEN_FILE` | `.plex_token` | Path to the `0600` token file (resolved next to `karaoke.db`). |
| `KARAOKE_PLEX_PATH_MAP` | unset | Rewrites file paths when Singhouse and Plex share storage under different mount points (e.g., `"/media=>/srv/music"`). |
| `KARAOKE_PLEX_LYRICS` | `off` | Opt-in (`1`): allow using lyrics stored on the Plex server as an alignment reference. |

## How Import Works

* **Read-only copy:** Importing a track **copies** the audio into Singhouse's `uploads/` folder and queues the standard separation and alignment pipeline. Your original Plex library files are never moved, modified, or linked.
* **Direct disk read vs. HTTP stream:** If Singhouse can read the Plex media path directly off disk (either natively or via `KARAOKE_PLEX_PATH_MAP`), it copies the file locally; otherwise, it streams the file from the Plex server over HTTP.
* **Lyrics are opt-in:** Tracks that have lyrics on your Plex server display a **♪** badge in the browser list, but Singhouse will not use them unless `KARAOKE_PLEX_LYRICS=1` is enabled—letting you decide whether metadata from your Plex server should be used for alignment.
