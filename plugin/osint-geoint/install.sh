#!/usr/bin/env bash
# Ez-install the OSINT GEOINT MCP server into Claude Code — Linux & macOS.
# (Windows: use plugin/osint-geoint/install.ps1)
#
#   bash plugin/osint-geoint/install.sh        # print the exact install commands
#   bash plugin/osint-geoint/install.sh -y     # also register the MCP server now
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"                 # plugin/osint-geoint -> repo root
py="$repo/apps/api/.venv/bin/python"
[ -x "$py" ] || py="$(command -v python3 || echo python3)"
api_base="${API_BASE:-http://127.0.0.1:8000}"

echo "OSINT repo:  $repo"
echo "Python:      $py"
echo "API base:    $api_base"
echo

echo "── Option A — full plugin (MCP + skill + commands + agent) ──────────────"
echo "In Claude Code, run:"
echo "    /plugin marketplace add $repo"
echo "    /plugin install osint-geoint@osint-velocity"
echo "  When prompted:  repo_dir = $repo   python = $py"
echo
echo "── Option B — MCP server only (Claude Code CLI) ─────────────────────────"
echo "    claude mcp add osint-geoint \\"
echo "        --env \"PYTHONPATH=$repo/apps/api\" \\"
echo "        --env \"API_BASE=$api_base\" \\"
echo "        -- \"$py\" -m app.mcp_server"
echo
echo "── Option C — hosted (no local backend; needs a Velocity token) ─────────"
echo "    claude mcp add --transport http osint-geoint \\"
echo "        https://projectvelocity.org/mcp \\"
echo "        --header \"Authorization: Bearer \$VELOCITY_TOKEN\""
echo
echo "NOTE: Options A/B query a LOCAL backend — start it first:  bash scripts/run-api.sh"

if [ "${1:-}" = "-y" ] || [ "${INSTALL_RUN:-}" = "1" ]; then
  command -v claude >/dev/null 2>&1 || { echo "'claude' not on PATH — install the Claude Code CLI first." >&2; exit 1; }
  echo
  echo "Registering the MCP server via 'claude mcp add'…"
  claude mcp add osint-geoint \
    --env "PYTHONPATH=$repo/apps/api" \
    --env "API_BASE=$api_base" \
    -- "$py" -m app.mcp_server
  echo "Done. Verify with:  claude mcp list"
fi
