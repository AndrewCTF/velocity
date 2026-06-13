#!/usr/bin/env bash
# Pre-PR detailed checks — run the full gauntlet before pushing a pull request.
#
#   ./scripts/preflight.sh
#
# Exits non-zero on the first failure. Mirrors what CI enforces:
#   - backend: ruff lint + pytest (CLAUDE.md bar: >=25 passed)
#   - frontend: tsc typecheck + eslint (0 warnings) + vitest + vite build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/apps/api"
PY="$API/.venv/bin"

bold() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

bold "backend · ruff"
( cd "$API" && "$PY/ruff" check app/ tests/ )

bold "backend · pytest"
( cd "$API" && "$PY/python" -m pytest -q )

bold "frontend · typecheck (all workspaces)"
( cd "$ROOT" && pnpm -r typecheck )

bold "frontend · eslint"
( cd "$ROOT/apps/web" && pnpm lint )

bold "frontend · vitest"
( cd "$ROOT/apps/web" && pnpm test )

bold "frontend · vite build"
( cd "$ROOT/apps/web" && pnpm build )

printf '\n\033[1;32mPREFLIGHT GREEN — safe to open a PR.\033[0m\n'
