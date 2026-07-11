"""Country statistics — World Bank API v2 + UNSD SDG API proxies (keyless).

`/api/country/*` powers the Country Data viewer app: a curated indicator
manifest (stable ids the frontend can rely on), per-country World Bank
time-series, UNSD SDG series, and an ISO-3166 country list (name, iso2/3,
M49 numeric, region) shipped in ``app/data/countries_iso.json``.

Both upstreams are keyless public statistical APIs; responses are cached a
day (they update yearly/quarterly). All values are the upstream's own —
nulls stay null, nothing interpolated.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.upstream import cache, get_client

router = APIRouter(tags=["country"])

_DATA = Path(__file__).resolve().parent.parent / "data"
_TTL = 86400.0
# api.worldbank.org rate-limits by IP and STALLS (accepts the connection,
# never responds) after a burst — hit live 2026-07-12 firing 16 indicators in
# parallel. Keep upstream concurrency polite; the 24h cache absorbs the rest.
_WB_SEM = None


def _wb_sem():
    global _WB_SEM  # noqa: PLW0603 — lazy so the semaphore binds to the running loop
    import asyncio

    if _WB_SEM is None:
        _WB_SEM = asyncio.Semaphore(4)
    return _WB_SEM

# Curated World Bank indicator manifest — id, human label, unit hint.
WB_INDICATORS: list[dict[str, str]] = [
    {"id": "SP.POP.TOTL", "label": "Population", "unit": "people"},
    {"id": "NY.GDP.MKTP.CD", "label": "GDP", "unit": "current US$"},
    {"id": "NY.GDP.PCAP.CD", "label": "GDP per capita", "unit": "current US$"},
    {"id": "NY.GDP.MKTP.KD.ZG", "label": "GDP growth", "unit": "% annual"},
    {"id": "FP.CPI.TOTL.ZG", "label": "Inflation (CPI)", "unit": "% annual"},
    {"id": "MS.MIL.XPND.GD.ZS", "label": "Military expenditure", "unit": "% of GDP"},
    {"id": "MS.MIL.TOTL.P1", "label": "Armed forces personnel", "unit": "people"},
    {"id": "EG.ELC.ACCS.ZS", "label": "Access to electricity", "unit": "% of population"},
    {"id": "EG.USE.ELEC.KH.PC", "label": "Electric power consumption", "unit": "kWh per capita"},
    {"id": "IT.NET.USER.ZS", "label": "Internet users", "unit": "% of population"},
    {"id": "SP.URB.TOTL.IN.ZS", "label": "Urban population", "unit": "% of total"},
    {"id": "SP.DYN.LE00.IN", "label": "Life expectancy at birth", "unit": "years"},
    {"id": "SL.UEM.TOTL.ZS", "label": "Unemployment", "unit": "% of labor force"},
    {"id": "NE.EXP.GNFS.ZS", "label": "Exports of goods and services", "unit": "% of GDP"},
    {"id": "BX.KLT.DINV.CD.WD", "label": "Foreign direct investment, net inflows", "unit": "current US$"},
    {"id": "EN.ATM.CO2E.PC", "label": "CO2 emissions", "unit": "t per capita"},
]

# Curated UNSD SDG series (seriesCode, label).
UN_SERIES: list[dict[str, str]] = [
    {"id": "SI_POV_DAY1", "label": "Population below intl. poverty line (SDG 1.1.1)", "unit": "%"},
    {"id": "SH_DYN_MORT", "label": "Under-5 mortality rate (SDG 3.2.1)", "unit": "per 1,000 live births"},
    {"id": "SE_ADT_LITRT", "label": "Adult literacy rate (SDG 4.6)", "unit": "%"},
    {"id": "EG_ELC_ACCS", "label": "Access to electricity (SDG 7.1.1)", "unit": "%"},
    {"id": "VC_IHR_PSRC", "label": "Intentional homicide rate (SDG 16.1.1)", "unit": "per 100,000"},
]


@lru_cache(maxsize=1)
def countries_iso() -> list[dict[str, Any]]:
    """ISO-3166 rows: name, alpha-2, alpha-3, country-code (M49), region…"""
    with (_DATA / "countries_iso.json").open(encoding="utf-8") as fh:
        rows = json.load(fh)
    return rows if isinstance(rows, list) else []


@lru_cache(maxsize=1)
def _iso3_index() -> dict[str, dict[str, Any]]:
    return {str(r.get("alpha-3") or "").upper(): r for r in countries_iso()}


def _resolve_iso3(iso3: str) -> dict[str, Any]:
    row = _iso3_index().get(iso3.strip().upper())
    if row is None:
        raise HTTPException(404, f"unknown ISO-3166 alpha-3 code {iso3!r}")
    return row


@router.get("/api/country/list")
async def country_list() -> list[dict[str, Any]]:
    """All ISO-3166 countries (name, iso2/iso3, M49 numeric, region/sub-region)."""
    return [
        {
            "name": r.get("name"),
            "iso2": r.get("alpha-2"),
            "iso3": r.get("alpha-3"),
            "m49": r.get("country-code"),
            "region": r.get("region"),
            "sub_region": r.get("sub-region"),
        }
        for r in countries_iso()
    ]


@router.get("/api/country/indicators")
async def country_indicators() -> dict[str, Any]:
    """The curated indicator manifest (stable ids the frontend renders)."""
    return {"worldbank": WB_INDICATORS, "un": UN_SERIES}


@router.get("/api/country/{iso3}/worldbank")
async def country_worldbank(
    iso3: str,
    indicators: str | None = Query(None, description="comma-joined WB indicator ids; default = curated manifest"),
    years: int = Query(15, ge=1, le=60),
) -> dict[str, Any]:
    """World Bank time-series for one country. Values are WB's own; a series
    the WB has no data for comes back with an empty list, never invented."""
    row = _resolve_iso3(iso3)
    manifest = {i["id"]: i for i in WB_INDICATORS}
    ids = [s.strip() for s in indicators.split(",") if s.strip()] if indicators else list(manifest)
    if len(ids) > 30:
        raise HTTPException(400, "too many indicators (max 30)")
    for ind in ids:
        if not all(c.isalnum() or c == "." for c in ind):
            raise HTTPException(400, f"malformed indicator id {ind!r}")

    iso3u = str(row["alpha-3"])

    async def load_one(ind: str) -> dict[str, Any]:
        key = f"wb:{iso3u}:{ind}:{years}"

        async def load() -> dict[str, Any]:
            try:
                async with _wb_sem():
                    r = await get_client().get(
                        f"https://api.worldbank.org/v2/country/{iso3u}/indicator/{ind}",
                        params={"format": "json", "mrv": years, "per_page": years},
                    )
                body = r.json()
            except Exception as e:  # noqa: BLE001 — one bad series never fails the country
                return {"id": ind, "unavailable": True, "note": f"{type(e).__name__}: {e}"[:120], "series": []}
            if not isinstance(body, list) or len(body) < 2 or not isinstance(body[1], list):
                return {"id": ind, "unavailable": True, "note": "wb: no data", "series": []}
            series = [
                {"year": p.get("date"), "value": p.get("value")}
                for p in body[1]
                if p.get("date")
            ]
            series.reverse()  # oldest → newest for charting
            meta = (body[1][0] or {}).get("indicator") or {} if body[1] else {}
            return {
                "id": ind,
                "label": manifest.get(ind, {}).get("label") or meta.get("value") or ind,
                "unit": manifest.get(ind, {}).get("unit", ""),
                "series": series,
            }

        out = await cache.get_or_fetch(key, _TTL, load)
        if out.get("unavailable"):
            # A transient upstream failure must not poison a day of cache.
            cache.shorten(key, 60.0)
        return out

    import asyncio

    results = await asyncio.gather(*[load_one(i) for i in ids])
    return {
        "iso3": iso3u,
        "name": row.get("name"),
        "source": "worldbank-api-v2",
        "indicators": list(results),
    }


@router.get("/api/country/{iso3}/un")
async def country_un(
    iso3: str,
    series: str | None = Query(None, description="comma-joined UNSD SDG series codes; default = curated set"),
) -> dict[str, Any]:
    """UNSD SDG series for one country (matched by M49 numeric area code)."""
    row = _resolve_iso3(iso3)
    m49 = str(int(row.get("country-code") or 0))
    manifest = {s["id"]: s for s in UN_SERIES}
    codes = [s.strip() for s in series.split(",") if s.strip()] if series else list(manifest)
    if len(codes) > 15:
        raise HTTPException(400, "too many series (max 15)")
    for c in codes:
        if not all(ch.isalnum() or ch == "_" for ch in c):
            raise HTTPException(400, f"malformed series code {c!r}")

    async def load_one(code: str) -> dict[str, Any]:
        key = f"un:{m49}:{code}"

        async def load() -> dict[str, Any]:
            try:
                r = await get_client().get(
                    "https://unstats.un.org/SDGAPI/v1/sdg/Series/Data",
                    params={"seriesCode": code, "areaCode": m49, "pageSize": 500},
                )
                body = r.json()
            except Exception as e:  # noqa: BLE001
                return {"id": code, "unavailable": True, "note": f"{type(e).__name__}: {e}"[:120], "series": []}
            pts = [
                {"year": d.get("timePeriodStart"), "value": d.get("value")}
                for d in body.get("data") or []
                if d.get("timePeriodStart") is not None
            ]
            pts.sort(key=lambda p: p["year"])
            return {
                "id": code,
                "label": manifest.get(code, {}).get("label", code),
                "unit": manifest.get(code, {}).get("unit", ""),
                "series": pts,
            }

        out = await cache.get_or_fetch(key, _TTL, load)
        if out.get("unavailable"):
            cache.shorten(key, 60.0)
        return out

    import asyncio

    results = await asyncio.gather(*[load_one(c) for c in codes])
    return {
        "iso3": str(row["alpha-3"]),
        "name": row.get("name"),
        "m49": m49,
        "source": "unstats-sdg-api",
        "series": list(results),
    }
