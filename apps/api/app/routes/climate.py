"""``/api/climate/anomalies`` — temperature/precipitation anomalies over
conflict-dense country centroids (worldmonitor-gaps wave, task B1d).

Targets: the top-25 countries by armed-conflict event count in the last 72h
(``app.intel.conflict.conflict_events``), centroid = mean of that country's
event coordinates. Fewer than 5 countries have events (feed thin or down) →
pad from a small static list of chronic-conflict-zone centroids; a fully
unavailable conflict feed falls back to the static list entirely and the
envelope carries ``degraded: true``.

Anomaly source: Open-Meteo's keyless ERA5 archive API
(``archive-api.open-meteo.com/v1/era5``), which accepts comma-joined
``latitude``/``longitude`` lists for one batched call across all centroids
(same batching idiom as ``env.py`` air-quality). Recent mean = last 30 days;
baseline = the same calendar-day window in each of the previous
``_BASELINE_YEARS`` years (5), so the whole fetch is a fixed 1 + 5 = 6
requests regardless of country count — no per-point fan-out, no need for a
separate climate-normals product. anomaly_c = recent mean temp − mean of the
per-year baseline means; precip_pct_of_normal = 100 * recent total precip /
mean of the per-year baseline totals (``None`` when the baseline total is 0,
to avoid a divide-by-zero reading as an infinite anomaly).
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter

from app.intel.conflict import conflict_events
from app.routes import _feedgeo as fg

router = APIRouter(tags=["climate"])

ERA5_URL = "https://archive-api.open-meteo.com/v1/era5"

_WINDOW_DAYS = 30
_BASELINE_YEARS = 5
_TOP_N_COUNTRIES = 25
_MIN_CONFLICT_COUNTRIES = 5

# Chronic-conflict-zone centroids used to pad (or, if the conflict feed is down,
# wholly replace) the country list. Coordinates are rough country centroids, not
# tied to any single event.
_STATIC_COUNTRIES: list[tuple[str, float, float]] = [
    ("UKR", 49.0, 32.0),
    ("SYR", 35.0, 38.0),
    ("YEM", 15.5, 47.5),
    ("SDN", 15.0, 30.0),
    ("SOM", 5.0, 46.0),
    ("MLI", 17.0, -4.0),
    ("MMR", 21.0, 96.0),
    ("AFG", 33.0, 65.0),
    ("COD", -2.0, 23.0),
    ("PSE", 31.9, 35.2),
]


def _country_centroids(conflict: dict[str, Any]) -> tuple[list[tuple[str, float, float]], bool]:
    """Return (iso3, lat, lon) centroids for the top conflict-dense countries.

    Second element is ``True`` when the result is the static fallback list
    (conflict feed unavailable, or too few distinct conflict countries to be
    a meaningful ranking).
    """
    if conflict.get("unavailable"):
        return _STATIC_COUNTRIES, True

    sums: dict[str, list[float]] = {}  # iso3 -> [lon_sum, lat_sum, count]
    for feat in conflict.get("features", []):
        iso3 = (feat.get("properties") or {}).get("iso3")
        if not iso3:
            continue
        lon, lat = feat["geometry"]["coordinates"]
        acc = sums.setdefault(iso3, [0.0, 0.0, 0])
        acc[0] += lon
        acc[1] += lat
        acc[2] += 1

    if len(sums) < _MIN_CONFLICT_COUNTRIES:
        return _STATIC_COUNTRIES, True

    ranked = sorted(sums.items(), key=lambda kv: kv[1][2], reverse=True)[:_TOP_N_COUNTRIES]
    centroids = [(iso3, acc[1] / acc[2], acc[0] / acc[2]) for iso3, acc in ranked]
    return centroids, False


def _date_window(end: dt.date, days: int) -> tuple[dt.date, dt.date]:
    return end - dt.timedelta(days=days - 1), end


def _shift_years(d: dt.date, years: int) -> dt.date:
    try:
        return d.replace(year=d.year - years)
    except ValueError:  # Feb 29 in a non-leap target year
        return d.replace(year=d.year - years, day=28)


async def _fetch_window(
    countries: list[tuple[str, float, float]], start: dt.date, end: dt.date
) -> list[dict[str, Any]] | None:
    """One batched ERA5 call for ``countries`` over ``[start, end]``.

    Returns the raw per-location rows (normalised to a list), or ``None`` if
    a location's ``daily`` block is missing/malformed.
    """
    lats = ",".join(f"{c[1]:.3f}" for c in countries)
    lons = ",".join(f"{c[2]:.3f}" for c in countries)
    raw = await fg.fetch_json(
        ERA5_URL,
        params={
            "latitude": lats,
            "longitude": lons,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "daily": "temperature_2m_mean,precipitation_sum",
            "timezone": "UTC",
        },
    )
    rows = raw if isinstance(raw, list) else [raw]
    return rows


def _window_stats(row: dict[str, Any] | None) -> tuple[float | None, float | None]:
    """(mean temp, total precip) for one location's ``daily`` block."""
    if not isinstance(row, dict):
        return None, None
    daily = row.get("daily") or {}
    temps = [t for t in (daily.get("temperature_2m_mean") or []) if t is not None]
    precs = [p for p in (daily.get("precipitation_sum") or []) if p is not None]
    mean_t = sum(temps) / len(temps) if temps else None
    total_p = sum(precs) if precs else None
    return mean_t, total_p


@router.get("/api/climate/anomalies")
async def climate_anomalies() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            conflict = await conflict_events(hours=72)
        except Exception as e:  # noqa: BLE001 — degrade to the static list, never 500
            conflict = {"unavailable": True, "note": str(e)[:120]}

        countries, degraded = _country_centroids(conflict)

        today = dt.datetime.now(dt.UTC).date()
        recent_start, recent_end = _date_window(today, _WINDOW_DAYS)
        recent_rows = await _fetch_window(countries, recent_start, recent_end)

        baseline_rows_by_year: list[list[dict[str, Any]]] = []
        for years_ago in range(1, _BASELINE_YEARS + 1):
            b_start = _shift_years(recent_start, years_ago)
            b_end = _shift_years(recent_end, years_ago)
            baseline_rows_by_year.append(await _fetch_window(countries, b_start, b_end))

        features: list[fg.Feature] = []
        for idx, (iso3, lat, lon) in enumerate(countries):
            recent_row = recent_rows[idx] if idx < len(recent_rows) else None
            recent_t, recent_p = _window_stats(recent_row)
            if recent_t is None:
                continue

            baseline_temps: list[float] = []
            baseline_precs: list[float] = []
            for year_rows in baseline_rows_by_year:
                row = year_rows[idx] if year_rows and idx < len(year_rows) else None
                b_t, b_p = _window_stats(row)
                if b_t is not None:
                    baseline_temps.append(b_t)
                if b_p is not None:
                    baseline_precs.append(b_p)

            if not baseline_temps:
                continue
            baseline_t_mean = sum(baseline_temps) / len(baseline_temps)
            anomaly_c = round(recent_t - baseline_t_mean, 2)

            precip_pct: float | None = None
            if baseline_precs:
                baseline_p_mean = sum(baseline_precs) / len(baseline_precs)
                if baseline_p_mean > 0 and recent_p is not None:
                    precip_pct = round(100.0 * recent_p / baseline_p_mean, 1)

            features.append(
                fg.point(
                    f"climate_anomaly:{iso3}",
                    lon,
                    lat,
                    {
                        "kind": "climate_anomaly",
                        "iso3": iso3,
                        "anomaly_c": anomaly_c,
                        "precip_pct_of_normal": precip_pct,
                        "window_days": _WINDOW_DAYS,
                        "baseline": f"mean of the same {_WINDOW_DAYS}-day calendar "
                        f"window in each of the previous {_BASELINE_YEARS} years",
                    },
                )
            )

        out = fg.fc(features)
        out["degraded"] = degraded
        out["source"] = "Open-Meteo ERA5 archive (keyless)"
        return out

    return await fg.cached("climate:anomalies", 43200.0, load)
