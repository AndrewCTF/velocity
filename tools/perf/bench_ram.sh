#!/usr/bin/env bash
# Benchmark the full stack (API backend + Vite + 3D Cesium globe in Chrome)
# under cgroup v2 RAM limits from 4 GB to 128 GB.
#
# Each tier runs inside a systemd user scope with MemoryMax set and swap
# disabled, so ALL processes (uvicorn, sidecars, Vite, Chrome) share one
# pool. The existing measure_ui.mjs (real Chrome, real GPU, camera legs)
# and measure_api.py (/proc sampling) do the actual measurement.
#
#   bash tools/perf/bench_ram.sh
#   bash tools/perf/bench_ram.sh --tiers "8G 16G 32G"
#   bash tools/perf/bench_ram.sh --ui-seconds 120 --settle 45
#
# Results land in tools/perf/ram-bench-results/<timestamp>/.
# Requires: systemd-run --user with memory controller delegated (cgroup v2).
set -euo pipefail
cd "$(dirname "$0")/../.."

# ponytail: descending order — 128G control runs on fresh feeds; 4G (guaranteed
# OOM, baseline tree is ~10GB) goes last where rate-limiting no longer matters.
TIERS="128G 64G 32G 16G 8G 4G"
UI_SECONDS=60
API_SECONDS=30
SETTLE=45
UI_PROFILE="all-toggles"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tiers)       TIERS="$2"; shift 2;;
    --ui-seconds)  UI_SECONDS="$2"; shift 2;;
    --api-seconds) API_SECONDS="$2"; shift 2;;
    --settle)      SETTLE="$2"; shift 2;;
    --profile)     UI_PROFILE="$2"; shift 2;;
    *) echo "unknown: $1" >&2; exit 1;;
  esac
done

STAMP=$(date '+%Y%m%d-%H%M%S')
OUT="tools/perf/ram-bench-results/$STAMP"
mkdir -p "$OUT"

echo "# RAM benchmark — $STAMP"
echo "tiers: $TIERS"
echo "ui_seconds=$UI_SECONDS  api_seconds=$API_SECONDS  settle=$SETTLE  profile=$UI_PROFILE"
echo "results: $OUT/"
echo

TIER_SCRIPT="$(dirname "$0")/_bench_tier.sh"

for TIER in $TIERS; do
  echo "=========================================="
  echo "=== TIER: $TIER"
  echo "=========================================="
  TIER_DIR="$OUT/$TIER"
  mkdir -p "$TIER_DIR"

  # Kill any leftover servers from the previous tier
  for p in 8000 5173 8090 8093 8095; do
    bash scripts/kill-port.sh "$p" 2>/dev/null || true
  done
  sleep 2

  # Run everything inside a memory-limited scope.
  # The tier script is a FILE (not a -c string) so systemd-run cannot do
  # its own $VAR expansion on the script text.
  systemd-run --user --scope \
    --property="MemoryMax=$TIER" \
    --property="MemorySwapMax=0" \
    --unit="bench-ram-${TIER}-${STAMP}" \
    bash "$TIER_SCRIPT" "$PWD" "$TIER" "$TIER_DIR" "$UI_SECONDS" "$API_SECONDS" "$SETTLE" "$UI_PROFILE" \
    2>&1 | tee "$TIER_DIR/tier.log" || {
      echo "[${TIER}] scope exited with error (likely OOM killed the scope itself)"
      echo '{"error":"scope_killed","tier":"'"$TIER"'","oom_kills":-1}' > "$TIER_DIR/summary.json"
    }

  echo
done

# Generate comparison report
echo
echo "=========================================="
echo "=== COMPARISON REPORT"
echo "=========================================="
echo

python3 -c "
import json, os, sys
out_dir = '$OUT'
tiers = '$TIERS'.split()
rows = []
for t in tiers:
    p = os.path.join(out_dir, t, 'summary.json')
    try:
        d = json.load(open(p))
    except:
        d = {'tier': t, 'error': 'no data'}
    rows.append(d)

print('| RAM | Status | OOM | Mem MB | Aircraft | Vessels | FPS p50 | FPS p05 | renderMs p95 | JS Heap MB | Entities |')
print('|-----|--------|-----|--------|----------|---------|---------|---------|--------------|------------|----------|')
for r in rows:
    err = r.get('error')
    if err:
        print(f'| {r[\"tier\"]} | **{err}** | {r.get(\"oom_kills\",\"?\")} | — | — | — | — | — | — | — | — |')
        continue
    def f(v, nd=1):
        if v is None or v == -1: return '—'
        return f'{v:.{nd}f}' if isinstance(v, float) else str(v)
    print(f'| {r[\"tier\"]} | {r.get(\"ui_verdict\",\"?\")[:20]} | {r.get(\"oom_kills\",\"?\")} | {f(r.get(\"mem_final_mb\"))} | {f(r.get(\"aircraft\"),0)} | {f(r.get(\"vessels\"),0)} | {f(r.get(\"ui_fps_p50\"))} | {f(r.get(\"ui_fps_p05\"))} | {f(r.get(\"ui_renderMs_p95\"))} | {f(r.get(\"ui_heap_mb\"))} | {f(r.get(\"ui_entities\"),0)} |')

combined = os.path.join(out_dir, 'comparison.json')
json.dump(rows, open(combined, 'w'), indent=2)
print(f'\nFull data: {combined}')
" | tee "$OUT/report.md"

echo
echo "Done. Results in $OUT/"
