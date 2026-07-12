#!/usr/bin/env bash
#
# Deploy Velocity (web + Cloudflare container):
#   web  — build apps/web, assemble site/app, push the Cloudflare Worker
#          (the Worker references apps/api/Dockerfile, so the backend container
#          is built + pushed by `wrangler deploy` as part of this)
#
# Usage:
#   scripts/deploy.sh [web]      (default: web)
#
# The legacy VPS (rsync apps/api -> systemd velocity-api) deploy path was
# removed — the backend now ships as the Cloudflare container image built from
# apps/api/Dockerfile.
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

case "${1:-web}" in
  web) deploy_web ;;
  *) echo "usage: $0 [web]"; exit 2 ;;
esac

echo "==> deploy complete"
