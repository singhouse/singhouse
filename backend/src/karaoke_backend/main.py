# SPDX-License-Identifier: AGPL-3.0-only
"""
Karaoke backend — FastAPI entry point
====================================

Entry point for the API server.

Endpoints:
  POST /api/separate                   → Upload audio, start GPU stem separation
  POST /api/import/video               → Import a karaoke video file you have
  GET  /api/jobs/{job_id}              → Poll job status
  GET  /api/features                   → Operator-gated capability flags
  GET  /api/lyrics?artist=&title=      → Fetch lyrics (opt-in third-party lookup)
  GET  /api/songs                      → List processed songs
  GET  /api/songs/{id}                 → Song detail + stem URLs
  PATCH /api/songs/{id}                → Update song metadata
  DELETE /api/songs/{id}               → Delete song
  GET  /api/songs/{id}/stems/{file}    → Download a stem WAV

Run:
  python -m uvicorn karaoke_backend.main:app --reload --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.datastructures import MutableHeaders
from starlette.middleware.sessions import SessionMiddleware

from karaoke_backend.api.identity import config_router
from karaoke_backend.api.catalog import router as catalog_router
from karaoke_backend.api.export import router as export_router
from karaoke_backend.api.features import router as features_router
from karaoke_backend.api.lyrics import router as lyrics_router
from karaoke_backend.api.lyrics_sets import router as lyrics_sets_router
from karaoke_backend.api.plex import router as plex_router
from karaoke_backend.api.providers import extension_routers, provider_routers
from karaoke_backend.api.separate import STEMS_DIR, UPLOADS_DIR, router as separate_router
from karaoke_backend.api.songs import router as songs_router
from karaoke_backend.api.video_import import router as video_import_router
from karaoke_backend.database import clamp_driver_logging, secret_dir
from karaoke_backend.db import bootstrap
from karaoke_backend.jobs.queue import sweep_legacy
from karaoke_backend.jobs.worker import JobWorker

from karaoke_backend import DOTENV_FOUND, DOTENV_LOADED, DOTENV_PATH, branding, plugins


def resolve_auth_mode() -> str:
    """Resolve auth assembly explicitly, then by premium package presence."""
    mode = os.getenv("AUTH_MODE", "").strip()
    if mode:
        if mode not in {"single_host", "multi_user"}:
            raise RuntimeError(
                "AUTH_MODE must be 'single_host' or 'multi_user', "
                f"not {mode!r}"
            )
        return mode
    return (
        "multi_user"
        if importlib.util.find_spec("karaoke_premium") is not None
        else "single_host"
    )

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.getLevelName(os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s | %(levelname)-8s | %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# Must follow basicConfig: the clamp is relative to the root level. Without it
# LOG_LEVEL=DEBUG turns the database driver into a credential log.
clamp_driver_logging()

logger = logging.getLogger(__name__)

# Say which configuration sources are actually in play. The package reads .env
# at import (see karaoke_backend/__init__.py) but cannot log it there: logging
# is not configured yet, and LOG_LEVEL may itself come from the file being
# loaded. Reporting it here is the whole point — what this mechanism replaced
# was a documented .env that nothing read, so an operator could set a value,
# see no error, and get none of the effect. Both branches are logged, which
# makes "why is my .env being ignored?" answerable from the startup log
# instead of by reading source.
#
# Three states, not two. "File exists" and "file set something" are different,
# and a file that exists but sets nothing — empty, or every line commented out —
# is exactly the state an operator debugging their config is usually in.
# Collapsing that into "no .env here" would answer their question with a
# falsehood, which is worse than the silence this replaced.
if DOTENV_LOADED:
    logger.info("Loaded environment defaults from %s", DOTENV_PATH)
elif DOTENV_FOUND:
    logger.warning(
        "%s exists but set no variables — every line is blank or commented "
        "out. Using the process environment only.",
        DOTENV_PATH,
    )
else:
    logger.info(
        "No .env at %s — using the process environment only "
        "(normal for a systemd deployment)",
        DOTENV_PATH,
    )


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan — runs schema bootstrap on startup."""
    logger.info("Starting %s backend…", branding.PRODUCT_NAME)

    # Ensure required directories exist. UPLOADS_DIR/STEMS_DIR come from the
    # env, exactly as the workers resolve them — the cwd-relative literals this
    # replaces created an empty ./uploads next to the process while every
    # reader and writer used the configured path.
    for directory in (UPLOADS_DIR, STEMS_DIR, Path("static")):
        directory.mkdir(parents=True, exist_ok=True)

    # Schema is alembic-managed. ensure_schema is synchronous by design —
    # the same code path serves the CLI and startup — so it runs in a worker
    # thread rather than blocking the event loop. It fails FAST: a database it
    # cannot recognise stops the boot instead of being silently ALTERed.
    await asyncio.to_thread(bootstrap.ensure_schema)

    # Premium's own migration chain — strictly after core's ensure_schema, which
    # its precondition enforces anyway. Same fail-fast contract, recorded in
    # alembic_version_premium so the core chain's public revision graph never
    # references a premium id. Never runs in core assembly; the lazy import is
    # a PREMIUM-EDGE that disappears with the package.
    if AUTH_MODE == "multi_user":
        from karaoke_premium.db.bootstrap import ensure_premium_schema

        await asyncio.to_thread(ensure_premium_schema)

    # Fail the pre-queue rows nothing can ever run again. New-world `queued`
    # rows deliberately SURVIVE this — durability is the point of the queue —
    # and `running` rows are handled by lease expiry, not by boot.
    await sweep_legacy()

    # Discover + register plugins ONCE, at startup (never at import time):
    # entry points -> KARAOKE_PROVIDERS_DIR. A broken plugin is logged and
    # skipped, not fatal.
    plugins.load_all()

    # Provider-owned routers mount HERE, not at import time. The registry they
    # come from is populated by load_all() immediately above, so an import-time
    # sweep collected an empty registry and every provider-owned route 404'd in
    # production. (``extension_routers()`` reads entry-point metadata directly,
    # needs no registry, and stays at import time in the Routers section.)
    if not getattr(app.state, "provider_routes_mounted", False):
        pre = len(app.router.routes)
        for provider_router in provider_routers():
            # Same contract as extension_routers(): a broken plugin is logged
            # and skipped, never fatal. A provider that hands back something
            # that is not an APIRouter, or one whose routes blow up on
            # inclusion, must not take the whole boot down with it.
            if not isinstance(provider_router, APIRouter):
                logger.warning(
                    "Provider router %r is not an APIRouter — skipping",
                    provider_router,
                )
                continue
            try:
                app.include_router(provider_router)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Provider router %r failed to mount — skipping",
                    provider_router,
                )
                continue
        # Move what we just appended to the anchor recorded in the Routers
        # section. The precedence is load-bearing and is exactly what the old
        # import-time loop produced: provider routes sit AFTER FastAPI's own
        # defaults and the premium install's auth/join/rotation mounts, and
        # BEFORE the extension routers, the core routers, and the
        # SPAStaticFiles mount at "/" — so a provider's literal path
        # (…/lyrics/<name>.xml) beats core's /{lid:int} convertor routes.
        # include_router appends, so the appended block moves as a unit, order
        # among its members preserved. Taking the tail slice (rather than
        # tracking counts) means a skipped or half-included router cannot leave
        # stray routes stranded at the end of the table.
        mounted = app.router.routes[pre:]
        del app.router.routes[pre:]
        anchor = app.state.provider_route_anchor
        app.router.routes[anchor:anchor] = mounted
        # Idempotent across repeated lifespan entries: the app is a module
        # global, and a second entry would otherwise mount everything twice.
        # Set even when individual routers were skipped — they were logged, and
        # a retry-on-next-entry loop is not wanted.
        app.state.provider_routes_mounted = True

    # STRICTLY after plugins.load_all(): a catalog-import job resolves its
    # provider through the registry that discovery populates, and the worker
    # can claim one on its very first pass.
    job_worker = JobWorker()
    await job_worker.start()
    app.state.job_worker = job_worker

    # Lifespan startup hooks. Anything an installed package must do inside the
    # application lifespan was registered as a hook at install time; core
    # neither knows nor names what those hooks do. Awaited in registration
    # order, after the worker is up. Deliberately NOT exception-isolated: a
    # hook that cannot come up is a boot that should fail visibly, not a
    # half-composed app serving traffic.
    for hook in app.state.lifespan_startup_hooks:
        await hook(app)

    logger.info("Ready.")
    yield
    logger.info("Shutting down.")
    await job_worker.stop()
    # Teardown runs AFTER the worker stops: a hook may hold resources a running
    # job still needs. The ordering is pinned by tests/test_ops_hardening.py.
    # REVERSE registration order (teardown unwinds what setup built), and each
    # hook is isolated: one raising teardown must not strand the rest with
    # subprocesses or tasks still alive.
    for hook in reversed(app.state.lifespan_shutdown_hooks):
        try:
            await hook(app)
        except Exception:  # noqa: BLE001
            logger.exception("Lifespan shutdown hook %r raised — continuing", hook)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title=branding.API_TITLE,
    description=(
        "Backend API for the unified karaoke toolkit.\n\n"
        "Provides GPU-accelerated stem separation via Modal, a song library, "
        "and an opt-in third-party lyrics lookup (off by default)."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# Lifespan composition seam. A package handed this app at composition time can
# register async callables (each taking the app) that core awaits inside its
# lifespan — see above. Reachable only by something holding the app object, so
# it is narrower than the entry-point mechanisms (extension_routers()) any
# installed distribution can use. Initialized UNCONDITIONALLY: the seam is a
# core fact, and an assembly with nothing composed onto it simply iterates two
# empty lists.
app.state.lifespan_startup_hooks = []
app.state.lifespan_shutdown_hooks = []

AUTH_MODE = resolve_auth_mode()
# Core-only routers: a premium build brings its own queue AND its
# own venue-scoped history (both mounted by its install below), so exactly one
# of each mounts. A core single-host build gets BasicManualQueue and the flat
# play history. They are collected here and mounted in the Routers section below
# so mount order stays stable.
_core_only_routers: list = []
if AUTH_MODE == "multi_user":
    # PREMIUM-EDGE: this lazy import — the single premium symbol core names —
    # disappears with the premium package. Everything the package adds
    # (identity backend, its routes, its queue, its lifespan hooks) is composed
    # behind this one call, so the cut stays a file-level operation.
    from karaoke_premium.install import install as install_premium

    install_premium(app)
else:
    # Core single-host gate: a constant Host identity + an optional shared
    # password. Explicit install (never a silent no-auth boot).
    from karaoke_backend.api.gate import install as install_gate
    from karaoke_backend.api.history import router as history_router
    from karaoke_backend.api.queue import router as queue_router

    install_gate(app)
    _core_only_routers = [queue_router, history_router]

# ---------------------------------------------------------------------------
# Sessions — signed httponly cookie via Starlette SessionMiddleware. Must be
# added BEFORE CORS so the session is set up before CORS wraps the response.
# The secret persists across restarts by default (see _load_session_secret),
# so the gate/projector stays unlocked over a service restart instead of
# re-locking every session — the self-hoster papercut. The cookie name is a
# neutral default (SESSION_COOKIE) BY DESIGN and stays that way: it is a
# load-bearing identifier, not brand surface. Product-brand strings live in
# karaoke_backend.branding (the brand module) — the cookie never derives from them.
# ---------------------------------------------------------------------------


def _session_secret_dir() -> Path:
    """Directory that holds ``.session_secret``.

    The sqlite DB's own directory (so it survives a read-only/rebuilt code
    dir in docker), else the current working directory for non-sqlite URLs.

    The rule itself now lives in ``database.secret_dir`` — the Plex token file
    persists next to the database by the same reasoning, and a second copy of
    this five-line rule is how the two would come to disagree about where an
    operator's secrets live. Kept as a named alias because this module's
    docstrings and the operator-facing log line below both speak of it.
    """
    return secret_dir()


def _load_session_secret() -> str:
    """Resolve the session secret, persisting one when none is configured.

    Priority: ``SESSION_SECRET`` env → ``SESSION_SECRET_FILE`` (default: the
    sqlite DB directory + ``/.session_secret``) read-or-created with mode
    0600 → an ephemeral key with a warning, only when the file is unwritable.
    """
    env_secret = os.getenv("SESSION_SECRET")
    if env_secret:
        return env_secret

    secret_file = os.getenv("SESSION_SECRET_FILE")
    path = (
        Path(secret_file)
        if secret_file
        else _session_secret_dir() / ".session_secret"
    )

    # Read an existing secret (tightening perms if a prior file was lax).
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            try:
                path.chmod(0o600)
            except OSError:
                pass
            return existing
    except OSError:
        pass  # missing/unreadable — fall through to create one

    secret = secrets.token_urlsafe(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Create atomically at mode 0600 — O_EXCL closes the create-then-chmod
        # window in which the signing secret would be world/group-readable.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, secret.encode("utf-8"))
        finally:
            os.close(fd)
        logger.info("SESSION_SECRET not set — persisted a new key at %s", path)
        return secret
    except FileExistsError:
        # A concurrent boot created it between our read and create — use theirs.
        try:
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        except OSError:
            pass
        return secret
    except OSError as exc:
        logger.warning(
            "SESSION_SECRET not set and %s is unwritable (%s) — using an "
            "ephemeral key; all sessions reset on restart.",
            path,
            exc,
        )
        return secret


_session_secret = _load_session_secret()

app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret,
    session_cookie=os.getenv("SESSION_COOKIE", "karaoke_session"),
    same_site="lax",
    https_only=os.getenv("SESSION_HTTPS_ONLY", "false").lower() == "true",
    max_age=int(os.getenv("SESSION_MAX_AGE", str(60 * 60 * 24 * 14))),  # 14 days
)

# ---------------------------------------------------------------------------
# CORS — allow frontend dev server (and any origin in dev mode). Added after
# the session middleware so it wraps it. Only the security-header middleware
# below sits further out, and that one merely stamps a response header.
# ---------------------------------------------------------------------------

CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:3000,http://localhost:5173,http://localhost:8080",
).split(",")
CORS_ORIGINS = [o.strip() for o in CORS_ORIGINS if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------


class SecurityHeaders:
    """Suppress the Referer header on every response.

    The guest surface is reached by opening a URL, and any identifier that URL
    carries is disclosed to every origin the page later talks to unless
    referrer is suppressed. Nothing here reads Referer, so the strictest value
    costs nothing.

    Written as pure ASGI rather than ``@app.middleware("http")``, which
    installs ``BaseHTTPMiddleware`` and routes every response body through an
    extra task and memory stream. This service streams stem downloads and
    serves the whole SPA through StaticFiles; a single static header does not
    justify making all of that pay for a wrapper.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message) -> None:
            if message["type"] == "http.response.start":
                # ASGI permits a start message with no headers key; every
                # Starlette response sets one, but a raw ASGI app mounted by a
                # provider or extension router need not.
                message.setdefault("headers", [])
                # setdefault: a route needing a different policy wins.
                MutableHeaders(scope=message).setdefault(
                    "referrer-policy", "no-referrer"
                )
            await send(message)

        await self.app(scope, receive, send_with_headers)


app.add_middleware(SecurityHeaders)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

# Extension routers mount BEFORE core routes so literal paths beat the core
# catch-all /{lid:int} convertor routes. Provider-owned routers need the same
# precedence but cannot be collected here — their registry is only populated by
# plugins.load_all() at startup — so the lifespan splices them in at the anchor
# recorded here: exactly the slot the import-time provider_routers() loop used
# to occupy, i.e. after FastAPI's own defaults and the premium install's mounts,
# immediately ahead of the extension routers and everything below.
app.state.provider_route_anchor = len(app.router.routes)

for _r in extension_routers():
    app.include_router(_r)

app.include_router(separate_router)      # POST /api/separate + GET /api/jobs/{id}
app.include_router(video_import_router)  # POST /api/import/video
app.include_router(features_router)      # GET  /api/features
# Core, not a catalog provider: it reads a media server the operator
# already runs, so it mounts at import time like every other core router.
app.include_router(plex_router)          # /api/plex settings + browse + import
app.include_router(export_router)        # /api/export settings + GET /api/export/songs/{id}
app.include_router(lyrics_router)        # GET  /api/lyrics
app.include_router(lyrics_sets_router)   # /api/songs/{id}/lyrics/* CRUD + transcribe
app.include_router(songs_router)         # GET/PATCH/DELETE /api/songs[/{id}]
for _core_router in _core_only_routers:  # core-only builds: /api/queue + /api/history
    app.include_router(_core_router)
app.include_router(catalog_router)       # /api/catalog providers + search + import
app.include_router(config_router)        # GET /api/auth/config (always mounted)

# ---------------------------------------------------------------------------
# Health / API info
# ---------------------------------------------------------------------------


@app.get("/health", tags=["meta"], summary="Health check")
async def health() -> JSONResponse:
    """Returns 200 OK if the server is running."""
    return JSONResponse({"status": "ok", "version": app.version})


@app.get("/api", tags=["meta"], summary="API info")
async def api_info() -> JSONResponse:
    """Returns basic info about the API."""
    return JSONResponse(
        {
            "name": app.title,
            "version": app.version,
            "endpoints": {
                "separate": "POST /api/separate",
                "video_import": "POST /api/import/video",
                "job_status": "GET /api/jobs/{job_id}",
                "features": "GET /api/features",
                "lyrics": "GET /api/lyrics?artist=&title=",
                "songs": "GET /api/songs",
                "song_detail": "GET /api/songs/{id}",
                "stem_download": "GET /api/songs/{id}/stems/{filename}",
            },
        }
    )


# ---------------------------------------------------------------------------
# Static files (frontend build output) — mounted LAST so explicit routes win.
# Falls back to index.html for unknown non-/api paths so Vue Router history
# routes (/screen, and any page an installed extension's UI adds) resolve on
# hard reload.
# ---------------------------------------------------------------------------


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return self._cached(await super().get_response(path, scope), path)
        except StarletteHTTPException as ex:
            if ex.status_code == 404 and not scope.get("path", "").startswith("/api/"):
                return self._cached(
                    await super().get_response("index.html", scope), "index.html"
                )
            raise

    @staticmethod
    def _cached(response, served):
        """Cache by name shape: assets/ is content-hashed, nothing else is.

        Deploys prune files the current build no longer contains, so anything
        under a stable name (index.html, the worklet, favicon) must
        revalidate — a heuristically cached index.html would point at hashed
        assets that are gone. ETag makes that a 304, and the 304 must carry
        the header too (RFC 7232: it replaces the stored headers).
        """
        if response.status_code < 300 or response.status_code == 304:
            response.headers["Cache-Control"] = (
                "public, max-age=31536000, immutable"
                if served.startswith("assets/")
                else "no-cache"
            )
        return response


_static_dir = Path("static")
if _static_dir.exists() and any(_static_dir.iterdir()):
    app.mount("/", SPAStaticFiles(directory=str(_static_dir), html=True), name="static")
    logger.info("Serving static files from %s", _static_dir.resolve())
