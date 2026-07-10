"""Keyless-first threat-intel connectors: url/hash/email reputation feeds.

  urlhaus_host        — abuse.ch URLhaus, urls hosted on a host   (POST, key-optional)
  urlhaus_url         — abuse.ch URLhaus, a specific url          (POST, key-optional)
  malwarebazaar_hash  — abuse.ch MalwareBazaar, sample by hash    (POST, key-optional)
  yaraify_hash        — abuse.ch YARAify, sample by hash          (POST, keyless)
  emailrep            — emailrep.io reputation                    (GET, key-optional)
  phishstats_url      — PhishStats phishing feed                  (GET, keyless)

All abuse.ch endpoints are POST-only and now accept (do not require) an
``Auth-Key`` header — set ``ABUSECH_AUTH_KEY`` to raise your rate limit; with
no key the connector still attempts the call and degrades to an empty result
+ ``note`` if the API rejects it. None of these ever raise.
"""

from __future__ import annotations

from typing import Any

from app.osint.fetch import (
    fetch_json,
    fetch_json_post,
    normalise_domain,
    normalise_email,
    normalise_hash,
    normalise_ip,
    normalise_url,
)


def _abusech_headers() -> dict[str, str]:
    from app.config import get_settings

    key = getattr(get_settings(), "abusech_auth_key", "") or ""
    return {"Auth-Key": key} if key else {}


# ── abuse.ch URLhaus ────────────────────────────────────────────────────────────


async def urlhaus_host(host: str) -> dict[str, Any]:
    """Malicious URLs hosted on ``host`` (a domain or an IP)."""
    h = normalise_domain(host) or normalise_ip(host)
    if h is None:
        return {"host": host, "urls": [], "url_count": 0, "note": "invalid host"}
    data = await fetch_json_post(
        "https://urlhaus-api.abuse.ch/v1/host/",
        900.0,
        data={"host": h},
        headers=_abusech_headers(),
    )
    if not isinstance(data, dict):
        return {"host": h, "urls": [], "url_count": 0, "note": "urlhaus unavailable"}
    status = str(data.get("query_status", ""))
    if status != "ok":
        return {"host": h, "urls": [], "url_count": 0, "note": f"urlhaus: {status or 'no data'}"}
    rows = data.get("urls") or []
    urls = [
        {
            "url": str(row.get("url", "")),
            "threat": str(row.get("threat", "")),
            "status": str(row.get("url_status", "")),
        }
        for row in rows
        if isinstance(row, dict)
    ]
    return {"host": h, "urls": urls[:40], "url_count": len(urls)}


async def urlhaus_url(url: str) -> dict[str, Any]:
    """URLhaus record for a specific url."""
    u = normalise_url(url)
    if u is None:
        return {
            "url": url,
            "threat": "",
            "tags": [],
            "payloads": [],
            "status": "",
            "note": "invalid url",
        }
    data = await fetch_json_post(
        "https://urlhaus-api.abuse.ch/v1/url/",
        900.0,
        data={"url": u},
        headers=_abusech_headers(),
    )
    if not isinstance(data, dict):
        return {
            "url": u,
            "threat": "",
            "tags": [],
            "payloads": [],
            "status": "",
            "note": "urlhaus unavailable",
        }
    status = str(data.get("query_status", ""))
    if status != "ok":
        return {
            "url": u,
            "threat": "",
            "tags": [],
            "payloads": [],
            "status": "",
            "note": f"urlhaus: {status or 'no data'}",
        }
    payloads = [
        str(p.get("response_sha256", ""))
        for p in (data.get("payloads") or [])
        if isinstance(p, dict) and p.get("response_sha256")
    ]
    return {
        "url": u,
        "threat": str(data.get("threat", "")),
        "tags": [str(t) for t in (data.get("tags") or [])],
        "payloads": payloads[:25],
        "status": str(data.get("url_status", "")),
    }


# ── abuse.ch MalwareBazaar ──────────────────────────────────────────────────────


async def malwarebazaar_hash(hash: str) -> dict[str, Any]:  # noqa: A002 — matches spec param name
    """Malware sample metadata by md5/sha1/sha256."""
    h = normalise_hash(hash)
    if h is None:
        return {
            "hash": hash,
            "family": "",
            "file_type": "",
            "tags": [],
            "first_seen": "",
            "signature": "",
            "note": "invalid hash",
        }
    data = await fetch_json_post(
        "https://mb-api.abuse.ch/api/v1/",
        1800.0,
        data={"query": "get_info", "hash": h},
        headers=_abusech_headers(),
    )
    if not isinstance(data, dict):
        return {
            "hash": h,
            "family": "",
            "file_type": "",
            "tags": [],
            "first_seen": "",
            "signature": "",
            "note": "malwarebazaar unavailable",
        }
    status = str(data.get("query_status", ""))
    if status != "ok":
        return {
            "hash": h,
            "family": "",
            "file_type": "",
            "tags": [],
            "first_seen": "",
            "signature": "",
            "note": f"malwarebazaar: {status or 'no data'}",
        }
    rows = data.get("data") or []
    if not rows or not isinstance(rows[0], dict):
        return {
            "hash": h,
            "family": "",
            "file_type": "",
            "tags": [],
            "first_seen": "",
            "signature": "",
            "note": "malwarebazaar: no data",
        }
    row = rows[0]
    signature = str(row.get("signature") or "")
    return {
        "hash": h,
        "family": signature,
        "file_type": str(row.get("file_type", "")),
        "tags": [str(t) for t in (row.get("tags") or [])],
        "first_seen": str(row.get("first_seen", "")),
        "signature": signature,
    }


# ── abuse.ch YARAify ─────────────────────────────────────────────────────────────


async def yaraify_hash(hash: str) -> dict[str, Any]:  # noqa: A002 — matches spec param name
    """YARA + ClamAV matches for a sample hash."""
    h = normalise_hash(hash)
    if h is None:
        return {"hash": hash, "yara": [], "clamav": [], "note": "invalid hash"}
    data = await fetch_json_post(
        "https://yaraify-api.abuse.ch/api/v1/",
        1800.0,
        json_body={"query": "lookup_hash", "search_term": h},
    )
    if not isinstance(data, dict):
        return {"hash": h, "yara": [], "clamav": [], "note": "yaraify unavailable"}
    status = str(data.get("query_status", ""))
    if status != "ok":
        return {"hash": h, "yara": [], "clamav": [], "note": f"yaraify: {status or 'no data'}"}
    tasks = (data.get("data") or {}).get("tasks") or []
    yara: set[str] = set()
    clamav: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict):
            continue
        for m in task.get("yara_matches") or []:
            if isinstance(m, dict) and m.get("rule_name"):
                yara.add(str(m["rule_name"]))
        for c in task.get("clamav_matches") or task.get("clamav") or []:
            if c:
                clamav.add(str(c))
    return {"hash": h, "yara": sorted(yara)[:25], "clamav": sorted(clamav)[:25]}


# ── emailrep.io ──────────────────────────────────────────────────────────────────


async def emailrep(email: str) -> dict[str, Any]:
    """Email reputation: suspicious/malicious flags, breach history, profiles."""
    e = normalise_email(email)
    if e is None:
        return {
            "email": email,
            "reputation": "",
            "suspicious": False,
            "malicious": False,
            "breach": False,
            "profiles": [],
            "note": "invalid email",
        }
    from app.config import get_settings

    key = getattr(get_settings(), "emailrep_api_key", "") or ""
    headers = {"Key": key} if key else {}
    data = await fetch_json(
        f"https://emailrep.io/{e}",
        1800.0,
        headers=headers or None,
        browser_ua=True,
    )
    if not isinstance(data, dict):
        return {
            "email": e,
            "reputation": "",
            "suspicious": False,
            "malicious": False,
            "breach": False,
            "profiles": [],
            "note": "emailrep unavailable",
        }
    details = data.get("details") or {}
    return {
        "email": e,
        "reputation": str(data.get("reputation", "")),
        "suspicious": bool(data.get("suspicious", False)),
        "malicious": bool(details.get("malicious_activity", False)),
        "breach": bool(details.get("credentials_leaked", False)),
        "profiles": [str(p) for p in (details.get("profiles") or [])],
    }


# ── PhishStats ───────────────────────────────────────────────────────────────────


async def phishstats_url(url: str) -> dict[str, Any]:
    """PhishStats phishing-feed lookup for a specific url."""
    u = normalise_url(url)
    if u is None:
        return {"url": url, "score": None, "tld": "", "ip": "", "count": 0, "note": "invalid url"}
    data = await fetch_json(
        f"https://phishstats.info:2096/api/phishing?_where=(url,eq,{u})&_size=5",
        900.0,
    )
    if not isinstance(data, list):
        return {
            "url": u,
            "score": None,
            "tld": "",
            "ip": "",
            "count": 0,
            "note": "phishstats unavailable",
        }
    if not data or not isinstance(data[0], dict):
        return {"url": u, "score": None, "tld": "", "ip": "", "count": 0}
    row = data[0]
    return {
        "url": u,
        "score": row.get("score"),
        "tld": str(row.get("tld", "")),
        "ip": str(row.get("ip", "")),
        "count": len(data),
    }
