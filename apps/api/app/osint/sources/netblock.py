"""Keyless-first IP/ASN routing + reputation connectors.

One function per source, mirroring ``app/osint/connectors.py`` style: each
returns a plain, normalised dict and never raises on upstream failure
(degrades to an empty result + ``note``). Sources:

  bgpview_ip        — BGPView IP → announcing prefixes/ASNs (keyless)
  bgpview_asn       — BGPView ASN → name/prefixes/peers        (keyless)
  ripestat_network  — RIPEstat network-info + abuse contact    (keyless)
  greynoise_community — GreyNoise Community scan classification (key-optional)
  onionoo_exit      — Tor onionoo relay search → exit-node flag (keyless)
  feodo_listed      — abuse.ch Feodo Tracker C2 IP blocklist   (keyless, 1h cache)
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.osint.fetch import fetch_json, normalise_asn, normalise_ip

# ── BGPView ──────────────────────────────────────────────────────────────────


async def bgpview_ip(ip: str) -> dict[str, Any]:
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "prefixes": [], "asns": [], "note": "invalid ip"}
    data = await fetch_json(f"https://api.bgpview.io/ip/{v}", 3600.0)
    if data is None:
        return {"ip": v, "prefixes": [], "asns": [], "note": "bgpview unavailable"}
    inner = data.get("data") or {}
    prefixes: list[str] = []
    asns: dict[str, dict[str, str]] = {}
    for p in inner.get("prefixes") or []:
        if not isinstance(p, dict):
            continue
        prefix = str(p.get("prefix", ""))
        if prefix:
            prefixes.append(prefix)
        asn_info = p.get("asn") or {}
        asn_num = asn_info.get("asn")
        if asn_num:
            asn_id = f"AS{asn_num}"
            asns.setdefault(
                asn_id,
                {
                    "asn": asn_id,
                    "name": str(asn_info.get("name", "")),
                    "country": str(asn_info.get("country_code", "")),
                },
            )
    return {"ip": v, "prefixes": prefixes[:40], "asns": list(asns.values())[:40]}


async def bgpview_asn(asn: str) -> dict[str, Any]:
    a = normalise_asn(asn)
    if a is None:
        return {
            "asn": asn,
            "name": "",
            "description": "",
            "country": "",
            "prefixes": [],
            "peers": [],
            "upstreams": [],
            "note": "invalid asn",
        }
    n = a[2:]  # "AS15169" -> "15169"
    info, prefixes_data, peers_data = await asyncio.gather(
        fetch_json(f"https://api.bgpview.io/asn/{n}", 3600.0),
        fetch_json(f"https://api.bgpview.io/asn/{n}/prefixes", 3600.0),
        fetch_json(f"https://api.bgpview.io/asn/{n}/peers", 3600.0),
    )
    if info is None and prefixes_data is None and peers_data is None:
        return {
            "asn": a,
            "name": "",
            "description": "",
            "country": "",
            "prefixes": [],
            "peers": [],
            "upstreams": [],
            "note": "bgpview unavailable",
        }

    info_data = (info or {}).get("data") or {}
    name = str(info_data.get("name") or "")
    description = str(info_data.get("description_short") or info_data.get("description_full") or "")
    country = str(info_data.get("country_code") or "")

    pdata = (prefixes_data or {}).get("data") or {}
    prefixes: list[str] = []
    for key in ("ipv4_prefixes", "ipv6_prefixes"):
        for p in pdata.get(key) or []:
            if not isinstance(p, dict):
                continue
            prefix = str(p.get("prefix", ""))
            if prefix:
                prefixes.append(prefix)

    peer_data = (peers_data or {}).get("data") or {}
    peers: set[str] = set()
    for key in ("ipv4_peers", "ipv6_peers"):
        for p in peer_data.get(key) or []:
            if not isinstance(p, dict):
                continue
            pn = p.get("asn")
            if pn:
                peers.add(f"AS{pn}")

    return {
        "asn": a,
        "name": name,
        "description": description,
        "country": country,
        "prefixes": prefixes[:40],
        "peers": sorted(peers)[:40],
        "upstreams": [],  # BGPView's free API doesn't distinguish upstream vs peer
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
