#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# check_core_neutrality.sh — assert no vendor-specific identifiers, brand
# literals, premium leaks, or private-infra strings sit where they must not.
#
# Usage: tools/check_core_neutrality.sh [repo-root]
# Default repo-root is the parent of this script's parent (the worktree).
#
# Exits 0 when clean, 1 on any hit.
#
# This gate lives CORE-SIDE (tools/) on purpose: it ships with the public
# repo as its own CI gate, and public files (frontend/package.json's
# test:neutrality) reference it without crossing the premium/ boundary — the
# public build stays a file-level deletion with no content edits.
#
# KEEP-PRIVATE mechanism: tools/keep-private.txt lists planning/internal
# paths that never enter public assembly. Listed paths are excluded from
# EVERY check here and deleted by premium/tools/check_public_cut.sh. A
# missing list file means an empty list — that is the intended behavior in
# the public repo, where the list itself is one of the deleted paths. Every
# listed path must be git-tracked (stale entries fail the gate — drift
# guard; present-but-untracked entries warn, since untracked files never
# ship anyway).
#
# PATTERN SUPPLEMENT: two checks below (brand, private-infra) OR additional
# match alternatives onto their built-in default from an optional data file,
# tools/private-patterns.txt, keyed by check. When that file is absent the
# built-in default is what runs. The file is loaded once, reported, and
# validated before any check consumes it — see the load block below.
#
# The script must run BOTH from this repo root AND from a repo root where
# premium/, keep-private.txt, and private-patterns.txt do not exist:
# premium-scoped pathspecs enumerate to nothing there (vacuous pass, correct —
# there is no premium tree to leak), and both file loads degrade to their
# documented empty behavior.
#
# READ THAT PARAGRAPH NARROWLY. It licenses a premium-scoped pathspec matching
# nothing; it does NOT license reading such a pass as coverage. These pathspecs
# reach exactly what THIS repo tracks, and a path this repo does not track is
# invisible to every check below — enumerated as zero files, reported as OK.
# That is why the premium vendor check states the size of the set it graded
# rather than only the absence of hits: "no hits" and "nothing to hit" are
# different facts and only one of them is coverage. The vendor line is the
# representative signal for the premium pathspecs generally; read it before
# concluding anything about them.

set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
FAIL=0

# Every check enumerates via `git ls-files`; against a non-repo root that
# yields nothing and every check passes VACUOUSLY. Fail closed instead —
# public assembly is exactly where an exported non-git tree shows up.
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "FAIL: $REPO_ROOT is not a git repository — cannot enumerate tracked files"
  exit 1
fi

# What this bans is a CATALOG vendor — a service whose songs are somebody
# else's library, reached through somebody else's account. Media-server names
# (Plex, Jellyfin) are deliberately NOT in this pattern and must not be added:
# they name a server the user runs themselves, holding music the user already
# has, and a source that reads it is core rather than a provider. Changing that
# distinction changes product scope and requires an explicit policy decision.
VENDOR_PATTERN=''

# --- Optional pattern-supplement load ---
# Emits the '|'-joined alternatives filed under $1 in the data file below, or
# nothing when the file is absent. Empty payloads are dropped: an interior
# empty alternative would produce '||', which matches every line of every file.
PRIVATE_FILE="$REPO_ROOT/tools/private-patterns.txt"
private_patterns() {
  [ -f "$PRIVATE_FILE" ] || return 0
  sed -e 's/^[[:space:]]*//' -e 's/#.*//' -e 's/[[:space:]]*$//' "$PRIVATE_FILE" \
    | grep -v '^$' \
    | grep "^$1:" \
    | cut -d: -f2- \
    | grep -v '^$' \
    | paste -sd'|' - || true
}

# OR-joins $2 onto the built-in default $1, skipping the join when $2 is empty
# so the pattern never grows a dangling '|' (which would match everything).
join_pattern() {
  if [ -n "$2" ]; then printf '%s|%s' "$1" "$2"; else printf '%s' "$1"; fi
}

# Alternative count of a '|'-joined string — for the load report, so a
# supplement that silently loaded nothing is visible rather than inferred.
count_alts() {
  if [ -z "$1" ]; then printf '0'; else printf '%s' "$1" | awk -F'|' '{print NF}'; fi
}

# A malformed alternative makes every downstream `grep -E` exit 2 and print
# NOTHING — with stderr discarded and the loop wrapped in `|| true`, the check
# would report OK while matching nothing at all. That is a green no-op on a
# gate whose entire job is to fail closed before an irrevocable publication,
# so an unusable pattern is fatal here, not a warning.
validate_ere() {   # $1 = label, $2 = pattern
  local rc
  printf '' | grep -qE -- "$2" >/dev/null 2>&1 && rc=0 || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "FAIL: $1 is not a valid extended regular expression"
    echo "      check the alternatives in tools/private-patterns.txt"
    exit 1
  fi
}

echo "=== Core neutrality check ==="
echo "Repo root: $REPO_ROOT"
echo ""

# --- Keep-private list load + drift guard ---
KEEP_FILE="$REPO_ROOT/tools/keep-private.txt"
KEEP_TMP="$(mktemp)"
KEEP_ERE="$(mktemp)"
trap 'rm -f "$KEEP_TMP" "$KEEP_ERE"' EXIT
if [ -f "$KEEP_FILE" ]; then
  sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$KEEP_FILE" | grep -v '^$' > "$KEEP_TMP" || true
fi

# Build the exclusion matcher. A plain entry matches that exact path; an entry
# with a trailing slash is a DIRECTORY and matches everything beneath it.
# Globs are rejected by the drift guard below: they would pass a pathspec
# check, match nothing here, and — worse — expand to nothing in
# check_public_cut.sh's quoted rm, reporting a deletion that never happened.
if [ -s "$KEEP_TMP" ]; then
  while IFS= read -r p; do
    esc=$(printf '%s' "$p" | sed 's/[][\.^$*+?(){}|\\]/\\&/g')
    case "$p" in
      */) printf '^%s\n' "$esc" >> "$KEEP_ERE" ;;
       *) printf '^%s$\n' "$esc" >> "$KEEP_ERE" ;;
    esac
  done < "$KEEP_TMP"
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

if [ -s "$KEEP_TMP" ]; then
  KEEP_STALE=0
  KEEP_UNTRACKED=0
  while IFS= read -r p; do
    case "$p" in
      *[*?[]*)
        echo "FAIL: keep-private entry uses a glob — list explicit paths or a directory: $p"
        KEEP_STALE=$((KEEP_STALE + 1))
        FAIL=1
        continue
        ;;
    esac
    # A directory entry is satisfied by any tracked file beneath it; a file
    # entry must match exactly one tracked path of the same name.
    case "$p" in
      */) MATCHED=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files -- "$p" | head -1) ;;
       *) MATCHED=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files -- "$p") ;;
    esac
    if { [ "${p%/}" != "$p" ] && [ -n "$MATCHED" ]; } || [ "$MATCHED" = "$p" ]; then
      :
    elif [ -e "$REPO_ROOT/$p" ]; then
      # Present on disk but not yet committed: not drift (an untracked file
      # never ships), but the exclusion is moot until it is tracked.
      echo "WARN: keep-private entry exists but is not git-tracked yet: $p"
      KEEP_UNTRACKED=$((KEEP_UNTRACKED + 1))
    else
      echo "FAIL: stale keep-private entry — no such file: $p"
      KEEP_STALE=$((KEEP_STALE + 1))
      FAIL=1
    fi
  done < "$KEEP_TMP"
  if [ "$KEEP_STALE" -eq 0 ]; then
    echo "OK: keep-private list loaded ($(wc -l < "$KEEP_TMP") entries, $KEEP_UNTRACKED untracked)"
  fi
else
  echo "OK: no keep-private list (empty exclusion set — expected in the public repo)"
fi

# --- Pattern-supplement load + mode report ---
# Loaded once, reported explicitly, and validated before any check consumes
# them. Reporting is the point: without it, a supplement that failed to load
# is indistinguishable from one that loaded — same OK lines, same exit 0.
#
# The two data files travel together (both are keep-private, both are deleted
# by the same cut), so keep-private.txt present + this file absent is not a
# valid state: it is a tree that still has private material with a check that
# no longer looks for it. Fail rather than run a weaker gate under a full-
# strength label.
BRAND_PRIVATE="$(private_patterns brand)"
INFRA_PRIVATE="$(private_patterns infra)"

if [ -f "$PRIVATE_FILE" ]; then
  BRAND_N=$(count_alts "$BRAND_PRIVATE")
  INFRA_N=$(count_alts "$INFRA_PRIVATE")
  echo "OK: pattern supplement loaded (brand: $BRAND_N, infra: $INFRA_N)"
  if [ "$BRAND_N" -eq 0 ] || [ "$INFRA_N" -eq 0 ]; then
    echo "FAIL: pattern supplement is present but a key loaded zero alternatives"
    echo "      (brand: $BRAND_N, infra: $INFRA_N) — a mistyped key name silently"
    echo "      drops that key's alternatives and weakens the check it feeds"
    FAIL=1
  fi
elif [ -s "$KEEP_TMP" ]; then
  echo "FAIL: tools/keep-private.txt is present but tools/private-patterns.txt is not."
  echo "      These are deleted together by the cut, so this tree still holds private"
  echo "      material while the checks that look for it are running at reduced strength."
  FAIL=1
else
  echo "OK: no pattern supplement (built-in defaults only — expected in the public repo)"
fi

# --- Enumeration integrity ---
# Every check below walks tracked paths and skips anything it cannot open. A
# silent skip is the wrong failure mode for a gate whose job is fail-closed
# enumeration before an irrevocable publication, so prove up front that every
# tracked path is nameable and present. (core.quotePath=false is set on every
# ls-files call for the same reason: quoted non-ASCII names would not resolve.)
MISSING=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files \
  | while IFS= read -r f; do
      [ -e "$REPO_ROOT/$f" ] || printf '%s\n' "$f"
    done || true)
if [ -n "$MISSING" ]; then
  echo "FAIL: tracked paths missing from the worktree (checks would skip them silently):"
  echo "$MISSING"
  FAIL=1
else
  echo "OK: every tracked path is nameable and present"
fi

# --- Core vendor check: ALL tracked files except premium/ (the premium
# check below holds that tree to the same bar with its own allowlist) and
# the keep-private list. Root files (README.md, PROJECT_DOCS.md, configs),
# tools/ and docs/ are in scope — a vendor literal in a doc or script leaks
# exactly as hard as one in src. Enumerated exception ONLY:
#   - tools/check_core_neutrality.sh — this script (carries the patterns)
CORE_ALLOW='^tools/check_core_neutrality\.sh$'
HITS=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files \
  | grep -v '^premium/' \
  | grep -vE "$CORE_ALLOW" \
  | keep_private_filter \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      [ -n "$VENDOR_PATTERN" ] && grep -inE -- "$VENDOR_PATTERN" "$REPO_ROOT/$f" 2>/dev/null \
        | p="$f" awk '{ print ENVIRON["p"] ":" $0 }'
    done || true)

if [ -n "$HITS" ]; then
  echo "FAIL: vendor literals in core tracked files:"
  echo "$HITS"
  FAIL=1
else
  echo "OK: no vendor literals in core tracked files"
fi

# --- Premium tree: premium ships zero providers, so it is held to the same
# vendor-literal bar as core. What follows grades premium paths THIS repo
# tracks; where it tracks none, the enumeration is empty and the success
# line says so rather than implying otherwise. Exceptions ONLY:
#   - tools/check_core_neutrality.sh — this script (carries the pattern).
#     It lives core-side since the move, so `ls-files -- premium/` can never
#     emit it; the entry is defensive, kept so the allowlist stays the
#     complete statement of what may carry the pattern.
#   - premium/frontend/tests/editor-legacy-method.test.js — real-dialect data
#     sentinel: proves core editor read-compat for the PERSISTED method string
#     of a legacy provider (stored-DB literals need read-compat, not rename). It is a
#     data value in a test, not vendor integration; its header documents this.
#     Like the entry above, it is unreachable wherever this repo tracks no
#     premium paths; both are kept so the allowlist stays the complete
#     statement of what may carry the pattern, whatever this repo tracks.
#
# The success line reports the size of the set the claim is about. "No hits"
# and "nothing to hit" are different facts, and a line that reports only the
# former reads as coverage in either case. The count says "in scope" rather
# than "graded" on purpose: it is the post-allowlist ENUMERATION, taken before
# the loop's `[ -f ]`, so it is an upper bound on what was read, not a receipt.
# The allowlist size is derived rather than written, for the same reason the
# file count is: a number typed next to a computed one drifts from it.
PREMIUM_ALLOW='^tools/check_core_neutrality\.sh$|^premium/frontend/tests/editor-legacy-method\.test\.js$'
PREMIUM_ALLOW_N=$(count_alts "$PREMIUM_ALLOW")
PREMIUM_FILES=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files -- 'premium/' \
  | grep -vE "$PREMIUM_ALLOW" \
  | keep_private_filter || true)
PREMIUM_N=$(printf '%s\n' "$PREMIUM_FILES" | grep -c . || true)
PREMIUM_HITS=$(printf '%s\n' "$PREMIUM_FILES" \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      [ -n "$VENDOR_PATTERN" ] && grep -inE -- "$VENDOR_PATTERN" "$REPO_ROOT/$f" 2>/dev/null \
        | p="$f" awk '{ print ENVIRON["p"] ":" $0 }'
    done || true)

if [ -n "$PREMIUM_HITS" ]; then
  echo "FAIL: vendor literals in premium tracked files:"
  echo "$PREMIUM_HITS"
  FAIL=1
else
  echo "OK: no vendor literals in premium tracked files ($PREMIUM_N in scope, allowlist: $PREMIUM_ALLOW_N)"
fi

# --- Premium import paths in core frontend/src ---
PREMIUM_IMPORT_HITS=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files -- 'frontend/src/' \
  | keep_private_filter \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      grep -n 'karaoke_premium' "$REPO_ROOT/$f" 2>/dev/null \
        | p="$f" awk '{ print ENVIRON["p"] ":" $0 }'
    done || true)

if [ -n "$PREMIUM_IMPORT_HITS" ]; then
  echo "FAIL: premium import paths in core frontend/src:"
  echo "$PREMIUM_IMPORT_HITS"
  FAIL=1
else
  echo "OK: no premium import paths in core frontend/src"
fi

# --- Language gate: Download-verb copy in shipped UI source ---
# Shipped UI speaks "Import" — "Download" is banned from UI copy in BOTH
# trees; the copy is legally load-bearing. Rather than parse copy out of
# markup, the gate bans the word from shipped frontend source outright
# (identifiers included — the renaming pass took downloadCatalog →
# importFromCatalog, downloadSession → saveSessionFile). Generic exceptions:
#   - comment-only lines (engineering vocabulary about HTTP is not UI copy)
#   - the DOM anchor `download` attribute (a.download = ... / download="...").
#     Token-granular, not line-granular: the attribute occurrence is stripped
#     and the residue re-tested, so `<a :download="fn">Download it</a>` still
#     fails (hit lines are shown post-strip). frontend/index.html is included
#     (title/noscript copy); tests are out of scope: they assert ON the word
#     and don't ship.
# "BOTH trees" above is the POLICY. This check enforces it over the premium
# pathspec only where this repo tracks those paths. Unlike the vendor check
# below, that subset is not separately counted here — the line covers a mixed
# set and a total would not tell you which part of it was empty. Header note.
LANG_HITS=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files -- 'frontend/src/' 'premium/frontend/src/' 'frontend/index.html' \
  | keep_private_filter \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      grep -inE 'download' "$REPO_ROOT/$f" 2>/dev/null \
        | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*|<!--)' \
        | sed -E 's/(\.|[[:space:]]|:)download[[:space:]]*=//gI' \
        | grep -iE 'download' \
        | p="$f" awk '{ print ENVIRON["p"] ":" $0 }'
    done || true)

if [ -n "$LANG_HITS" ]; then
  echo "FAIL: Download-verb language in shipped UI source (say Import):"
  echo "$LANG_HITS"
  FAIL=1
else
  echo "OK: no Download-verb language in shipped UI source"
fi

# --- Multi-user auth leak in core frontend/src ---
# The account lifecycle (invites, login/signup routes, the multi-user store)
# lives in the premium bundle. None of its markers may appear in core source.
AUTH_LEAK_PATTERN='invite_token|/auth/(login|signup)|useAuthStore'
AUTH_LEAK_HITS=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files -- 'frontend/src/' \
  | keep_private_filter \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      grep -nE "$AUTH_LEAK_PATTERN" "$REPO_ROOT/$f" 2>/dev/null \
        | p="$f" awk '{ print ENVIRON["p"] ":" $0 }'
    done || true)

if [ -n "$AUTH_LEAK_HITS" ]; then
  echo "FAIL: multi-user auth markers in core frontend/src:"
  echo "$AUTH_LEAK_HITS"
  FAIL=1
else
  echo "OK: no multi-user auth markers in core frontend/src"
fi

# --- Rotation leak in core frontend/src ---
# The rotation queue — its store, its API slice, its panel, and the two guest
# surfaces it exists to serve (/screen, /join) — lives in the premium bundle.
# Core reaches it ONLY through the neutral seams, so none of its module or
# component names may appear in core source.
#
# The seam names are deliberately absent from this pattern and MUST stay
# absent: 'queue-provider', 'stage-overlays' and the AudioPlayer 'ended' event
# are core vocabulary describing a hole, not the thing that fills it. So is the
# English word "rotation" on its own (core comments still explain what the hole
# is for) — every alternative below names a specific premium module.
ROTATION_LEAK_PATTERN='useRotationStore|stores/rotation|rotationApi|showApi|joinApi|RotationPanel|StageOverlays|TunnelPill|JoinView|ScreenView'
ROTATION_LEAK_HITS=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files -- 'frontend/src/' \
  | keep_private_filter \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      grep -nE "$ROTATION_LEAK_PATTERN" "$REPO_ROOT/$f" 2>/dev/null \
        | p="$f" awk '{ print ENVIRON["p"] ":" $0 }'
    done || true)

if [ -n "$ROTATION_LEAK_HITS" ]; then
  echo "FAIL: premium rotation markers in core frontend/src:"
  echo "$ROTATION_LEAK_HITS"
  FAIL=1
else
  echo "OK: no premium rotation markers in core frontend/src"
fi

# --- Brand indirection gate ---
# Every brand-identifying string lives in exactly two modules —
# frontend/src/brand.js and backend/src/karaoke_backend/branding.py — and
# everything else reads from them. A hit here means a brand literal was
# hardcoded somewhere it cannot be swapped from one place. The product name is
# the built-in default; the pattern supplement (key `brand`) adds any further
# names to ban, so a rename cannot re-scatter literals either.
#
# Scope is ALL tracked files — docs, READMEs, configs, scripts, tests,
# lyricsync, and whatever is tracked here under premium/ — minus the
# keep-private list. Premium is in scope on its own merits (it ships to
# customers as a wheel; a brand literal there re-scatters just as silently),
# but "in scope" reaches only what this repo tracks — see the note in the
# header before reading a pass here as premium coverage.
#
# Enumerated exceptions ONLY:
#   - frontend/src/brand.js                   — the frontend source of truth
#   - backend/src/karaoke_backend/branding.py — the backend source of truth
#   - tools/check_core_neutrality.sh          — this script (carries the pattern)
#   - README.md, PROJECT_DOCS.md              — the product name (Singhouse)
#     is settled and allowed in the two root docs
#   - desktop/                                — product-delivery code and
#     packaging must name the installed public product. This is a content-level
#     exception for the built-in public name only: private/supplement names
#     remain checked, and desktop stays in every vendor, infra, and leak gate.
#   - seven named release/setup documents under docs/ — user-facing instructions
#     that must name the installed product. This is the same content-level
#     exception as desktop: exact paths, public name only, every other gate live.
# NOTE (residual risk): the allowlist is per-FILE for the WHOLE brand
# pattern — an allowlisted file is exempt from every alternative, not just the
# product name, so the allowlisted docs must stay free of the supplement's
# alternatives by discipline; this gate cannot see one inside them.
#
# ADDRESS EXEMPTION. The pattern matches the product name as a bare
# SUBSTRING, so it also fires inside the repository URL — where those letters
# are an ADDRESS, not a brand literal. Rebranding changes the presentation
# layer, not stable package identifiers or the public source address; it no
# more creates a different GitHub URL than a different `karaoke_backend`
# package name. Without this, the two
# package manifests cannot carry the `[project.urls]` / `repository` field
# every published package has, and the only other way out is widening the
# per-file allowlist — which by the NOTE above would also blind those files to
# private supplement names. The exemption is therefore by CONTENT and applies
# to every file equally.
#
# Applied by stripping the exempt substring from a candidate line and
# re-testing what remains, NOT by dropping the line: a line carrying the URL
# *and* a genuine brand literal still fails, and the reported hit is the
# ORIGINAL line, not the stripped residue. Built-in rather than
# supplement-sourced, because it must hold identically in the public repo,
# where tools/private-patterns.txt does not exist and the pattern degrades to
# the built-in alternative alone.
#
# DELIBERATELY NARROW — this exempts the repository, and nothing else. Not
# exempt, and each would be its own ruling: `api.github.com/repos/...`,
# `raw.githubusercontent.com/...`, the Pages host, `/orgs/` paths, and any
# renamed owner. If one of those is ever genuinely needed, widen THIS constant
# after deciding it; do NOT reach for the per-file allowlist, which is per-file
# for the whole pattern and would also exempt private supplement names.
BRAND_PATTERN="$(join_pattern 'singhouse' "$BRAND_PRIVATE")"
validate_ere "the brand pattern" "$BRAND_PATTERN"
BRAND_EXEMPT='github\.com[:/]singhouse/singhouse'
validate_ere "the brand address exemption" "$BRAND_EXEMPT"

# ONE regex engine, both times. An earlier revision re-tested the survivor in
# awk, which ran the brand pattern through TWO engines while validate_ere only
# ever exercised grep's — and every divergence there fails OPEN. A supplement
# alternative valid for `grep -E` but different in awk (`\b`, or any uppercase
# alternative against awk's case-SENSITIVE `~`) gets matched by grep and then
# silently discarded; one that is FATAL to awk empties the pipeline, which the
# `|| true` below swallows and the check reports as a green "no hits". Testing
# the residue with `grep -qiE` leaves nothing to diverge. The subject is folded
# with `tr` rather than a `sed //I` flag or bash's `${x,,}`, both of which are
# non-portable, and this gate ships to strangers' machines.
brand_survives_exemption() {
  local residue
  residue=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E "s|$BRAND_EXEMPT||g")
  grep -qiE -- "${2:-$BRAND_PATTERN}" <<<"$residue"
}

# Prove the filter before trusting it: the product name must survive it, and
# the repository URL alone must not. Either way round, a regression here stops
# the gate loudly instead of reporting a green "no hits" — which is the whole
# failure mode the single-engine rewrite above exists to prevent, and it
# deserves an assertion rather than only a comment.
if ! brand_survives_exemption 'singhouse'; then
  echo "FAIL: brand self-test — the product name no longer matches its own pattern"
  exit 1
fi
if brand_survives_exemption 'https://github.com/singhouse/singhouse'; then
  echo "FAIL: brand self-test — the repository URL is no longer exempted"
  exit 1
fi

BRAND_ALLOW='^frontend/src/brand\.js$|^backend/src/karaoke_backend/branding\.py$|^tools/check_core_neutrality\.sh$|^README\.md$|^PROJECT_DOCS\.md$'
BRAND_HITS=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files \
  | grep -vE "$BRAND_ALLOW" \
  | keep_private_filter \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      # These legal records must name the product directly. Only the public
      # name is permitted: supplement alternatives remain checked, even when
      # they contain the public name as a substring.
      file_brand_pattern="$BRAND_PATTERN"
      case "$f" in
        .github/scripts/cla.cjs|CLA.md|CCLA.md|CLA-SIGNATURES.json|CONTRIBUTING.md|LICENSING.md)
          [ -n "$BRAND_PRIVATE" ] || continue
          file_brand_pattern="$BRAND_PRIVATE"
          ;;
        docs/install-desktop.md|docs/modal.md|docs/release-notes-draft.md|docs/release-qualification.md|docs/support-diagnostics.md|docs/asahi-local-test.md|docs/release-checklist.md)
          [ -n "$BRAND_PRIVATE" ] || continue
          file_brand_pattern="$BRAND_PRIVATE"
          ;;
        desktop/*)
          [ -n "$BRAND_PRIVATE" ] || continue
          file_brand_pattern="$BRAND_PRIVATE"
          ;;
      esac
      grep -inE -- "$BRAND_PATTERN" "$REPO_ROOT/$f" 2>/dev/null \
        | while IFS= read -r hit; do
            # printf, not `sed "s|^|$f:|"`: a filename containing | & or a
            # backslash is data to printf and syntax to sed.
            if brand_survives_exemption "$hit" "$file_brand_pattern"; then printf '%s:%s\n' "$f" "$hit"; fi
          done
    done || true)

if [ -n "$BRAND_HITS" ]; then
  echo "FAIL: brand literals outside the brand modules:"
  echo "$BRAND_HITS"
  FAIL=1
else
  echo "OK: no brand literals outside the brand modules (allowlist: 5)"
fi

# --- Private-infra literals in ANY tracked file ---
# LAN addresses, home-directory paths, personal account names and hostnames
# identify the development environment and must never ship — in core, and
# equally in premium/ (it ships to customers as a wheel; an infra path there is
# a leak too). Scope is every tracked file minus the keep-private list, which
# reaches premium/ only where this repo tracks it — header note again.
#
# The built-in default bans an absolute home directory of ANY account, on
# either OS convention: whoever's machine it names, it is a developer's local
# layout and not a path a user of this software has. Deliberately unanchored at
# the tail: a bare home directory — assigned to a variable, or the argument to
# a cd — is caught, not just paths beneath one. (Which is why this comment
# cannot spell an example: the check reads its own source too.) Additional
# alternatives come from the pattern supplement, key `infra`.
#
# Generic documentation addresses (192.168.x.x and friends) are deliberately
# NOT banned anywhere here — they are example vocabulary, not infrastructure.
#
# This check does not allowlist this script: a literal that lands in the gate
# itself is caught like any other file's.
INFRA_PATTERN="$(join_pattern '/home/[a-z][a-z0-9_-]*|/Users/[a-z][a-z0-9_-]*' \
                              "$INFRA_PRIVATE")"
validate_ere "the private-infra pattern" "$INFRA_PATTERN"
# The documented account-ID lookup is a public API URL, not a home path.
# Strip only that exact placeholder URL, then check the rest of the line.
# Require an end or documentation delimiter so a longer account is still
# checked, and preserve the delimiter when stripping the placeholder.
# Split the literal so the gate's own source is not mistaken for a home path.
ACCOUNT_LOOKUP_EXEMPT='https://api\.github\.com/'
ACCOUNT_LOOKUP_EXEMPT+='users/YOUR_LOGIN($|[[:space:]`"<>),.;])'
INFRA_HITS=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files \
  | keep_private_filter \
  | while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] || continue
      grep -inE -- "$INFRA_PATTERN" "$REPO_ROOT/$f" 2>/dev/null \
        | while IFS= read -r hit; do
            residue=$(printf '%s' "$hit" | sed -E "s@$ACCOUNT_LOOKUP_EXEMPT@\\1@g")
            if grep -qiE -- "$INFRA_PATTERN" <<<"$residue"; then
              printf '%s:%s\n' "$f" "$hit"
            fi
          done
    done || true)

if [ -n "$INFRA_HITS" ]; then
  echo "FAIL: private-infra literals in tracked files:"
  echo "$INFRA_HITS"
  FAIL=1
else
  echo "OK: no private-infra literals in tracked files"
fi

# --- Dangling keep-private references ---
# A surviving file must not point at a path the cut deletes. Such a pointer
# resolves to nothing for a public reader and advertises that a document was
# deliberately withheld — the same defect class as the planning-label sweep,
# and one no pattern-based check can see. Only meaningful when the list exists
# (in the public repo the referenced paths are simply gone).
#
# This script is excluded at FILE level, and has to be: it names both data
# files in code to load them, and a loader cannot cite its own path
# indirectly. The SPDX header gate is excluded for the same reason — it too
# loads the keep-private list at runtime to skip withheld paths. The
# exemption is therefore load-bearing, not convenience — but it is also a
# blind spot, so keep the PROSE in both scripts free of references to
# withheld paths. The code lines are the only ones that should need it.
if [ -s "$KEEP_TMP" ]; then
  DANGLE=$(git -C "$REPO_ROOT" -c core.quotePath=false ls-files \
    | grep -v '^premium/' \
    | grep -vE '^tools/(check_core_neutrality\.sh|check_spdx_headers\.sh|keep-private\.txt)$' \
    | keep_private_filter \
    | while IFS= read -r f; do
        [ -f "$REPO_ROOT/$f" ] || continue
        grep -nFf "$KEEP_TMP" "$REPO_ROOT/$f" 2>/dev/null \
          | p="$f" awk '{ print ENVIRON["p"] ":" $0 }'
      done || true)
  if [ -n "$DANGLE" ]; then
    echo "FAIL: surviving files reference keep-private paths:"
    echo "$DANGLE"
    FAIL=1
  else
    echo "OK: no surviving file references a keep-private path"
  fi
fi

echo ""
if [ "$FAIL" -eq 1 ]; then
  echo "NEUTRALITY CHECK FAILED"
  exit 1
fi
echo "NEUTRALITY CHECK PASSED"
exit 0
