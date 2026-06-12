"""Intel layer — deep, agent-facing analytics over the live OSINT feeds.

This package is what the MCP server (``app.mcp_server``) and the
``/api/intel/*`` routes are built on. It never opens its own steady-state
upstream fan-out; it reads the already-warm in-process ADS-B snapshot
(``app.routes.adsb.adsb_global``) and the fusion-engine observation store
(``app.correlate.store``), plus a *focused* per-area direct fetch
(``app.intel.aoi``) that the agent can prioritise without disturbing the
guarded global snapshot.

Design goals (per the MCP brief):
- **Area-primary loading** — an agent can mark an AOI; that area gets a
  dedicated, always-fresh direct fetch + ongoing priority refresh while the
  rest of the world keeps streaming from the global snapshot.
- **Context-safe JSON** — every public function returns bounded, distilled
  JSON (counts, grids, small samples), never a 15k-feature dump, so an
  agent's context window survives the query.
"""
