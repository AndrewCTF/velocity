#!/usr/bin/env python3
"""Measure the local inference path the way a user experiences it.

The number that matters is time-to-FIRST-BYTE on a selection brief, not total —
that is what the operator watches. Total and the cache hit rate come second.

    apps/api/.venv/bin/python tools/perf/measure_llm.py --n 10 --repeat

A disabled or absent engine is a RESULT, not a zero: this prints the 409/503 and
says so rather than reporting a fast time for a route that did nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

BASE_DEFAULT = "http://127.0.0.1:8000"


def get_json(url: str, timeout: float = 10.0) -> tuple[int, dict | None]:
    try:
        req = urllib.request.Request(url, headers={"accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — localhost
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 — best-effort body decode
            return e.code, None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        print(f"  ! {url}: {e}")
        return 0, None


def post_timed(url: str, body: dict, timeout: float = 120.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, headers={"content-type": "application/json"}, method="POST"
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — localhost
            first = time.perf_counter()
            raw = r.read()
            end = time.perf_counter()
            try:
                payload = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                payload = {}
            return {
                "status": r.status,
                "ttfb_ms": (first - t0) * 1000.0,
                "total_ms": (end - t0) * 1000.0,
                "cached": bool(payload.get("cached")),
                "backend": payload.get("backend") or payload.get("engine") or "-",
                "latency_ms": payload.get("latency_ms"),
                "chars": len(payload.get("text") or payload.get("brief") or ""),
            }
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", "replace")[:200]
        except Exception:  # noqa: BLE001
            pass
        return {
            "status": e.code,
            "ttfb_ms": (time.perf_counter() - t0) * 1000.0,
            "total_ms": (time.perf_counter() - t0) * 1000.0,
            "cached": False,
            "backend": "-",
            "error": body_txt,
        }
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return {
            "status": 0,
            "ttfb_ms": -1,
            "total_ms": -1,
            "cached": False,
            "backend": "-",
            "error": str(e)[:120],
        }


def pct(v: list[float], p: float) -> float:
    if not v:
        return float("nan")
    s = sorted(v)
    return s[min(len(s) - 1, max(0, round((p / 100.0) * (len(s) - 1))))]


def f(x: float, nd: int = 0) -> str:
    return "—" if x != x else f"{x:.{nd}f}"


def pick_targets(base: str, n: int) -> list[dict]:
    """n distinct aircraft from the live world snapshot."""
    status, fc = get_json(f"{base}/api/adsb/global?limit=200", timeout=20.0)
    if status != 200 or not fc:
        return []
    out: list[dict] = []
    for feat in (fc.get("features") or [])[: n * 4]:
        fid = feat.get("id")
        props = feat.get("properties") or {}
        if not fid:
            continue
        out.append({"kind": "aircraft", "id": str(fid), "props": props})
        if len(out) >= n:
            break
    return out


def run(base: str, targets: list[dict], label: str) -> list[dict]:
    print(f"\n### {label} ({len(targets)} calls)\n")
    print("| # | id | status | ttfb ms | total ms | cached | backend | chars |")
    print("|---|---|---|---|---|---|---|---|")
    rows = []
    for i, t in enumerate(targets):
        r = post_timed(f"{base}/api/ai/selection/brief", t)
        rows.append(r)
        print(
            f"| {i+1} | `{t['id']}` | {r['status']} | {f(r['ttfb_ms'])} | "
            f"{f(r['total_ms'])} | {'yes' if r['cached'] else 'no'} | "
            f"{r.get('backend','-')} | {r.get('chars', 0)} |"
        )
        if r.get("error"):
            print(f"|   | error | | | | | | `{r['error'][:80]}` |")
    return rows


def summarize(rows: list[dict], label: str) -> None:
    ok = [r for r in rows if r["status"] == 200 and r["ttfb_ms"] >= 0]
    if not ok:
        codes = sorted({r["status"] for r in rows})
        print(f"\n**{label}: no successful calls.** status codes: {codes}. "
              "This is the result — the route did not produce a brief.")
        return
    ttfb = [r["ttfb_ms"] for r in ok]
    total = [r["total_ms"] for r in ok]
    hits = sum(1 for r in ok if r["cached"])
    print(f"\n**{label}:** n={len(ok)}  "
          f"ttfb p50 {f(pct(ttfb,50))} ms / p95 {f(pct(ttfb,95))} ms  ·  "
          f"total p50 {f(pct(total,50))} ms / p95 {f(pct(total,95))} ms  ·  "
          f"cache hits {hits}/{len(ok)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=BASE_DEFAULT)
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--repeat", action="store_true",
                    help="fire the same set again to measure the cache hit rate")
    args = ap.parse_args()

    print(f"# measure_llm — {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"base={args.base} n={args.n} repeat={args.repeat}")

    for path in ("/api/ai/hardware", "/api/ai/local"):
        status, body = get_json(args.base + path, timeout=15.0)
        print(f"\n## {path} (HTTP {status})\n")
        print("```json")
        print(json.dumps(body, indent=2)[:2000] if body else "null")
        print("```")

    targets = pick_targets(args.base, args.n)
    if not targets:
        print("\n**No aircraft available from /api/adsb/global — cannot measure.** "
              "Boot the backend and wait for the snapshot to warm.")
        return 2

    rows = run(args.base, targets, "cold")
    summarize(rows, "cold")

    if args.repeat:
        rows2 = run(args.base, targets, "repeat (cache probe)")
        summarize(rows2, "repeat")

    return 0


if __name__ == "__main__":
    sys.exit(main())
