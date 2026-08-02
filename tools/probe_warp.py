#!/usr/bin/env python3
"""A/B every gated upstream DIRECT vs through the WARP SOCKS5 proxy.

WHY: several upstreams gate on the CALLER'S IP (adsb.lol 451, airplanes.live /
adsb.fi 403 from a datacenter address, OpenSky's per-IP anonymous budget).
`warp-cli mode proxy` exposes a keyless free-tier SOCKS5 on 127.0.0.1 whose exit
is a Cloudflare consumer address, which can lift those. CAN, not does — some
sites block WARP ranges outright, and a shared exit can arrive already
rate-limited. This script is what decides, per host, whether WARP goes in
`WARP_HOSTS`. Never populate that list from a guess.

    bash scripts/warp.sh up          # tunnel first
    apps/api/.venv/bin/python tools/probe_warp.py
    apps/api/.venv/bin/python tools/probe_warp.py https://host/path  # custom set

Reads: status, payload size, decoded record count, latency. A row is a WIN only
if WARP's status is 200 where direct is not, or WARP's count is materially
higher. Equal-and-fine means leave the host direct — the tunnel is not free.
"""

from __future__ import annotations

import json
import sys
import time

import httpx

PROXY = "socks5://127.0.0.1:40000"

# Browser-ish UA. The gated hosts 451/403 an obvious bot UA regardless of IP, so
# a bare-UA probe would measure the UA, not the egress.
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

CANDIDATES = [
    # identity — not a feed, tells you which exit each column is using
    "https://1.1.1.1/cdn-cgi/trace",
    # ADS-B: readsb aircraft.json mirrors + the /v2 APIs
    "https://globe.theairtraffic.com/data/aircraft.json",
    "https://skylink.hpradar.com/data/aircraft.json",
    "https://api.adsb.lol/v2/point/0/0/20000",
    "https://globe.airplanes.live/data/aircraft.json",
    "https://globe.adsb.fi/data/aircraft.json",
    "https://globe.adsbexchange.com/data/aircraft.json",
    # satellites (CelesTrak 403-rate-limits bursts — one small group only)
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",
    # AIS
    "https://data.shipxplorer.com/live",
    # aviation reference
    "https://opensky-network.org/api/states/all?lamin=51&lomin=-1&lamax=52&lomax=1",
]

# Hosts that only answer with a matching Referer/Origin (see ais_keyless.py).
EXTRA_HEADERS = {
    "data.shipxplorer.com": {
        "referer": "https://www.shipxplorer.com/",
        "origin": "https://www.shipxplorer.com",
        "accept": "application/json, text/plain, */*",
    },
}


def _count(body: bytes, url: str) -> str:
    """Decoded record count, so a 200 that carries nothing is not read as a win."""
    if "cdn-cgi/trace" in url:
        for line in body.decode("utf-8", "replace").splitlines():
            if line.startswith(("ip=", "warp=")):
                return line
        return "-"
    if url.endswith("FORMAT=tle"):
        return f"{len(body.splitlines()) // 3} tle"
    try:
        data = json.loads(body)
    except Exception:  # noqa: BLE001 — a challenge page is HTML, that IS the answer
        head = body[:40].decode("utf-8", "replace").replace("\n", " ")
        return f"non-json:{head!r}"
    for key in ("ac", "aircraft", "states", "data", "vessels"):
        val = data.get(key) if isinstance(data, dict) else None
        if isinstance(val, list):
            return f"{len(val)} {key}"
    return f"{len(data)} keys" if isinstance(data, dict) else "?"


def probe(url: str, proxy: str | None) -> str:
    host = httpx.URL(url).host
    headers = {"user-agent": UA, **EXTRA_HEADERS.get(host, {})}
    # local_address pins IPv4 (this egress has broken v6); httpx ignores it for
    # SOCKS pools, which is fine — the tunnel handles its own addressing.
    transport = httpx.HTTPTransport(
        local_address=None if proxy else "0.0.0.0",
        proxy=httpx.Proxy(proxy) if proxy else None,
        retries=1,
    )
    t0 = time.monotonic()
    try:
        with httpx.Client(transport=transport, timeout=20.0, headers=headers) as c:
            r = c.get(url)
        ms = int((time.monotonic() - t0) * 1000)
        return f"{r.status_code} · {len(r.content) // 1024:>5}KB · {_count(r.content, url):<28} · {ms:>5}ms"
    except Exception as exc:  # noqa: BLE001 — a refusal is a result, not a crash
        ms = int((time.monotonic() - t0) * 1000)
        return f"ERR · {type(exc).__name__}: {str(exc)[:48]:<40} · {ms:>5}ms"


def main() -> None:
    urls = sys.argv[1:] or CANDIDATES
    print(f"proxy: {PROXY}\n")
    for url in urls:
        print(f"── {url}")
        print(f"   direct : {probe(url, None)}")
        print(f"   warp   : {probe(url, PROXY)}")
    print(
        "\nWARP only earns a host when its status/count beats direct. "
        "Equal → leave it direct; the tunnel costs latency."
    )


if __name__ == "__main__":
    main()
