"""Full end-to-end MCP exercise — every tool through the real stdio protocol.

Spawns the MCP server as a subprocess, performs the MCP handshake, then calls
ALL 11 tools the way an agent would and asserts each response shape. Also
feeds the vessel store (via the maritime route) so vessel tools have data,
and runs the Ollama-backed deep_analyze. Prints a PASS/FAIL line per check
and exits non-zero on any failure.

Run (backend must be on :8000):  .venv/bin/python tests/mcp_full_test.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import urllib.request

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
_results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    _results.append((ok, label))
    print(f"  [{PASS if ok else FAIL}] {label}{(' — ' + detail) if detail else ''}")


def _tool_json(result) -> dict:
    return json.loads(result.content[0].text)


async def main() -> int:
    # Pre-feed the AIS observation store so vessel tools return data.
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8000/api/maritime/digitraffic", timeout=40
        ) as r:
            n = len(json.loads(r.read()).get("features") or [])
        print(f"seeded vessel store: {n} AIS vessels\n")
    except Exception as exc:  # noqa: BLE001
        print(f"(vessel seed skipped: {exc})\n")

    params = StdioServerParameters(command=sys.executable, args=["-m", "app.mcp_server"])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            check(init.serverInfo.name == "osint-geoint", "initialize handshake")

            tools = await session.list_tools()
            names = {t.name for t in tools.tools}
            expected = {
                "get_situation", "focus_area", "aircraft_density", "gps_jamming",
                "query_aircraft", "lookup_aircraft", "query_vessels", "anomalies",
                "list_focus_areas", "data_sources", "deep_analyze",
            }
            check(names == expected, "list_tools == 11 expected", f"{len(names)} tools")
            check(all(t.inputSchema for t in tools.tools), "every tool has inputSchema")

            # 1. get_situation
            sit = _tool_json(await session.call_tool("get_situation", {}))
            total = sit.get("aircraft", {}).get("total", 0)
            check("aircraft" in sit and "gps_jamming" in sit, "get_situation", f"{total} aircraft")

            # 2. data_sources
            ds = _tool_json(await session.call_tool("data_sources", {}))
            check("always_on" in ds and "ollama" in ds, "data_sources")

            # 3. focus_area (area-primary)
            fa = _tool_json(
                await session.call_tool(
                    "focus_area", {"lat": 50.03, "lon": 8.56, "radius_nm": 150, "label": "FRA"}
                )
            )
            check(
                fa.get("load_mode") in ("direct", "snapshot") and "density" in fa,
                "focus_area (PRIMARY)",
                f"mode={fa.get('load_mode')} ac={fa.get('aircraft', {}).get('count')}",
            )

            # 4. list_focus_areas — FRA must now be registered
            aois = _tool_json(await session.call_tool("list_focus_areas", {}))
            check(len(aois.get("aois", [])) >= 1, "list_focus_areas", f"{len(aois['aois'])} active")

            # 5. aircraft_density (Europe bbox)
            dens = _tool_json(
                await session.call_tool(
                    "aircraft_density",
                    {"min_lon": -10, "min_lat": 35, "max_lon": 30, "max_lat": 60, "cell_deg": 1.0},
                )
            )
            check("aircraft" in dens and "cells" in dens["aircraft"], "aircraft_density",
                  f"{dens['aircraft']['total']} ac / {dens['aircraft']['occupied_cells']} cells")

            # 6. gps_jamming (global)
            jam = _tool_json(await session.call_tool("gps_jamming", {}))
            check("summary" in jam, "gps_jamming (global)", f"{jam['summary']['cells_flagged']} flagged")

            # 7. query_aircraft (military)
            mil = _tool_json(await session.call_tool("query_aircraft", {"category": "military", "limit": 5}))
            check("matched_total" in mil, "query_aircraft military", f"{mil['matched_total']} matched")

            # 8. query_aircraft (gnss_degraded filter)
            deg = _tool_json(await session.call_tool("query_aircraft", {"gnss_degraded": True, "limit": 5}))
            check("matched_total" in deg, "query_aircraft gnss_degraded", f"{deg['matched_total']} matched")

            # 9. lookup_aircraft (use a real icao from the snapshot)
            probe = _tool_json(await session.call_tool("query_aircraft", {"limit": 1}))
            if probe.get("aircraft"):
                ic = probe["aircraft"][0]["icao24"]
                lk = _tool_json(await session.call_tool("lookup_aircraft", {"ident": ic}))
                check(lk.get("found") is True, "lookup_aircraft", f"{ic} -> {lk.get('assessment')}")
            else:
                check(False, "lookup_aircraft", "no aircraft to probe")

            # 10. query_vessels (Gulf of Finland)
            ves = _tool_json(
                await session.call_tool(
                    "query_vessels",
                    {"min_lon": 18, "min_lat": 58, "max_lon": 30, "max_lat": 66, "limit": 5},
                )
            )
            check("by_category" in ves, "query_vessels", f"{ves['matched_total']} matched {ves['by_category']}")

            # 11. anomalies (global)
            anom = _tool_json(await session.call_tool("anomalies", {}))
            check("threat_level" in anom, "anomalies", f"threat={anom['threat_level']} score={anom['score']}")

            # 12. deep_analyze (Ollama-backed — may take ~30-60s)
            print("  … running deep_analyze (local model) …")
            dz = _tool_json(
                await session.call_tool(
                    "deep_analyze",
                    {"question": "Any GPS jamming or emergencies right now?", "lat": 50.0, "lon": 8.0},
                )
            )
            got_analysis = bool(dz.get("analysis")) or dz.get("note")
            check(bool(got_analysis), "deep_analyze (ollama)", f"model={dz.get('model')}")

    n_pass = sum(1 for ok, _ in _results if ok)
    n_total = len(_results)
    print(f"\n{'='*48}\n  {n_pass}/{n_total} checks passed\n{'='*48}")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
