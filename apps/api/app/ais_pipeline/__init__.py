"""AIS pipeline: keyless global-ish ingest + open-ocean SAR coverage.

Entry point for the backend. Fans out to the keyless providers on their own
cadences, merges into a freshness-wins store, and exposes both the AIS coverage
and the SAR-based open-ocean view.

Coverage statement, measured not assumed (2026-10-03, this egress):
  * ShipXplorer /live → 30 737 unique MMSIs, median fix age 1.9 min.
  * Those vessels are COASTAL: mid-Pacific, S-Atlantic, Indian Ocean and Arctic
    boxes return ZERO. "Global" describes the query, not the coverage.
  * Open-ocean coverage therefore comes from Sentinel-1 SAR (see ``sar``), which
    is keyless end-to-end and sees vessels regardless of AIS.
Neither number may be described as "full ocean coverage" without a fresh count.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from app.ais_pipeline import providers, sar, vesselfinder
from app.ais_pipeline.store import VesselStore
from app.config import get_settings
from app.upstream import get_client

log = logging.getLogger(__name__)

vessels = VesselStore()  # singleton; the MODULE is app.ais_pipeline.store

_tasks: list[asyncio.Task[None]] = []
_stats: dict[str, Any] = {
    "shipxplorer_vessels": 0,
    "shipxplorer_provider_total": None,
    "openwaters_vessels": 0,
    "openwaters_tiles": 0,
    "openwaters_tiles_failed": 0,
    "openwaters_tiles_truncated": 0,
    "openwaters_tiles_split": 0,
    "openwaters_sweep_complete": False,
    "vesselfinder_vessels": 0,
    "vesselfinder_tiles": 0,
    "vesselfinder_tiles_failed": 0,
    "vesselfinder_tiles_throttled": 0,
    "vesselfinder_sweep_complete": False,
    "vesselfinder_site_total": None,
    "satellite_positions": 0,
    "last_good_shipxplorer": 0.0,
    "last_good_openwaters": 0.0,
    "last_good_vesselfinder": 0.0,
    "errors": 0,
}

# Unidentified satellite positions (VesselFinder's "Satellite Position" markers).
# Kept OUT of the vessel store on purpose: they carry no MMSI to merge on and no
# age to rank by. Replaced wholesale by each sweep that completes.
satellite: dict[str, Any] = {"positions": [], "fetched_at": 0.0, "complete": False}


def stats() -> dict[str, Any]:
    s = get_settings()
    return {
        **_stats,
        "store": vessels.stats(),
        "coverageNote": (
            "Identified keyless AIS is COASTAL, not global. The per-source "
            "counts in this payload are live. OpenWaters only answers "
            "anonymous queries for lon [-90,+81], and a sweep with truncated "
            "tiles undercounts. ShipXplorer and OpenWaters hold ZERO vessels "
            "in all 6 deep-ocean boxes tested (2026-10-03, again 2026-10-04). "
            "Open ocean is covered two ways, neither of them an identified "
            "track: unidentified satellite positions (/api/maritime/satellite, "
            "no MMSI and no age) and Sentinel-1 SAR — see ais_pipeline.sar."
        ),
        "sarEnabled": s.ais_pipeline_sar_enabled,
        "satellite": {
            "positions": len(satellite["positions"]),
            "complete": satellite["complete"],
            "ageS": round(time.time() - satellite["fetched_at"], 1)
            if satellite["fetched_at"]
            else None,
        },
    }


def _err(e: Exception, who: str) -> None:
    _stats["errors"] += 1
    log.warning("ais_pipeline %s error: %s", who, e)


# ── bridge into the shared observation store ─────────────────────────────────
#
# Everything that draws or reasons about vessels (/api/maritime/snapshot and its
# blob, parked, chokepoints, analytics, dark-vessel correlation, the
# query_vessels MCP tool) reads the shared ObservationStore, which is
# LAST-WRITE-WINS by arrival. So the bridge carries the freshness rule itself:
# a fix is written only when it is this store's winner AND strictly newer than
# what the shared store holds for that id. Without the gate an older OpenWaters
# fix would land on top of a fresher one from another writer, and latest() would
# then hide the MMSI.
#
# Known limit: the gate compares unlike clocks. ShipXplorer/OpenWaters carry the
# per-fix time, MyShipTracking stamps its sweep time and the push feeds stamp
# wall clock, so a contested MMSI usually stays with those writers. That is the
# safe direction (never clobber), not a full merge.


def _mirror(fixes: list[providers.Fix]) -> int:
    """Write this batch's winners into the shared store. Returns the count."""
    from app import ais_firehose  # noqa: PLC0415 — keeps package import light
    from app.correlate.store import DEFAULT_RETENTION_SEC  # noqa: PLC0415
    from app.correlate.types import Observation  # noqa: PLC0415
    from app.routes import ais as ais_routes  # noqa: PLC0415

    shared = ais_firehose.store
    now = time.time()
    cutoff = now - DEFAULT_RETENTION_SEC
    batch: list[Observation] = []
    for fx in fixes:
        st = vessels.get(fx.mmsi)
        if st is None or st.fix is not fx:
            continue  # lost inside the pipeline store, or a duplicate in the batch
        # Feed the cross-source caches even when the position loses below: the
        # other writers label their fixes from these, so the name survives.
        ais_firehose._remember_name(fx.mmsi, fx.name)
        code = providers.itu_ship_type(fx.ship_type)
        if code is not None:
            ais_routes._remember_ship_type(fx.mmsi, code)
        # A timestamp from the future would win every comparison and pin itself.
        t = min(fx.t, now)
        if t < cutoff:
            continue  # latest() would hide it; it would only bloat the buffer
        oid = f"vessel:{fx.mmsi}"
        cur = shared.latest_for(oid)
        if cur is not None and cur.t >= t:
            continue
        batch.append(
            Observation(
                id=oid,
                source=fx.source,
                t=t,
                lon=fx.lon,
                lat=fx.lat,
                emits_kind="vessel",
                attrs={
                    "mmsi": fx.mmsi,
                    "name": ais_firehose._name_by_mmsi.get(fx.mmsi),
                    "sog": fx.sog,
                    "cog": fx.cog,
                    "heading": fx.heading,
                    "shipType": code
                    if code is not None
                    else ais_routes._ship_type_by_mmsi.get(fx.mmsi),
                    "flag": fx.flag,
                },
            )
        )
    if batch:
        shared.add_many(batch)
    return len(batch)


async def _ingest(fixes: list[providers.Fix]) -> int:
    """merge + mirror in slices, yielding the event loop between them.

    A sweep can carry six figures of fixes; done in one piece that is a visible
    stall on a loop that also drives the 1 s aircraft cycle. Returns the number
    of vessels whose state changed.
    """
    changed = 0
    for i in range(0, len(fixes), _INGEST_SLICE):
        chunk = fixes[i : i + _INGEST_SLICE]
        changed += vessels.merge(chunk)
        _mirror(chunk)
        await asyncio.sleep(0)
    vessels.prune()
    return changed


_INGEST_SLICE = 5000


# ── provider loops ───────────────────────────────────────────────────────────


async def _run_shipxplorer() -> None:
    s = get_settings()
    interval = s.ais_shipxplorer_interval_s
    backoff = interval
    while True:
        try:
            fixes, tel = await providers.fetch_shipxplorer(
                get_client(), s.ais_shipxplorer_url, zoom=s.ais_shipxplorer_zoom
            )
            n = await _ingest(fixes)
            _stats["shipxplorer_vessels"] = len(fixes)
            _stats["shipxplorer_provider_total"] = tel.get("provider_total")
            _stats["last_good_shipxplorer"] = time.time()
            backoff = interval
            log.info(
                "shipxplorer: %d fixes accepted (%d changed), provider total %s",
                len(fixes),
                n,
                tel.get("provider_total"),
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — transient upstream
            _err(e, "shipxplorer")
            backoff = min(backoff * 2, 300.0)
        await asyncio.sleep(max(interval, backoff))


async def _run_openwaters() -> None:
    """World sweep of ais.openwaters.io on its own (slow) cadence.

    The sweep is 342 tiles at concurrency 2 (``ais_openwaters_max_tiles`` /
    ``ais_openwaters_concurrency``), so it takes minutes — hence a longer
    interval than the ShipXplorer poll. Because the store merges
    FRESHNESS-WINS, a stale tile can never displace a newer fix from another
    source; the worst a late sweep can do is re-affirm older positions.
    """
    s = get_settings()
    interval = s.ais_openwaters_interval_s
    backoff = interval
    while True:
        try:
            fixes, tel = await providers.fetch_openwaters_world(
                get_client(),
                max_tiles=s.ais_openwaters_max_tiles,
                concurrency=s.ais_openwaters_concurrency,
            )
            n = await _ingest(fixes)
            _stats["openwaters_vessels"] = tel["uniqueMmsi"]
            _stats["openwaters_tiles"] = tel["tiles"]
            _stats["openwaters_tiles_failed"] = tel["tilesFailed"]
            _stats["openwaters_tiles_truncated"] = tel["tilesTruncated"]
            _stats["openwaters_tiles_split"] = tel["tilesSplit"]
            _stats["openwaters_sweep_complete"] = tel.get("complete", False)
            _stats["last_good_openwaters"] = time.time()
            backoff = interval
            log.info(
                "openwaters: %d unique MMSIs from %d tiles (%d failed, %d truncated), %d changed",
                tel["uniqueMmsi"],
                tel["tiles"],
                tel["tilesFailed"],
                tel["tilesTruncated"],
                n,
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — transient upstream
            _err(e, "openwaters")
            backoff = min(backoff * 2, 1800.0)
        await asyncio.sleep(max(interval, backoff))


# ── VesselFinder: identified vessels + unidentified satellite positions ──────
#
# The (zoom, box) pairs are pinned because the endpoint punishes a wrong one
# SILENTLY. Verified live 2026-10-04 over the Singapore Strait:
#   zoom 11, 4x4 degrees  -> the full set (3 663 vessels; quartering it adds 0)
#   zoom 11, 5x5 degrees  -> 9 vessels, HTTP 200, no error
#   zoom 8, 30x30 degrees -> answered, thinned (the scout pass)
# The scout pass (72 thinned world tiles) is the default tier: measured, it
# returns about 37 000 identified vessels. The detail pass asks for 4-degree
# boxes that already hold a vessel we know of and is opt-in, because sustaining
# it got this address refused (see config.ais_vesselfinder_detail_tiles).
_VF_DETAIL_ZOOM, _VF_DETAIL_DEG = 11, 4.0
_VF_SCOUT_ZOOM, _VF_SCOUT_DEG = 8, 30.0
_VF_SAT_ZOOM = 4  # 12 world tiles, about 10 000 positions


def vesselfinder_boxes(max_tiles: int) -> list[tuple[float, float, float, float]]:
    """4-degree boxes holding at least one known vessel, busiest first."""
    counts: dict[tuple[int, int], int] = {}
    d = _VF_DETAIL_DEG
    for st in vessels.all():
        key = (int(min(st.fix.lon, 179.999) // d), int(min(st.fix.lat, 89.999) // d))
        counts[key] = counts.get(key, 0) + 1
    busiest = sorted(counts, key=lambda k: -counts[k])[:max_tiles]
    return [(cx * d, cy * d, cx * d + d, min(cy * d + d, 90.0)) for cx, cy in busiest]


def _parse_tiles(bodies: list[bytes], zoom: int) -> list[providers.Fix]:
    out: list[providers.Fix] = []
    for b in bodies:
        out.extend(vesselfinder.parse_mp2(b, zoom=zoom))
    return out


def _parse_satellite(bodies: list[bytes]) -> list[dict[str, Any]]:
    seen: dict[tuple[float, float], dict[str, Any]] = {}
    for b in bodies:
        for row in vesselfinder.parse_sfl(b):
            seen[(row["lat"], row["lon"])] = row  # tiles overlap on their edges
    return list(seen.values())


async def _run_vesselfinder() -> None:
    s = get_settings()
    interval = s.ais_vesselfinder_interval_s
    pause = s.ais_vesselfinder_pause_s
    backoff = interval
    await asyncio.sleep(45.0)  # let boot settle; nothing here is urgent
    while True:
        refused = False
        try:
            client = get_client()
            scout_bodies, tel = await vesselfinder.sweep(
                client, "mp2", vesselfinder.tiles(_VF_SCOUT_DEG), _VF_SCOUT_ZOOM, pause_s=pause
            )
            fixes = await asyncio.to_thread(_parse_tiles, scout_bodies, _VF_SCOUT_ZOOM)
            n = await _ingest(fixes)
            refused = tel["aborted"]
            if scout_bodies:
                _stats["vesselfinder_site_total"] = vesselfinder.total_ships(scout_bodies[0])

            if s.ais_vesselfinder_satellite_enabled and not refused:
                sat_bodies, sat_tel = await vesselfinder.sweep(
                    client,
                    "sfl",
                    vesselfinder.tiles(60.0, lat0=-78.0, lat1=82.0),
                    _VF_SAT_ZOOM,
                    pause_s=pause,
                )
                refused = sat_tel["aborted"]
                # A partial sweep would make half the oceans look empty, so the
                # previous complete picture is kept until a full one replaces it.
                if sat_tel["complete"] or not satellite["positions"]:
                    rows = await asyncio.to_thread(_parse_satellite, sat_bodies)
                    satellite.update(
                        positions=rows, fetched_at=time.time(), complete=sat_tel["complete"]
                    )
                    _stats["satellite_positions"] = len(rows)

            if s.ais_vesselfinder_detail_tiles > 0 and not refused:
                boxes = vesselfinder_boxes(s.ais_vesselfinder_detail_tiles)
                bodies, dtel = await vesselfinder.sweep(
                    client, "mp2", boxes, _VF_DETAIL_ZOOM, pause_s=pause
                )
                detail = await asyncio.to_thread(_parse_tiles, bodies, _VF_DETAIL_ZOOM)
                n += await _ingest(detail)
                fixes += detail
                refused = dtel["aborted"]
                for k in ("tiles", "tilesFailed", "tilesThrottled", "tilesSkipped"):
                    tel[k] += dtel[k]
                tel["complete"] = tel["complete"] and dtel["complete"]

            _stats["vesselfinder_vessels"] = len({f.mmsi for f in fixes})
            _stats["vesselfinder_tiles"] = tel["tiles"]
            _stats["vesselfinder_tiles_failed"] = tel["tilesFailed"] + tel["tilesSkipped"]
            _stats["vesselfinder_tiles_throttled"] = tel["tilesThrottled"]
            _stats["vesselfinder_sweep_complete"] = tel["complete"]
            if fixes:
                _stats["last_good_vesselfinder"] = time.time()
            log.info(
                "vesselfinder: %d unique MMSIs from %d tiles (%d failed, %d throttled), "
                "%d changed, %d satellite positions",
                _stats["vesselfinder_vessels"],
                tel["tiles"],
                _stats["vesselfinder_tiles_failed"],
                tel["tilesThrottled"],
                n,
                _stats["satellite_positions"],
            )
            # Pushed back on: slow down. Asking again sooner is what earns a block.
            pushed = refused or tel["tilesThrottled"] > 0
            backoff = interval if not pushed else min(backoff * 2, 6 * 3600.0)
            if refused:
                log.warning("vesselfinder is refusing requests; next sweep in %.0f s", backoff)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — transient upstream
            _err(e, "vesselfinder")
            backoff = min(backoff * 2, 6 * 3600.0)
        await asyncio.sleep(max(interval, backoff))


# ── lifecycle ────────────────────────────────────────────────────────────────


def start() -> None:
    """Start the enabled provider loops. Idempotent; no-op when all disabled."""
    s = get_settings()
    # `vessels` is built at import, before settings are worth reading, so the
    # configured cap is applied to the existing instance here.
    vessels._max_fix_age_s = s.ais_pipeline_max_fix_age_s
    if s.ais_shipxplorer_enabled and not _running("shipxplorer"):
        _tasks.append(asyncio.create_task(_run_shipxplorer(), name="ais_pipeline_shipxplorer"))
    if s.ais_openwaters_enabled and not _running("openwaters"):
        _tasks.append(asyncio.create_task(_run_openwaters(), name="ais_pipeline_openwaters"))
    if s.ais_vesselfinder_enabled and not _running("vesselfinder"):
        _tasks.append(asyncio.create_task(_run_vesselfinder(), name="ais_pipeline_vesselfinder"))


def _running(tag: str) -> bool:
    return any(tag in (t.get_name() or "") and not t.done() for t in _tasks)


async def stop() -> None:
    tasks = list(_tasks)
    _tasks.clear()
    for t in tasks:
        t.cancel()
    for t in tasks:
        try:
            await t
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


# ── SAR open-ocean scan ──────────────────────────────────────────────────────


async def sar_scan(
    bbox: tuple[float, float, float, float], *, days: int = 2, limit: int = 3, detect: bool = False
) -> dict[str, Any]:
    """Sentinel-1 scene inventory over a box; with ``detect``, located contacts too."""
    return await sar.scan_aoi(get_client(), vessels, bbox, days=days, limit=limit, detect=detect)
