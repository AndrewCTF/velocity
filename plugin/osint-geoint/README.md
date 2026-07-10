# OSINT GEOINT — Claude Code plugin

Live geospatial intelligence as MCP tools, bundled with an analyst **skill**,
three **slash commands**, and a **watch-officer agent**. Sweep the planet for a
few hundred tokens; drill on demand.

- **22 MCP tools** over live ADS-B (aircraft), AIS (vessels), a GPS-jamming
  layer, Sentinel-1 SAR dark vessels, geocoded events, and a cross-domain
  incident-fusion engine.
- **Context-optimised** — every heavy tool takes `detail='short'` (a token-frugal
  digest, the default) or `detail='long'` (the full bundle). See the skill.
- **Skill** `osint-intel` teaches the brief-first → drill-second workflow, with
  `reference/tools.md` and `reference/workflows.md` loaded on demand.
- **Commands** `/osint-brief`, `/osint-watch`, `/osint-jamming`.
- **Agent** `osint-watch-officer` for standing surveillance.

## Install

The tools query a **local OSINT backend**, so start it first (from the repo root):

```bash
bash scripts/run-api.sh          # backend on :8000
```

**Full plugin** (MCP + skill + commands + agent):

```
/plugin marketplace add /path/to/OSINT
/plugin install osint-geoint@osint-velocity
```

When prompted, set **repo_dir** to your cloned OSINT repo (the folder containing
`apps/api`) and **python** to that repo's venv interpreter —
`apps/api/.venv/bin/python` (macOS/Linux) or `apps\api\.venv\Scripts\python.exe`
(Windows). `api_base` defaults to `http://127.0.0.1:8000`. The plugin launches
that Python directly (`python -m app.mcp_server`), so the same manifest works on
Windows, macOS, and Linux.

**MCP only** (no skill/commands), or to script it — the installer prints the exact
commands for your OS and, with the run flag, registers the server via
`claude mcp add`:

```bash
# Linux / macOS  (or double-click install.command on macOS)
bash plugin/osint-geoint/install.sh          # print commands
bash plugin/osint-geoint/install.sh -y       # also register the MCP server
```

```powershell
# Windows PowerShell  (or double-click install.cmd)
plugin\osint-geoint\install.ps1              # print commands
plugin\osint-geoint\install.ps1 -Run         # also register the MCP server
```

**Hosted** (no local backend; needs a Velocity token):

```bash
claude mcp add --transport http osint-geoint \
  https://projectvelocity.org/mcp \
  --header "Authorization: Bearer $VELOCITY_TOKEN"
```

## First moves

`get_situation()` to orient → `intel_brief()` for cited cross-domain incidents →
`focus_area(lat, lon)` to load a region PRIMARY → drill with `query_vessels` /
`gps_jamming` / `detect_deception` → `deep_analyze()` for an off-context judgement.

Full architecture and the `/api/intel/*` HTTP surface: [`docs/mcp-server.md`](../../docs/mcp-server.md).
