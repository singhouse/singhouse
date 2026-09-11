# SPDX-License-Identifier: AGPL-3.0-only
"""Generic core operator settings — a plain key/value store of operator toggles.

This is CORE operator configuration: knobs the person running the box may change
freely, framed as hygiene, not license state and not a paywall. Values are stored
as text (``String(255)``) and PARSED by their callers — there is deliberately no
typed column per setting, so a new operator knob is a new key, never a migration.

The first tenant is history retention: ``history_retention_days`` (default 30,
``0`` = keep forever), read and written by the history router. Retention is a
plain setting by decision: it prunes old rows for hygiene, it never gates a
feature.
"""

from sqlalchemy import Column, String

from karaoke_backend.models.song import Base

# The history retention knob and its default. Retention is a plain operator
# setting by decision: default 30 days, 0 = keep forever. Never a paywall.
HISTORY_RETENTION_KEY = "history_retention_days"
DEFAULT_RETENTION_DAYS = 30
# Upper bound on the retention window (~100 years). The purge turns this into a
# ``timedelta(days=...)``, and ``timedelta`` overflows past ~2.7M days — an
# unbounded value would 500 every list/record call that runs the purge. This is
# a sanity ceiling, not a paywall: anything at or above it is effectively
# "keep forever" already (0 is the explicit forever).
MAX_RETENTION_DAYS = 36500

# The CD+G export attribution-card toggle. Stored as "true"/"false" text;
# readers parse case-insensitively and fall back to the default on anything
# unparseable. A plain operator setting, same as retention: never a paywall.
CDG_CARD_KEY = "cdg_attribution_card"
DEFAULT_CDG_CARD = True

# The Plex media-server base URL, e.g. "http://plex.lan:32400". Empty (the
# shipped default) means no server is configured and every Plex route says so.
# Only the URL lives here: the Plex TOKEN is a credential and is deliberately
# NOT a row in this table — it is written to a 0600 file beside the database
# (karaoke_backend.plex.config), because a DB dump, a backup, or a support
# copy of karaoke.db must not carry a credential to the operator's library.
PLEX_URL_KEY = "plex_url"
DEFAULT_PLEX_URL = ""


class AppSetting(Base):
    """One operator setting as a ``key`` -> text ``value`` pair."""

    __tablename__ = "app_settings"

    key: str = Column(String(64), primary_key=True)
    value: str = Column(String(255), nullable=False)  # stored as text; callers parse

    def __repr__(self) -> str:
        return f"<AppSetting key={self.key!r} value={self.value!r}>"
