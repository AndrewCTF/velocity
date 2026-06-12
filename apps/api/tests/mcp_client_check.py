"""Real MCP stdio handshake check — exercises the server the way an agent does.

Spawns `python -m app.mcp_server` as a subprocess, performs the MCP
initialize handshake, lists tools, and calls a few of them. This proves the
stdio transport is clean (no stray stdout) and the tool schemas are valid.

Run:  .venv/bin/python tests/mcp_client_check.py
Exits non-zero on any failure so it can gate CI.
"""

from __future__ import annotations

import asyncio
import json
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main() -> int:
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "app.mcp_server"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            print("✓ initialize:", init.serverInfo.name)

            tools = await session.list_tools()
            names = [t.name for t in tools.tools]
            print(f"✓ list_tools: {len(names)} tools -> {names}")
            assert len(names) == 11, f"expected 11 tools, got {len(names)}"

            # Every tool must expose a valid input schema (this is what an
            # agent reads to call the tool).
            for t in tools.tools:
                assert t.inputSchema is not None, f"{t.name} has no inputSchema"
            print("✓ all tools carry an inputSchema")

            r = await session.call_tool("get_situation", {})
            payload = json.loads(r.content[0].text)
            assert "aircraft" in payload, "get_situation missing 'aircraft'"
            print("✓ call get_situation -> aircraft total:", payload["aircraft"]["total"])

            r2 = await session.call_tool("data_sources", {})
            ds = json.loads(r2.content[0].text)
            assert "always_on" in ds
            print("✓ call data_sources -> ollama:", ds["ollama"])

            r3 = await session.call_tool(
                "focus_area", {"lat": 50.03, "lon": 8.56, "radius_nm": 150}
            )
            fa = json.loads(r3.content[0].text)
            assert "load_mode" in fa
            print(
                "✓ call focus_area -> mode:",
                fa.get("load_mode"),
                "| aircraft:",
                fa.get("aircraft", {}).get("count"),
            )

            r4 = await session.call_tool(
                "gps_jamming", {"min_lon": -10, "min_lat": 35, "max_lon": 40, "max_lat": 70}
            )
            jam = json.loads(r4.content[0].text)
            assert "summary" in jam
            print("✓ call gps_jamming (Europe bbox) -> flagged:", jam["summary"]["cells_flagged"])

    print("\nALL MCP HANDSHAKE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
