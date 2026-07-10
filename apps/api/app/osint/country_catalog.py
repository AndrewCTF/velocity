"""Country-OSINT catalog loader — apps/api/app/osint/country_data/*.json.

Harvests every country's toolkit (docs/country-osint-spec.md) into one
normalised catalog behind a generic parameterized endpoint set
(``routes/countries.py``). Each ``<code>.json`` file is written independently
(one file, one owner — parallel-safe), so this loader globs whatever is
present, validates + coerces on the way in, and NEVER raises at import: a
malformed file is skipped and logged, not fatal to the whole catalog.

``build_graph`` is the single mint function — the bridge that links a
national registry (``asic.gov.au``) into the SAME ``domain:`` node the
existing digital-OSINT ``investigate()`` fan-out (``routes/osint.py``)
enriches, so an analyst pivots seamlessly between the country catalog and the
domain/IP/threat graph. It is reused by both the graph-preview GET and the
persist POST in ``routes/countries.py`` so the linking logic exists once.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.intel.ontology import Link, Object
from app.osint.fetch import normalise_domain

log = logging.getLogger("app.osint.country_catalog")

_DATA_DIR = Path(__file__).resolve().parent / "country_data"

# Controlled category vocabulary (docs/country-osint-spec.md §Data layer). A
# resource's category is coerced to "other" if it isn't one of these — the
# loader never rejects a whole file over one bad category.
CATEGORIES: tuple[str, ...] = (
    "open-data", "business-registry", "land-property", "people-search", "vehicle",
    "transport-tracking", "court-legal", "government", "maps-geo", "phone",
    "social-media", "news-media", "sanctions-pep", "finance-tax", "archives",
    "tenders", "telecom-infra", "other",
)
_CATEGORY_SET: frozenset[str] = frozenset(CATEGORIES)


@dataclass(frozen=True)
class Resource:
    name: str
    url: str
    category: str
    note: str = ""
    keyless: bool | None = None


@dataclass(frozen=True)
class CountryRecord:
    code: str
    name: str
    region: str
    iso2: str
    source_url: str
    note: str = ""
    resources: tuple[Resource, ...] = field(default_factory=tuple)


def _coerce_resource(raw: Any) -> Resource | None:
    """Validate one resource entry; bad/missing required fields → skip it."""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()
    url = str(raw.get("url") or "").strip()
    if not name or not url:
        return None
    category = raw.get("category")
    if category not in _CATEGORY_SET:
        category = "other"
    keyless = raw.get("keyless")
    return Resource(
        name=name,
        url=url,
        category=category,
        note=str(raw.get("note") or ""),
        keyless=keyless if isinstance(keyless, bool) else None,
    )


def _load_one(path: Path) -> CountryRecord | None:
    """Parse + validate one country file. Never raises — a bad file is
    skipped (logged) so 52 good files still load if one is broken."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — malformed JSON must not break the catalog
        log.warning("country_catalog: skipping unreadable %s", path.name)
        return None
    if not isinstance(raw, dict):
        log.warning("country_catalog: skipping non-object %s", path.name)
        return None
    try:
        code = str(raw["code"]).strip().lower()
        name = str(raw["name"]).strip()
    except (KeyError, TypeError, AttributeError):
        log.warning("country_catalog: skipping %s (missing code/name)", path.name)
        return None
    if not code or not name:
        log.warning("country_catalog: skipping %s (empty code/name)", path.name)
        return None

    resources: list[Resource] = []
    for entry in raw.get("resources") or []:
        res = _coerce_resource(entry)
        if res is not None:
            resources.append(res)

    return CountryRecord(
        code=code,
        name=name,
        region=str(raw.get("region") or "").strip(),
        iso2=str(raw.get("iso2") or "").strip().upper(),
        source_url=str(raw.get("source_url") or "").strip(),
        note=str(raw.get("note") or ""),
        resources=tuple(resources),
    )


def _load_catalog() -> list[CountryRecord]:
    records: list[CountryRecord] = []
    if not _DATA_DIR.is_dir():
        return records
    for path in sorted(_DATA_DIR.glob("*.json")):
        try:
            rec = _load_one(path)
        except Exception:  # noqa: BLE001 — a single file must never wedge boot
            log.warning("country_catalog: unexpected error loading %s", path.name)
            rec = None
        if rec is not None:
            records.append(rec)
    records.sort(key=lambda r: r.name)
    return records


# Loaded once at import (module-level cache). country_data/*.json is static
# content written by a separate process; a hot-reload isn't needed for a
# backend process restart to pick up new files.
CATALOG: list[CountryRecord] = _load_catalog()
_BY_CODE: dict[str, CountryRecord] = {r.code: r for r in CATALOG}


def by_code(code: str) -> CountryRecord | None:
    return _BY_CODE.get((code or "").strip().lower())


def _category_counts(rec: CountryRecord) -> dict[str, int]:
    counts: dict[str, int] = {}
    for res in rec.resources:
        counts[res.category] = counts.get(res.category, 0) + 1
    return counts


def list_summary(region: str | None = None, category: str | None = None) -> dict[str, Any]:
    """``{count, regions, categories, countries:[...]}`` — optionally filtered."""
    records = CATALOG
    if region:
        records = [r for r in records if r.region.lower() == region.strip().lower()]
    if category:
        records = [r for r in records if any(res.category == category for res in r.resources)]
    all_regions = sorted({r.region for r in CATALOG if r.region})
    return {
        "count": len(records),
        "regions": all_regions,
        "categories": list(CATEGORIES),
        "countries": [
            {
                "code": r.code,
                "name": r.name,
                "region": r.region,
                "iso2": r.iso2,
                "source_url": r.source_url,
                "resource_count": len(r.resources),
                "category_counts": _category_counts(r),
            }
            for r in records
        ],
    }


def category_summary() -> dict[str, Any]:
    """``{categories, counts}`` — cross-country resource totals per category."""
    counts: dict[str, int] = {c: 0 for c in CATEGORIES}
    for rec in CATALOG:
        for res in rec.resources:
            counts[res.category] = counts.get(res.category, 0) + 1
    return {"categories": list(CATEGORIES), "counts": counts}


def _slug(s: str) -> str:
    # Mirrors routes/osint.py::_slug exactly (same id-safe slugging convention
    # used across the ontology's minted ids).
    out = re.sub(r"[^a-z0-9]+", "-", s.strip().lower()).strip("-")
    return out[:64] or "x"


def build_graph(code: str) -> dict[str, list[Any]] | None:
    """Mint ``country:<code> -> resource:<code>:<slug> -> domain:<host>``.

    The single mint function — reused by both the graph-preview GET and the
    persist POST (``routes/countries.py``) so the linking logic exists once.
    Returns ``None`` for an unknown code. Node shape matches
    ``routes/osint.py::_Graph.obj`` output (``Object`` with ``id``/``props``,
    ``kind`` derived from the id prefix) so the Investigation canvas renders
    country nodes with no frontend change.
    """
    rec = by_code(code)
    if rec is None:
        return None

    ts = time.time()
    objs: dict[str, Object] = {}
    links: dict[tuple[str, str, str], Link] = {}

    def _obj(id_: str, entity_type: str, props: dict[str, Any]) -> str:
        if id_ not in objs:
            objs[id_] = Object(
                id=id_,
                props={
                    "entity_type": entity_type,
                    "source": "osint-world-series",
                    "collected_at": ts,
                    **{k: v for k, v in props.items() if v not in (None, "", [], {})},
                },
            ).normalised()
        return id_

    def _link(src: str, dst: str, rel: str) -> None:
        links[(src, dst, rel)] = Link(src=src, dst=dst, rel=rel)

    root = _obj(
        "country:" + rec.code,
        "Country",
        {
            "name": rec.name,
            "region": rec.region,
            "iso2": rec.iso2,
            "source_url": rec.source_url,
            "resource_count": len(rec.resources),
        },
    )

    for res in rec.resources:
        rid = _obj(
            f"resource:{rec.code}:{_slug(res.name)}",
            "Resource",
            {
                "name": res.name,
                "url": res.url,
                "category": res.category,
                "note": res.note,
                "keyless": res.keyless,
            },
        )
        _link(root, rid, "has_resource")

        host = normalise_domain(res.url)
        if host:
            did = _obj("domain:" + host, "Domain", {"name": host})
            _link(rid, did, "hosted_at")

    return {"nodes": list(objs.values()), "links": list(links.values())}
