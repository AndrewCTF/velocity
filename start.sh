#!/usr/bin/env bash
# Launch the full OSINT stack: FastAPI backend (uvicorn) + Vite frontend.
#
# Backend goes through scripts/run-api.sh so LD_PRELOAD=jemalloc is set before
# the process starts (see that script for why — bare `uvicorn` ratchets RSS into
# the tens of GB under sustained feed load). Frontend is the Vite dev server.
#
# Usage:
#   bash start.sh                 # both on default ports (API 8000, web 5173)
#   API_PORT=8001 bash start.sh   # override backend port
# Ctrl-C tears down both.
set -euo pipefail
cd "$(dirname "$0")"

API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"

# Free stale holders first: a leftover backend/frontend on these ports makes
# uvicorn/vite fail to bind, and under `wait -n` the first dead child tears the
# whole stack down — reads as an instant crash. Clear them before launching.
for port in "$API_PORT" "$WEB_PORT"; do
  holders="$(lsof -ti ":$port" 2>/dev/null || true)"
  if [[ -n "$holders" ]]; then
    echo "[start] port $port busy (pids: $holders) — freeing"
    if [[ -x scripts/kill-port.sh ]]; then
      bash scripts/kill-port.sh "$port" || true
    fi
    # kill-port may miss non-listening children; force any survivors
    holders="$(lsof -ti ":$port" 2>/dev/null || true)"
    [[ -n "$holders" ]] && kill -9 $holders 2>/dev/null || true
  fi
done

pids=()
cleanup() {
  echo
  echo "[start] shutting down…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[start] backend  → http://localhost:${API_PORT}  (uvicorn app.main:app)"
API_PORT="$API_PORT" bash scripts/run-api.sh &
pids+=($!)

echo "[start] frontend → http://localhost:${WEB_PORT}  (vite)"
# Run the locally-installed vite binary directly. pnpm lives under nvm and is
# often not on PATH in a non-login shell, so `pnpm dev` fails with "command not
# found"; the vendored ./node_modules/.bin/vite always works. Fall back to a
# package manager only if the binary is missing (deps not installed yet).
(
  cd apps/web
  if [[ -x node_modules/.bin/vite ]]; then
    exec node_modules/.bin/vite --port "$WEB_PORT"
  elif command -v pnpm >/dev/null 2>&1; then
    exec pnpm dev --port "$WEB_PORT"
  else
    exec npx vite --port "$WEB_PORT"
  fi
) &
pids+=($!)

# If either process exits, tear the other down too.
wait -n
