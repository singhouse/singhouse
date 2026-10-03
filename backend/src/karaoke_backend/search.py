# SPDX-License-Identifier: AGPL-3.0-only
"""Shared, literal Unicode search for local library and history surfaces."""

from __future__ import annotations

import unicodedata
from functools import lru_cache

from sqlalchemy import func
from sqlalchemy.sql.elements import ColumnElement


def _normalize(value: str) -> str:
    # Keep SQL wildcard characters literal. Removing other punctuation lets
    # omitted apostrophes and separators match (Don't -> dont, AC/DC -> acdc).
    folded = unicodedata.normalize("NFKD", unicodedata.normalize("NFKD", value).casefold())
    return "".join(
        char for char in folded
        if not unicodedata.category(char).startswith("M")
        and (char in "%_" or not unicodedata.category(char).startswith("P"))
    )


@lru_cache(maxsize=128)
def _query_words(query: str) -> tuple[str, ...]:
    # Queries repeat for every row in a SQL scan. Bound retained query data and
    # avoid checking the same word repeatedly for redundant user input.
    return tuple(dict.fromkeys(_normalize(query).split()))


def normalized_search(query: str, *fields: str | None) -> int:
    """SQLite predicate: require every query word in at least one allowed field.

    Casefold and compatibility decomposition make case and accents tolerant;
    punctuation is omitted except literal ``%`` and ``_``. Whitespace separates
    words, so repeated spaces and word order do not matter. Words remain
    substring matches, but cannot be assembled across field boundaries.
    Field whitespace is ignored as well, so "Hello,World" also matches
    "Hello World". This deliberately permits partial matches across words
    within one field. Symbols such as ``+`` remain literal.
    Null fields are empty. Blank queries impose no filter; queries containing
    only discarded punctuation/marks match nothing, never the whole library.
    Stored values and exact artist grouping are not changed.
    """
    if not query.strip():
        return 1
    words = _query_words(query)
    if not words:
        return 0
    normalized_fields = ["".join(_normalize(field or "").split()) for field in fields]
    return int(all(any(word in field for field in normalized_fields) for word in words))


def search_predicate(query: str, *columns) -> ColumnElement[bool]:
    """Build a bound SQL predicate for use BEFORE counting and pagination.

    Connections must install ``db.sqlite.install_sqlite_pragmas`` (as the
    product engine does), which registers the deterministic SQLite function.
    Callers control which fields may be searched, including privacy boundaries.
    """
    return func.normalized_search(query, *columns) == 1
