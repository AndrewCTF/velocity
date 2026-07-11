"""Dataset geo-column auto-detection.

Name heuristics (exact match preferred over a loose substring match) narrowed
by a numeric-range sanity check over a sample of rows, so a column merely
NAMED ``x``/``y`` that isn't actually degrees doesn't get treated as
lon/lat. Used by ``GET /api/foundry/datasets/{id}/geo`` to turn a dataset
with plausible coordinate columns into a GeoJSON FeatureCollection without
the operator having to say which columns those are.
"""

from __future__ import annotations

from typing import Any

_LAT_EXACT = {"lat", "latitude", "y"}
_LON_EXACT = {"lon", "lng", "long", "longitude", "x"}
_LAT_CONTAINS = ("lat",)
_LON_CONTAINS = ("lon", "lng")

# How many rows to sample for the range-validity check — enough to catch a
# column that's clearly not coordinates without scanning a 200k-row dataset.
_SAMPLE_SIZE = 200


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _candidate_cols(
    schema: list[dict[str, str]], exact: set[str], contains: tuple[str, ...]
) -> list[str]:
    names = [c["name"] for c in schema]
    exact_matches = [n for n in names if n.lower() in exact]
    if exact_matches:
        return exact_matches
    return [n for n in names if any(s in n.lower() for s in contains)]


def _valid_numeric_range(rows: list[dict[str, Any]], col: str, limit: float) -> bool:
    sample = rows[:_SAMPLE_SIZE]
    values = [r.get(col) for r in sample if _is_number(r.get(col))]
    if not values:
        return False
    return all(abs(v) <= limit for v in values)


def detect_geo(schema: list[dict[str, str]], rows: list[dict[str, Any]]) -> dict[str, str] | None:
    """Best-effort ``{lat_col, lon_col}`` detection. Returns ``None`` if no
    name-heuristic column pair also passes the |lat|<=90 / |lon|<=180 numeric
    range check over a sample of rows."""
    lat_candidates = _candidate_cols(schema, _LAT_EXACT, _LAT_CONTAINS)
    lon_candidates = _candidate_cols(schema, _LON_EXACT, _LON_CONTAINS)
    for lat_col in lat_candidates:
        if not _valid_numeric_range(rows, lat_col, 90.0):
            continue
        for lon_col in lon_candidates:
            if lon_col == lat_col:
                continue
            if _valid_numeric_range(rows, lon_col, 180.0):
                return {"lat_col": lat_col, "lon_col": lon_col}
    return None


def to_feature_collection(
    rows: list[dict[str, Any]], lat_col: str, lon_col: str, cap: int = 5000
) -> dict[str, Any]:
    """GeoJSON FeatureCollection of Points, capped at ``cap`` VALID features in
    stable original-row order (each feature's ``_idx`` is its source row
    index, so a capped view still traces back to the underlying dataset)."""
    features: list[dict[str, Any]] = []
    for idx, r in enumerate(rows):
        if len(features) >= cap:
            break
        lat = r.get(lat_col)
        lon = r.get(lon_col)
        if not (_is_number(lat) and _is_number(lon)):
            continue
        props = {k: v for k, v in r.items() if k not in (lat_col, lon_col)}
        props["_idx"] = idx
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            }
        )
    return {"type": "FeatureCollection", "features": features}
