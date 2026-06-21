#!/usr/bin/env python3
"""Probe keyless ADS-B aircraft.json mirrors for reachability + freshness.

Run from the SAME egress the backend uses (the droplet 167.99.149.34) — a
datacenter IP gets Cloudflare-blocked where a home IP isn't (adsb.lol 451,
airplanes.live/adsb.fi 403), so "works here" on a laptop can still fail in prod.

Prints one row per candidate: aircraft count, median seen_pos age (s), HTTP
status, url. Keep the ones that return 200 + a high count + low age and add their
URLs to `adsb_feed_urls` (apps/api/app/config.py). Pass URLs as args to probe a
custom set; otherwise the built-in candidate list is used.

    python tools/probe_adsb_mirrors.py
    python tools/probe_adsb_mirrors.py https://my.ultrafeeder/data/aircraft.json
"""
from __future__ import annotations

import concurrent.futures
import json
import socket
import statistics
import sys
import urllib.error
import urllib.request

# Force IPv4 — this egress (and the droplet) has broken IPv6; an AAAA-first
# connect hangs/fails and masks a perfectly reachable host as URLError. The
# backend's httpx client pins IPv4 (local_address 0.0.0.0); match it here.
_orig_getaddrinfo = socket.getaddrinfo


def _getaddrinfo_v4(host, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
    return [r for r in _orig_getaddrinfo(host, *args, **kwargs) if r[0] == socket.AF_INET]


socket.getaddrinfo = _getaddrinfo_v4

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Open readsb/tar1090 instances + ADSBx-v2 endpoints to test. Many will be dead
# or geo/UA/Cloudflare-blocked — that's the point of probing. The first three are
# the currently-configured feeds (baseline sanity).
CANDIDATES = [
    # readsb/tar1090 open mirrors (no key, no Cloudflare) — the "tar1090 way".
    "https://globe.theairtraffic.com/data/aircraft.json",
    "https://skylink.hpradar.com/data/aircraft.json",
    "https://hpradar.com/data/aircraft.json",
    "https://radar.fdy.cz/data/aircraft.json",
    "https://adsb.330k.info/data/aircraft.json",
    "https://tar1090.adsb.im/data/aircraft.json",
    "https://adsbexchange.com/data/aircraft.json",
    # ADSBx-v2 API hosts — /v2/point/0/0/20000 is the whole-globe snapshot quirk.
    "https://api.adsb.lol/v2/point/0/0/20000",
    "https://api.airplanes.live/v2/point/0/0/20000",
    "https://api.adsb.fi/v2/point/0/0/20000",
    "https://api.adsb.one/v2/point/0/0/20000",
    "https://opendata.adsb.fi/v2/point/0/0/20000",
]


def probe(url: str) -> tuple[str, str, int, float]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            status, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        return (url, f"HTTP {e.code}", 0, -1.0)
    except Exception as e:  # noqa: BLE001 — timeouts, DNS, TLS, resets
        return (url, type(e).__name__, 0, -1.0)
    try:
        j = json.loads(body)
    except Exception:  # noqa: BLE001 — non-JSON / rate-limit text body
        return (url, f"{status} non-json", 0, -1.0)
    ac = j.get("aircraft") or j.get("ac") or []
    ages = [
        a["seen_pos"]
        for a in ac
        if isinstance(a, dict) and isinstance(a.get("seen_pos"), (int, float))
    ]
    return (url, str(status), len(ac), statistics.median(ages) if ages else -1.0)


def main() -> None:
    urls = sys.argv[1:] or CANDIDATES
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        rows = sorted(ex.map(probe, urls), key=lambda r: r[2], reverse=True)
    print(f"{'count':>7}  {'age_s':>6}  {'status':<14}  url")
    for url, status, count, med in rows:
        age = f"{med:.1f}" if med >= 0 else "-"
        print(f"{count:>7}  {age:>6}  {status:<14}  {url}")


if __name__ == "__main__":
    main()
