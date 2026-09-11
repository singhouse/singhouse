#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Build the web frontend into a named assembly and publish that assembly to the
# backend's static directory.
#
# Why an assembly rather than a copy of dist/: dist/ keeps its vanilla meaning
# (whatever `npm run build` happens to produce), while a deploy is a distinct,
# identifiable artifact — reproducible name, a manifest recording what it is,
# no sourcemaps, and a publish step that also REMOVES files the new build no
# longer contains. The old `cp -r dist/* ../backend/static/` never deleted, so
# the served tree accumulated every asset ever built.
#
# The publish is a MIRROR (rsync --delete): whatever the assembly does not
# contain is erased from the target. A mistyped target is therefore not a
# no-op, it is data loss — so the target is resolved and validated in full
# before anything is built, created, or written (see "target validation").
#
# Config (environment):
#   KARAOKE_DEPLOY_MODE    multi | core — which build script to run. When unset
#                          the mode is DERIVED from the checkout: multi if the
#                          premium frontend tree exists at the path vite.config.js
#                          resolves its `@premium` alias to (../premium/frontend/src),
#                          core otherwise. A core-only checkout thus builds core
#                          without needing the variable set at all.
#   KARAOKE_DEPLOY_TARGET  publish destination, default ../backend/static
#
# deploy-manifest.json is written BESIDE the target (../backend/deploy-manifest.json
# by default), never inside it: it answers "what is live?" for humans and has
# no business being served to browsers.
#
set -euo pipefail

cd "$(dirname "$0")/.."
frontend_dir="$(pwd -P)"
deploy_root="$frontend_dir/deploy"

fail() {
    echo "deploy: $*" >&2
    exit 1
}

# is_within <path> <ancestor>: true when <path> IS <ancestor> or lives under it.
# Compared as strings, so both arguments must already be resolved absolute
# paths without trailing slashes; the "/" case is rejected separately below
# because "$ancestor"/* cannot express it.
is_within() {
    case "$1" in
        "$2" | "$2"/*) return 0 ;;
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------- provenance
# Fails closed: if git cannot be asked, we do not get to claim the tree was
# clean. An unverifiable build is marked dirty, because that is what it is.
if git rev-parse --git-dir >/dev/null 2>&1; then
    sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    if status_out="$(git status --porcelain 2>/dev/null)"; then
        if [ -n "$status_out" ]; then dirty=true; else dirty=false; fi
    else
        dirty=true
    fi
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$repo_root" ] && [ -d "$repo_root" ]; then
        repo_root="$(cd -- "$repo_root" && pwd -P)"
    else
        repo_root=""
    fi
else
    sha=nogit
    dirty=true
    repo_root=""
fi

# ---------------------------------------------------------------------- mode
premium_src="$frontend_dir/../premium/frontend/src"
if [ -n "${KARAOKE_DEPLOY_MODE+x}" ]; then
    mode="$KARAOKE_DEPLOY_MODE"
elif [ -d "$premium_src" ]; then
    mode=multi
else
    mode=core
fi

case "$mode" in
    multi | core) ;;
    *) fail "KARAOKE_DEPLOY_MODE must be 'multi' or 'core' (got '$mode')" ;;
esac

# --------------------------------------------------------- target validation
# Resolve FIRST, judge second, create last. Every check runs against the
# resolved absolute path — a relative path, a symlink or a "/.." can otherwise
# mean something quite different from what it reads like.
target="${KARAOKE_DEPLOY_TARGET:-../backend/static}"

if [ -d "$target" ]; then
    target_abs="$(cd -- "$target" && pwd -P)"
elif [ -e "$target" ]; then
    fail "target exists and is not a directory: $target"
else
    target_parent="$(dirname -- "$target")"
    [ -d "$target_parent" ] || fail \
        "target '$target' does not exist and neither does its parent ('$target_parent'). Create the parent deliberately, then re-run."
    target_parent_abs="$(cd -- "$target_parent" && pwd -P)"
    target_base="$(basename -- "$target")"
    case "$target_base" in
        . | .. | /) fail "target has no usable basename: $target" ;;
    esac
    if [ "$target_parent_abs" = "/" ]; then
        target_abs="/$target_base"
    else
        target_abs="$target_parent_abs/$target_base"
    fi
fi

if [ "$target_abs" = "/" ]; then
    fail "refusing to publish to / — this is a mirroring publish and would erase the filesystem"
fi
if [ -n "${HOME:-}" ] && [ "$target_abs" = "${HOME%/}" ]; then
    fail "refusing to publish to your home directory ($target_abs) — this is a mirroring publish and would erase it"
fi
if [ -n "$repo_root" ] && is_within "$repo_root" "$target_abs"; then
    fail "refusing to publish to $target_abs — it is the repository root, or an ancestor of it ($repo_root)"
fi
if is_within "$target_abs" "$deploy_root"; then
    fail "refusing to publish into the assembly directory ($deploy_root) — assemblies are the source of a publish, never its destination"
fi

# Shape check. An existing non-empty target must look like a tree this script
# published, because the publish deletes everything it does not recognise: the
# realistic accident is a typo'd path that lands on a directory full of
# something else entirely.
target_was_bare=false
if [ ! -d "$target_abs" ] || [ -z "$(ls -A -- "$target_abs")" ]; then
    target_was_bare=true
elif [ ! -f "$target_abs/index.html" ] || [ ! -d "$target_abs/assets" ]; then
    fail "$target_abs is not empty and does not look like a published frontend (expected index.html and assets/).
       Publishing mirrors the assembly onto the target and DELETES everything
       else, so this is refused. If the path really is correct, empty the
       directory deliberately first, then re-run."
fi

mkdir -p -- "$target_abs"

# --------------------------------------------------------------------- build
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ "$dirty" = true ]; then
    name="$stamp-g$sha-dirty-$mode"
else
    name="$stamp-g$sha-$mode"
fi
assembly="$deploy_root/$name"
manifest="$(dirname -- "$target_abs")/deploy-manifest.json"
mkdir -p -- "$deploy_root"

# Build through the existing npm scripts so their env semantics (VITE_AUTH_MODE)
# stay single-sourced there. --sourcemap hidden emits maps without the trailing
# sourceMappingURL comment, so stripping the maps below leaves no dangling
# reference; vite.config.js is untouched.
echo "deploy: building $mode into deploy/$name"
if [ "$mode" = "multi" ]; then
    npm run build:multi -- --outDir "deploy/$name" --emptyOutDir --sourcemap hidden
else
    npm run build -- --outDir "deploy/$name" --emptyOutDir --sourcemap hidden
fi

# Sourcemaps reconstruct the original source; they never leave this machine.
find "$assembly" -type f -name '*.map' -delete

# Verify the assembly before anything is published. A failure here leaves the
# served tree exactly as it was.
[ -f "$assembly/index.html" ] || fail "assembly has no index.html"
[ -d "$assembly/assets" ] || fail "assembly has no assets/ directory"
[ -n "$(ls -A "$assembly/assets")" ] || fail "assembly assets/ is empty"
[ -z "$(find "$assembly" -type f -name '*.map' -print -quit)" ] ||
    fail "sourcemaps survived the strip"
# Every text file, not just .js/.css: a sourceMappingURL in an .html, .svg or
# .json file leaks exactly as much. -I already skips binaries.
map_refs="$(grep -rIl 'sourceMappingURL' "$assembly" || true)"
if [ -n "$map_refs" ]; then
    fail "sourceMappingURL reference(s) remain in the assembly:
$map_refs"
fi

files=$(find "$assembly" -type f | wc -l)

# ------------------------------------------------------------------- publish
# --delay-updates stages incoming files in .~tmp~/ reservoirs inside the target
# and clears them on completion; a killed rsync leaves them behind, where they
# are both served and skipped by the next run's --delete pass. Clear them first
# so a previous interruption cannot become permanent.
find "$target_abs" -type d -name '.~tmp~' -prune -exec rm -rf -- {} +

# --delay-updates/--delete-delay: new files all land first, deletions happen
# last, so the window where the tree is half-old/half-new is as short as rsync
# can make it.
rsync -a --delay-updates --delete-delay -- "$assembly/" "$target_abs/"

# The manifest is what makes "what is live?" answerable. It sits BESIDE the
# served tree, not in it — publishing it would put the build's git sha and
# dirty flag on the wire for anyone who asks. Written only once the publish
# has actually succeeded, so it never describes a deploy that did not land.
cat >"$manifest" <<EOF
{
  "assembly": "$name",
  "builtAt": "$stamp",
  "git": "$sha",
  "dirty": $dirty,
  "mode": "$mode",
  "files": $files
}
EOF

[ -f "$target_abs/index.html" ] || fail "published tree has no index.html"
[ -z "$(find "$target_abs" -type f -name '*.map' -print -quit)" ] ||
    fail "sourcemaps present under $target_abs"
[ -z "$(find "$target_abs" -type d -name '.~tmp~' -print -quit)" ] ||
    fail "an rsync partial-transfer reservoir (.~tmp~) survives under $target_abs — the publish was interrupted"
[ ! -e "$target_abs/deploy-manifest.json" ] ||
    fail "deploy-manifest.json is inside the served tree ($target_abs); it belongs beside it, not on the wire"
live="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).assembly)' \
    "$manifest")"
[ "$live" = "$name" ] || fail "manifest at $manifest says '$live', expected '$name'"

# Keep the 3 newest assemblies. The UTC stamp leads the name, so lexical sort
# is chronological; the pattern match means only directories this script
# created are ever candidates, and only inside deploy/.
stale="$(ls -1 "$deploy_root" |
    grep -E '^[0-9]{8}T[0-9]{6}Z-g[0-9a-z]+(-dirty)?-(multi|core)$' |
    sort | head -n -3 || true)"
if [ -n "$stale" ]; then
    while IFS= read -r old; do
        [ -d "$deploy_root/$old" ] || continue
        rm -rf -- "$deploy_root/$old"
        echo "deploy: pruned deploy/$old"
    done <<<"$stale"
fi

echo
echo "deploy: assembly $name"
echo "deploy: files    $files"
echo "deploy: target   $target_abs"
echo "deploy: manifest $manifest (deliberately not served)"

if [ "$target_was_bare" = true ]; then
    echo
    echo "deploy: NOTE — the target was missing or empty before this publish."
    echo "deploy:        The backend creates its static mount at STARTUP, and only"
    echo "deploy:        when static/ is non-empty. If the service was already"
    echo "deploy:        running before this first publish it has no mount, and"
    echo "deploy:        must be restarted once to pick the tree up:"
    echo "deploy:          systemctl --user restart karaoke-backend"
    echo "deploy:        (a restart kills in-flight stem/transcription jobs)"
fi
