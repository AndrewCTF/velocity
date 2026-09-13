"""Keyless-first IP/ASN routing + reputation connectors.

One function per source, mirroring ``app/osint/connectors.py`` style: each
returns a plain, normalised dict and never raises on upstream failure
(degrades to an empty result + ``note``). Sources:

  bgpview_ip        — IP → announcing prefixes/ASNs, via RIPEstat (keyless)
  bgpview_asn       — ASN → holder/prefixes/peers, via RIPEstat (keyless)
  ripestat_network  — RIPEstat network-info + abuse contact    (keyless)
  greynoise_community — GreyNoise Community scan classification (key-optional)
  onionoo_exit      — Tor onionoo relay search → exit-node flag (keyless)
  feodo_listed      — abuse.ch Feodo Tracker C2 IP blocklist   (keyless, 1h cache)
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.osint.fetch import fetch_json, normalise_asn, normalise_ip

# ── IP / ASN topology ────────────────────────────────────────────────────────
#
# These two were BGPView (api.bgpview.io) until 2026-08-21, when the host went
# NXDOMAIN — not blocked, not rate-limited: no A record, confirmed against the
# system resolver and 1.1.1.1 independently. The egress audit filed it as
# "dns-fail" and nothing else looked at it.
#
# They now run on RIPEstat, which was ALREADY a substrate in this same file
# (ripestat_network below) and answers 200 keyless. The function and route names
# stay `bgpview_*` on purpose: /api/osint/bgpview-ip and -asn are a frontend
# contract and an ontology provenance string, and renaming them to fix a
# backend swap would break routeCoverage.test.ts and the graph for no gain.
# The names are historical; the data is RIPEstat's.

_RIPESTAT = "https://stat.ripe.net/data"
_SOURCEAPP = "sourceapp=velocity-osint"


async def bgpview_ip(ip: str) -> dict[str, Any]:
    """IP → announcing prefix + origin ASNs. RIPEstat prefix-overview."""
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "prefixes": [], "asns": [], "note": "invalid ip"}
    data = await fetch_json(
        f"{_RIPESTAT}/prefix-overview/data.json?resource={v}&{_SOURCEAPP}", 3600.0
    )
    if data is None:
        return {"ip": v, "prefixes": [], "asns": [], "note": "ripestat unavailable"}
    inner = data.get("data") or {}
    prefixes: list[str] = []
    resource = str(inner.get("resource") or "")
    if resource:
        prefixes.append(resource)
    for rel in inner.get("related_prefixes") or []:
        if isinstance(rel, str) and rel:
            prefixes.append(rel)
    asns: dict[str, dict[str, str]] = {}
    for a in inner.get("asns") or []:
        if not isinstance(a, dict):
            continue
        num = a.get("asn")
        if not num:
            continue
        asn_id = f"AS{num}"
        # RIPEstat gives one `holder` string ("GOOGLE - Google LLC"); BGPView
        # split name and country. Country is not in this endpoint, so it stays
        # empty rather than being guessed — an empty field beats a wrong one.
        asns.setdefault(asn_id, {"asn": asn_id, "name": str(a.get("holder", "")), "country": ""})
    return {"ip": v, "prefixes": prefixes[:40], "asns": list(asns.values())[:40]}


async def bgpview_asn(asn: str) -> dict[str, Any]:
    """ASN → holder, announced prefixes, neighbours. RIPEstat, three calls.

    Unlike BGPView's free API, RIPEstat's asn-neighbours DOES distinguish
    direction (`type`: left = upstream/provider side, right = customer side), so
    `upstreams` is finally populated instead of being a permanently empty list
    with an apology next to it.
    """
    a = normalise_asn(asn)
    empty = {
        "asn": asn,
        "name": "",
        "description": "",
        "country": "",
        "prefixes": [],
        "peers": [],
        "upstreams": [],
    }
    if a is None:
        return {**empty, "note": "invalid asn"}
    info, prefixes_data, peers_data = await asyncio.gather(
        fetch_json(f"{_RIPESTAT}/as-overview/data.json?resource={a}&{_SOURCEAPP}", 3600.0),
        fetch_json(
            f"{_RIPESTAT}/announced-prefixes/data.json?resource={a}&{_SOURCEAPP}", 3600.0
        ),
        fetch_json(f"{_RIPESTAT}/asn-neighbours/data.json?resource={a}&{_SOURCEAPP}", 3600.0),
    )
    if info is None and prefixes_data is None and peers_data is None:
        return {**empty, "asn": a, "note": "ripestat unavailable"}

    info_data = (info or {}).get("data") or {}
    holder = str(info_data.get("holder") or "")

    pdata = (prefixes_data or {}).get("data") or {}
    prefixes: list[str] = []
    for entry in pdata.get("prefixes") or []:
        if isinstance(entry, dict):
            pfx = str(entry.get("prefix", ""))
            if pfx:
                prefixes.append(pfx)

    peer_data = (peers_data or {}).get("data") or {}
    peers: set[str] = set()
    upstreams: set[str] = set()
    for n in peer_data.get("neighbours") or []:
        if not isinstance(n, dict):
            continue
        num = n.get("asn")
        if not num:
            continue
        nid = f"AS{num}"
        peers.add(nid)
        if n.get("type") == "left":
            upstreams.add(nid)

    return {
        "asn": a,
        "name": holder,
        "description": holder,
        "country": "",
        "prefixes": prefixes[:40],
        "peers": sorted(peers)[:40],
        "upstreams": sorted(upstreams)[:40],
    }


# ── RIPEstat ─────────────────────────────────────────────────────────────────


async def ripestat_network(ip: str) -> dict[str, Any]:
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "asns": [], "prefix": "", "abuse_email": "", "note": "invalid ip"}
    net_data, abuse_data = await asyncio.gather(
        fetch_json(
            f"https://stat.ripe.net/data/network-info/data.json?resource={v}&sourceapp=velocity-osint",
            3600.0,
        ),
        fetch_json(
            f"https://stat.ripe.net/data/abuse-contact-finder/data.json?resource={v}&sourceapp=velocity-osint",
            3600.0,
        ),
    )
    if net_data is None and abuse_data is None:
        return {
            "ip": v,
            "asns": [],
            "prefix": "",
            "abuse_email": "",
            "note": "ripestat unavailable",
        }

    net_inner = (net_data or {}).get("data") or {}
    asns = [f"AS{n}" for n in (net_inner.get("asns") or []) if n]
    prefix = str(net_inner.get("prefix") or "")

    abuse_inner = (abuse_data or {}).get("data") or {}
    contacts = abuse_inner.get("abuse_contacts") or []
    abuse_email = str(contacts[0]) if contacts else ""

    return {"ip": v, "asns": asns, "prefix": prefix, "abuse_email": abuse_email}


# ── GreyNoise Community ───────────────────────────────────────────────────────


async def greynoise_community(ip: str) -> dict[str, Any]:
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "classification": "unknown", "noise": False, "note": "invalid ip"}
    from app.config import get_settings

    key = getattr(get_settings(), "greynoise_api_key", "") or ""
    headers = {"key": key} if key else None
    data = await fetch_json(f"https://api.greynoise.io/v3/community/{v}", 900.0, headers=headers)
    if not isinstance(data, dict) or "classification" not in data:
        # 404 / unseen IP is the common, normal case for this endpoint — not an error.
        return {"ip": v, "classification": "unknown", "noise": False, "note": "not observed"}
    return {
        "ip": v,
        "classification": str(data.get("classification", "unknown")),
        "name": str(data.get("name", "")),
        "noise": bool(data.get("noise", False)),
        "last_seen": str(data.get("last_seen", "")),
        "tags": [str(t) for t in (data.get("tags") or [])],
    }


# ── Tor onionoo ────────────────────────────────────────────────────────────────


async def onionoo_exit(ip: str) -> dict[str, Any]:
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "is_tor_exit": False, "nickname": "", "country": "", "note": "invalid ip"}
    data = await fetch_json(
        f"https://onionoo.torproject.org/details?type=relay&running=true&search={v}", 900.0
    )
    relays = (data or {}).get("relays") or []
    if not relays:
        return {"ip": v, "is_tor_exit": False, "nickname": "", "country": ""}
    for relay in relays:
        if not isinstance(relay, dict):
            continue
        if "Exit" in (relay.get("flags") or []):
            return {
                "ip": v,
                "is_tor_exit": True,
                "nickname": str(relay.get("nickname", "")),
                "country": str(relay.get("country", "")),
            }
    first = relays[0] if isinstance(relays[0], dict) else {}
    return {
        "ip": v,
        "is_tor_exit": False,
        "nickname": str(first.get("nickname", "")),
        "country": str(first.get("country", "")),
    }


# ── abuse.ch Feodo Tracker ───────────────────────────────────────────────────


async def feodo_listed(ip: str) -> dict[str, Any]:
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "listed": False, "malware": "", "first_seen": "", "note": "invalid ip"}
    # Whole blocklist cached for 1h (fetch_json caches by url) — fetched once/hr,
    # reused for every ip lookup rather than hitting the upstream per-target.
    data = await fetch_json("https://feodotracker.abuse.ch/downloads/ipblocklist.json", 3600.0)
    if not isinstance(data, list):
        return {
            "ip": v,
            "listed": False,
            "malware": "",
            "first_seen": "",
            "note": "feodo unavailable",
        }
    for row in data:
        if isinstance(row, dict) and str(row.get("ip_address", "")) == v:
            return {
                "ip": v,
                "listed": True,
                "malware": str(row.get("malware", "")),
                "first_seen": str(row.get("first_seen", "")),
            }
    return {"ip": v, "listed": False, "malware": "", "first_seen": ""}
