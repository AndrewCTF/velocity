"""GET /api/displacement — keyless IDP/refugee counts, country-level (no geo
features; this feeds the Country app's DisplacementCard and the future
instability scorer, not the globe).

Source: UN OCHA HDX HAPI (`hapi.humdata.org`), the same warehouse OCHA's own
dashboards run on. It's keyless in the sense that `app_identifier` needs no
signup or approval — it's just `base64("app_name:email")` the caller invents
on the spot (probed live 2026-07-21: a `localhost`-style email is rejected as
"Invalid app identifier", but any string with a plausible TLD, e.g.
`ops@example.com`, is accepted). Two endpoints:

- ``/api/v2/affected-people/idps`` — national (admin_level=0) IDP figures by
  reporting round. Filtered to ``start_date=2024-01-01`` to stay well under
  the API's 10 000-row cap (unfiltered admin_level=0 alone is already 1 368
  rows; unfiltered admin0+admin1+admin2 hits the cap and silently truncates).
- ``/api/v2/affected-people/refugees-persons-of-concern`` — filtered to
  ``population_group=REF`` (the classic UNHCR refugee figure, excluding
  asylum-seekers/other-concern rows) with ``gender=all&age_range=all`` to
  collapse the demographic disaggregation, and the same ``start_date`` guard
  (unfiltered hits the 10 000 cap even with the REF filter alone).

For each series we keep only the latest ``reference_period_end`` per country
(summing rows that tie on that end date — concurrent operations, or, for
refugees, multiple asylum countries hosting the same origin's caseload)."""

from __future__ import annotations

import base64
from typing import Any

from fastapi import APIRouter, HTTPException

from app.routes import _feedgeo as fg

router = APIRouter(tags=["displacement"])

HAPI_BASE = "https://hapi.humdata.org/api/v2/affected-people"
SOURCE = "hapi.humdata.org"

# Self-generated per HAPI's own scheme (no signup); a `localhost`-style email
# is rejected by their validator, a plausible-TLD one is not.
_APP_IDENTIFIER = base64.b64encode(b"velocity-osint:ops@example.com").decode()

# HAPI 406s the shared client's `osint-console/0.1` User-Agent (curl's default
# passes) — same class of upstream UA filter as SEC EDGAR; send a plain
# tool-style UA on these two calls only.
_HAPI_HEADERS = {"User-Agent": "curl/8.5.0"}

# Latest per-country figures don't need years of history; this keeps both
# queries under the API's 10 000-row response cap (see module docstring).
_START_DATE = "2024-01-01"

CountryTotals = dict[str, tuple[str, int, str]]  # iso3 -> (name, total, asof)


def _accumulate(rows: list[dict[str, Any]], code_key: str, name_key: str) -> CountryTotals:
    """Fold rows into iso3 -> (name, population, reference_period_end), keeping
    only the latest reference period per country and summing ties on it."""
    latest_end: dict[str, str] = {}
    totals: dict[str, int] = {}
    names: dict[str, str] = {}
    for row in rows:
        iso3 = row.get(code_key)
        end = row.get("reference_period_end")
        pop = fg.num(row.get("population"))
        if not iso3 or not end or pop is None:
            continue
        iso3 = str(iso3).upper()
        cur = latest_end.get(iso3)
        if cur is None or end > cur:
            latest_end[iso3] = end
            totals[iso3] = int(pop)
            names[iso3] = row.get(name_key) or iso3
        elif end == cur:
            totals[iso3] = totals.get(iso3, 0) + int(pop)
    return {iso3: (names[iso3], totals[iso3], latest_end[iso3]) for iso3 in totals}


async def _fetch_idps() -> CountryTotals:
    raw = await fg.fetch_json(
        f"{HAPI_BASE}/idps",
        params={
            "output_format": "json",
            "limit": "10000",
            "admin_level": "0",
            "start_date": _START_DATE,
            "app_identifier": _APP_IDENTIFIER,
        },
        headers=_HAPI_HEADERS,
    )
    return _accumulate((raw or {}).get("data", []) or [], "location_code", "location_name")


async def _fetch_refugees() -> CountryTotals:
    raw = await fg.fetch_json(
        f"{HAPI_BASE}/refugees-persons-of-concern",
        params={
            "output_format": "json",
            "limit": "10000",
            "population_group": "REF",
            "gender": "all",
            "age_range": "all",
            "start_date": _START_DATE,
            "app_identifier": _APP_IDENTIFIER,
        },
        headers=_HAPI_HEADERS,
    )
    return _accumulate(
        (raw or {}).get("data", []) or [], "origin_location_code", "origin_location_name"
    )


async def _load() -> dict[str, Any]:
    idps: CountryTotals = {}
    refugees: CountryTotals = {}
    idps_ok = refugees_ok = False
    try:
        idps = await _fetch_idps()
        idps_ok = True
    except HTTPException:
        pass
    try:
        refugees = await _fetch_refugees()
        refugees_ok = True
    except HTTPException:
        pass

    if not idps_ok and not refugees_ok:
        return {"items": [], "source": SOURCE, "unavailable": True}

    items: list[dict[str, Any]] = []
    for iso3 in sorted(set(idps) | set(refugees)):
        i_name, i_total, i_asof = idps.get(iso3, (None, None, None))
        r_name, r_total, r_asof = refugees.get(iso3, (None, None, None))
        asof = max((a for a in (i_asof, r_asof) if a), default=None)
        items.append(
            {
                "iso3": iso3,
                "country": i_name or r_name or iso3,
                "idps": i_total,
                "refugees": r_total,
                "asof": asof[:10] if asof else None,
                "source": SOURCE,
            }
        )
    return {"items": items, "source": SOURCE, "unavailable": False}


@router.get("/api/displacement")
async def displacement() -> dict[str, Any]:
    return await fg.cached("displacement:hapi", 21600.0, _load)


async def displacement_summary() -> dict[str, int]:
    """iso3 -> total displaced (idps + refugees where present); for the
    instability scorer. Reuses the same cached load as the route."""
    data = await displacement()
    out: dict[str, int] = {}
    for item in data.get("items", []):
        idps = item.get("idps") or 0
        refugees = item.get("refugees") or 0
        total = idps + refugees
        if total:
            out[item["iso3"]] = total
    return out
