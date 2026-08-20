#!/usr/bin/env python3
"""Sweep every safe GET route and classify what it actually answers.

`measure_api.py --routes` asks how EXPENSIVE the ~50 registered globe layers
are. This asks a different question of all ~400 routes: does the endpoint tell
the truth when its upstream is down? A route that answers 200 with an empty body
after a failed fetch is indistinguishable, to a status-code probe, from a route
that is genuinely working and genuinely has nothing to report.

Enumeration comes from /openapi.json, which is exact (the app is a plain
FastAPI with no include_in_schema=False anywhere, and the path is in
auth.PUBLIC_PATHS so it serves regardless of auth posture). It is NOT a regex
over @router decorators the way routeCoverage.test.ts must be -- that test runs
in vitest with no server to ask.

Three things this must not do, each learned the hard way:

  1. "GET-only" is NOT the safety boundary on this app. GET /api/intel/baseline
     WRITES (intel.py: baseline_store.sample), GET /api/maritime/keyless writes
     into the last-write-wins vessel store, and a dozen GETs spend LLM credits
     or GPU. The skip list is ratelimit.is_compute_path -- the existing single
     source of truth -- plus the four mutating GETs named below.
  2. It must not manufacture the defects it reports. ~380 cold GETs is a burst
     against upstreams documented to punish bursts (CelesTrak 403s, Wikidata
     SPARQL 429s). An UPSTREAM 429 arrives here as a 502 or an empty 200, not as
     the `gated-429` bucket, so it would be filed as an upstream defect.
     Concurrency is capped low and the SECOND pass is canonical.
  3. It must not assume its own auth posture. ALLOW_UNAUTHENTICATED is dead code
     whenever the resolved .env carries SUPABASE_URL+SUPABASE_ANON_KEY, and
     config.py resolves env_file relative to CWD. Boot via
     `bash scripts/run-api.sh` from the repo ROOT. This script asserts the
     posture before classifying a single route.

    apps/api/.venv/bin/python tools/perf/sweep_api.py --twice
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "apps/api"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# The compute/actuation skip list already exists and is shared by the rate
# limiter and the auth fail-closed gate. Import it; never re-list it here, or
# the two drift and this sweep starts spending money the gate was written to
# protect.
from app.ratelimit import is_compute_path  # noqa: E402

# measure_api.timed_get cannot be reused: it deliberately discards the body, and
# the body is the entire question this script asks. Its percentile helper is
# reusable as-is.
from measure_api import pct  # noqa: E402

# GET routes that mutate state. Verified by reading each handler, not inferred.
MUTATING_GETS: dict[str, str] = {
    "/api/intel/baseline": "baseline_store.sample() writes an AOI sample on read",
    "/api/intel/watch": "record() persists a watch entry",
    "/api/maritime/keyless": "store.add_many() into the LAST-WRITE-WINS vessel store",
    "/api/news/feed": "_ensure_articles() triggers a refresh/write when stale",
}

# Params the sweep can answer honestly. Anything not here that is REQUIRED makes
# the route `needs-fixture` -- a gap in this table, reported as such, never
# reported as a broken endpoint.
FIXTURES: dict[str, str] = {
    "min_lon": "-10", "min_lat": "35", "max_lon": "30", "max_lat": "60",
    "lomin": "-10", "lamin": "35", "lomax": "30", "lamax": "60",
    "west": "-10", "south": "35", "east": "30", "north": "60",
    "lon": "10", "lat": "50", "longitude": "10", "latitude": "50",
    "radius_nm": "200", "radius_km": "200", "radius": "200",
    "bbox": "-10,35,30,60",
    "q": "berlin", "query": "berlin", "search": "berlin", "name": "berlin",
    "country": "DEU", "iso3": "DEU", "cc": "DE", "code": "DEU",
    "limit": "50", "days": "3", "hours": "6", "z": "3", "x": "4", "y": "2",
    "category": "port", "kind": "aircraft", "scope": "global",
}

TIMEOUT_S = 25.0


def http_get(url: str, timeout: float = TIMEOUT_S) -> dict:
    """One GET, keeping the body. Returns status, content-type, body, ms."""
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - localhost
            body = r.read()
            return {
                "status": r.status,
                "ctype": (r.headers.get("content-type") or "").split(";")[0],
                "body": body,
                "ms": (time.perf_counter() - t0) * 1000.0,
            }
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:  # noqa: BLE001 - the error body is a nicety
            pass
        return {
            "status": e.code,
            "ctype": (e.headers.get("content-type") or "").split(";")[0] if e.headers else "",
            "body": body,
            "ms": (time.perf_counter() - t0) * 1000.0,
        }
    except (TimeoutError, urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        timed_out = isinstance(reason, TimeoutError) or "timed out" in str(reason).lower()
        return {
            "status": 0,
            "ctype": "",
            "body": b"",
            "ms": (time.perf_counter() - t0) * 1000.0,
            "error": str(reason)[:80],
            "timeout": timed_out,
        }


# -- classification -----------------------------------------------------------

_EMPTY_LIST_KEYS = (
    "features", "results", "items", "datasets", "sources", "events", "alerts",
    "articles", "entries", "rows", "objects", "hits", "records", "data",
)


def _is_empty(payload: object) -> bool:
    """True when the body is well-formed and carries no information.

    Deliberately conservative: a payload with ANY non-empty collection or any
    scalar field beyond bookkeeping counts as real. Over-reporting `200-empty`
    would make the ledger the thing that lies.
    """
    if payload is None:
        return True
    if isinstance(payload, list):
        return len(payload) == 0
    if not isinstance(payload, dict):
        return False
    if not payload:
        return True
    # A FeatureCollection / result envelope whose collection is empty.
    for k in _EMPTY_LIST_KEYS:
        if k in payload:
            v = payload[k]
            if isinstance(v, (list, dict)) and len(v) == 0:
                return True
    # Every value is an empty container and there is nothing else to read.
    meaningful = 0
    for k, v in payload.items():
        if k in ("type", "generated_at", "as_of", "count", "total", "note", "detail"):
            continue
        if isinstance(v, (list, dict, str)) and len(v) == 0:
            continue
        if v is None:
            continue
        meaningful += 1
    return meaningful == 0


def _is_degraded(payload: object) -> bool:
    """The honest-degradation idiom already in the codebase.

    `{"degraded": true, "note": ...}` (routes/events.py) and the explicit
    `"note": "GDELT is throttling..."` shape (routes/mega_feeds.py) are CORRECT
    answers to a failed upstream, not defects. They must be counted apart from
    the silent empties or the fix looks like a regression.
    """
    if not isinstance(payload, dict):
        return False
    if payload.get("degraded"):
        return True
    note = payload.get("note") or payload.get("detail")
    return bool(note) and _is_empty(payload)


def classify(res: dict) -> tuple[str, str]:
    st = res["status"]
    if st == 0:
        return ("timeout" if res.get("timeout") else "unreachable", res.get("error", ""))
    if st in (401, 403):
        return ("auth-gated", f"HTTP {st}")
    if st == 429:
        return ("gated-429", "rate limiter answered - correct behaviour")
    if st == 503:
        return ("gated-503", "compute gate answered - correct behaviour")
    if st == 404:
        return ("404", "")
    if st == 422:
        return ("422-needs-fixture", "required param the fixture table cannot answer")
    if st >= 500:
        return ("5xx", f"HTTP {st}")
    if st != 200:
        return (f"http-{st}", "")
    # 200 from here down. An /api/ path answering text/html is a routing defect.
    if res["ctype"] and res["ctype"] not in ("application/json", "application/geo+json"):
        if res["ctype"] == "text/html":
            return ("200-html", "an /api/ path answered HTML")
        if res["ctype"].startswith(("image/", "application/octet-stream")):
            return ("200-binary", res["ctype"] + " - tile/chip route, correct")
        return ("200-nonjson", res["ctype"])
    try:
        payload = json.loads(res["body"].decode("utf-8", "replace")) if res["body"] else None
    except ValueError:
        return ("200-nonjson", "body is not JSON")
    if _is_degraded(payload):
        return ("200-degraded", "declares its own degradation - honest")
    if _is_empty(payload):
        return ("200-empty", "well-formed and carries nothing")
    return ("200-real", f"{len(res['body']):,} bytes")


# -- enumeration --------------------------------------------------------------


def enumerate_routes(base: str) -> list[dict]:
    """Every GET route from the live schema, with its required params."""
    res = http_get(f"{base}/openapi.json", timeout=30.0)
    if res["status"] != 200:
        raise SystemExit(f"/openapi.json answered {res['status']} - is the backend up?")
    spec = json.loads(res["body"].decode("utf-8"))
    out: list[dict] = []
    for path, ops in (spec.get("paths") or {}).items():
        op = (ops or {}).get("get")
        if not op:
            continue
        params = op.get("parameters") or []
        out.append({
            "path": path,
            "path_params": [p["name"] for p in params if p.get("in") == "path"],
            "required_query": [
                p["name"] for p in params if p.get("in") == "query" and p.get("required")
            ],
            "optional_query": [
                p["name"] for p in params if p.get("in") == "query" and not p.get("required")
            ],
        })
    return sorted(out, key=lambda r: r["path"])


def build_url(base: str, route: dict, seeds: dict[str, str]) -> str | None:
    """Fill the route's params from the fixture table. None = needs-fixture."""
    table = {**FIXTURES, **seeds}
    path = route["path"]
    for name in route["path_params"]:
        val = table.get(name)
        if val is None:
            return None
        path = path.replace("{" + name + "}", urllib.parse.quote(str(val)))
    if "{" in path:
        return None
    qs: dict[str, str] = {}
    for name in route["required_query"]:
        val = table.get(name)
        if val is None:
            return None
        qs[name] = val
    url = base + path
    if qs:
        url += "?" + urllib.parse.urlencode(qs)
    return url


def build_url_with_optionals(base: str, route: dict, seeds: dict[str, str]) -> str | None:
    """The 422 retry: same URL plus every OPTIONAL param the table can answer.

    Filling optionals on the FIRST attempt is a measured harness bug, not a
    refinement: `category=port` emptied /api/sources/catalog (60 sources bare,
    0 with that category) and the bbox/limit fixtures emptied /api/eq, which
    serves the real USGS feed when left alone. Both were about to be reported as
    dead endpoints. Optionals are a fallback for a 422, never a default.
    """
    base_url = build_url(base, route, seeds)
    if base_url is None:
        return None
    table = {**FIXTURES, **seeds}
    extra = {n: table[n] for n in route["optional_query"] if n in table}
    if not extra:
        return None
    sep = "&" if "?" in base_url else "?"
    return base_url + sep + urllib.parse.urlencode(extra)


def seed_fixtures(base: str) -> dict[str, str]:
    """Pull real identifiers out of the running snapshot.

    An invented ICAO24 makes every dossier route answer an honest 404 that the
    ledger would then have to call a defect. Read-only: /api/adsb/global is the
    pre-rendered blob the refresher already built.
    """
    seeds: dict[str, str] = {}
    res = http_get(f"{base}/api/adsb/global?limit=200", timeout=30.0)
    if res["status"] == 200:
        try:
            feats = json.loads(res["body"].decode("utf-8")).get("features") or []
            for f in feats:
                ident = (f.get("properties") or {}).get("icao24") or f.get("id")
                if ident and isinstance(ident, str):
                    seeds["icao24"] = seeds["hex"] = seeds["ident"] = ident.strip()
                    break
        except (ValueError, AttributeError):
            pass
    return seeds


# -- posture ------------------------------------------------------------------


def assert_posture(base: str) -> dict:
    """Know which auth mode we are in BEFORE classifying anything.

    auth._auth_enabled() is true when the resolved .env carries API_KEY, a
    Supabase JWT secret, or SUPABASE_URL+SUPABASE_ANON_KEY -- and the
    allow_unauthenticated branch is only reachable when auth is OFF. The repo
    has TWO .env files disagreeing about this and config.py resolves env_file
    relative to CWD, so the boot path decides the answer. A sweep that assumed
    open mode against a Supabase-configured backend would file 400 routes as
    broken on a wall of 401s.
    """
    # /api/config is the app's OWN answer to this question (it is what the
    # frontend boots from), so it cannot drift from the code the way a guessed
    # probe route does. /api/audit was the first candidate here and it is WRONG:
    # it 401s to bare curl by design in either mode, so it reported open mode as
    # closed and would have filed 200 working routes as unreachable.
    probe = http_get(f"{base}/api/config", timeout=10.0)
    open_mode = False
    if probe["status"] == 200:
        try:
            open_mode = bool(json.loads(probe["body"].decode("utf-8")).get("openMode"))
        except ValueError:
            pass
    return {
        "open_mode": open_mode,
        "probe_status": probe["status"],
        "note": (
            "ALLOW_UNAUTHENTICATED is in effect: auth-gated routes are reachable "
            "and a 401 below is a real finding"
            if open_mode
            else "auth is ON for this boot (the resolved .env carries API_KEY or "
            "SUPABASE_URL+SUPABASE_ANON_KEY, which makes ALLOW_UNAUTHENTICATED "
            "dead code). Every gated route answers 401 and is reported as "
            "auth-gated, NOT as a defect. Boot via `bash scripts/run-api.sh` "
            "from the repo ROOT for full coverage."
        ),
    }


# -- driver -------------------------------------------------------------------


def run_pass(base: str, plan: list[dict], workers: int) -> dict[str, dict]:
    def one(item: dict) -> tuple[str, dict]:
        res = http_get(item["url"])
        bucket, detail = classify(res)
        # Retry once with the optional fixtures when the bare call was empty or
        # rejected. Both directions are real: /api/sources/catalog answers 60
        # sources bare and 0 with a category, while /api/places/airports answers
        # nothing bare and thousands inside a bbox. Take whichever call carried
        # information -- but only ever as a SECOND attempt, so a bad fixture can
        # never turn a working route into a reported defect.
        if bucket in ("422-needs-fixture", "200-empty") and item.get("url_opt"):
            res2 = http_get(item["url_opt"])
            b2, d2 = classify(res2)
            if b2 in ("200-real", "200-degraded"):
                res, bucket = res2, b2
                detail = d2 + " (needed params; empty when asked unbounded)"
        return item["path"], {
            "bucket": bucket, "detail": detail, "ms": res["ms"],
            "status": res["status"], "bytes": len(res["body"]), "url": item["url"],
        }

    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for path, row in pool.map(one, plan):
            out[path] = row
    return out


BUCKET_ORDER = [
    "5xx", "unreachable", "timeout", "200-html", "200-nonjson", "200-empty",
    "404", "422-needs-fixture", "200-degraded", "auth-gated", "gated-429",
    "gated-503", "200-binary", "200-real",
]
DEFECT_BUCKETS = {"5xx", "unreachable", "timeout", "200-html", "200-nonjson", "200-empty"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--twice", action="store_true",
                    help="run two passes and classify from the SECOND (warm cache, "
                         "and any throttling this sweep itself induced has settled)")
    ap.add_argument("--workers", type=int, default=6,
                    help="concurrency cap. Keep it low: several upstreams punish bursts.")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    posture = assert_posture(args.base)
    routes = enumerate_routes(args.base)
    seeds = seed_fixtures(args.base)

    plan: list[dict] = []
    skipped: list[dict] = []
    for r in routes:
        path = r["path"]
        if path in MUTATING_GETS:
            skipped.append({"path": path, "why": MUTATING_GETS[path], "class": "mutating-get"})
            continue
        if is_compute_path(path):
            skipped.append({"path": path, "why": "ratelimit.is_compute_path: spends LLM "
                                                 "credits, GPU or actuates", "class": "compute"})
            continue
        url = build_url(args.base, r, seeds)
        if url is None:
            missing = [p for p in r["path_params"] + r["required_query"]
                       if p not in {**FIXTURES, **seeds}]
            skipped.append({"path": path, "why": "no fixture for " + ", ".join(missing),
                            "class": "needs-fixture"})
            continue
        plan.append({
            "path": path,
            "url": url,
            "url_opt": build_url_with_optionals(args.base, r, seeds),
        })

    print(f"# API sweep - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"\nbase={args.base} workers={args.workers} twice={args.twice}")
    print(f"\n**Auth posture:** open_mode={posture['open_mode']} "
          f"(probe /api/config -> {posture['probe_status']}). {posture['note']}")
    print(f"\n**Fixture seeds from live data:** {seeds or 'none - snapshot was empty'}")
    print(f"\nGET routes in schema: {len(routes)} · swept: {len(plan)} · "
          f"skipped: {len(skipped)}")

    if args.twice:
        run_pass(args.base, plan, args.workers)
    results = run_pass(args.base, plan, args.workers)

    counts: dict[str, int] = {}
    for row in results.values():
        counts[row["bucket"]] = counts.get(row["bucket"], 0) + 1

    print("\n## Buckets\n")
    print("| bucket | n | meaning |")
    print("|---|---|---|")
    meaning = {
        "5xx": "server error", "unreachable": "no answer", "timeout": f">{TIMEOUT_S:.0f}s",
        "200-html": "**routing defect** - /api/ answered HTML",
        "200-nonjson": "200 with a body that is not JSON",
        "200-empty": "**200 carrying nothing, and not saying so**",
        "404": "not found", "422-needs-fixture": "fixture-table gap, not a defect",
        "200-degraded": "declares its own degradation - correct",
        "auth-gated": "401/403 - by design", "gated-429": "rate limiter - correct",
        "gated-503": "compute gate - correct", "200-real": "answered with data",
        "200-binary": "image/tile body - correct",
    }
    for b in BUCKET_ORDER:
        if counts.get(b):
            print(f"| `{b}` | {counts[b]} | {meaning.get(b,'')} |")
    for b in sorted(set(counts) - set(BUCKET_ORDER)):
        print(f"| `{b}` | {counts[b]} | |")

    defects = sum(counts.get(b, 0) for b in DEFECT_BUCKETS)
    print(f"\n**Defect total: {defects} of {len(plan)} swept.** "
          f"`200-empty` alone: {counts.get('200-empty', 0)}.")

    for b in BUCKET_ORDER:
        rows = sorted([(p, r) for p, r in results.items() if r["bucket"] == b])
        if not rows or b in ("200-real", "auth-gated"):
            continue
        print(f"\n### {b} ({len(rows)})\n")
        print("| endpoint | status | ms | detail |")
        print("|---|---|---|---|")
        for p, r in rows:
            print(f"| `{p}` | {r['status']} | {r['ms']:.0f} | {r['detail']} |")

    print(f"\n## Skipped, and why ({len(skipped)})\n")
    print("A ledger that hides its own gaps reads as coverage it does not have.\n")
    print("| endpoint | class | reason |")
    print("|---|---|---|")
    for s in sorted(skipped, key=lambda x: (x["class"], x["path"])):
        print(f"| `{s['path']}` | {s['class']} | {s['why']} |")

    # The half of the answer a route sweep cannot give on its own.
    #
    # An empty body has two completely different causes -- a dead upstream, or a
    # local store that is genuinely empty on a fresh boot -- and they are
    # indistinguishable from outside. /api/status/sources is what tells them
    # apart, so the ledger asks it rather than leaving the reader to guess.
    health = http_get(f"{args.base}/api/status/sources", timeout=20.0)
    if health["status"] == 200:
        try:
            hz = json.loads(health["body"].decode("utf-8"))
        except ValueError:
            hz = {}
        failing = [r for r in hz.get("sources", []) if r.get("state") == "failing"]
        print("\n## Upstreams that failed during this sweep\n")
        if failing:
            print("An empty route above with one of these behind it is a DEAD FEED. "
                  "An empty route with nothing here is an empty store.\n")
            print("| host | ok | failed | last error |")
            print("|---|---|---|---|")
            for r in sorted(failing, key=lambda r: -r["fail"]):
                print(f"| `{r['host']}` | {r['ok']} | {r['fail']} | {r.get('last_error') or ''} |")
        else:
            print("None. Every upstream called through the shared client answered.\n")
        counts_h = hz.get("counts", {})
        print(f"\nRegistry: {counts_h.get('total', 0)} hosts called · "
              f"{counts_h.get('ok', 0)} answering · {counts_h.get('failing', 0)} failing · "
              f"{len(hz.get('unmeasured', []))} upstreams build their own client and are "
              "not measured.")
    else:
        print(f"\n## Upstreams\n\n/api/status/sources answered {health['status']} - "
              "the empty/dead distinction below is UNAVAILABLE for this run.")

    lat = [r["ms"] for r in results.values() if r["status"]]
    if lat:
        print(f"\nLatency p50 {pct(lat,50):.0f} ms · p95 {pct(lat,95):.0f} ms · "
              f"max {max(lat):.0f} ms")

    if args.out:
        Path(args.out).write_text(json.dumps(
            {"posture": posture, "seeds": seeds, "counts": counts,
             "results": results, "skipped": skipped}, indent=2), encoding="utf-8")
        print(f"\nbaseline written to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
