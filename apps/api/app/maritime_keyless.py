"""Consolidated keyless vessel feed — Digitraffic (Baltic) ∪ Kystdatahuset (Norway).

The frontend's default no-key vessel layer historically saw ONLY Digitraffic
(Finnish/Baltic). Norway's Kystdatahuset coverage was fed only through the
``/ws/ais`` broadcast (off by default unless the AISStream layer is enabled),
so a fresh install showed Baltic ships but not the Norwegian/Arctic coast.

This module unions the two REST polls into ONE viewport-filterable GeoJSON
FeatureCollection, deduped by ``vessel:<mmsi>`` with the FRESHEST fix winning.
Both upstreams degrade independently: a fetch failure for one source returns
an empty list for it and the other still renders (and a total double-failure
serves the last good union via the route's stale-on-failure cache).

Measured coverage (live TestClient probe, this run): Digitraffic in-commission
994 distinct MMSI (Baltic / Gulf of Finland) + Kystdatahuset 3,552 distinct
MMSI (Norwegian coast / North Sea / Arctic), no MMSI overlap → 4,546 distinct
vessels over bbox lon[-8.4, 34.0] lat[55.3, 80.6]. This is REGIONAL Northern-
Europe coverage — the Mediterranean, Black Sea, the Americas, and Asia-Pacific
have NO keyless live point feed reachable from this egress (every national
authority + aggregator probed was HTML-only, key/OAuth-gated, datacenter-
blocked, or historical-only), so worldwide vessels still need AISStream (key,
on-demand).

Speed units: both upstreams report SOG in KNOTS (AIS 0.1-kn resolution); the
102.3-kn "not available" sentinel is masked to ``None`` on every source
(``_clean_sog_kn``). Freshness: ``properties.t`` is the upstream per-fix time
(Kystdatahuset ``date_time_utc`` / Digitraffic ``timestampExternal``), falling
back to ingest time only when absent, so ``merge_vessel_features`` dedup is
fair (NIT N4).

The pure ``merge_vessel_features`` + parse helpers take no network so the
union/dedup/freshness logic is unit-tested offline.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from typing import Any

from app.upstream import get_client

log = logging.getLogger(__name__)

_KYSTDATAHUSET_URL = "https://kystdatahuset.no/ws/api/ais/realtime/geojson"
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# AIS SOG "not available" sentinel: raw 1023 → 102.3 kn (ITU-R M.1371). Any
# source that forwards the raw field unmasked will report 102.3 for a vessel
# with no speed solution; treat it as "unknown" so it never paints as a
# 102-knot ghost.
_SOG_NA = 102.3


def _parse_iso_utc(value: Any) -> float | None:
    """Parse an ISO-8601 timestamp to epoch SECONDS (UTC), else ``None``.

    Kystdatahuset stamps each fix with ``date_time_utc`` — a naive ISO string
    in UTC (e.g. ``"2026-06-15T11:44:00"``, sometimes with a ``Z`` suffix or a
    fractional part). A naive value (no tz offset) is interpreted as UTC, which
    is what the field name promises.
    """
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def _clean_sog_kn(value: Any) -> float | int | None:
    """Return a knots SOG, nulling the AIS 102.3-kn "not available" sentinel.

    Both upstreams the consolidated feed reads (Digitraffic ``sog`` and
    Kystdatahuset ``speed``) already report SOG in KNOTS at AIS 0.1-kn
    resolution, so no unit conversion is needed — only sentinel masking. If a
    future source reports m/s or 0.1-kn raw, convert it to knots in that
    source's parser before storing, so ``properties.sog`` stays in knots
    everywhere (matching Digitraffic).
    """
    if isinstance(value, (int, float)) and value >= _SOG_NA:
        return None
    return value


def _feat_mmsi(feat: dict[str, Any]) -> int | None:
    """MMSI from a normalized vessel feature (``id`` ``vessel:<mmsi>`` or props)."""
    props = feat.get("properties") or {}
    m = props.get("mmsi")
    if m is None:
        fid = feat.get("id")
        if isinstance(fid, str) and fid.startswith("vessel:"):
            m = fid.split(":", 1)[1]
    try:
        return int(m) if m is not None else None
    except (TypeError, ValueError):
        return None


def merge_vessel_features(
    *groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Union normalized vessel features, dedup by MMSI, freshest fix wins.

    Each feature carries ``properties.t`` (epoch seconds; may be ``None``).
    When two sources report the same MMSI the one with the larger ``t`` is
    kept; a feature with a known ``t`` always beats one with ``t is None``.
    Features without a resolvable MMSI are dropped (every keyless source here
    keys on MMSI). Order across distinct MMSIs follows first-seen.

    Fairness (NIT N4): every source must stamp ``t`` with the upstream fix
    time, not the ingest time, or it would always win this comparison against a
    real-timestamped peer. Kystdatahuset now parses ``date_time_utc`` and
    Digitraffic parses ``timestampExternal``; both fall back to ``now()`` only
    when their per-fix timestamp is genuinely absent.
    """
    best: dict[int, dict[str, Any]] = {}
    order: list[int] = []
    for group in groups:
        for feat in group:
            mmsi = _feat_mmsi(feat)
            if mmsi is None:
                continue
            cur = best.get(mmsi)
            if cur is None:
                best[mmsi] = feat
                order.append(mmsi)
                continue
            new_t = (feat.get("properties") or {}).get("t")
            cur_t = (cur.get("properties") or {}).get("t")
            if cur_t is None and new_t is not None:
                best[mmsi] = feat
            elif new_t is not None and cur_t is not None and new_t > cur_t:
                best[mmsi] = feat
    return [best[m] for m in order]


def _latest_lonlat(geometry: dict[str, Any]) -> tuple[float, float] | None:
    coords = geometry.get("coordinates")
    gtype = geometry.get("type")
    if gtype == "Point" and isinstance(coords, list) and len(coords) >= 2:
        return float(coords[0]), float(coords[1])
    if gtype == "LineString" and isinstance(coords, list) and coords:
        last = coords[-1]
        if isinstance(last, list) and len(last) >= 2:
            return float(last[0]), float(last[1])
    return None


def parse_kystdatahuset(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize a Kystdatahuset realtime GeoJSON FeatureCollection.

    Kystdatahuset returns one Feature per vessel — usually a LineString of the
    recent track, where the LAST coordinate is the newest fix. Properties use
    ``mmsi`` / ``ship_name`` / ``ship_type`` / ``speed`` / ``cog`` /
    ``true_heading`` / ``date_time_utc``. Drops null-island (0,0) and MMSI-less
    rows. Output matches the Digitraffic vessel shape so the frontend paint
    reuses unchanged.

    ``properties.t`` (epoch seconds) comes from the per-fix ``date_time_utc``
    when present, falling back to the fetch time only when the field is missing
    or unparseable — so this source competes FAIRLY in ``merge_vessel_features``
    dedup rather than always winning with a fresh ingest stamp (NIT N4).
    ``properties.sog`` is the upstream ``speed`` field, already in KNOTS (AIS
    0.1-kn resolution), with the 102.3-kn "not available" sentinel nulled
    (NIT N5).
    """
    out: list[dict[str, Any]] = []
    now = time.time()
    for feat in payload.get("features") or []:
        if not isinstance(feat, dict):
            continue
        geom = feat.get("geometry") or {}
        fix = _latest_lonlat(geom)
        if fix is None:
            continue
        lon, lat = fix
        if lon == 0.0 and lat == 0.0:  # Kystdatahuset null-island placeholder
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        props = feat.get("properties") or {}
        mmsi = props.get("mmsi")
        if mmsi is None:
            continue
        try:
            mmsi_int = int(mmsi)
        except (TypeError, ValueError):
            continue
        name = props.get("ship_name") or props.get("name")
        if isinstance(name, str):
            name = name.strip() or None
        # Per-fix timestamp (epoch s) from date_time_utc; fall back to fetch
        # time only when the field is absent/unparseable (NIT N4).
        fix_t = _parse_iso_utc(props.get("date_time_utc"))
        out.append(
            {
                "type": "Feature",
                "id": f"vessel:{mmsi_int}",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "mmsi": mmsi_int,
                    "name": name,
                    # `speed` is already knots (AIS 0.1-kn); 102.3 sentinel → None.
                    "sog": _clean_sog_kn(props.get("speed")),
                    "cog": props.get("cog"),
                    "heading": props.get("true_heading"),
                    "shipType": props.get("ship_type"),
                    "t": fix_t if fix_t is not None else now,
                    "kind": "vessel",
                    "source": "kystdatahuset",
                },
            }
        )
    return out


async def fetch_kystdatahuset() -> list[dict[str, Any]]:
    """Poll Kystdatahuset realtime GeoJSON → normalized vessel features.

    Best-effort: any failure (network, non-JSON, bad status) returns ``[]`` so
    the consolidated feed degrades to its other source rather than erroring.
    """
    try:
        r = await get_client().get(
            _KYSTDATAHUSET_URL,
            headers={"User-Agent": _UA, "Accept": "application/json"},
            timeout=30.0,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("kystdatahuset fetch error: %s", e)
        return []
    if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
        return []
    try:
        payload = r.json()
    except Exception:  # noqa: BLE001
        return []
    return parse_kystdatahuset(payload)
