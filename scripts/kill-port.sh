#!/usr/bin/env bash
# Kill whatever process is listening on a TCP port.
# Usage: scripts/kill-port.sh 8000
# This is the sanctioned way to stop a dev server here — pkill by argv pattern
# misses processes whose argv is just "node index.js" and leaves stale listeners.
set -euo pipefail
port=${1:?usage: kill-port.sh PORT}
pids=$(ss -ltnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
if [ -z "$pids" ]; then
  echo "nothing listening on :$port"
  exit 0
fi
echo "killing pid(s) $pids listening on :$port"
# TERM first, then verify, then SIGKILL the process GROUP.
#
# A plain `kill` is not enough for the browser sidecars (:8090, :8093, :8095):
# Playwright installs its own SIGTERM listener, and once ANY listener is
# attached Node stops doing its default terminate — so the feeder swallows the
# signal and keeps serving. Measured 2026-08-02: `kill-port.sh 8090` reported
# success and the same pid was still LISTENing 30 s later, which reads as "the
# kill worked but the thing came back" and sends you debugging the supervisor.
# The AIS twin taught the same lesson in 2026-07-15 (still LISTENing 12 s after
# `kill`, gone 2 s after `kill -9`). The group kill also takes the Chrome tree,
# which otherwise outlives its parent and holds memory.
# shellcheck disable=SC2086
kill $pids 2>/dev/null || true

for _ in $(seq 1 10); do
  sleep 0.5
  still=$(ss -ltnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
  [ -z "$still" ] && echo "stopped :$port" && exit 0
done

echo "still holding :$port after SIGTERM — escalating to SIGKILL"
for pid in $still; do
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$pgid" ]; then kill -9 -- "-$pgid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
  else kill -9 "$pid" 2>/dev/null || true; fi
done
sleep 1
if ss -ltnp "sport = :$port" 2>/dev/null | grep -q 'pid='; then
  echo "FAILED to free :$port" >&2
  exit 1
fi
echo "stopped :$port (SIGKILL)"
