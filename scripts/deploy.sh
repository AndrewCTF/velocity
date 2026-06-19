#!/usr/bin/env bash
#
# Deploy Velocity. Two targets:
#   web  — build apps/web, assemble site/app, push the Cloudflare Worker
#   api  — rsync apps/api to the droplet, restart the systemd unit
#
# Usage:
#   scripts/deploy.sh [web|api|all]      (default: all)
#
# Backend host / credentials come from the environment (never hard-coded):
#   DROPLET_HOST   (default 167.99.149.34)
#   DROPLET_USER   (default root)
#   REMOTE_API_DIR (default /opt/velocity-api)
#   SSHPASS        password for sshpass; if unset, plain ssh (keys/agent) is used
#
# THE CESIUM TRAP this script exists to prevent:
#   `vite build --base=/app/` writes the Cesium runtime to dist/app/cesium
#   (vite-plugin-cesium does path.join(outDir, CESIUM_BASE_URL) and CESIUM_BASE_URL
#   is "/app/cesium/"), NOT dist/cesium. The page references /app/cesium/Cesium.js.
#   A naive `rsync --delete dist/ site/app/` therefore never carries cesium AND
#   deletes the previous copy -> blank globe ("Cesium is not defined"). We assemble
#   site/app from the two real roots: dist (index.html + assets) and dist/app/cesium.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BASE="/app/"

DROPLET_HOST="${DROPLET_HOST:-167.99.149.34}"
DROPLET_USER="${DROPLET_USER:-root}"
REMOTE_API_DIR="${REMOTE_API_DIR:-/opt/velocity-api}"

# ssh/rsync transport: use sshpass only when SSHPASS is exported, else plain ssh.
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
if [ -n "${SSHPASS:-}" ]; then
  SSH_BIN="sshpass -e ssh ${SSH_OPTS}"
else
  SSH_BIN="ssh ${SSH_OPTS}"
fi

deploy_web() {
  echo "==> [web] typecheck + build (base=${APP_BASE})"
  ( cd "${ROOT}/apps/web" && pnpm exec tsc --noEmit && pnpm exec vite build --base="${APP_BASE}" )

  echo "==> [web] assemble site/app from dist (index.html+assets) and dist/app/cesium"
  # index.html, assets/, favicon.svg — protect cesium/ from --delete, ignore the nested app/.
  rsync -a --delete --exclude='cesium/' --exclude='app/' \
    "${ROOT}/apps/web/dist/" "${ROOT}/site/app/"
  # The Cesium runtime, from its real (base-nested) location.
  rsync -a --delete \
    "${ROOT}/apps/web/dist/app/cesium/" "${ROOT}/site/app/cesium/"

  echo "==> [web] sanity check"
  test -f "${ROOT}/site/app/cesium/Cesium.js" \
    || { echo "FATAL: site/app/cesium/Cesium.js missing — cesium copy failed"; exit 1; }
  test -f "${ROOT}/site/app/index.html" \
    || { echo "FATAL: site/app/index.html missing"; exit 1; }

  echo "==> [web] wrangler deploy"
  ( cd "${ROOT}/site" && node_modules/.bin/wrangler deploy )
  echo "==> [web] done"
}

deploy_api() {
  echo "==> [api] rsync apps/api -> ${DROPLET_USER}@${DROPLET_HOST}:${REMOTE_API_DIR}"
  # Exclude runtime state (.venv rebuilt on host; data/ holds the multi-GB history.db
  # + tilecache) and dev caches. Never carry these up or down.
  rsync -az --delete \
    --exclude='.venv' --exclude='data' \
    --exclude='.mypy_cache' --exclude='.ruff_cache' --exclude='.pytest_cache' \
    --exclude='__pycache__' --exclude='*.pyc' \
    -e "${SSH_BIN}" \
    "${ROOT}/apps/api/" "${DROPLET_USER}@${DROPLET_HOST}:${REMOTE_API_DIR}/"

  echo "==> [api] restart velocity-api + health"
  # shellcheck disable=SC2029
  ${SSH_BIN} "${DROPLET_USER}@${DROPLET_HOST}" '
    systemctl restart velocity-api
    sleep 4
    printf "active:"; systemctl is-active velocity-api
    for i in 1 2 3 4 5 6; do
      c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://127.0.0.1:8000/health || echo 000)
      echo "health:$c"
      [ "$c" != "000" ] && break
      sleep 2
    done
  '
  # health 401 == up (auth gate); 000 == not listening.
  echo "==> [api] done"
}

case "${1:-all}" in
  web) deploy_web ;;
  api) deploy_api ;;
  all) deploy_web; deploy_api ;;
  *) echo "usage: $0 [web|api|all]"; exit 2 ;;
esac

echo "==> deploy complete"
