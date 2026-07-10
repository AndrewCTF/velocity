"""Domain/IP infrastructure enrichment — passive recon beyond DNS/WHOIS/certs.

One function per source, all keyless-first (key-optional sources still run
without a key, degrading to a limited result + ``note``). Never raises on
upstream failure. Sources:

  wayback_urls          — Wayback Machine CDX index      (web.archive.org)
  hackertarget_hosts     — hostsearch (plaintext host,ip) (api.hackertarget.com, 50/day)
  anubis_subdomains      — jldc.me anubis subdomain dump  (jldc.me)
  columbus_subdomains    — columbus subdomain lookup      (columbus.elmasy.com)
  certspotter_issuances  — certificate transparency       (api.certspotter.com, key-optional)
  urlscan_domain         — historical scans for a domain  (urlscan.io, key-optional)
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from app.osint.fetch import fetch_json, normalise_domain
from app.upstream import get_client

_BOUND = 40


async def _fetch_text(url: str, *, headers: dict[str, str] | None = None) -> str | None:
    """Uncached, bounded GET returning the raw text body — or None on failure.

    A few sources here (hackertarget) reply with plaintext, not JSON, so the
    shared ``fetch_json`` (which requires a JSON body) can't be reused. Kept
    local and tiny rather than growing ``fetch.py``'s scope for one caller.
    """
    try:
        r = await get_client().get(url, headers=headers or None, follow_redirects=True)
    except Exception:  # noqa: BLE001 — network error → degrade
        return None
    if r.status_code != 200:
        return None
    return r.text


# ── Wayback Machine CDX ──────────────────────────────────────────────────────


async def wayback_urls(domain: str) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {
            "domain": domain,
            "urls": [],
            "subdomains": [],
            "url_count": 0,
            "subdomain_count": 0,
            "note": "invalid domain",
        }
    data = await fetch_json(
        f"http://web.archive.org/cdx/search/cdx?url={d}"
        "&matchType=domain&output=json&fl=original&collapse=urlkey&limit=500",
        3600.0,
    )
    if not isinstance(data, list) or len(data) < 2:
        return {
            "domain": d,
            "urls": [],
            "subdomains": [],
            "url_count": 0,
            "subdomain_count": 0,
            "note": "wayback unavailable",
        }
    rows = data[1:]  # first row is the header (["original"])
    urls: list[str] = []
    subs: set[str] = set()
    for row in rows:
        if not isinstance(row, list) or not row:
            continue
        u = str(row[0]).strip()
        if not u:
            continue
        urls.append(u)
        host = urlsplit(u).hostname
        if host:
            host = host.lower()
            if host.endswith(d) and host != d:
                subs.add(host)
    subdomains = sorted(subs)
    return {
        "domain": d,
        "urls": urls[:_BOUND],
        "subdomains": subdomains[:_BOUND],
        "url_count": len(urls),
        "subdomain_count": len(subdomains),
    }


# ── HackerTarget hostsearch (plaintext) ──────────────────────────────────────


async def hackertarget_hosts(domain: str) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {"domain": domain, "hosts": [], "count": 0, "note": "invalid domain"}
    text = await _fetch_text(f"https://api.hackertarget.com/hostsearch/?q={d}")
    if text is None:
        return {"domain": d, "hosts": [], "count": 0, "note": "hackertarget unavailable"}
    stripped = text.strip()
    if not stripped or "API count exceeded" in stripped or "error" in stripped.lower():
        return {"domain": d, "hosts": [], "count": 0, "note": "hackertarget rate limit or no data"}
    hosts: list[dict[str, str]] = []
    for line in stripped.splitlines():
        parts = line.strip().split(",")
        if len(parts) != 2:
            continue
        host, ip = parts[0].strip().lower(), parts[1].strip()
        if host:
            hosts.append({"host": host, "ip": ip})
    return {"domain": d, "hosts": hosts[:_BOUND], "count": len(hosts)}


# ── Anubis subdomain dump ────────────────────────────────────────────────────


async def anubis_subdomains(domain: str) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {"domain": domain, "subdomains": [], "count": 0, "note": "invalid domain"}
    data = await fetch_json(f"https://jldc.me/anubis/subdomains/{d}", 3600.0)
    if not isinstance(data, list):
        return {"domain": d, "subdomains": [], "count": 0, "note": "anubis unavailable"}
    subs = sorted({str(s).strip().lower() for s in data if str(s).strip()})
    return {"domain": d, "subdomains": subs[:_BOUND], "count": len(subs)}


# ── Columbus subdomain lookup ────────────────────────────────────────────────


async def columbus_subdomains(domain: str) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {"domain": domain, "subdomains": [], "count": 0, "note": "invalid domain"}
    data = await fetch_json(f"https://columbus.elmasy.com/api/lookup/{d}", 3600.0)
    if not isinstance(data, list):
        return {"domain": d, "subdomains": [], "count": 0, "note": "columbus unavailable"}
    subs: set[str] = set()
    for item in data:
        label = str(item).strip().lower()
        if not label:
            continue
        # Columbus returns bare labels ("www"), not FQDNs — prepend the domain
        # unless the upstream already qualified it.
        subs.add(label if label.endswith(d) else f"{label}.{d}")
    sorted_subs = sorted(subs)
    return {"domain": d, "subdomains": sorted_subs[:_BOUND], "count": len(sorted_subs)}


# ── CertSpotter issuances (key-optional) ─────────────────────────────────────


async def certspotter_issuances(domain: str) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {
            "domain": domain,
            "subdomains": [],
            "certs": [],
            "count": 0,
            "note": "invalid domain",
        }
    from app.config import get_settings

    key = getattr(get_settings(), "certspotter_api_key", "") or ""
    headers = {"Authorization": f"Bearer {key}"} if key else None
    data = await fetch_json(
        f"https://api.certspotter.com/v1/issuances?domain={d}"
        "&include_subdomains=true&expand=dns_names",
        1800.0,
        headers=headers,
    )
    if not isinstance(data, list):
        note = None if key else "no CERTSPOTTER_API_KEY set (unauthenticated rate limit)"
        return {
            "domain": d,
            "subdomains": [],
            "certs": [],
            "count": 0,
            "note": note or "certspotter unavailable",
        }
    subs: set[str] = set()
    certs: list[dict[str, str]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        for name in row.get("dns_names") or []:
            name = str(name).strip().lower().lstrip("*.")
            if name.endswith(d) and name != d:
                subs.add(name)
        if len(certs) < 20:
            issuer = row.get("issuer") or {}
            certs.append(
                {
                    "issuer": str(issuer.get("name", ""))
                    if isinstance(issuer, dict)
                    else str(issuer),
                    "not_before": str(row.get("not_before", "")),
                    "not_after": str(row.get("not_after", "")),
                }
            )
    subdomains = sorted(subs)
    return {
        "domain": d,
        "subdomains": subdomains[:_BOUND],
        "certs": certs,
        "count": len(subdomains),
    }


# ── urlscan.io historical scans (key-optional) ───────────────────────────────


async def urlscan_domain(domain: str) -> dict[str, Any]:
    d = normalise_domain(domain)
    if d is None:
        return {"domain": domain, "scans": [], "ips": [], "count": 0, "note": "invalid domain"}
    from app.config import get_settings

    key = getattr(get_settings(), "urlscan_api_key", "") or ""
    headers = {"API-Key": key} if key else None
    data = await fetch_json(
        f"https://urlscan.io/api/v1/search/?q=domain:{d}",
        1800.0,
        headers=headers,
    )
    if not isinstance(data, dict):
        return {"domain": d, "scans": [], "ips": [], "count": 0, "note": "urlscan unavailable"}
    results = data.get("results") or []
    scans: list[dict[str, Any]] = []
    ips: set[str] = set()
    for row in results:
        if not isinstance(row, dict):
            continue
        page = row.get("page") or {}
        task = row.get("task") or {}
        ip = page.get("ip")
        if ip:
            ips.add(str(ip))
        if len(scans) < _BOUND:
            scans.append(
                {
                    "url": str(page.get("url", "")),
                    "ip": str(ip or ""),
                    "asn": str(page.get("asn", "")),
                    "time": str(task.get("time", "")),
                }
            )
    return {
        "domain": d,
        "scans": scans,
        "ips": sorted(ips),
        "count": len(results),
    }
