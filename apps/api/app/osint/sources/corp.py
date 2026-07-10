"""Company / person / sanctions / entity-resolution connectors.

Every function here takes a free-text NAME (not a machine id) — a company,
person, or org handle typed by an analyst — and searches a public register or
watchlist. Keyless-first; key-optional sources read their key via
``getattr(get_settings(), "<name>", "") or ""`` and still run (unauthenticated
or throttled) with no key set. None of these ever raise; a bad upstream
degrades to an empty result + a ``note``, mirroring ``app/osint/connectors.py``.

  sec_edgar_company     — SEC EDGAR full-text search + filer submissions  (GET, keyless, browser_ua)
  opensanctions_search  — OpenSanctions watchlist/PEP search                (GET, keyless)
  opencorporates_search — OpenCorporates company registry search            (GET, key-optional)
  openownership_search  — OpenOwnership beneficial-ownership register       (GET, keyless)
  aleph_search          — OCCRP Aleph investigative entities                (GET, key-optional)
  wikidata_search       — Wikidata entity search                            (GET, keyless)
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from app.osint.fetch import fetch_json

_MAX_NAME = 120


def _clean_name(name: str) -> str:
    """Strip + cap a free-text query; callers still get a (possibly empty) string."""
    return (name or "").strip()[:_MAX_NAME]


# ── SEC EDGAR ─────────────────────────────────────────────────────────────────

_SEC_UA = "velocity-osint research contact@example.com"


async def sec_edgar_company(name: str) -> dict[str, Any]:
    """Full-text search SEC EDGAR for a company, then pull the top match's filings.

    EDGAR requires a descriptive User-Agent (their policy, not a browser check);
    a datacenter IP can still get a 403 — that degrades to a note, not an error.
    """
    q = _clean_name(name)
    if not q:
        return {
            "name": name,
            "cik": "",
            "ticker": "",
            "sic": "",
            "filings": [],
            "count": 0,
            "note": "empty name",
        }
    headers = {"User-Agent": _SEC_UA}
    search = await fetch_json(
        f'https://efts.sec.gov/LATEST/search-index?q="{quote(q)}"',
        900.0,
        browser_ua=True,
        headers=headers,
    )
    hits = ((search or {}).get("hits") or {}).get("hits") or []
    if not isinstance(hits, list) or not hits:
        return {
            "name": q,
            "cik": "",
            "ticker": "",
            "sic": "",
            "filings": [],
            "count": 0,
            "note": "sec edgar: no match or unavailable",
        }
    top = hits[0] if isinstance(hits[0], dict) else {}
    src = top.get("_source") or {}
    cik_raw = str(src.get("cik") or top.get("_id") or "").strip()
    # cik may arrive as e.g. "0000320193" or embedded in the doc id; keep digits,
    # then drop the zero-padding EDGAR uses internally (human CIKs omit it).
    cik_digits = "".join(c for c in cik_raw if c.isdigit())
    cik_digits = str(int(cik_digits)) if cik_digits else ""
    entity_name = str(src.get("display_names") or src.get("entity") or q)
    if isinstance(entity_name, list):
        entity_name = entity_name[0] if entity_name else q
    if not cik_digits:
        return {
            "name": str(entity_name),
            "cik": "",
            "ticker": "",
            "sic": "",
            "filings": [],
            "count": 0,
            "note": "sec edgar: match had no CIK",
        }
    cik10 = cik_digits.zfill(10)
    sub = await fetch_json(
        f"https://data.sec.gov/submissions/CIK{cik10}.json",
        3600.0,
        browser_ua=True,
        headers=headers,
    )
    if not isinstance(sub, dict):
        return {
            "name": str(entity_name),
            "cik": cik_digits,
            "ticker": "",
            "sic": "",
            "filings": [],
            "count": 0,
            "note": "sec edgar: submissions unavailable",
        }
    tickers = sub.get("tickers") or []
    ticker = str(tickers[0]) if tickers else ""
    sic = str(sub.get("sicDescription", ""))
    recent = ((sub.get("filings") or {}).get("recent")) or {}
    forms = recent.get("form") or []
    dates = recent.get("filingDate") or []
    accessions = recent.get("accessionNumber") or []
    filings = [
        {"form": str(forms[i]), "date": str(dates[i]), "accession": str(accessions[i])}
        for i in range(min(len(forms), len(dates), len(accessions)))
    ]
    return {
        "name": str(sub.get("name") or entity_name),
        "cik": cik_digits,
        "ticker": ticker,
        "sic": sic,
        "filings": filings[:25],
        "count": len(filings),
    }


# ── OpenSanctions ────────────────────────────────────────────────────────────


async def opensanctions_search(name: str) -> dict[str, Any]:
    """Search the OpenSanctions consolidated sanctions/PEP/crime watchlist."""
    q = _clean_name(name)
    if not q:
        return {"query": name, "matches": [], "count": 0, "note": "empty name"}
    data = await fetch_json(f"https://api.opensanctions.org/search/default?q={quote(q)}", 900.0)
    results = (data or {}).get("results")
    if not isinstance(results, list):
        return {"query": q, "matches": [], "count": 0, "note": "opensanctions unavailable"}
    matches = []
    for r in results:
        if not isinstance(r, dict):
            continue
        props = r.get("properties") or {}
        matches.append(
            {
                "id": str(r.get("id", "")),
                "name": str(r.get("caption", "")),
                "schema": str(r.get("schema", "")),
                "topics": [str(t) for t in (props.get("topics") or [])],
                "datasets": [str(d) for d in (r.get("datasets") or [])],
            }
        )
    return {"query": q, "matches": matches[:25], "count": len(matches)}


# ── OpenCorporates ───────────────────────────────────────────────────────────


async def opencorporates_search(name: str) -> dict[str, Any]:
    """Search the OpenCorporates global company registry (keyless, low rate limit)."""
    q = _clean_name(name)
    if not q:
        return {"query": name, "companies": [], "count": 0, "note": "empty name"}
    from app.config import get_settings

    token = getattr(get_settings(), "opencorporates_api_key", "") or ""
    url = f"https://api.opencorporates.com/v0.4/companies/search?q={quote(q)}"
    if token:
        url += f"&api_token={quote(token)}"
    data = await fetch_json(url, 900.0)
    companies_raw = ((data or {}).get("results") or {}).get("companies")
    if not isinstance(companies_raw, list):
        return {
            "query": q,
            "companies": [],
            "count": 0,
            "note": "opencorporates unavailable"
            + ("" if token else " (keyless, may be throttled)"),
        }
    companies = []
    for row in companies_raw:
        c = (row or {}).get("company") if isinstance(row, dict) else None
        if not isinstance(c, dict):
            continue
        companies.append(
            {
                "name": str(c.get("name", "")),
                "number": str(c.get("company_number", "")),
                "jurisdiction": str(c.get("jurisdiction_code", "")),
                "status": str(c.get("current_status", "")),
            }
        )
    result: dict[str, Any] = {"query": q, "companies": companies[:25], "count": len(companies)}
    if not token:
        result["note"] = "keyless request, may be throttled"
    return result


# ── OpenOwnership ────────────────────────────────────────────────────────────


async def openownership_search(name: str) -> dict[str, Any]:
    """Search the OpenOwnership beneficial-ownership register.

    Shape of the public search API is not stable/documented — defensively pull
    any ``name``/``type`` fields out of whatever we get back; an unusable
    response degrades to an honest empty result.
    """
    q = _clean_name(name)
    if not q:
        return {"query": name, "owners": [], "count": 0, "note": "empty name"}
    data = await fetch_json(f"https://api.openownership.org/v0.4.0/search?q={quote(q)}", 900.0)
    if not isinstance(data, dict):
        return {"query": q, "owners": [], "count": 0, "note": "unavailable"}
    # Try a few plausible list keys before giving up.
    rows: Any = None
    for key in ("statements", "results", "entities", "data"):
        candidate = data.get(key)
        if isinstance(candidate, list):
            rows = candidate
            break
    if rows is None:
        return {"query": q, "owners": [], "count": 0, "note": "unavailable"}
    owners = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        entity = row.get("entity")
        if isinstance(entity, dict):
            nm, tp = entity.get("name"), entity.get("type")
        else:
            nm, tp = row.get("name"), row.get("statementType")
        if not nm:
            continue
        owners.append({"name": str(nm), "type": str(tp or "")})
    if not owners:
        return {"query": q, "owners": [], "count": 0, "note": "unavailable"}
    return {"query": q, "owners": owners[:25], "count": len(owners)}


# ── OCCRP Aleph ──────────────────────────────────────────────────────────────


async def aleph_search(name: str) -> dict[str, Any]:
    """Search OCCRP Aleph's cross-leak/registry entity index (key-optional)."""
    q = _clean_name(name)
    if not q:
        return {"query": name, "entities": [], "count": 0, "note": "empty name"}
    from app.config import get_settings

    key = getattr(get_settings(), "aleph_api_key", "") or ""
    headers = {"Authorization": f"ApiKey {key}"} if key else None
    data = await fetch_json(
        f"https://aleph.occrp.org/api/2/entities?q={quote(q)}", 900.0, headers=headers
    )
    results = (data or {}).get("results")
    if not isinstance(results, list):
        return {"query": q, "entities": [], "count": 0, "note": "aleph unavailable"}
    entities = []
    for r in results:
        if not isinstance(r, dict):
            continue
        props = r.get("properties") or {}
        names = props.get("name") if isinstance(props, dict) else None
        nm = names[0] if isinstance(names, list) and names else (names or "")
        collection = (r.get("collection") or {}) if isinstance(r.get("collection"), dict) else {}
        entities.append(
            {
                "id": str(r.get("id", "")),
                "name": str(nm or ""),
                "schema": str(r.get("schema", "")),
                "collection": str(collection.get("label", "")),
            }
        )
    return {"query": q, "entities": entities[:25], "count": len(entities)}


# ── Wikidata ─────────────────────────────────────────────────────────────────


async def wikidata_search(name: str) -> dict[str, Any]:
    """Search Wikidata for an entity matching this name (keyless)."""
    q = _clean_name(name)
    if not q:
        return {"query": name, "entities": [], "count": 0, "note": "empty name"}
    data = await fetch_json(
        "https://www.wikidata.org/w/api.php?action=wbsearchentities"
        f"&search={quote(q)}&format=json&language=en&limit=10",
        3600.0,
    )
    results = (data or {}).get("search")
    if not isinstance(results, list):
        return {"query": q, "entities": [], "count": 0, "note": "wikidata unavailable"}
    entities = [
        {
            "qid": str(r.get("id", "")),
            "label": str(r.get("label", "")),
            "description": str(r.get("description", "")),
        }
        for r in results
        if isinstance(r, dict)
    ]
    return {"query": q, "entities": entities[:25], "count": len(entities)}
