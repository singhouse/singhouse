#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# smoke_provider_seam.sh — verify the provider seam infrastructure is healthy.
#
# Neutral, public-safe curl assertions (no vendor-specific literals).
# Usage: backend/scripts/smoke_provider_seam.sh [BASE_URL]
# Default BASE_URL is http://localhost:8000.
#
# Exits 0 when all assertions pass, 1 on any failure.

set -euo pipefail

BASE="${1:-http://localhost:8000}"
FAIL=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=1; }

check_status() {
  local desc="$1" url="$2" want="$3"
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  if [ "$got" = "$want" ]; then
    pass "$desc (HTTP $got)"
  else
    fail "$desc — expected $want, got $got"
  fi
}

check_json() {
  local desc="$1" url="$2" jq_expr="$3"
  local body
  body=$(curl -s "$url")
  if echo "$body" | python3 -c "
import sys, json
data = json.load(sys.stdin)
expr = '$jq_expr'
# simple dot-path evaluation
for key in expr.split('.'):
    if key:
        data = data[key]
assert data is not None
" 2>/dev/null; then
    pass "$desc"
  else
    fail "$desc — JSON assertion failed"
  fi
}

echo "=== Provider seam smoke test ==="
echo "Target: $BASE"
echo ""

# 1. Health
check_status "health endpoint" "$BASE/health" 200

# 2. Catalog providers listing
check_status "GET /api/catalog/providers" "$BASE/api/catalog/providers" 200

# 3. Providers response is a JSON array
PROVIDERS=$(curl -s "$BASE/api/catalog/providers")
if echo "$PROVIDERS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
assert isinstance(data, list), f'expected list, got {type(data).__name__}'
" 2>/dev/null; then
  pass "providers response is a JSON array"
else
  fail "providers response is not a JSON array"
fi

# 4. If providers exist, each has name + capabilities
PROVIDER_COUNT=$(echo "$PROVIDERS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
if [ "$PROVIDER_COUNT" -gt 0 ]; then
  if echo "$PROVIDERS" | python3 -c "
import sys, json
for p in json.load(sys.stdin):
    assert 'name' in p, f'missing name: {p}'
    assert 'capabilities' in p, f'missing capabilities: {p}'
    assert isinstance(p['capabilities'], list)
" 2>/dev/null; then
    pass "all $PROVIDER_COUNT provider(s) have name + capabilities"
  else
    fail "provider(s) missing name or capabilities"
  fi
else
  echo "  INFO: zero providers registered (core-only mode)"
fi

# 5. Provider-owned route returns 404 (not 500) for nonexistent song
check_status "provider route 404 for missing song" "$BASE/api/songs/999999/lyrics/source-doc.xml" 404

# 6. Songs API is reachable (200 open or 401 auth-required — both healthy).
SONGS_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/songs")
if [ "$SONGS_CODE" = "200" ] || [ "$SONGS_CODE" = "401" ]; then
  pass "GET /api/songs reachable (HTTP $SONGS_CODE)"
else
  fail "GET /api/songs — expected 200 or 401, got $SONGS_CODE"
fi

echo ""
if [ "$FAIL" -eq 1 ]; then
  echo "SMOKE TEST FAILED"
  exit 1
fi
echo "SMOKE TEST PASSED"
exit 0
