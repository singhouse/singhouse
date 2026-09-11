#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# pkg-import-rewrite.sh — mechanical flat-import -> packaged-import rewriter.
#
# Rewrites the backend's historical flat module imports (api/, workers/,
# models/, database, tunnel, ratelimit, main) to their packaged names under
# the karaoke_backend import package (src layout). Committed so the exact
# same transform can be re-applied to arbitrary files later: untracked
# per-host provider modules at upgrade, either side of a cross-track rebase,
# etc.
#
# Usage:
#   tools/pkg-import-rewrite.sh PATH [PATH...]
#
# Each PATH may be a .py file or a directory (searched recursively for *.py,
# skipping __pycache__ and virtualenvs). Non-existent paths are skipped with
# a warning so a fixed invocation line works across checkouts that lack an
# optional scope (e.g. backend/fixtures).
#
# IDEMPOTENT: re-running over already-rewritten files is a no-op — every
# pattern below fails to match its own replacement.
#
# Rules:
#   1. from api|workers|models[. ]...      -> from karaoke_backend.<same>
#   2. from database|tunnel|ratelimit|main import
#                                          -> from karaoke_backend.<same> import
#   3. import tunnel|database|ratelimit    -> from karaoke_backend import <same>
#        (a bare `import karaoke_backend.tunnel` would bind the wrong name
#         for `tunnel.start()` call sites)
#   4. import api|workers|models.<dotted>  -> import karaoke_backend.<same>
#        (prefix rewrite, so `as <alias>` and trailing comments survive)
#   5. STRING-LITERAL PASS — applied ONLY to test-context files (any file
#      under a tests/ directory, or named test_*.py / conftest.py):
#        "api.|workers.|models.|database.|main.  -> "karaoke_backend.<same>
#      Covers unittest.mock patch targets, sys.modules injection keys and
#      importorskip targets. Never applied outside tests, so provider-keyed
#      data literals (external-id columns, persisted source/method values)
#      cannot be touched.
#   6. models/__init__.py only: the lone relative import of .song is
#      normalized to absolute (uniform grep-ability).

set -euo pipefail

if [[ $# -eq 0 ]]; then
    echo "usage: $0 PATH [PATH...]" >&2
    exit 2
fi

PKG="karaoke_backend"

rewrite_file() {
    local f="$1"

    # Rules 1-4: import statements (all files).
    sed -E -i \
        -e "s/^([[:space:]]*)from (api|workers|models)([. ])/\1from ${PKG}.\2\3/" \
        -e "s/^([[:space:]]*)from (database|tunnel|ratelimit|main) import /\1from ${PKG}.\2 import /" \
        -e "s/^([[:space:]]*)import (tunnel|database|ratelimit)\b([^.]|$)/\1from ${PKG} import \2\3/" \
        -e "s/^([[:space:]]*)import (api|workers|models)\./\1import ${PKG}.\2./" \
        "$f"

    # Rule 5: dotted string literals — test-context files ONLY.
    case "$f" in
        */tests/*|test_*.py|*/test_*.py|conftest.py|*/conftest.py)
            sed -E -i \
                -e "s/([\"'])(api|workers|models|database|main)\./\1${PKG}.\2./g" \
                "$f"
            ;;
    esac

    # Rule 6: models/__init__.py's lone relative import -> absolute.
    case "$f" in
        */models/__init__.py)
            sed -E -i \
                -e "s/^from \.song import /from ${PKG}.models.song import /" \
                "$f"
            ;;
    esac
}

for target in "$@"; do
    if [[ -f "$target" ]]; then
        rewrite_file "$target"
    elif [[ -d "$target" ]]; then
        while IFS= read -r -d '' f; do
            rewrite_file "$f"
        done < <(find "$target" -name '*.py' -type f \
                    -not -path '*/__pycache__/*' \
                    -not -path '*/.venv/*' -not -path '*/.venv-*/*' \
                    -print0 | sort -z)
    else
        echo "pkg-import-rewrite: skipping non-existent path: $target" >&2
    fi
done
