# SPDX-License-Identifier: AGPL-3.0-only
"""The seam through which an extension supplies the card an export opens with.

An installed extension package registers ONE provider at install time, the
same single-object idiom as the authentication backend seam. When an export
has the card turned on, the service asks the provider for a card;
``card_for`` returning None means "use the standard attribution card". Core
ships no provider, so out of the box every export gets the standard card.

The provider only ever changes WHICH card is shown. Whether a card is shown
at all belongs to the operator's setting and the per-request override, and a
provider is not consulted when the card is off.
"""

from __future__ import annotations

from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.cdg import Card


class CardProvider(Protocol):
    """Provider contract for resolving the card shown on an owner's exports."""

    async def card_for(self, db: AsyncSession, owner_id: int) -> Card | None: ...


_provider: CardProvider | None = None


def set_card_provider(provider: CardProvider) -> None:
    global _provider
    _provider = provider


def get_card_provider() -> CardProvider | None:
    return _provider


def clear_card_provider() -> None:
    global _provider
    _provider = None
