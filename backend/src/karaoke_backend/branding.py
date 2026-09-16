# SPDX-License-Identifier: AGPL-3.0-only
"""Single source of product-brand identity for the backend.

Load-bearing identifiers (package name, entry-point groups, session cookie,
env vars, storage keys) are deliberately NEUTRAL and never derive from this
module.
"""
from karaoke_backend import __version__

PRODUCT_NAME = "Singhouse"
PRODUCT_SLUG = "singhouse"
# Source repository, carried as the User-Agent comment so the operators of the
# services we call have a way to reach the project. Not a link shown in any UI.
REPO_URL = "https://github.com/singhouse/singhouse"
USER_AGENT = f"{PRODUCT_NAME}/{__version__} ({REPO_URL})"
API_TITLE = f"{PRODUCT_NAME} API"
TUNNEL_LOG_PREFIX = f"{PRODUCT_SLUG}-cloudflared."
# Attribution card copy (the card itself ships with the CD+G exporter later).
# Copy discipline: factual tool attribution only — never acquisition-flavored.
#
# Both lines are load-bearing rather than decorative: the card travels into
# rooms and onto discs we do not control, and "Created with <Name>" is the
# factual attribution of a tool. A bare mark could be read as labeling the
# disc or its content instead, so the sentence and mark always ship together.
#
# PRODUCT_URL is the canonical product domain, deliberately bare: no scheme or
# path. REPO_URL above is the source repository and is not shown on the card.
PRODUCT_URL = "sing.house"
ATTRIBUTION_CARD_TEXT = f"Created with {PRODUCT_NAME}"
# Brand-derived id prefix baked into exported filenames ("SH0001 - Artist -
# Title"): exports travel into other players' libraries, and the prefix plus
# the database id is how a file stays traceable to the library it came from.
EXPORT_ID_PREFIX = "SH"
