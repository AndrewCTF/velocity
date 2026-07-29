#!/usr/bin/env python3
"""Sample the API process tree and (optionally) the per-route cost table.

Two jobs, both read-only:

  1. Sample CPU / RSS / threads / fds for the uvicorn process and every
     descendant (node sidecars, chrome renderers) once a second, alongside the
     CHEAP /api/status/perf. It deliberately does NOT poll /api/status unless
     asked (--status): that route copies the whole snapshot, and polling it made
     an earlier version of this harness report 248 ms of loop lag on a backend
     that was actually sitting at 0.0.
  2. With --routes, GET every layer endpoint the frontend registers and emit a
     ranked cost table (TTFB, total, bytes, content-encoding, etag).

No dependencies: /proc directly, urllib for HTTP. psutil is not installed in
apps/api/.venv and this is not worth a dependency.

    apps/api/.venv/bin/python tools/perf/measure_api.py --seconds 300
    apps/api/.venv/bin/python tools/perf/measure_api.py --routes
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE_KB = os.sysconf("SC_PAGE_SIZE") // 1024


# ── /proc helpers ────────────────────────────────────────────────────────────


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def proc_stat(pid: int) -> dict[str, float] | None:
    """utime+stime in seconds, rss in MB, thread count — from /proc/<pid>/stat."""
    raw = _read(f"/proc/{pid}/stat")
    if not raw:
        return None
    # comm can contain spaces and parens; split on the LAST ')'.
    close = raw.rfind(")")
    comm = raw[raw.find("(") + 1 : close]
    rest = raw[close + 2 :].split()
    # rest[0] is state; fields are 1-indexed from there per proc(5) minus 2.
    utime, stime = float(rest[11]), float(rest[12])
    threads = int(rest[17])
    rss_pages = int(rest[21])
    return {
        "comm": comm,
        "cpu_s": (utime + stime) / CLK_TCK,
        "rss_mb": rss_pages * PAGE_KB / 1024.0,
        "threads": threads,
    }


def proc_fds(pid: int) -> int:
    try:
        return len(os.listdir(f"/proc/{pid}/fd"))
    except OSError:
        return -1


def proc_cmdline(pid: int) -> str:
    raw = _read(f"/proc/{pid}/cmdline") or ""
    return raw.replace("\0", " ").strip()


def children(pid: int) -> list[int]:
    out: list[int] = []
    try:
        tasks = os.listdir(f"/proc/{pid}/task")
    except OSError:
        return out
    for t in tasks:
        raw = _read(f"/proc/{pid}/task/{t}/children") or ""
        out.extend(int(x) for x in raw.split())
    return out


def descendants(pid: int, depth: int = 0) -> list[int]:
    if depth > 8:
        return []
    out = [pid]
    for c in children(pid):
        out.extend(descendants(c, depth + 1))
    return out


def pid_on_port(port: int) -> int | None:
    """The pid LISTENing on `port`, via `ss -ltnp` (same call the sidecars use)."""
    try:
        r = subprocess.run(
            ["ss", "-ltnp"], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in r.stdout.splitlines():
        cols = line.split()
        if len(cols) < 4:
            continue
        local = cols[3]  # Local Address:Port
        if not local.endswith(f":{port}"):
            continue
        m = re.search(r"pid=(\d+)", line)
        if m:
            return int(m.group(1))
    return None


# ── HTTP helpers ─────────────────────────────────────────────────────────────


def get_json(url: str, timeout: float = 5.0) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — localhost
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def timed_get(url: str, timeout: float = 30.0) -> dict:
    """One GET. Returns timing, size and the caching headers that matter."""
    req = urllib.request.Request(
        url, headers={"accept-encoding": "gzip", "accept": "application/json"}
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — localhost
            first = time.perf_counter()
            body = r.read()
            end = time.perf_counter()
            return {
                "status": r.status,
                "ttfb_ms": (first - t0) * 1000.0,
                "total_ms": (end - t0) * 1000.0,
                "bytes": len(body),
                "encoding": r.headers.get("content-encoding") or "-",
                "etag": "yes" if r.headers.get("etag") else "-",
            }
    except urllib.error.HTTPError as e:
        return {
            "status": e.code,
            "ttfb_ms": (time.perf_counter() - t0) * 1000.0,
            "total_ms": (time.perf_counter() - t0) * 1000.0,
            "bytes": 0,
            "encoding": "-",
            "etag": "-",
        }
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return {
            "status": 0,
            "ttfb_ms": -1,
            "total_ms": -1,
            "bytes": 0,
            "encoding": "-",
            "etag": "-",
            "error": str(e)[:60],
        }


# ── route discovery ──────────────────────────────────────────────────────────


def layer_endpoints() -> list[str]:
    """Pull every `endpoint:` string out of the frontend layer registry."""
    src = REPO / "apps/web/src/registry/defaults.ts"
    text = src.read_text(encoding="utf-8")
    found: list[str] = []
    for m in re.finditer(r"endpoint:\s*[`'\"]([^`'\"]+)[`'\"]", text):
        ep = m.group(1)
        if ep.startswith("/api/"):
            found.append(ep)
    # The 9 generated infra layers use a template literal with ${category}.
    for m in re.finditer(r"\['(infra\.[a-z_]+)',[^\]]*?'([a-z_]+)'", text):
        found.append(f"/api/places/infrastructure?category={m.group(2)}&limit=2000")
    seen: set[str] = set()
    out: list[str] = []
    for ep in found:
        if "${" in ep or ep in seen:
            continue
        seen.add(ep)
        out.append(ep)
    return out


# ── stats ────────────────────────────────────────────────────────────────────


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return s[k]


def fmt(x: float, nd: int = 1) -> str:
    return "—" if x != x else f"{x:.{nd}f}"


# ── main ─────────────────────────────────────────────────────────────────────


def sample_loop(
    root: int, base: str, seconds: int, interval: float, with_status: bool = False
) -> None:
    print(f"\n## Process sampling — root pid {root}, {seconds}s @ {interval}s\n")
    prev: dict[int, float] = {}
    series: dict[str, list[float]] = {}
    lag: list[float] = []
    aircraft: list[float] = []
    vessels: list[float] = []
    parked: list[float] = []
    n_ticks = 0
    t_end = time.monotonic() + seconds
    last = time.monotonic()

    while time.monotonic() < t_end:
        pids = descendants(root)
        tick_cpu: dict[str, float] = {}
        tick_rss: dict[str, float] = {}
        now = time.monotonic()
        dt = max(1e-6, now - last)
        last = now
        for pid in pids:
            st = proc_stat(pid)
            if not st:
                continue
            group = st["comm"]
            if "chrome" in group:
                group = "chrome"
            elif "node" in group:
                group = "node"
            elif "python" in group or "uvicorn" in group:
                group = "api"
            d = st["cpu_s"] - prev.get(pid, st["cpu_s"])
            prev[pid] = st["cpu_s"]
            tick_cpu[group] = tick_cpu.get(group, 0.0) + (d / dt) * 100.0
            tick_rss[group] = tick_rss.get(group, 0.0) + st["rss_mb"]
        for g, v in tick_cpu.items():
            series.setdefault(f"cpu%:{g}", []).append(v)
        for g, v in tick_rss.items():
            series.setdefault(f"rss_mb:{g}", []).append(v)
        series.setdefault("fds:api", []).append(float(proc_fds(root)))
        series.setdefault("procs", []).append(float(len(pids)))
        series.setdefault("chrome_procs", []).append(
            float(sum(1 for p in pids if "chrome" in (proc_stat(p) or {}).get("comm", "")))
        )

        # /api/status/perf is deliberately cheap (module state only) so polling
        # it once a second does not perturb what it reports.
        perf = get_json(f"{base}/api/status/perf", timeout=2.0)
        if perf and isinstance(perf.get("loop_lag_ms_p95"), (int, float)):
            lag.append(float(perf["loop_lag_ms_p95"]))
        if perf:
            a = ((perf.get("adsb") or {}).get("cycle_ms") or {}).get("features")
            if isinstance(a, (int, float)):
                aircraft.append(float(a))
            v = (perf.get("vessels") or {}).get("parked_cached")
            if isinstance(v, (int, float)):
                parked.append(float(v))
        # /api/status is NOT free: it copies the whole snapshot
        # (`global_snapshot()`) and walks the vessel store, so polling it once a
        # second is a load generator, not an observation. Measured 2026-07-27:
        # sampling it every 2 s made this harness report a loop-lag p50 of 248 ms
        # on a backend that read 0.0 ms when left alone. Opt in with --status
        # only when you want that route's cost included on purpose.
        if with_status:
            st = get_json(f"{base}/api/status", timeout=3.0)
            if st:
                if isinstance(st.get("aircraft_count"), (int, float)):
                    aircraft.append(float(st["aircraft_count"]))
                if isinstance(st.get("vessel_count"), (int, float)):
                    vessels.append(float(st["vessel_count"]))

        n_ticks += 1
        time.sleep(interval)

    print(f"ticks: {n_ticks}\n")
    print("| series | p50 | p95 | max |")
    print("|---|---|---|---|")
    for key in sorted(series):
        v = [x for x in series[key] if x == x and x >= 0]
        if not v:
            continue
        print(f"| {key} | {fmt(pct(v,50))} | {fmt(pct(v,95))} | {fmt(max(v))} |")
    if lag:
        print(f"| loop_lag_ms (from /api/status/perf) | {fmt(pct(lag,50))} | "
              f"{fmt(pct(lag,95))} | {fmt(max(lag))} |")
    else:
        print("| loop_lag_ms | NOT AVAILABLE (/api/status/perf absent) | | |")
    if aircraft:
        print(f"| aircraft_count | {fmt(pct(aircraft,50),0)} | {fmt(pct(aircraft,95),0)} "
              f"| {fmt(max(aircraft),0)} |")
    if vessels:
        print(f"| vessel_count | {fmt(pct(vessels,50),0)} | {fmt(pct(vessels,95),0)} "
              f"| {fmt(max(vessels),0)} |")
    if parked:
        print(f"| parked_cached | {fmt(pct(parked,50),0)} | {fmt(pct(parked,95),0)} "
              f"| {fmt(max(parked),0)} |")


def route_sweep(base: str, reps: int) -> None:
    eps = layer_endpoints()
    print(f"\n## Route cost table — {len(eps)} layer endpoints × {reps} GETs\n")
    rows = []
    for ep in eps:
        runs = [timed_get(base + ep) for _ in range(reps)]
        ok = [r for r in runs if r["status"] and r["total_ms"] >= 0]
        if not ok:
            rows.append((ep, -1.0, -1.0, 0, "-", "-", runs[0].get("status", 0)))
            continue
        rows.append(
            (
                ep,
                pct([r["ttfb_ms"] for r in ok], 50),
                pct([r["total_ms"] for r in ok], 50),
                int(pct([float(r["bytes"]) for r in ok], 50)),
                ok[-1]["encoding"],
                ok[-1]["etag"],
                ok[-1]["status"],
            )
        )
    rows.sort(key=lambda r: -(r[2] if r[2] > 0 else 0))
    print("| endpoint | ttfb p50 ms | total p50 ms | bytes p50 | enc | etag | status |")
    print("|---|---|---|---|---|---|---|")
    for ep, ttfb, total, size, enc, etag, status in rows:
        print(
            f"| `{ep}` | {fmt(ttfb)} | {fmt(total)} | {size:,} | {enc} | {etag} | {status} |"
        )
    live = [r for r in rows if r[2] > 0]
    print(f"\nTotal p50 wall time to fetch every layer once: "
          f"{sum(r[2] for r in live):.0f} ms across {len(live)} endpoints")
    print(f"Total p50 bytes: {sum(r[3] for r in live):,}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--routes", action="store_true", help="also run the route sweep")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--pid", type=int, default=0, help="override the api pid")
    ap.add_argument(
        "--status",
        action="store_true",
        help="also poll /api/status each tick. OFF by default: that route copies "
        "the whole snapshot, so polling it makes this harness a load generator "
        "rather than an observer (see sample_loop).",
    )
    args = ap.parse_args()

    print(f"# measure_api — {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"base={args.base} seconds={args.seconds} interval={args.interval} "
          f"routes={args.routes}")

    st = get_json(f"{args.base}/api/status", timeout=5.0)
    if st is None:
        print("\n**BACKEND NOT REACHABLE** — nothing measured. Boot with "
              "`bash scripts/run-api.sh` from the repo root.")
        return 2
    print(f"\n/api/status: status={st.get('status')} aircraft={st.get('aircraft_count')} "
          f"vessels={st.get('vessel_count')} parked={st.get('parked_count')}")

    root = args.pid or pid_on_port(args.port) or 0
    if not root:
        print("\ncould not resolve the api pid from ss; pass --pid. "
              "Skipping process sampling.")
    else:
        print(f"api pid {root}: {proc_cmdline(root)[:120]}")
        sample_loop(root, args.base, args.seconds, args.interval, args.status)

    if args.routes:
        route_sweep(args.base, args.reps)
    return 0


if __name__ == "__main__":
    sys.exit(main())
