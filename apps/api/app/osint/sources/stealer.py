"""Infostealer-log exposure — Hudson Rock Cavalier (keyless).

The one capability class in *OSINT Techniques* 11th ed. (ch. 23 and ch. 42,
"Stealer Logs") the platform had no coverage of at all. A stealer log is what a
credential-stealing malware family exfiltrated off one machine: the browser
profiles, the saved logins, the machine's own identity. Hudson Rock indexes
them and answers three keyless questions — was this ADDRESS on an infected
machine, was this HANDLE, and how many machines with credentials for this
DOMAIN are in the corpus.

A clean target is a real, distinguishable answer here, not a failure: the
upstream returns ``stealers: []`` plus a "is not associated" message, which
becomes ``infected: False``. That matters because "checked, clean" is the
finding an analyst needs recorded.

**Credential material is dropped on the floor.** The upstream ships
``top_passwords`` and ``top_logins`` for every compromised machine. Those are
live secrets belonging to a third party; this connector never returns them, so
they never reach the ontology, the case export, or a model prompt. What the
graph gets is the fact of the compromise, its date, the malware family, and the
counts — which is what an investigation actually turns on.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from app.osint.fetch import fetch_json, normalise_domain, normalise_email, normalise_username

_BASE = "https://cavalier.hudsonrock.com/api/json/v2/osint-tools"
_TTL = 3600.0
_MAX_COMPUTERS = 10
_MAX_URLS = 25

# Fields copied out of a `stealers[]` entry. Everything not named here is
# dropped, which is how top_passwords / top_logins stay out by construction
# rather than by remembering to delete them.
_COMPUTER_FIELDS = (
    "date_compromised",
    "stealer_family",
    "computer_name",
    "operating_system",
    "malware_path",
    "ip",
)


def _computers(data: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in (data.get("stealers") or [])[:_MAX_COMPUTERS]:
        if not isinstance(s, dict):
            continue
        row = {k: s.get(k) for k in _COMPUTER_FIELDS if s.get(k) not in (None, "")}
        avs = s.get("antiviruses")
        if isinstance(avs, list) and avs:
            row["antiviruses"] = [str(a) for a in avs[:5]]
        out.append(row)
    return out


def _families(computers: list[dict[str, Any]]) -> list[str]:
    return sorted({str(c["stealer_family"]) for c in computers if c.get("stealer_family")})


def _real_date(value: Any) -> str:
    """Drop the upstream's epoch-zero sentinel for "never compromised".

    It ships ``1970-01-01T00:00:00.000Z`` rather than null, and rendering that
    as a date claims a 1970 breach that did not happen. Empty means no value
    reported, which is what the dashboard's own never-guess rule wants.
    """
    s = str(value or "")
    return "" if s.startswith("1970-01-01") else s


def _account_result(indicator: str, data: Any) -> dict[str, Any]:
    """Shared shaping for the email and username endpoints (same payload shape)."""
    if not isinstance(data, dict) or "stealers" not in data:
        return {"indicator": indicator, "infected": False, "checked": False,
                "computers": [], "note": "hudson rock unavailable"}
    computers = _computers(data)
    return {
        "indicator": indicator,
        "checked": True,
        "infected": bool(data.get("stealers")),
        "computer_count": len(data.get("stealers") or []),
        "stealer_families": _families(computers),
        "corporate_services": data.get("total_corporate_services"),
        "user_services": data.get("total_user_services"),
        "computers": computers,
    }


async def hudsonrock_email(email: str) -> dict[str, Any]:
    """Was this address saved on a machine an info-stealer emptied?"""
    e = normalise_email(email)
    if e is None:
        return {"indicator": email, "infected": False, "checked": False,
                "computers": [], "note": "invalid email"}
    data = await fetch_json(
        f"{_BASE}/search-by-email?email={quote(e)}", _TTL, browser_ua=True
    )
    return _account_result(e, data)


async def hudsonrock_username(username: str) -> dict[str, Any]:
    """Was this handle saved on a machine an info-stealer emptied?"""
    u = normalise_username(username)
    if u is None:
        return {"indicator": username, "infected": False, "checked": False,
                "computers": [], "note": "invalid username"}
    data = await fetch_json(
        f"{_BASE}/search-by-username?username={quote(u)}", _TTL, browser_ua=True
    )
    return _account_result(u, data)


async def hudsonrock_domain(domain: str) -> dict[str, Any]:
    """How much of this domain's user and employee estate is in stealer logs.

    A different payload from the account endpoints: counts and the URLs the
    stolen credentials were saved against, never the credentials themselves.
    """
    d = normalise_domain(domain)
    if d is None:
        return {"indicator": domain, "checked": False, "total": 0,
                "urls": [], "note": "invalid domain"}
    data = await fetch_json(
        f"{_BASE}/search-by-domain?domain={quote(d)}", _TTL, browser_ua=True
    )
    if not isinstance(data, dict) or "total" not in data:
        return {"indicator": d, "checked": False, "total": 0,
                "urls": [], "note": "hudson rock unavailable"}
    urls: list[dict[str, Any]] = []
    for row in ((data.get("data") or {}).get("all_urls") or [])[:_MAX_URLS]:
        if isinstance(row, dict) and row.get("url"):
            urls.append({
                "url": str(row["url"])[:300],
                "type": str(row.get("type", "")),
                "occurrence": row.get("occurrence"),
            })
    return {
        "indicator": d,
        "checked": True,
        "total": int(data.get("total") or 0),
        "employees": int(data.get("employees") or 0),
        "users": int(data.get("users") or 0),
        "third_parties": int(data.get("third_parties") or 0),
        "last_employee_compromised": _real_date(data.get("last_employee_compromised")),
        "last_user_compromised": _real_date(data.get("last_user_compromised")),
        "urls": urls,
    }
