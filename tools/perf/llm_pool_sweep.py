#!/usr/bin/env python3
"""Sweep the local-inference pool width and report what it actually buys.

The claim "process it with local models in high parallelism" is only worth
anything with a number attached, and the number is not the width you configured
— it is the throughput you measured at that width. Past some point a wider pool
buys nothing (the server is decoding at its limit) or costs (KV cache per slot
shrinks the usable context, or the box starts swapping), and the only way to
know where that point is on THIS box is to run it.

    apps/api/.venv/bin/python tools/perf/llm_pool_sweep.py --widths 1,2,4,8

Runs against the API at :8000, which is where the real path lives (engine
resolution, prose style, injection guard, call logging). Measuring the model
server directly would measure a system nobody uses.

Writes docs/perf-results-llm-pool-<date>.md when --write is passed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from typing import Any

import httpx

# Short, uniform, and shaped like the real work: turn one line of operational
# prose into a typed fact. Uniform on purpose — a sweep whose items differ in
# length measures the items, not the width.
SYSTEM = (
    "Extract fields from one maritime or aviation notice. "
    'Reply with JSON only: {"kind":"...","place":"...","hazard":"..."} '
    "Use null for anything the text does not state. Never guess."
)
ITEMS = [
    "NAVAREA I 0421/26. Gunnery exercise 5401N 00312E to 5405N 00320E, 0600-1400Z daily until 12 Aug.",
    "NOTAM A0912/26 EGLL. Runway 09R/27L closed for resurfacing 2100-0500 daily.",
    "NAVAREA III 1188/26. Buoy Alpha 3612N 01455E reported off station, unlit.",
    "NOTAM K1177/26. Unmanned aircraft operations within 3NM radius of 3852N 07701W, surface to 400FT AGL.",
    "NAVAREA XI 0733/26. Live firing 2418N 12005E to 2430N 12020E, 2200-0400Z 8-10 Aug.",
    "NOTAM B4410/26 LGAV. ILS RWY 03R unserviceable until further notice.",
    "NAVAREA II 0902/26. Cable laying operations 4735N 00412W, wide berth requested.",
    "NOTAM E0031/26 UKBB. Airspace closed to all civil traffic until further notice.",
]


async def one_run(client: httpx.AsyncClient, base: str, width: int, n: int) -> dict[str, Any]:
    items = [ITEMS[i % len(ITEMS)] for i in range(n)]
    t0 = time.monotonic()
    r = await client.post(
        f"{base}/api/ai/batch",
        json={
            "system": SYSTEM,
            "items": items,
            "structured": True,
            "width": width,
            "max_tokens": 160,
        },
        timeout=900.0,
    )
    wall = time.monotonic() - t0
    if r.status_code != 200:
        return {"width": width, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    body = r.json()
    stats = body["stats"]
    parsed = sum(1 for x in body["results"] if isinstance(x, dict))
    return {
        "width": width,
        "n": n,
        "wall_s": round(wall, 2),
        "server_wall_s": stats["wall_s"],
        "completed": stats["completed"],
        "failed": stats["failed"],
        "parsed": parsed,
        "throughput_per_s": stats["throughput_per_s"],
        "p50_s": stats["p50_s"],
        "p95_s": stats["p95_s"],
    }


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--widths", default="1,2,4,8")
    ap.add_argument("--n", type=int, default=16, help="documents per run")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--local", action="store_true", default=True)
    ap.add_argument("--no-local", dest="local", action="store_false")
    args = ap.parse_args()

    widths = [int(w) for w in args.widths.split(",") if w.strip()]
    async with httpx.AsyncClient() as client:
        info = (await client.get(f"{args.base}/api/ai/batch", timeout=30.0)).json()
        print("pool:", json.dumps(info), flush=True)
        # Pin the run to the local engine, and put the toggle back afterwards.
        # Without this the sweep measures whichever cloud backend the tier
        # ladder happens to pick, at a concurrency limit that has nothing to do
        # with this box. The first run of this harness did exactly that, which
        # is why the pin is in the harness rather than in an operator's memory.
        before = (await client.get(f"{args.base}/api/ai/local", timeout=30.0)).json()
        if args.local:
            await client.post(
                f"{args.base}/api/ai/local",
                json={"enabled": True, "local_only": True},
                timeout=30.0,
            )
        rows = []
        try:
            for w in widths:
                row = await one_run(client, args.base, w, args.n)
                rows.append(row)
                print(json.dumps(row), flush=True)
        finally:
            if args.local:
                await client.post(
                    f"{args.base}/api/ai/local",
                    json={
                        "enabled": bool(before.get("enabled")),
                        "local_only": bool(before.get("local_only")),
                    },
                    timeout=30.0,
                )

    ok = [r for r in rows if "error" not in r and r["completed"]]
    if not ok:
        print("no successful runs; is a local model loaded?", file=sys.stderr)
        return 1
    base_tp = ok[0]["throughput_per_s"] or 0.0
    best = max(ok, key=lambda r: r["throughput_per_s"])
    print(
        f"\nbest width {best['width']}: {best['throughput_per_s']:.2f} docs/s"
        f" ({(best['throughput_per_s'] / base_tp) if base_tp else 0:.2f}x width-1),"
        f" p95 {best['p95_s']:.1f}s"
    )

    if args.write:
        from datetime import date  # noqa: PLC0415

        path = f"docs/perf-results-llm-pool-{date.today().isoformat()}.md"
        lines = [
            f"# Local-inference pool sweep, {date.today().isoformat()}",
            "",
            f"Engine `{info.get('engine')}`, declared slots {info.get('slots')} "
            f"(from `{info.get('width_source')}`). {args.n} documents per run, "
            "structured extraction, identical items at every width.",
            "",
            "| width | wall s | docs/s | vs width 1 | p50 s | p95 s | parsed |",
            "|---|---|---|---|---|---|---|",
        ]
        for r in rows:
            if "error" in r:
                lines.append(f"| {r['width']} | — | — | — | — | — | {r['error']} |")
                continue
            rel = (r["throughput_per_s"] / base_tp) if base_tp else 0
            lines.append(
                f"| {r['width']} | {r['server_wall_s']} | {r['throughput_per_s']} | "
                f"{rel:.2f}x | {r['p50_s']} | {r['p95_s']} | {r['parsed']}/{r['n']} |"
            )
        lines += [
            "",
            f"Median p50 across widths: {statistics.median([r['p50_s'] for r in ok]):.2f} s.",
            "",
            "Read it as: past the engine's own slot count a wider pool does not add "
            "throughput, it adds queueing, and the p95 is where that shows up first.",
        ]
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print("wrote", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
