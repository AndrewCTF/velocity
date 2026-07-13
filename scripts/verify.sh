#!/usr/bin/env bash
# One-command verification for the whole platform.
#
#   bash scripts/verify.sh            static: typecheck + lint + web unit + api pytest
#   bash scripts/verify.sh --live     also probe the running backend on :8000
#                                     (feed freshness, aircraft/vessel counts,
#                                      sidecar health). Set OSINT_PROBE_KEY if
#                                      the API enforces X-API-Key.
#
# Exit code 0 = everything ran and passed. Any failure is reported and the
# script keeps going so one run yields the full picture.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/apps/api/.venv/bin/python"
FAIL=0

step() {
  echo
  echo "===== $1"
  shift
  if ! "$@"; then
    echo "----- FAILED: $1"
    FAIL=1
  fi
}

cd "$ROOT"

step "typecheck (pnpm -r typecheck)" pnpm -r typecheck
step "lint (pnpm -r lint)" pnpm -r lint
step "web unit tests (vitest)" pnpm --dir "$ROOT/apps/web" test
step "api lint (ruff)" "$ROOT/apps/api/.venv/bin/ruff" check "$ROOT/apps/api"
step "api tests (pytest, background feeds off)" \
  env OSINT_DISABLE_BACKGROUND=1 "$ROOT/apps/api/.venv/bin/pytest" "$ROOT/apps/api" -q

if [ "${1:-}" = "--live" ]; then
  echo
  echo "===== live probes (backend on :8000)"
  step "adsb freshness + counts" "$PY" - <<'EOF'
import json
import os
import time
import urllib.request

BASE = "http://127.0.0.1:8000"
headers = {}
if os.environ.get("OSINT_PROBE_KEY"):
    headers["X-API-Key"] = os.environ["OSINT_PROBE_KEY"]


def pull(path):
    req = urllib.request.Request(BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


a = pull("/api/adsb/global?limit=20000")
time.sleep(8)
b = pull("/api/adsb/global?limit=20000")

fa = {f["id"]: f for f in a.get("features", []) if "id" in f}
fb = {f["id"]: f for f in b.get("features", []) if "id" in f}
common = set(fa) & set(fb)
changed = sum(
    1
    for i in common
    if fa[i].get("properties", {}).get("seen_pos_s") != fb[i].get("properties", {}).get("seen_pos_s")
)
pct = 100 * changed / max(1, len(common))
print(f"aircraft: {len(fa)} -> {len(fb)} features; {pct:.0f}% of {len(common)} common ids refreshed seen_pos_s over 8s")
assert len(fb) >= 8000, f"aircraft count {len(fb)} < 8000 floor (feed regression)"
assert pct >= 20, f"only {pct:.0f}% refreshed over 8s — blob looks frozen (probe the fan-out, not the frontend)"
print("adsb: OK")
EOF

  step "vessel count" "$PY" - <<'EOF'
import json
import urllib.request

# AIS has no HTTP snapshot route (vessels are WS-push via /ws/ais); the keyless
# /api/status endpoint carries the unified store's live vessel_count instead.
with urllib.request.urlopen("http://127.0.0.1:8000/api/status", timeout=30) as r:
    body = json.load(r)
assert "vessel_count" in body, "/api/status lost its vessel_count field"
print(f"vessels: {body['vessel_count']} ({body.get('parked_count', 0)} parked)")
EOF

  step "sidecar health" bash -c '
    for port in 8090 8093; do
      out=$(curl -sf -m 5 "http://127.0.0.1:$port/health" 2>/dev/null) \
        || out=$(curl -sf -m 5 "http://127.0.0.1:$port/aircraft.json" 2>/dev/null | head -c 200) \
        || out=$(curl -sf -m 5 "http://127.0.0.1:$port/vessels.json" 2>/dev/null | head -c 200)
      if [ -n "$out" ]; then echo ":$port alive"; else echo ":$port NOT answering (sidecar down?)"; fi
    done'
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify: ALL GREEN"
else
  echo "verify: FAILURES above"
fi
exit "$FAIL"
