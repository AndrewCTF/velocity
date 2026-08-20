#!/usr/bin/env python3
"""Is every upstream reachable from THIS egress? And what changes if it moves?

The question this answers is "is it me or is it them". A feed that reads empty
has two causes that look identical from inside the app: the upstream is down, or
this address is not welcome. `/api/status/sources` records which upstreams
failed; this records whether they would answer ANY caller from here, and diffs
two egress addresses so the difference is measured rather than argued.

`probe_warp.py` is the neighbouring tool and answers a narrower question: does
routing a host through WARP unblock it. Use that one when deciding WARP_HOSTS
membership. Use this one when the whole egress changed - a VPN went up, the box
moved, a deploy landed on a different address.

    apps/api/.venv/bin/python tools/probe_egress.py --out on-vpn.json
    # turn the VPN off, then:
    apps/api/.venv/bin/python tools/probe_egress.py --diff on-vpn.json

Classification is deliberately about REACHABILITY, not correctness: a 404 counts
as reached, because they answered us. 403/451 with a browser User-Agent is the
shape an address-level refusal takes - a plain 403 on our own UA is usually just
bot filtering, which is why both are sent.
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP = REPO / "apps/api/app"

OUR_UA = "osint-console/0.1"
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0.0.0 Safari/537.36"
)

# Documentation placeholders and example values that live in config docstrings.
# They are not providers and a DNS failure on them is not a finding.
_PLACEHOLDER = re.compile(
    r"(your-host\.tld|localhost|example\.(com|org)|user:pass@|^evil$|^host$|,)"
)

_URL_RE = re.compile(r'https?://[A-Za-z0-9._~:/?#\[\]@!$&\'()*+,;=%{}-]+')


def upstream_urls() -> list[dict[str, str]]:
    """One concrete URL per external host referenced anywhere in the backend.

    Prefers the URL with the fewest templated segments, so the probe asks for
    something the host can actually route.
    """
    best: dict[str, tuple[str, tuple[int, int, int], str]] = {}
    for f in sorted(APP.rglob("*.py")):
        for m in _URL_RE.finditer(f.read_text(errors="replace")):
            url = m.group(0).rstrip('.,;\'")')
            host = re.sub(r"^https?://", "", url).split("/")[0].split("?")[0].lower()
            if not host or host.startswith(("127.", "localhost", "0.0.0.0")):
                continue
            if any(c in host for c in "{}$") or _PLACEHOLDER.search(host):
                continue
            score = (url.count("{"), url.count("$"), len(url))
            cur = best.get(host)
            if cur is None or score < cur[1]:
                best[host] = (url, score, str(f.relative_to(APP)))
    return [
        {"host": h, "url": v[0], "where": v[2]} for h, v in sorted(best.items())
    ]


def _get(url: str, ua: str, timeout: float = 15.0) -> int | str:
    req = urllib.request.Request(
        url, headers={"User-Agent": ua, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            return int(r.status)
    except urllib.error.HTTPError as e:
        return int(e.code)
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
            return "timeout"
        if isinstance(reason, ssl.SSLError):
            return "tls-fail"
        return "conn-fail"
    except Exception as e:  # noqa: BLE001
        return type(e).__name__


def classify(code: int | str, browser: int | str | None) -> str:
    if isinstance(code, str):
        return code
    if code in (403, 451):
        # A 403 that a browser UA clears is bot filtering, not this address.
        if isinstance(browser, int) and 200 <= browser < 400:
            return "ua-blocked"
        return "BLOCKED"
    if code == 429:
        return "throttled"
    if code in (401, 402):
        return "needs-key"
    if 200 <= code < 400:
        return "ok"
    return "reached-4xx5xx"


def probe(item: dict[str, str]) -> dict[str, object]:
    host = item["host"]
    try:
        socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        return {**item, "cls": "dns-fail", "status": 0,
                "browser_status": None, "detail": str(e)[:60]}
    t0 = time.perf_counter()
    code = _get(item["url"], OUR_UA)
    browser = _get(item["url"], BROWSER_UA) if code in (403, 451) else None
    return {
        **item,
        "cls": classify(code, browser),
        "status": code if isinstance(code, int) else 0,
        "browser_status": browser,
        "detail": f"{(time.perf_counter() - t0) * 1000:.0f}ms",
    }


def egress_identity() -> dict[str, object]:
    """Who the internet thinks we are. The diff is meaningless without it."""
    try:
        with urllib.request.urlopen(  # noqa: S310
            urllib.request.Request("https://ipinfo.io/json", headers={"User-Agent": OUR_UA}),
            timeout=12,
        ) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
        return {k: d.get(k) for k in ("ip", "city", "country", "org")}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"[:80]}


ORDER = ["BLOCKED", "timeout", "tls-fail", "conn-fail", "dns-fail", "ua-blocked",
         "throttled", "needs-key", "reached-4xx5xx", "ok"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="")
    ap.add_argument("--diff", default="", help="a previous --out file to compare against")
    ap.add_argument("--workers", type=int, default=6,
                    help="keep it low: several upstreams punish bursts and a "
                         "throttle would be indistinguishable from a block")
    args = ap.parse_args()

    who = egress_identity()
    items = upstream_urls()
    print(f"# egress reachability — {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"\nExit: {who}")
    print(f"Upstream hosts referenced in apps/api/app: {len(items)}\n")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(probe, items))

    counts: dict[str, int] = {}
    for r in rows:
        counts[str(r["cls"])] = counts.get(str(r["cls"]), 0) + 1
    reached = sum(counts.get(c, 0) for c in ("ok", "reached-4xx5xx", "needs-key", "throttled"))
    print(f"**Reached {reached} of {len(rows)}.**\n")
    print("| class | n |")
    print("|---|---|")
    for c in ORDER:
        if counts.get(c):
            print(f"| `{c}` | {counts[c]} |")

    for c in ("BLOCKED", "timeout", "tls-fail", "conn-fail", "dns-fail", "ua-blocked"):
        sel = sorted([r for r in rows if r["cls"] == c], key=lambda r: str(r["host"]))
        if not sel:
            continue
        print(f"\n### {c} ({len(sel)})\n")
        print("| host | status | browser UA | declared in |")
        print("|---|---|---|---|")
        for r in sel:
            print(f"| `{r['host']}` | {r['status'] or r['cls']} | "
                  f"{r.get('browser_status') if r.get('browser_status') is not None else '—'} | "
                  f"`{r['where']}` |")

    if args.diff:
        prev = json.loads(Path(args.diff).read_text())
        old = {r["host"]: r for r in prev["rows"]}
        print(f"\n## Diff against {args.diff}\n")
        print(f"That run's exit: {prev.get('egress')}\n")
        changed = [(r, old[r["host"]]) for r in rows
                   if r["host"] in old and old[r["host"]]["cls"] != r["cls"]]
        if not changed:
            print("No class changed. The egress is not what decides these.")
        else:
            print("| host | was | now | verdict |")
            print("|---|---|---|---|")
            for new, was in sorted(changed, key=lambda t: str(t[0]["host"])):
                better = new["cls"] in ("ok", "reached-4xx5xx", "needs-key")
                worse = was["cls"] in ("ok", "reached-4xx5xx", "needs-key")
                v = ("**this egress was the problem**" if better and not worse
                     else "**this egress broke it**" if worse and not better else "changed")
                print(f"| `{new['host']}` | {was['cls']} | {new['cls']} | {v} |")

    if args.out:
        Path(args.out).write_text(json.dumps(
            {"egress": who, "at": int(time.time()), "rows": rows}, indent=1), encoding="utf-8")
        print(f"\nbaseline written to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
