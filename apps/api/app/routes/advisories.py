"""GET /api/advisories — keyless country-level travel advisories (task B1a,
2026-07 worldmonitor-gaps wave).

Three official keyless feeds, each a country list with no geo features (this
is a country-scored layer for the future instability index, not a map feed —
compare ``_feedgeo.py`` which builds GeoJSON):

- US State Dept (RSS) — level is printed straight in the title ("Country -
  Level 3: Reconsider Travel").
- UK FCDO (Atom) — no numeric level in the feed; normalised from the
  "advise against all / part of" phrasing in each entry's summary text.
- Australia Smartraveller (RSS + a ``ta:`` extension namespace) — the
  ``dc:description`` inside ``ta:warnings`` carries the plain-English level
  ("Do not travel" / "Reconsider your need to travel" / "Exercise a high
  degree of caution" / "Exercise normal safety precautions"); normalised from
  that text rather than the accompanying ``ta:level`` (an internal 1-5 scale
  that does not line up with the public four-level scale).

All three were probed live 2026-07-21 with the shared IPv4-pinned client
(``app.upstream.get_client``, default ``osint-console/0.1`` UA) — all 200,
no browser UA or special headers needed.

Each source is fetched/cached/parsed independently (``fg.cached`` per-source
key, 1800 s TTL) so one dead feed degrades gracefully instead of blanking the
whole response; ``unavailable`` is only true when ALL THREE fail. iso3 comes
from :func:`app.geo.adminshapes.country_name_to_iso3` — ``None`` when a feed's
country string doesn't match, never guessed.
"""

from __future__ import annotations

import re
from email.utils import parsedate_to_datetime
from typing import Any
from xml.etree import ElementTree as ET

from fastapi import APIRouter

from app.geo.adminshapes import country_name_to_iso3
from app.routes import _feedgeo as fg

router = APIRouter(tags=["advisories"])

US_STATE_URL = "https://travel.state.gov/_res/rss/TAsTWs.xml"
UK_FCDO_URL = "https://www.gov.uk/foreign-travel-advice.atom"
AU_SMARTRAVELLER_URL = "https://www.smartraveller.gov.au/countries/documents/index.rss"

_TTL = 1800.0

Advisory = dict[str, Any]

# ── shared helpers ────────────────────────────────────────────────────────────


def _iso(name: str | None) -> str | None:
    return country_name_to_iso3(name) if name else None


def _to_iso_utc(raw: str | None) -> str | None:
    """Best-effort RFC822/ISO8601 -> ISO-8601 UTC string; ``None`` when the
    upstream's date string doesn't parse (never guessed)."""
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        try:
            from datetime import datetime

            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        return None
    return dt.isoformat()


def _strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html)


# ── US State Dept — level is printed in the title ────────────────────────────

_US_TITLE_RE = re.compile(r"^(.*?)\s*-\s*Level\s*([1-4])\b", re.IGNORECASE)


def _parse_us_state(xml_text: str) -> list[Advisory]:
    root = ET.fromstring(xml_text)
    out: list[Advisory] = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        m = _US_TITLE_RE.match(title)
        if not m:
            continue
        country = m.group(1).strip()
        level = int(m.group(2))
        link = (item.findtext("link") or "").strip()
        out.append(
            {
                "country": country,
                "iso3": _iso(country),
                "level": level,
                "source": "us-state",
                "title": title,
                "link": link or None,
                "updated_utc": _to_iso_utc((item.findtext("pubDate") or "").strip() or None),
            }
        )
    return out


# ── UK FCDO — normalise from the "advise against" phrasing ──────────────────

_ATOM_NS = "{http://www.w3.org/2005/Atom}"
_XHTML_NS = "{http://www.w3.org/1999/xhtml}"
_PARTIAL_KEYWORDS = (
    "cities of",
    "parts of",
    "part of",
    "the border",
    "certain areas",
    "the region",
    "regions of",
    "province",
)


_AGAINST_ALL_RE = re.compile(r"advis\w*\s+against\s+all\b")


def _fcdo_level(text: str) -> int:
    t = text.lower()
    if _AGAINST_ALL_RE.search(t):
        return 3 if any(k in t for k in _PARTIAL_KEYWORDS) else 4
    return 2


def _parse_uk_fcdo(xml_text: str) -> list[Advisory]:
    root = ET.fromstring(xml_text)
    out: list[Advisory] = []
    for entry in root.iter(f"{_ATOM_NS}entry"):
        country = (entry.findtext(f"{_ATOM_NS}title") or "").strip()
        if not country:
            continue
        link = None
        for link_el in entry.findall(f"{_ATOM_NS}link"):
            if link_el.get("rel") == "alternate" and link_el.get("type") == "text/html":
                link = link_el.get("href")
                break
        summary_el = entry.find(f"{_ATOM_NS}summary")
        summary_text = "".join(summary_el.itertext()) if summary_el is not None else ""
        summary_text = _strip_tags(summary_text)
        out.append(
            {
                "country": country,
                "iso3": _iso(country),
                "level": _fcdo_level(f"{country} {summary_text}"),
                "source": "uk-fcdo",
                "title": country,
                "link": link,
                "updated_utc": _to_iso_utc(
                    (entry.findtext(f"{_ATOM_NS}updated") or "").strip() or None
                ),
            }
        )
    return out


# ── Australia Smartraveller — ta:warnings/dc:description phrasing ───────────

_TA_NS = "{http://www.smartraveller.gov.au/schema/rss/travel_advisories/}"
_DC_NS = "{http://purl.org/dc/elements/1.1/}"


def _au_level(description: str) -> int:
    d = description.lower()
    if "do not travel" in d:
        return 4
    if "reconsider" in d:
        return 3
    if "high degree of caution" in d:
        return 2
    return 1


def _parse_au_smartraveller(xml_text: str) -> list[Advisory]:
    root = ET.fromstring(xml_text)
    out: list[Advisory] = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        link = (item.findtext("link") or "").strip()
        warnings = item.find(f"{_TA_NS}warnings")
        desc = warnings.findtext(f"{_DC_NS}description") if warnings is not None else None
        level = _au_level(desc or "")
        out.append(
            {
                "country": title,
                "iso3": _iso(title),
                "level": level,
                "source": "au-smartraveller",
                "title": desc.strip() if desc else title,
                "link": link or None,
                "updated_utc": _to_iso_utc((item.findtext("pubDate") or "").strip() or None),
            }
        )
    return out


_SOURCES: list[tuple[str, str, Any]] = [
    ("us-state", US_STATE_URL, _parse_us_state),
    ("uk-fcdo", UK_FCDO_URL, _parse_uk_fcdo),
    ("au-smartraveller", AU_SMARTRAVELLER_URL, _parse_au_smartraveller),
]


async def _load_source(name: str, url: str, parser: Any) -> list[Advisory]:
    async def load() -> list[Advisory]:
        text = await fg.fetch_text(url)
        return parser(text)

    return await fg.cached(f"advisories:{name}", _TTL, load)


async def _gather() -> tuple[list[Advisory], list[str]]:
    """Fetch every source independently; return (items, ok_sources).

    Each source's fetch/parse errors are swallowed here (not just the
    transport-level 502 ``fg.fetch_text`` already raises) so one upstream's
    XML shape drifting doesn't take the other two down with it.
    """
    items: list[Advisory] = []
    ok: list[str] = []
    for name, url, parser in _SOURCES:
        try:
            rows = await _load_source(name, url, parser)
        except Exception:  # noqa: BLE001 - any upstream/parse failure degrades, never 500s
            continue
        items.extend(rows)
        ok.append(name)
    return items, ok


@router.get("/api/advisories")
async def advisories() -> dict[str, Any]:
    items, ok_sources = await _gather()
    all_sources = [name for name, _, _ in _SOURCES]
    return {
        "items": items,
        "sources": all_sources,
        "unavailable": len(ok_sources) == 0,
    }


async def advisories_summary() -> dict[str, int]:
    """``{iso3: max_level}`` across all sources — for in-process consumers
    only (the future instability scorer). Never call the route handler
    in-process; call this."""
    items, _ = await _gather()
    out: dict[str, int] = {}
    for it in items:
        iso3 = it.get("iso3")
        level = it.get("level")
        if not iso3 or not isinstance(level, int):
            continue
        if iso3 not in out or level > out[iso3]:
            out[iso3] = level
    return out
