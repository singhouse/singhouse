#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# check_spdx_headers.sh — assert every in-scope tracked source file carries
# the SPDX license identifier required for its area, within its first 5 lines.
#
# Usage: tools/check_spdx_headers.sh [repo-root]
# Default repo-root is `.` — run it from the repo root, or pass one.
#
# Exits 0 when every in-scope file is labeled, 1 on any offender.
#
# Scope: tracked files matching *.py, *.js, *.mjs, *.vue, *.sh, *.css. Other
# types carry no header on purpose — docs, config, generated output, and
# formats with no comment syntax.
#
# Required identifier by area:
#   lyricsync/**      MIT            (a separately-licensed package — its
#                                     pyproject declares the MIT license; an
#                                     AGPL header there would mislabel it)
#   everything else   AGPL-3.0-only
#
# Exclusions:
#   - paths listed in tools/keep-private.txt, parsed the same way the
#     neutrality gate parses it ('#' starts a comment, blank lines are
#     ignored, a trailing slash marks a directory prefix). A missing list
#     file means an empty list — the expected state in the public repo.
#   - frontend/public/vendor/** — third-party code under its own licenses; a
#     project header there would mislabel someone else's copyright.

set -euo pipefail

REPO_ROOT="${1:-.}"
FAIL=0

# Enumeration is via `git ls-files`; against a non-repo root that yields
# nothing, every file test below would pass VACUOUSLY. Fail closed instead.
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "FAIL: $REPO_ROOT is not a git repository — cannot enumerate tracked files"
  exit 1
fi

echo "=== SPDX header check ==="
echo "Repo root: $REPO_ROOT"
echo ""

# --- Keep-private list load (same parse as the neutrality gate) ---
KEEP_FILE="$REPO_ROOT/tools/keep-private.txt"
KEEP_TMP="$(mktemp)"
KEEP_ERE="$(mktemp)"
trap 'rm -f "$KEEP_TMP" "$KEEP_ERE"' EXIT
if [ -f "$KEEP_FILE" ]; then
  sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$KEEP_FILE" | grep -v '^$' > "$KEEP_TMP" || true
fi

# Build the exclusion matcher. A plain entry matches that exact path; an entry
# with a trailing slash is a DIRECTORY and matches everything beneath it.
if [ -s "$KEEP_TMP" ]; then
  while IFS= read -r p; do
    esc=$(printf '%s' "$p" | sed 's/[][\.^$*+?(){}|\\]/\\&/g')
    case "$p" in
      */) printf '^%s\n' "$esc" >> "$KEEP_ERE" ;;
       *) printf '^%s$\n' "$esc" >> "$KEEP_ERE" ;;
    esac
  done < "$KEEP_TMP"
  echo "OK: keep-private list loaded ($(wc -l < "$KEEP_TMP") entries excluded from scope)"
else
  echo "OK: no keep-private list (empty exclusion set — expected in the public repo)"
fi

# Filter tracked-file lists through the keep-private exclusions.
# Empty list = pass-through.
keep_private_filter() {
  if [ -s "$KEEP_ERE" ]; then
    grep -vE -f "$KEEP_ERE" || true
  else
    cat
  fi
}

# --- The check ---
# The premium/ filter is defensive: that path is a separate repository with
# its own header gate, so this repo's index never lists it; the filter is
# kept so the scope statement here is complete on its own.
#
# A file passes when its required identifier appears in its first 5 lines.
# The character class after the identifier keeps a shorter identifier from
# matching inside a longer one (MIT inside MIT-0, for example); the counts in
# the report are derived from the enumeration, never written as literals.
IN_SCOPE=0
OFFENDERS=""
while IFS= read -r f; do
  case "$f" in
    lyricsync/*) REQ='MIT'           REQ_ERE='MIT' ;;
    *)           REQ='AGPL-3.0-only' REQ_ERE='AGPL-3\.0-only' ;;
  esac
  IN_SCOPE=$((IN_SCOPE + 1))
  if [ ! -f "$REPO_ROOT/$f" ]; then
    OFFENDERS="${OFFENDERS}  $f  (requires: $REQ — tracked but missing from the worktree)"$'\n'
    continue
  fi
  if ! head -n 5 "$REPO_ROOT/$f" 2>/dev/null \
      | grep -Eq "SPDX-License-Identifier: ${REQ_ERE}(\$|[^A-Za-z0-9.+-])"; then
    OFFENDERS="${OFFENDERS}  $f  (requires: $REQ)"$'\n'
  fi
done < <(git -C "$REPO_ROOT" -c core.quotePath=false ls-files \
  | grep -E '\.(py|js|mjs|vue|sh|css)$' \
  | grep -v '^premium/' \
  | grep -v '^frontend/public/vendor/' \
  | keep_private_filter)

if [ -n "$OFFENDERS" ]; then
  echo "FAIL: in-scope files missing the required SPDX identifier in their first 5 lines:"
  printf '%s' "$OFFENDERS"
  FAIL=1
elif [ "$IN_SCOPE" -eq 0 ]; then
  # Zero files enumerated means the root is wrong (a subdirectory inside a
  # repository still satisfies the git check above but lists only its own
  # subtree) or the enumeration itself failed inside the pipeline. Either
  # way a pass here would be vacuous — fail closed.
  echo "FAIL: no in-scope files enumerated — wrong root, or the enumeration failed"
  FAIL=1
else
  echo "OK: every in-scope tracked source file carries its required SPDX identifier ($IN_SCOPE checked)"
fi

echo ""
if [ "$FAIL" -eq 1 ]; then
  echo "SPDX HEADER CHECK FAILED"
  exit 1
fi
echo "SPDX HEADER CHECK PASSED"
exit 0
