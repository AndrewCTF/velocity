"""Background correlation runner.

Polls the (already-cached) /api/aviation/states and /api/adsb/live/emergencies
endpoints in-process, ingests into the Observation store, runs rules, and
publishes alerts to the bus. Started by FastAPI's lifespan.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

import httpx

from app.config import get_settings
from app.correlate.bus import JAMMING_RECENT, bus
from app.correlate.rules import (
    emergency_squawk,
    gps_jam_cluster,
    major_quake,
    proximity_mil_vessel,
)
from app.correlate.store import store
from app.correlate.types import Alert, Observation
from app.ingest.opensky import OpenSkyTokenManager, fetch_states
from app.upstream import get_client

log = logging.getLogger(__name__)

# To avoid alert spam we dedupe by (rule_id, key) for a cool-down window
_seen: dict[str, float] = {}
_DEDUP_SEC = 600.0


def _dedupe(key: str) -> bool:
    now = time.time()
    last = _seen.get(key)
    if last and now - last < _DEDUP_SEC:
        return True
    _seen[key] = now
    # opportunistic prune
    if len(_seen) > 10_000:
        cutoff = now - _DEDUP_SEC
        for k, t in list(_seen.items()):
            if t < cutoff:
                _seen.pop(k, None)
    return False


def _aircraft_obs_from_geojson(fc: dict[str, Any], source: str) -> list[Observation]:
    out: list[Observation] = []
    now = time.time()
    for f in fc.get("features") or []:
        coords = (f.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        props = f.get("properties") or {}
        out.append(
            Observation(
                id=str(f.get("id") or ""),
                source=source,
                t=now,
                lon=float(coords[0]),
                lat=float(coords[1]),
                emits_kind="aircraft",
                attrs={
                    "callsign": props.get("callsign"),
                    "icao24": props.get("icao24"),
                    "squawk": props.get("squawk"),
                    "source": source,
                    "on_ground": props.get("on_ground"),
                    # GNSS integrity flags — pulled through so the
                    # gps_jam_cluster rule can bucket on them.
                    "nac_p": props.get("nac_p"),
                    "nic": props.get("nic"),
                },
            )
        )
    return out


async def _opensky_loop(stop: asyncio.Event) -> None:
    """Authed-only OpenSky ingest.

    HARD-GATED on configured OAuth creds. Running this anonymously would
    burn the same per-IP ~400-credit/day budget that `routes.adsb`'s paced
    breadth tier (`_opensky_cached`) depends on — draining it ~3x faster and
    blanking the global aircraft count hours earlier. Anonymous deployments
    already get OpenSky data via `_global_loop`'s adsb_global ingest.
    """
    s = get_settings()
    tm = OpenSkyTokenManager(s.opensky_client_id, s.opensky_client_secret)
    if not tm.enabled:
        return
    backoff = 0.0
    while not stop.is_set():
        try:
            raw = await fetch_states(tm, None)
            obs = _aircraft_obs_from_geojson(_states_to_fc(raw), "opensky")
            store.add_many(obs)
            backoff = 0.0
        except httpx.HTTPStatusError as e:
            # 429 = credit budget exhausted; back off exponentially (capped)
            # instead of hammering a host that is refusing us every 30 s.
            if e.response is not None and e.response.status_code == 429:
                backoff = min(backoff * 2 + 30.0, 900.0)
            log.debug("opensky loop status: %s", e)
        except httpx.HTTPError as e:
            log.debug("opensky loop transient: %s", e)
        await asyncio.sleep(30 + backoff)


def _states_to_fc(raw: dict[str, Any]) -> dict[str, Any]:
    # Inline conversion to avoid import cycle with the route module.
    feats: list[dict[str, Any]] = []
    for s in raw.get("states") or []:
        if not s or s[5] is None or s[6] is None:
            continue
        feats.append(
            {
                "type": "Feature",
                "id": f"aircraft:{s[0]}",
                "geometry": {"type": "Point", "coordinates": [float(s[5]), float(s[6])]},
                "properties": {
                    "callsign": (s[1] or "").strip() or None,
                    "icao24": s[0],
                    "squawk": s[14],
                    "on_ground": bool(s[8]),
                },
            }
        )
    return {"type": "FeatureCollection", "features": feats}


async def _mil_loop(stop: asyncio.Event) -> None:
    """Poll airplanes.live /v2/mil into the store as `source=adsb_mil`.

    Uses the shared `get_client()` connection pool from `app.upstream` rather
    than spinning up a fresh AsyncClient each iteration — TCP/TLS handshake
    setup-and-teardown every 30s is wasted work, and a single long-lived pool
    means connection reuse + HTTP/2 keep-alive across all background loops.
    """
    while not stop.is_set():
        try:
            client = get_client()
            r = await client.get("https://api.airplanes.live/v2/mil", timeout=15.0)
            if r.status_code == 200:
                j = r.json()
                fc = {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "id": f"aircraft:{a.get('hex')}",
                            "geometry": {
                                "type": "Point",
                                "coordinates": [a.get("lon"), a.get("lat")],
                            },
                            "properties": {
                                "icao24": a.get("hex"),
                                "callsign": (a.get("flight") or "").strip() or None,
                                "squawk": a.get("squawk"),
                                "registration": a.get("r"),
                                "type": a.get("t"),
                            },
                        }
                        for a in (j.get("ac") or [])
                        if a.get("lon") is not None and a.get("lat") is not None
                    ],
                }
                obs = _aircraft_obs_from_geojson(fc, "adsb_mil")
                store.add_many(obs)
        except httpx.HTTPError as e:
            log.debug("mil_loop transient: %s", e)
        await asyncio.sleep(30)


async def _global_loop(stop: asyncio.Event) -> None:
    """Re-ingests the multi-source global ADS-B feed into the store so
    proximity_mil_vessel and other cross-domain rules have a population to
    work with. Calls the route function directly — no HTTP loopback —
    avoiding the auth middleware self-DoS when API_KEY is set.
    """
    # Import here to avoid a circular import at module load (routes.adsb
    # imports from app.upstream, which imports nothing from us).
    from app.routes.adsb import global_snapshot  # noqa: PLC0415

    # Boot warmup: don't fire the heavy global fan-out the instant the app
    # starts. Lets the event loop finish booting before the first ~13k-aircraft
    # ingest, avoids a cold-start upstream stampede, and keeps fast unit tests
    # isolated from this background loop's HTTP traffic.
    await asyncio.sleep(2)

    while not stop.is_set():
        try:
            fc = await global_snapshot()
            obs = _aircraft_obs_from_geojson(fc, "adsb_global")
            store.add_many(obs)
        except Exception as e:  # noqa: BLE001
            log.debug("global_loop transient: %s", e)
        # Align with the adsb_global 1 s merge-cache TTL: re-ingest every 2 s
        # so the observation store stays inside the 2 s end-to-end refresh
        # budget. Every other tick is a cheap merge-cache hit, the rest fan
        # out to the cell cache — neither path touches upstream when polls
        # arrive faster than the cell TTL.
        await asyncio.sleep(2)


async def _quake_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(
                    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
                )
                if r.status_code == 200:
                    j = r.json()
                    now = time.time()
                    batch = []
                    for f in j.get("features", []) or []:
                        coords = (f.get("geometry") or {}).get("coordinates") or [None, None, None]
                        if coords[0] is None or coords[1] is None:
                            continue
                        p = f.get("properties") or {}
                        batch.append(
                            Observation(
                                id=f"quake:{f.get('id')}",
                                source="usgs",
                                t=(p.get("time") or now * 1000) / 1000.0,
                                lon=float(coords[0]),
                                lat=float(coords[1]),
                                emits_kind="quake",
                                attrs={
                                    "mag": p.get("mag"),
                                    "place": p.get("place"),
                                    "alert": p.get("alert"),
                                    "tsunami": bool(p.get("tsunami")),
                                    "source": "usgs",
                                },
                            )
                        )
                    if batch:
                        store.add_many(batch)
        except httpx.HTTPError as e:
            log.debug("quake_loop transient: %s", e)
        await asyncio.sleep(120)


async def _emerg_loop(stop: asyncio.Event) -> None:
    # Reuse the shared client pool (`get_client()` from app.upstream) instead
    # of spinning a fresh AsyncClient each tick — see `_mil_loop` rationale.
    while not stop.is_set():
        try:
            client = get_client()
            for code in ("7500", "7600", "7700"):
                r = await client.get(
                    f"https://api.airplanes.live/v2/squawk/{code}", timeout=15.0
                )
                if r.status_code != 200:
                    continue
                j = r.json()
                fc = {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "id": f"aircraft:{a.get('hex')}",
                            "geometry": {
                                "type": "Point",
                                "coordinates": [a.get("lon"), a.get("lat")],
                            },
                            "properties": {
                                "icao24": a.get("hex"),
                                "callsign": (a.get("flight") or "").strip() or None,
                                "squawk": code,
                            },
                        }
                        for a in (j.get("ac") or [])
                        if a.get("lon") is not None and a.get("lat") is not None
                    ],
                }
                obs = _aircraft_obs_from_geojson(fc, "airplanes_live")
                store.add_many(obs)
        except httpx.HTTPError as e:
            log.debug("emerg loop transient: %s", e)
        await asyncio.sleep(30)


async def _rule_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            # Aircraft-only rules — short window for emergency squawks.
            ac_window = store.window(seconds=300, kinds={"aircraft"})
            for alert in emergency_squawk(ac_window):
                _publish(alert)

            # Cross-domain rules — wider window so a vessel fix can correlate
            # with a more recent military aircraft fix.
            mixed = store.window(seconds=900, kinds={"aircraft", "vessel"})
            for alert in proximity_mil_vessel(mixed):
                _publish(alert)

            # Quakes
            q_window = store.window(seconds=3600, kinds={"quake"})
            for alert in major_quake(q_window):
                _publish(alert)

            # GPS jamming clusters — routed to a separate ring-buffer so they
            # do NOT appear in the main alerts ticker, drawer, or WS push.
            # The frontend polls /api/jamming/alerts independently.
            for alert in gps_jam_cluster(ac_window):
                _publish_jamming(alert)
        except Exception as e:  # noqa: BLE001
            log.exception("rule_loop: %s", e)
        await asyncio.sleep(10)


async def _incident_watch_loop(stop: asyncio.Event) -> None:
    """Standing watch: every 60 s recompute the GLOBAL cross-domain incident
    brief, record it (building the change-diff + history the /watch and
    /incident-history endpoints serve), and PUSH any new-or-escalated HIGH
    incident to the alert bus so it reaches the command-bar ticker + drawer +
    WS without the operator watching the Intel tab.
    """
    # Lazy imports: keep the intel layer out of the runner's import graph at
    # module load, mirroring the in-process route loopbacks elsewhere here.
    from app.intel import incidents as intel_incidents  # noqa: PLC0415
    from app.intel.incident_store import incident_store  # noqa: PLC0415

    await asyncio.sleep(20)  # let the first global snapshot warm
    while not stop.is_set():
        try:
            b = await intel_incidents.brief(None)
            diff = incident_store.record("global", b["incidents"])
            for inc in diff["new"] + diff["escalated"]:
                if inc.get("threat_level") != "high":
                    continue
                c = inc.get("centroid") or {}
                _publish(
                    Alert(
                        id=str(uuid.uuid4()),
                        rule_id="incident",
                        severity="high",
                        t=time.time(),
                        lon=float(c.get("lon", 0.0)),
                        lat=float(c.get("lat", 0.0)),
                        confidence=0.8,
                        message=inc.get("narrative") or "cross-domain incident",
                        contributing=[inc.get("key") or ""],
                    )
                )
        except Exception as e:  # noqa: BLE001
            log.exception("incident_watch_loop: %s", e)
        await asyncio.sleep(60)


def _publish(alert: object) -> None:
    # Dedupe key uses the set of contributing observation ids (stable across
    # position updates). Critical for proximity rules whose `message` embeds
    # km distance — that would otherwise generate infinite alerts for the
    # same aircraft/vessel pair as the distance changes each tick.
    rule_id = getattr(alert, "rule_id", "?")
    contributing = sorted(getattr(alert, "contributing", []) or [])
    if contributing:
        key = f"{rule_id}:{'|'.join(contributing)}"
    else:
        key = f"{rule_id}:{getattr(alert, 'message', '?')}"
    if _dedupe(key):
        return
    bus.publish(alert)  # type: ignore[arg-type]


def _publish_jamming(alert: object) -> None:
    """Dedupe and stash a gps_jam_cluster alert into the jamming ring-buffer.

    Intentionally does NOT call bus.publish — jamming cluster events are
    surfaced via the dedicated /api/jamming/alerts REST endpoint and must
    NOT appear in the main WS stream, alerts ticker, or alerts drawer.
    """
    rule_id = getattr(alert, "rule_id", "?")
    contributing = sorted(getattr(alert, "contributing", []) or [])
    if contributing:
        key = f"{rule_id}:{'|'.join(contributing)}"
    else:
        key = f"{rule_id}:{getattr(alert, 'message', '?')}"
    if _dedupe(key):
        return
    JAMMING_RECENT.append(alert)  # type: ignore[arg-type]


_tasks: list[asyncio.Task[None]] = []
_stop = asyncio.Event()


def start() -> None:
    if _tasks:
        return
    _stop.clear()
    # OpenSky is opt-in (the loop exits immediately without OAuth creds —
    # see _opensky_loop); the primary feed for aircraft observations is the
    # in-process /api/adsb/global loopback in _global_loop, which fans out
    # airplanes.live + ADSB.lol + the paced anonymous OpenSky breadth tier.
    _tasks.append(asyncio.create_task(_opensky_loop(_stop), name="opensky_loop"))
    _tasks.append(asyncio.create_task(_global_loop(_stop), name="global_loop"))
    _tasks.append(asyncio.create_task(_mil_loop(_stop), name="mil_loop"))
    _tasks.append(asyncio.create_task(_quake_loop(_stop), name="quake_loop"))
    _tasks.append(asyncio.create_task(_emerg_loop(_stop), name="emerg_loop"))
    _tasks.append(asyncio.create_task(_rule_loop(_stop), name="rule_loop"))
    _tasks.append(asyncio.create_task(_incident_watch_loop(_stop), name="incident_watch_loop"))


async def stop_all() -> None:
    _stop.set()
    for t in _tasks:
        t.cancel()
    for t in _tasks:
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    _tasks.clear()
