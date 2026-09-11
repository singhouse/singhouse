# SPDX-License-Identifier: AGPL-3.0-only
"""Provider-owned routers mount from the LIFESPAN, not at import time.

``provider_routers()`` reads the catalog-provider registry, and that registry
is populated by ``plugins.load_all()`` — which the app lifespan calls at
startup, deliberately never at import time. Collecting the routers in the
module-level Routers section therefore swept an empty registry, and every
provider-owned route 404'd in production. It was invisible to the suites
because a test registers its provider *before* it touches the app, so the
import-time sweep happened to see it.

What is pinned here:

1. A provider registered after import is reachable once the lifespan has run.
2. Its routes land at the ANCHOR the Routers section recorded — the slot the
   old import-time loop occupied, i.e. ahead of every extension router, every
   core router, and the ``SPAStaticFiles`` mount at ``/`` (a provider's
   literal path must beat core's ``/{lid:int}`` convertor routes, and
   everything must beat the SPA catch-all), while leaving FastAPI's own
   defaults and anything a composition install mounted first where they were.
   Front-inserting at index 0 instead would have silently promoted providers
   over those.
3. A provider that misbehaves is skipped, not fatal, and leaves no debris in
   the route table.
4. Entering the lifespan twice (the app is a module global; a suite can do
   this) does not mount anything twice.

``extension_routers()`` is NOT part of this: it reads entry-point metadata
directly, needs no registry, and correctly stays at import time.

(Named for the lifespan, not the provider. That began as a workaround: a
``.gitignore`` rule excluded ``backend/tests/test_provider_*.py``, so a file
with that shape would silently never have been committed. **That rule is
gone** — it also shadowed the tracked ``test_provider_registry.py``, and
local-only provider tests are now scoped to the ``backend/tests/local/``
directory, which cannot collide with a tracked filename. So the name no longer
dodges anything; it is simply accurate.)
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from fastapi import APIRouter
from httpx import ASGITransport, AsyncClient
from starlette.routing import Mount

import karaoke_backend.api.providers as registry
from karaoke_backend import main as main_module

PROBE_PATH = "/api/mount-probe"


class _RoutedProvider:
    """Minimal v2-shaped provider that owns one real route."""

    name = "mount-probe"
    label = "Mount Probe"
    icon = ""
    available = True

    def __init__(self) -> None:
        router = APIRouter()

        @router.get(PROBE_PATH)
        async def _probe() -> dict:
            return {"mounted": True}

        self._router = router

    def filename_for(self, external_id: str) -> str:
        return f"{self.name}-{external_id}.bin"

    def routers(self) -> list[APIRouter]:
        return [self._router]


class _ExplodingRouter(APIRouter):
    """An APIRouter that raises the moment ``include_router`` walks it.

    A real one of these is a provider whose route table is built lazily from
    something that can fail (a config file, a network call at first access).
    """

    @property
    def routes(self):  # type: ignore[override]
        raise RuntimeError("provider router exploded")

    @routes.setter
    def routes(self, value) -> None:
        # APIRouter.__init__ assigns here; swallow it so the object can exist.
        pass


class _BadProvider:
    """Hands back one non-router object and one router that explodes."""

    name = "bad-mount-probe"
    label = "Bad Mount Probe"
    icon = ""
    available = True

    def filename_for(self, external_id: str) -> str:
        return f"{self.name}-{external_id}.bin"

    def routers(self) -> list:
        return ["not-a-router", _ExplodingRouter()]


@pytest.fixture
def routed_provider_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The module-global app with a routed provider registered post-import.

    Restores the route table and the registry afterwards: both are process
    globals, and a leaked provider route would silently change what every
    later test's client sees.
    """
    app = main_module.app
    routes_before = list(app.router.routes)
    registry_before = dict(registry._REGISTRY)

    class FakeWorker:
        async def start(self) -> None:
            return None

        async def stop(self) -> None:
            return None

    async def fake_sweep() -> int:
        return 0

    # The lifespan mkdir's uploads/stems/static relative to the cwd; chdir so
    # nothing is written into the source tree (same reason as the boot-order
    # test in test_ops_hardening.py).
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main_module.bootstrap, "ensure_schema", lambda: None)
    monkeypatch.setattr(main_module, "sweep_legacy", fake_sweep)
    monkeypatch.setattr(main_module, "JobWorker", FakeWorker)
    # Whether some earlier test already ran a lifespan on this app is not this
    # test's business — start from "not yet mounted" either way.
    monkeypatch.setattr(app.state, "provider_routes_mounted", False, raising=False)

    registry.register(_RoutedProvider())
    try:
        yield app
    finally:
        registry._REGISTRY.clear()
        registry._REGISTRY.update(registry_before)
        app.router.routes[:] = routes_before


@pytest.mark.asyncio
async def test_provider_route_answers_after_the_lifespan_runs(routed_provider_app):
    app = routed_provider_app
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        # Import time is over and the provider is registered, yet nothing has
        # mounted it: mounting is the lifespan's job.
        assert (await client.get(PROBE_PATH)).status_code == 404

        async with main_module.lifespan(app):
            resp = await client.get(PROBE_PATH)
            assert resp.status_code == 200, resp.text
            assert resp.json() == {"mounted": True}

            # Spliced at the anchor, not at index 0: precedence over every
            # core route (and the SPA mount) is the reason provider routers
            # were mounted where they were in the old import-time loop, but
            # nothing that already sat ahead of that slot gets demoted.
            paths = [getattr(r, "path", "") for r in app.router.routes]
            probe_index = paths.index(PROBE_PATH)
            assert probe_index == app.state.provider_route_anchor
            # Ahead of core's own routers.
            assert probe_index < paths.index("/api/songs")
            # Ahead of every mount, which is where the SPA catch-all at "/"
            # lands. Conditional rather than asserted present: main.py only
            # mounts it when ./static holds a build, and this suite runs
            # against a tree that need not have one.
            assert all(
                probe_index < i
                for i, r in enumerate(app.router.routes)
                if isinstance(r, Mount)
            )
            # Behind FastAPI's own defaults (and behind anything a
            # composition install mounted at import time), which the old
            # index-0 splice would have jumped.
            assert probe_index > paths.index("/openapi.json")


@pytest.mark.asyncio
async def test_a_broken_provider_router_is_logged_and_skipped_not_fatal(
    routed_provider_app,
    caplog,
):
    """One misbehaving provider must not take the boot down with it.

    Same contract ``extension_routers()`` already honours ("a broken plugin is
    logged and skipped, not fatal") — and the skip must be clean: a router
    that raised part-way through inclusion cannot be allowed to leave orphan
    routes stranded at the tail of the table, which is why the block takes the
    whole appended tail as a slice rather than counting what it added.
    """
    app = routed_provider_app
    registry.register(_BadProvider())
    routes_before = len(app.router.routes)

    with caplog.at_level(logging.WARNING, logger="karaoke_backend.main"):
        async with main_module.lifespan(app):
            paths = [getattr(r, "path", "") for r in app.router.routes]

            # The good provider still mounted, exactly once...
            assert paths.count(PROBE_PATH) == 1
            # ...and the two bad routers contributed nothing at all.
            assert len(app.router.routes) == routes_before + 1

    assert "not an APIRouter" in caplog.text
    assert "failed to mount" in caplog.text


@pytest.mark.asyncio
async def test_a_second_lifespan_entry_does_not_duplicate_provider_routes(
    routed_provider_app,
):
    app = routed_provider_app

    async with main_module.lifespan(app):
        paths_after_first = [getattr(r, "path", "") for r in app.router.routes]

    assert paths_after_first.count(PROBE_PATH) == 1

    async with main_module.lifespan(app):
        paths_after_second = [getattr(r, "path", "") for r in app.router.routes]

    assert paths_after_second == paths_after_first
