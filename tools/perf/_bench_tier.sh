#!/usr/bin/env bash
# Inner script for bench_ram.sh — runs inside a memory-limited cgroup scope.
# Called by systemd-run, so this is a file (not a -c string) to avoid
# systemd-run's environment variable expansion on the command text.
set -euo pipefail

REPO="$1"; TIER="$2"; TIER_DIR="$3"; UI_SECONDS="$4"; API_SECONDS="$5"
SETTLE="$6"; UI_PROFILE="$7"
cd "$REPO"

# Find our cgroup for OOM event counting
CGROUP_DIR=$(awk -F: '$1=="0" {print "/sys/fs/cgroup" $3}' /proc/self/cgroup)

oom_count() {
  if [ -f "$CGROUP_DIR/memory.events" ]; then
    grep -oP 'oom_kill \K\d+' "$CGROUP_DIR/memory.events" 2>/dev/null || echo 0
  else
    echo -1
  fi
}

mem_current() {
  if [ -f "$CGROUP_DIR/memory.current" ]; then
    awk '{printf "%.0f", $1/1048576}' "$CGROUP_DIR/memory.current"
  else
    echo -1
  fi
}

OOM_BEFORE=$(oom_count)

echo "[${TIER}] starting backend..."
bash scripts/run-api.sh &
API_PID=$!

echo "[${TIER}] starting vite..."
pnpm --filter @osint/web dev --host 127.0.0.1 > "$TIER_DIR/vite.log" 2>&1 &
VITE_PID=$!

# Wait for backend
echo "[${TIER}] waiting for :8000..."
ELAPSED=0
while ! curl -sf --max-time 3 http://127.0.0.1:8000/api/status >/dev/null 2>&1; do
  sleep 2; ELAPSED=$((ELAPSED + 2))
  if [ "$ELAPSED" -ge 120 ]; then
    echo "[${TIER}] BACKEND FAILED TO START (OOM likely)"
    echo '{"error":"backend_timeout","tier":"'"$TIER"'","oom_kills":'"$(oom_count)"'}' > "$TIER_DIR/summary.json"
    kill $API_PID $VITE_PID 2>/dev/null || true; wait 2>/dev/null || true; exit 0
  fi
  if ! kill -0 $API_PID 2>/dev/null; then
    echo "[${TIER}] BACKEND PROCESS DIED (OOM kill)"
    echo '{"error":"backend_oom","tier":"'"$TIER"'","oom_kills":'"$(oom_count)"'}' > "$TIER_DIR/summary.json"
    kill $VITE_PID 2>/dev/null || true; wait 2>/dev/null || true; exit 0
  fi
done
echo "[${TIER}] backend ready"

# Wait for Vite
echo "[${TIER}] waiting for :5173..."
ELAPSED=0
while ! curl -sf --max-time 3 http://127.0.0.1:5173/ >/dev/null 2>&1; do
  sleep 2; ELAPSED=$((ELAPSED + 2))
  if [ "$ELAPSED" -ge 90 ]; then
    echo "[${TIER}] VITE FAILED TO START"
    echo '{"error":"vite_timeout","tier":"'"$TIER"'","oom_kills":'"$(oom_count)"'}' > "$TIER_DIR/summary.json"
    kill $API_PID $VITE_PID 2>/dev/null || true; wait 2>/dev/null || true; exit 0
  fi
done
echo "[${TIER}] vite ready"

echo "[${TIER}] settling ${SETTLE}s for feeds to populate..."
sleep "$SETTLE"
echo "[${TIER}] memory after settle: $(mem_current) MB / $TIER"

# Grab /api/status snapshot
curl -sf http://127.0.0.1:8000/api/status 2>/dev/null > "$TIER_DIR/api_status.json" || true

# Run measure_ui.mjs (launches Chrome inside this cgroup)
echo "[${TIER}] running measure_ui.mjs (${UI_SECONDS}s, profile=$UI_PROFILE)..."
node tools/perf/measure_ui.mjs \
  --seconds "$UI_SECONDS" \
  --profile "$UI_PROFILE" \
  --out "$TIER_DIR/ui.json" \
  > "$TIER_DIR/ui.log" 2>&1 || true
echo "[${TIER}] measure_ui done, memory: $(mem_current) MB"

# Run measure_api.py
echo "[${TIER}] running measure_api.py (${API_SECONDS}s)..."
apps/api/.venv/bin/python tools/perf/measure_api.py \
  --seconds "$API_SECONDS" --routes \
  > "$TIER_DIR/api.log" 2>&1 || true
echo "[${TIER}] measure_api done"

# Collect final stats
OOM_AFTER=$(oom_count)
OOM_DELTA=$((OOM_AFTER - OOM_BEFORE))
MEM_FINAL=$(mem_current)

echo "[${TIER}] OOM kills during this tier: $OOM_DELTA"
echo "[${TIER}] final memory: ${MEM_FINAL} MB"

# Write tier summary
python3 -c "
import json, sys
ui = {}
try: ui = json.load(open('$TIER_DIR/ui.json'))
except: pass
status = {}
try: status = json.load(open('$TIER_DIR/api_status.json'))
except: pass
summary = {
    'tier': '$TIER',
    'oom_kills': $OOM_DELTA,
    'mem_final_mb': $MEM_FINAL,
    'aircraft': status.get('aircraft_count', -1),
    'vessels': status.get('vessel_count', -1),
    'ui_verdict': ui.get('verdict', 'NO DATA'),
    'ui_renderMs_p95': ui.get('renderMsP95', None),
    'ui_pass': ui.get('pass', None),
    'ui_entities': ui.get('entitiesAtStart', -1),
    'ui_dataSources': ui.get('dataSources', -1),
    'ui_heap_mb': (ui.get('series', {}).get('heapMB', {}).get('p95', None)),
    'ui_fps_p50': (ui.get('series', {}).get('rendersPerSec', {}).get('p50', None)),
    'ui_fps_p05': (ui.get('series', {}).get('rendersPerSec', {}).get('p05', None)),
    'console_errors': ui.get('consoleErrors', -1),
}
json.dump(summary, sys.stdout, indent=2)
print()
" > "$TIER_DIR/summary.json"

kill $API_PID $VITE_PID 2>/dev/null || true
wait 2>/dev/null || true
