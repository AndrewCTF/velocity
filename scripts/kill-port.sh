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
# shellcheck disable=SC2086
kill $pids
