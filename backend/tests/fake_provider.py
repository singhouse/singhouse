# SPDX-License-Identifier: AGPL-3.0-only
"""
In-memory CatalogProvider used by test_catalog.py.

Lets us exercise the generic /api/catalog/* abstraction (search hit
stamping, import idempotency, run_import background dispatch) without
needing any real provider configured.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter
from sqlalchemy import update

from karaoke_backend.api.catalog import ProviderHit, ProviderInfo


class FakeProvider:
    """A scriptable in-memory provider.

    Tests mutate ``catalog`` (id → ProviderInfo) and ``available`` directly,
    then either register the singleton or pass it where needed.
    """

    name = "fake"
    label = "Fake"
    icon = "🧪"
    capabilities = frozenset({"search", "import"})

    def __init__(self) -> None:
        self.available: bool = True  # type: ignore[assignment]
        self.catalog: dict[str, ProviderInfo] = {}
        self.import_calls: list[tuple[str, int, int, str]] = []
        self.import_event = asyncio.Event()

    def filename_for(self, external_id: str) -> str:
        return f"fake-{external_id}.bin"

    def routers(self) -> list[APIRouter]:
        return []

    def parse_legacy_metadata(self, md: dict) -> tuple[str, str, int | None] | None:
        if "fakeprov_id" in md:
            return ("fake", str(md["fakeprov_id"]), md.get("format_version"))
        return None

    async def search(
        self, q: str, *, offset: int = 0, hydrate: bool = True
    ) -> list[ProviderHit]:
        ql = q.lower()
        hits = [
            ProviderHit(
                external_id=info.external_id,
                title=info.title,
                artist=info.artist,
                year=info.year,
                length=info.length,
                free=info.free,
                kind="song",
            )
            for info in self.catalog.values()
            if ql in info.title.lower() or ql in info.artist.lower()
        ]
        return hits[offset:]

    async def info(self, external_id: str) -> Optional[ProviderInfo]:
        return self.catalog.get(external_id)

    async def run_import(
        self, *, job_id: str, song_id: int, owner_id: int, external_id: str
    ) -> None:
        """Flips Job + Song to ready so importing tests can finish in-process.

        Signature mirrors the real ``CatalogProvider.run_import`` protocol,
        including the ``owner_id`` of the host the import is scoped to — the
        account holder, or the host who admitted the guest that triggered it.
        Never the guest, who has no account to own anything.
        """
        from karaoke_backend.database import AsyncSessionLocal
        from karaoke_backend.models.song import Job, Song

        self.import_calls.append((job_id, song_id, owner_id, external_id))

        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Job).where(Job.id == job_id).values(
                    status="done", progress=100, message="fake import done",
                )
            )
            await db.execute(
                update(Song).where(Song.id == song_id).values(status="ready")
            )
            await db.commit()

        self.import_event.set()
