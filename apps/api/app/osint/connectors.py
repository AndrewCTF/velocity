"""Keyless infra/domain OSINT connectors — one function per source.

Each returns a plain, normalised dict (never raises for an upstream failure —
degrades to an empty result + ``note``). They do NOT persist anything; the
investigate orchestrator (``routes/osint.py``) composes them into ontology
objects/links. Sources, all keyless:

  dns     — Google DNS-over-HTTPS  (dns.google/resolve)
  whois   — RDAP                    (rdap.org/domain|ip)
  certs   — Certificate Transparency (crt.sh)
  ipgeo   — IP geolocation + ASN    (ip-api.com, 45 req/min free)
  shodan  — Shodan InternetDB       (internetdb.shodan.io — keyless mirror)
  threat  — AlienVault OTX          (otx.alienvault.com — keyless read)
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.osint.fetch import fetch_json, normalise_domain, normalise_ip

# ── DNS ────────────────────────────────────────────────────────────────────────

# dns.google/resolve type numbers → record label.
_DNS_TYPES = {"A": 1, "AAAA": 28, "MX": 15, "NS": 2, "TXT": 16, "CNAME": 5}


async def lookup_dns(domain: str) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {"domain": domain, "records": {}, "ips": [], "note": "invalid domain"}

    async def one(rtype: str, num: int) -> tuple[str, list[str]]:
        data = await fetch_json(
            f"https://dns.google/resolve?name={d}&type={num}", 300.0
        )
        answers = (data or {}).get("Answer") or []
        vals = [str(a.get("data", "")).strip() for a in answers if a.get("type") == num]
        return rtype, [v for v in vals if v]

    pairs = await asyncio.gather(*(one(t, n) for t, n in _DNS_TYPES.items()))
    records = {t: v for t, v in pairs if v}
    ips = records.get("A", []) + records.get("AAAA", [])
    return {"domain": d, "records": records, "ips": ips}


# ── RDAP WHOIS ──────────────────────────────────────────────────────────────────

def _vcard_field(entity: dict[str, Any], field: str) -> str:
    """Pull one field (fn/email/org) out of an RDAP entity's jCard array."""
    arr = entity.get("vcardArray")
    if not isinstance(arr, list) or len(arr) < 2 or not isinstance(arr[1], list):
        return ""
    for item in arr[1]:
        if isinstance(item, list) and len(item) >= 4 and item[0] == field:
            return str(item[3]).strip()
    return ""


def _rdap_events(obj: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for ev in obj.get("events") or []:
        action = str(ev.get("eventAction", ""))
        date = str(ev.get("eventDate", ""))
        if action and date:
            out[action] = date
    return out


async def lookup_whois(target: str) -> dict[str, Any]:
    """RDAP registration data for a domain OR an ip."""
    ip = normalise_ip(target)
    if ip is not None:
        data = await fetch_json(
            f"https://rdap.org/ip/{ip}", 3600.0,
            headers={"Accept": "application/rdap+json"},
        )
        if not data:
            return {"ip": ip, "note": "rdap unavailable"}
        return {
            "ip": ip,
            "handle": str(data.get("handle", "")),
            "name": str(data.get("name", "")),
            "country": str(data.get("country", "")),
            "cidr": _ip_cidr(data),
            "type": str(data.get("type", "")),
        }

    d = normalise_domain(target)
    if d is None:
        return {"domain": target, "note": "invalid target"}
    data = await fetch_json(
        f"https://rdap.org/domain/{d}", 3600.0,
        headers={"Accept": "application/rdap+json"},
    )
    if not data:
        return {"domain": d, "note": "rdap unavailable"}
    registrant_org = registrant_email = ""
    for ent in data.get("entities") or []:
        roles = ent.get("roles") or []
        if "registrant" in roles or "registrar" in roles:
            registrant_org = registrant_org or _vcard_field(ent, "fn") or _vcard_field(ent, "org")
            registrant_email = registrant_email or _vcard_field(ent, "email")
    events = _rdap_events(data)
    return {
        "domain": d,
        "registrar": registrant_org,
        "registrant_email": registrant_email,
        "created": events.get("registration", ""),
        "expires": events.get("expiration", ""),
        "updated": events.get("last changed", ""),
        "status": [str(x) for x in (data.get("status") or [])],
        "nameservers": [
            str(ns.get("ldhName", "")).lower()
            for ns in (data.get("nameservers") or [])
            if ns.get("ldhName")
        ],
    }


def _ip_cidr(data: dict[str, Any]) -> str:
    start, end = data.get("startAddress"), data.get("endAddress")
    if start and end:
        return f"{start} – {end}"
    return ""


# ── Certificate Transparency (crt.sh) ───────────────────────────────────────────

async def lookup_certs(domain: str, *, max_subdomains: int = 100) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {"domain": domain, "subdomains": [], "certs": [], "note": "invalid domain"}
    # %25 = url-encoded % wildcard: all certs for the domain + its subdomains.
    data = await fetch_json(
        f"https://crt.sh/?q=%25.{d}&output=json", 3600.0, browser_ua=True
    )
    if not isinstance(data, list):
        return {"domain": d, "subdomains": [], "certs": [], "note": "crt.sh unavailable"}
    subs: set[str] = set()
    certs: list[dict[str, str]] = []
    for row in data[:2000]:  # crt.sh can return thousands; bound the scan
        if not isinstance(row, dict):
            continue
        for name in str(row.get("name_value", "")).splitlines():
            name = name.strip().lower().lstrip("*.")
            if name.endswith(d) and name != d:
                subs.add(name)
        if len(certs) < 50:
            certs.append({
                "issuer": str(row.get("issuer_name", ""))[:200],
                "not_before": str(row.get("not_before", "")),
                "not_after": str(row.get("not_after", "")),
            })
    subdomains = sorted(subs)
    truncated = len(subdomains) > max_subdomains
    return {
        "domain": d,
        "subdomains": subdomains[:max_subdomains],
        "subdomain_count": len(subdomains),  # honest total, even when truncated
        "truncated": truncated,
        "certs": certs,
    }


# ── IP geolocation + ASN (ip-api.com) ────────────────────────────────────────────

async def lookup_ip(ip: str) -> dict[str, Any]:
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "note": "invalid ip"}
    data = await fetch_json(
        f"http://ip-api.com/json/{v}"
        "?fields=status,country,countryCode,city,lat,lon,isp,org,as,reverse,query",
        3600.0,
    )
    if not data or data.get("status") != "success":
        return {"ip": v, "note": "ip-api unavailable"}
    asn = str(data.get("as", "")).split(" ", 1)[0]  # "AS15169 Google LLC" → AS15169
    return {
        "ip": v,
        "city": str(data.get("city", "")),
        "country": str(data.get("country", "")),
        "country_code": str(data.get("countryCode", "")),
        "lat": data.get("lat"),
        "lon": data.get("lon"),
        "asn": asn,
        "org": str(data.get("org") or data.get("isp") or ""),
        "reverse": str(data.get("reverse", "")),
    }


# ── Shodan InternetDB (keyless) ──────────────────────────────────────────────────

async def lookup_shodan(ip: str) -> dict[str, Any]:
    v = normalise_ip(ip)
    if v is None:
        return {"ip": ip, "note": "invalid ip"}
    data = await fetch_json(f"https://internetdb.shodan.io/{v}", 1800.0)
    if not isinstance(data, dict) or "ports" not in data:
        return {"ip": v, "ports": [], "hostnames": [], "vulns": [], "note": "no data"}
    return {
        "ip": v,
        "ports": list(data.get("ports") or []),
        "hostnames": [str(h) for h in (data.get("hostnames") or [])],
        "cpes": [str(c) for c in (data.get("cpes") or [])],
        "tags": [str(t) for t in (data.get("tags") or [])],
        "vulns": [str(x) for x in (data.get("vulns") or [])],
    }


# ── AlienVault OTX threat-intel (keyless read) ───────────────────────────────────

async def lookup_threat(target: str) -> dict[str, Any]:
    ip = normalise_ip(target)
    if ip is not None:
        section = "IPv6" if ":" in ip else "IPv4"
        indicator = ip
    else:
        d = normalise_domain(target)
        if d is None:
            return {"indicator": target, "pulse_count": 0, "pulses": [], "note": "invalid"}
        section, indicator = "domain", d
    data = await fetch_json(
        f"https://otx.alienvault.com/api/v1/indicators/{section}/{indicator}/general",
        1800.0, browser_ua=True,
    )
    info = (data or {}).get("pulse_info") or {}
    pulses = [str(p.get("name", "")) for p in (info.get("pulses") or []) if p.get("name")]
    tags: set[str] = set()
    for p in info.get("pulses") or []:
        for t in p.get("tags") or []:
            tags.add(str(t))
    return {
        "indicator": indicator,
        "pulse_count": int(info.get("count") or 0),
        "pulses": pulses[:25],
        "tags": sorted(tags)[:25],
    }
