"""Starter fusion rules.

Per research_updated.md §1.3. Each rule consumes Observations from the
sliding window and emits Alerts. Wired into the background runner
(`app.correlate.runner._rule_loop`):

- emergency_squawk           — any aircraft with squawk 7500/7600/7700
- proximity_mil_vessel       — /v2/mil aircraft within 25 km of an AIS vessel
- major_quake                — USGS quake at/above magnitude threshold
- gps_jam_cluster            — clusters of aircraft reporting degraded GNSS

Library rules (tested, available for AOI wiring but not yet scheduled):

- mil_aircraft_in_aoi        — /mil contact inside a monitored bbox
- ais_gap_in_aoi             — vessels not seen for ≥gapMs while last fix in AOI
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Iterable
from typing import Any

from app.correlate.types import Alert, Observation

EMERGENCY_SQUAWKS = {"7500", "7600", "7700"}

# GNSS integrity thresholds per research_updated.md §2.7 / research.md §5.
# FAA-compliant ADS-B Out requires nac_p ≥ 8 and nic ≥ 7 — anything below
# means the on-board GNSS is degraded, which is the GPSJam.org definition
# of a "bad" position report.
GPS_JAM_NACP_GOOD = 8
GPS_JAM_NIC_GOOD = 7
# Minimum cell population before we trust the ratio. One bad fix among one
# aircraft is 100% bad — but it's noise, not a jamming footprint. Three
# aircraft is the floor where ≥50% bad becomes statistically interesting.
GPS_JAM_MIN_AIRCRAFT = 3
GPS_JAM_BAD_PERCENT = 50.0


def proximity_mil_vessel(
    obs: Iterable[Observation],
    radius_km: float = 25.0,
) -> list[Alert]:
    """Military aircraft within radius_km of a (live, AIS-on) vessel.

    Real-world signal: ISR / patrol orbits over a contact of interest.
    Useful even when neither is in a saved AOI.
    """
    observations = list(obs)
    # ONLY the /v2/mil ingest (source="adsb_mil") counts as military here.
    # "airplanes_live" is the EMERGENCY-SQUAWK loop's source tag — counting it
    # produced spurious "MIL near vessel" alerts for civilian aircraft
    # squawking 7700 over shipping lanes.
    mils = [
        o for o in observations
        if o.emits_kind == "aircraft" and o.attrs.get("source") == "adsb_mil"
    ]
    ships = [o for o in observations if o.emits_kind == "vessel"]
    if not mils or not ships:
        return []
    # Coarse spatial pre-filter: bucket ships into 1°×1° tiles so the per-mil
    # inner loop only checks ships in a 3×3 neighborhood (cuts M×N to ~M×K
    # where K = ships in 9 tiles). At 2200 ships globally this is ~10–30.
    # Antimeridian-safe bucketing — wrap longitude into [-180, 180] before
    # bucketing, then probe neighbours modulo 360. Aircraft/vessels straddling
    # ±180° still find each other.
    def _wrap_lon(v: float) -> int:
        return int(((v + 180.0) % 360.0) - 180.0)

    ship_buckets: dict[tuple[int, int], list[Observation]] = {}
    for s in ships:
        key = (_wrap_lon(s.lon), int(s.lat))
        ship_buckets.setdefault(key, []).append(s)
    out: list[Alert] = []
    for a in mils:
        ax = _wrap_lon(a.lon)
        ay = int(a.lat)
        nearby: list[Observation] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                # wrap the neighbour bucket modulo 360 so probes near +179 hit -179.
                nx = ((ax + dx + 180) % 360) - 180
                bucket = ship_buckets.get((nx, ay + dy))
                if bucket:
                    nearby.extend(bucket)
        for s in nearby:
            d = haversine_km(a.lon, a.lat, s.lon, s.lat)
            if d > radius_km:
                continue
            ac = a.attrs.get("callsign") or a.attrs.get("icao24") or "?"
            sh = s.attrs.get("name") or s.attrs.get("mmsi") or "?"
            out.append(
                Alert(
                    id=str(uuid.uuid4()),
                    rule_id="proximity_mil_vessel",
                    severity="low",
                    t=max(a.t, s.t),
                    lon=(a.lon + s.lon) / 2,
                    lat=(a.lat + s.lat) / 2,
                    confidence=max(0.4, 1.0 - d / radius_km),
                    message=f"MIL {ac} within {d:.1f} km of vessel {sh}",
                    contributing=[a.id, s.id],
                )
            )
    return out


def major_quake(obs: Iterable[Observation], minmag: float = 4.5) -> list[Alert]:
    """Any quake at or above minmag in the last sliding window."""
    out: list[Alert] = []
    for o in obs:
        if o.emits_kind != "quake":
            continue
        mag_raw = o.attrs.get("mag")
        if mag_raw is None:
            continue
        try:
            mag = float(mag_raw)
        except (TypeError, ValueError):
            continue
        if mag < minmag:
            continue
        place = o.attrs.get("place") or "unknown"
        out.append(
            Alert(
                id=str(uuid.uuid4()),
                rule_id="major_quake",
                severity="high" if mag >= 6 else "medium",
                t=o.t,
                lon=o.lon,
                lat=o.lat,
                confidence=1.0,
                message=f"M{mag:.1f} earthquake — {place}",
                contributing=[o.id],
            )
        )
    return out


def emergency_squawk(obs: Iterable[Observation]) -> list[Alert]:
    out: list[Alert] = []
    for o in obs:
        if o.emits_kind != "aircraft":
            continue
        sq = o.attrs.get("squawk")
        if not sq or sq not in EMERGENCY_SQUAWKS:
            continue
        cs = (o.attrs.get("callsign") or o.attrs.get("icao24") or "?")
        reason = {
            "7500": "Hijack",
            "7600": "Radio failure",
            "7700": "Emergency",
        }[sq]
        out.append(
            Alert(
                id=str(uuid.uuid4()),
                rule_id="emergency_squawk",
                severity="critical" if sq == "7500" else "high",
                t=o.t,
                lon=o.lon,
                lat=o.lat,
                confidence=1.0,
                message=f"{cs} squawking {sq} ({reason})",
                contributing=[o.id],
            )
        )
    return out


def gps_jam_cluster(obs: Iterable[Observation]) -> list[Alert]:
    """Clusters of aircraft reporting degraded GNSS in a 1°×1° cell.

    Replicates GPSJam.org's bucketing (without an H3 dep) over the live
    sliding window: bin every aircraft with a reported nac_p/nic into a
    1° cell; if a cell holds ≥3 aircraft and ≥50% of them are below the
    FAA thresholds, emit a high-severity alert. Confidence scales with
    the bad fraction.

    Observations without integrity fields (e.g. MLAT, OpenSky state-vector
    fallback) are excluded from both numerator and denominator so we don't
    dilute the signal.
    """
    buckets: dict[tuple[int, int], dict[str, Any]] = {}
    for o in obs:
        if o.emits_kind != "aircraft":
            continue
        nac_p = o.attrs.get("nac_p")
        nic = o.attrs.get("nic")
        try:
            nac_p_v = int(nac_p) if nac_p is not None else None
        except (TypeError, ValueError):
            nac_p_v = None
        try:
            nic_v = int(nic) if nic is not None else None
        except (TypeError, ValueError):
            nic_v = None
        if nac_p_v is None and nic_v is None:
            continue

        # Antimeridian-safe 1° bucket; floor (not int()) so negatives don't
        # collapse toward zero from both sides.
        wlon = ((o.lon + 180.0) % 360.0) - 180.0
        key = (int(wlon // 1.0), int(o.lat // 1.0))
        slot = buckets.setdefault(
            key,
            {"total": 0, "bad": 0, "sum_lon": 0.0, "sum_lat": 0.0, "ids": []},
        )
        slot["total"] += 1
        slot["sum_lon"] += o.lon
        slot["sum_lat"] += o.lat
        slot["ids"].append(o.id)
        is_bad = (nac_p_v is not None and nac_p_v < GPS_JAM_NACP_GOOD) or (
            nic_v is not None and nic_v < GPS_JAM_NIC_GOOD
        )
        if is_bad:
            slot["bad"] += 1

    now = max((o.t for o in obs if o.emits_kind == "aircraft"), default=0.0)
    out: list[Alert] = []
    for (gx, gy), v in buckets.items():
        total = int(v["total"])
        bad = int(v["bad"])
        if total < GPS_JAM_MIN_AIRCRAFT:
            continue
        percent_bad = 100.0 * bad / total
        if percent_bad < GPS_JAM_BAD_PERCENT:
            continue
        # Centroid of contributing aircraft → more useful for the analyst
        # than the cell centre (which can be 50+ km off if the cluster is
        # concentrated in one corner).
        clon = v["sum_lon"] / total
        clat = v["sum_lat"] / total
        # Confidence climbs from 0.6 at the 50% threshold up to 0.95 at 100%.
        confidence = 0.6 + 0.35 * ((percent_bad - GPS_JAM_BAD_PERCENT) / 50.0)
        confidence = max(0.6, min(0.95, confidence))
        out.append(
            Alert(
                id=str(uuid.uuid4()),
                rule_id="gps_jam_cluster",
                severity="high",
                t=now,
                lon=clon,
                lat=clat,
                confidence=confidence,
                message=(
                    f"{bad}/{total} aircraft in [{gx},{gy}] reporting degraded GNSS"
                ),
                # Stable cell sentinel — _publish's dedup key is built from
                # sorted(contributing), so a varying aircraft list per tick
                # would defeat dedup and re-fire the same cluster every 10s.
                # We deliberately do NOT include individual aircraft IDs here
                # because (a) they rotate as aircraft transit, (b) the alert
                # is about the cell, not the specific contacts, and (c) any
                # operator drilling in can query the live /api/jamming/nacp
                # layer for the cell breakdown.
                contributing=[f"jamcell:{gx}:{gy}"],
            )
        )
    return out


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    # Clamp: floating-point error can push `a` past 1.0 for near-antipodal
    # pairs, and math.asin would raise a domain error inside the rule loop.
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def mil_aircraft_in_aoi(
    obs: Iterable[Observation],
    aoi_bbox: tuple[float, float, float, float],
) -> list[Alert]:
    """Any /mil ADS-B contact whose position is inside the AOI."""
    out: list[Alert] = []
    w, s, e, n = aoi_bbox
    for o in obs:
        if o.emits_kind != "aircraft":
            continue
        if o.attrs.get("source") != "adsb_mil":
            continue
        if not (w <= o.lon <= e and s <= o.lat <= n):
            continue
        cs = (o.attrs.get("callsign") or o.attrs.get("icao24") or "?")
        out.append(
            Alert(
                id=str(uuid.uuid4()),
                rule_id="mil_in_aoi",
                severity="medium",
                t=o.t,
                lon=o.lon,
                lat=o.lat,
                confidence=0.9,
                message=f"Military contact {cs} in monitored AOI",
                contributing=[o.id],
            )
        )
    return out


def ais_gap_in_aoi(
    last_fixes: dict[str, Observation],
    aoi_bbox: tuple[float, float, float, float],
    now: float,
    gap_sec: float = 3600.0,
    lookback_sec: float = 1800.0,
) -> list[Alert]:
    """Vessels whose last AIS fix in the AOI is ≥gap old but ≤gap+lookback."""
    out: list[Alert] = []
    w, s, e, n = aoi_bbox
    for mmsi, o in last_fixes.items():
        if o.emits_kind != "vessel":
            continue
        if not (w <= o.lon <= e and s <= o.lat <= n):
            continue
        gap = now - o.t
        if gap < gap_sec or gap > gap_sec + lookback_sec:
            continue
        name = o.attrs.get("name") or mmsi
        out.append(
            Alert(
                id=str(uuid.uuid4()),
                rule_id="ais_gap_in_aoi",
                severity="medium",
                t=now,
                lon=o.lon,
                lat=o.lat,
                confidence=0.5 + min(0.4, gap / 36000.0),  # confidence grows with gap
                message=f"{name} (MMSI {mmsi}) — AIS silent {int(gap/60)} min in AOI",
                contributing=[o.id],
            )
        )
    return out
