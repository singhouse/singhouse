# singhouse development

Read `CONTRIBUTING.md` before changing contribution or licensing behavior.
External contributor intake is currently inactive; public source availability
is not an invitation to submit signatures or contributions before it opens.
Use `SECURITY.md` for security reports.

## Find the relevant code

- `backend/src/karaoke_backend/`: FastAPI API, durable jobs, storage, and workers.
- `frontend/src/`: Vue application and canvas stage renderer.
- `lyricsync/src/lyricsync/`: lyric alignment and transcription library.
- `desktop/`: Electron shell, managed runtimes, packaging, and qualification.
- `PROJECT_DOCS.md`: architecture and test reference. `desktop/README.md` and
  `docs/install-desktop.md`: desktop build and installation details.

Keep changes focused and match surrounding code. Separate optional extensions
through existing seams; core must not import premium. Brand text uses the
existing branding modules; do not rename package identifiers or environment
variables as a cosmetic change.

## Local checks

Use an isolated development environment. Python packages require Python 3.12+;
frontend package metadata declares its supported Node version. From the repo
root, install the local alignment library before the backend:

```sh
python -m pip install -e './lyricsync[whisper,metaphone,levenshtein]'
python -m pip install -e './backend[dev]'
```

Run checks for the affected area:

| Directory | Commands |
|---|---|
| `backend/` | `python -m pytest -q` |
| `lyricsync/` | `python -m pytest -q` |
| `frontend/` | `npm ci`, then `npm test` and `npm run build`; `npm run lint` for linting |
| `desktop/` | `npm ci`, then `npm test`; see desktop docs for Python fixtures and native tests |
| Repository root | `bash tools/check_core_neutrality.sh .` and `bash tools/check_spdx_headers.sh .` |

Use focused tests while iterating and relevant broader checks before finishing.
Report actual results and pre-existing failures. Fixture tests do not establish
native installer, hardware, or audio-quality qualification. Follow desktop
instructions before assembling installers or downloading processing models.
Do not run deployment scripts against an existing installation as a test.

## Product boundaries

singhouse works with the user's own library. Do not add music acquisition,
a centralized catalog, bundled lyrics, or services that host user songs,
stems, or synced lyrics. Lyrics lookup remains opt-in and default-off; local
processing remains the default. Optional cloud processing uses the user's
own configured account. Never introduce an unrequested external data flow.

Keep credentials, personal data, machine-specific configuration, and
copyrighted lyric fixtures out of commits. Preserve license notices and
review public claims against implemented behavior and available releases.

## Public output rule

Do not add assistant attribution, generated-by signatures, agent/model/tool
branding, or agent co-author trailers to public source, documentation, commits,
issues, or pull requests. Write ordinary project-focused descriptions. Check
the final diff, commit message, issue body, and PR title/body before publishing.
Preserve legitimate third-party license notices and human authorship.
