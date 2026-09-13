"""Ransomware leak-site tracking — ransomware.live (keyless).

*OSINT Techniques* 11th ed. ch. 43. A ransomware crew that has not been paid
publishes its victim on a leak site; those posts are aggregated, and they are
the earliest public record that an organisation was breached — usually well
before any disclosure. That makes a leak-site hit a finding about a DOMAIN or a
COMPANY, which is how it is wired here.

Every victim record carries a country, so this is also the rare digital-OSINT
source with a position on it; ``country_counts`` exists so a caller can put
recent activity on the map without re-deriving it.

**The search endpoint is fuzzy and matches the description text**, so a query
for "cnn" returns a Ghanaian beverage manufacturer whose blurb mentions CNN
Money. ``ransomware_domain`` therefore filters on the record's own ``domain``
field rather than trusting the ranking — the same lesson as the LittleSis
namesake filter in ``corp.py``.

Two upstream behaviours this connector has to tell apart, both measured
2026-08-29 rather than assumed:

  * a no-match answers ``{"error": "No victims found for keyword ..."}`` — an
    OBJECT, not an empty list. That is a clean result and is reported as
    ``checked: True`` with a zero count, because "no crew has posted this org"
    is a finding an investigator wants on the record.
  * ``/searchvictims`` is rate limited to **1 request per minute** and says so
    with ``{"message": "1 per 1 minute"}`` and an HTTP 200. Treating that as a
    clean result would report every rate-limited org as un-breached, so it is
    reported as ``checked: False`` instead. The cache TTL is deliberately long
    (leak-site posts do not move by the minute) so a repeat lookup of the same
    target does not spend the budget.

Nothing here ever raises; a dead upstream degrades to an empty result + a
``note``, matching ``app/osint/connectors.py``.
"""

from __future__ import annotations

import time
from collections import Counter, OrderedDict
from typing import Any
from urllib.parse import quote

from app.osint.fetch import fetch_json, normalise_domain
from app.upstream import get_client

_BASE = "https://api.ransomware.live/v2"
# Six hours: /searchvictims allows one request a minute, and a leak-site post
# is days-to-weeks old by the time it is aggregated. A short TTL here would
# spend the whole budget re-asking the same question.
_TTL = 21600.0
_MAX_VICTIMS = 40
_MAX_NAME = 120

# Crews post a placeholder domain when they have not attributed a victim yet —
# `killsec` files several under literal example.com. An exact-match on one of
# these returns records about somebody else entirely, so they are never claimed.
# Measured 2026-08-29: example.com had 3 such posts, none of them about it.
_PLACEHOLDER_DOMAINS = frozenset({
    "example.com", "example.org", "example.net", "domain.com",
    "test.com", "localhost", "n/a", "unknown.com",
})
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Copied out of a victim record. `description` is the crew's own marketing copy
# about the victim — long, and attacker-authored, so it is truncated hard and
# never treated as fact.
_VICTIM_FIELDS = ("victim", "group", "domain", "country", "activity",
                  "attackdate", "discovered", "claim_url")


def _victim(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict) or not row.get("victim"):
        return None
    out: dict[str, Any] = {
        k: row.get(k) for k in _VICTIM_FIELDS if row.get(k) not in (None, "")
    }
    desc = str(row.get("description") or "").strip()
    if desc:
        out["description"] = desc[:400]
    return out


# ``fetch_json`` collapses every non-200 to None, and this upstream says the two
# things we most need to tell apart with a status code: 429 for the rate limit,
# and a JSON error object for a genuine no-match. So this one call reads the
# status itself, the way ``social._head_ok`` does for a non-JSON body.
#
# It also keeps its OWN cache rather than the shared one, for a reason worth
# stating: the shared TtlCache stores whatever the loader returns, so a
# rate-limited call would be cached for the same six hours as a real answer and
# one unlucky request would blind that target for a working day. Here only an
# ANSWER is cached; a 429 or an outage is not, so the next call retries.
_ANSWERS: OrderedDict[str, tuple[float, list[Any]]] = OrderedDict()
_MAX_ANSWERS = 512


async def _get_search(url: str) -> tuple[list[Any] | None, str]:
    """(rows, note). rows is None only when we did not get an answer at all."""
    hit = _ANSWERS.get(url)
    if hit and hit[0] > time.monotonic():
        _ANSWERS.move_to_end(url)
        return hit[1], ""

    try:
        r = await get_client().get(
            url, headers={"User-Agent": _UA}, follow_redirects=True
        )
        status, body = r.status_code, (r.json() if r.content else None)
    except Exception:  # noqa: BLE001 — network error or non-JSON body → degrade
        return None, "ransomware.live unavailable"

    rows, note = _read(status, body)
    if rows is None:
        return None, note
    _ANSWERS[url] = (time.monotonic() + _TTL, rows)
    _ANSWERS.move_to_end(url)
    while len(_ANSWERS) > _MAX_ANSWERS:
        _ANSWERS.popitem(last=False)
    return rows, ""


def _read(status: int, body: Any) -> tuple[list[Any] | None, str]:
    """Split an upstream answer into (rows, note).

    ``(list, "")`` is data, ``([], "")`` is a checked-clean no-match, and
    ``(None, note)`` is "we did not get an answer" — a rate limit or an outage.
    Collapsing the middle two is the bug this function exists to prevent: a
    rate-limited lookup reported as clean is an all-clear nobody asked for.
    """
    if status == 429:
        return None, "ransomware.live rate limited (1 request per minute)"
    if isinstance(body, dict):
        if "no victims found" in str(body.get("error") or "").lower():
            return [], ""
        msg = str(body.get("message") or "")
        if "per" in msg and "minute" in msg:
            return None, f"ransomware.live rate limited ({msg})"
    if status == 200 and isinstance(body, list):
        return body, ""
    return None, "ransomware.live unavailable"


def _empty(query: str, note: str, *, checked: bool | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"query": query, "victims": [], "count": 0,
                           "groups": [], "country_counts": {}}
    if note:
        out["note"] = note
    if checked is not None:
        out["checked"] = checked
    return out


def _shape(query: str, rows: Any, *, note: str | None = None) -> dict[str, Any]:
    if not isinstance(rows, list):
        return _empty(query, note or "ransomware.live unavailable")
    victims = [v for v in (_victim(r) for r in rows) if v]
    # Newest claim first: an investigator wants the most recent post, and the
    # upstream does not guarantee an order.
    victims.sort(key=lambda v: str(v.get("discovered") or ""), reverse=True)
    return {
        "query": query,
        "count": len(victims),
        "victims": victims[:_MAX_VICTIMS],
        "groups": sorted({str(v["group"]) for v in victims if v.get("group")}),
        "country_counts": dict(
            Counter(str(v["country"]) for v in victims if v.get("country")).most_common(25)
        ),
    }


async def ransomware_search(name: str) -> dict[str, Any]:
    """Free-text victim search across every tracked leak site.

    Fuzzy by design (it matches the crews' description text too), so callers
    that hold a precise selector should use ``ransomware_domain`` instead.
    """
    q = (name or "").strip()[:_MAX_NAME]
    if not q:
        return _empty(name, "empty query")
    rows, note = await _get_search(f"{_BASE}/searchvictims/{quote(q, safe='')}")
    if rows is None:
        return _empty(q, note)
    return _shape(q, rows)


async def ransomware_domain(domain: str) -> dict[str, Any]:
    """Leak-site posts naming THIS domain, exact-matched.

    The upstream search is fuzzy, so its hits are filtered against the record's
    own ``domain`` field (bare or ``www.``-prefixed). A domain that was searched
    and matched nothing returns ``checked: True`` with a zero count, which is a
    finding — "no crew has posted this org" is worth recording.
    """
    d = normalise_domain(domain)
    if d is None:
        return _empty(domain, "invalid domain", checked=False)
    if d in _PLACEHOLDER_DOMAINS:
        return _empty(
            d, "placeholder domain: leak-site posts using it name other victims",
            checked=False,
        )
    rows, note = await _get_search(f"{_BASE}/searchvictims/{quote(d, safe='')}")
    if rows is None:
        # Rate limited or down. NOT clean: saying "checked, no posts" here
        # would report an un-asked question as an all-clear.
        return _empty(d, note, checked=False)
    wanted = {d, f"www.{d}"}
    exact = [
        r for r in rows
        if isinstance(r, dict) and str(r.get("domain") or "").strip().lower() in wanted
    ]
    return {**_shape(d, exact), "checked": True, "searched": len(rows)}


async def ransomware_group(name: str) -> dict[str, Any]:
    """One crew's profile: its leak-site addresses, tooling and known TTPs."""
    g = (name or "").strip().lower()[:_MAX_NAME]
    if not g or not g.replace("-", "").replace("_", "").isalnum():
        return {"group": name, "found": False, "note": "invalid group name"}
    data = await fetch_json(f"{_BASE}/group/{quote(g, safe='')}", _TTL, browser_ua=True)
    if not isinstance(data, dict) or not data.get("name"):
        return {"group": g, "found": False, "note": "no such tracked group"}
    return {
        "group": str(data.get("name") or g),
        "found": True,
        "altname": data.get("altname"),
        "description": str(data.get("description") or "")[:600],
        "added_date": data.get("added_date"),
        "locations": [
            {"url": str(loc.get("fqdn") or loc.get("slug") or ""),
             "available": loc.get("available"),
             "last_seen": loc.get("lastscrape")}
            for loc in (data.get("locations") or [])[:10]
            if isinstance(loc, dict)
        ],
        "tools": [str(t) for t in (data.get("tools") or [])[:25]],
        "ttps": [str(t) for t in (data.get("ttps") or [])[:25]],
    }
