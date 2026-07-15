"""Extra keyless regional AIS sources — Norway Kystdatahuset + Finland Digitraffic.

Both feed the same observation store + ``/ws/ais`` browser broadcast as the
Kystverket NMEA firehose, via :func:`app.ais_firehose.publish_vessel`, so the
vessel layer densifies over Northern Europe with zero API keys.

  * Kystdatahuset (Norway) — REST GeoJSON poll. FeatureCollection of LineStrings
    (recent track per vessel); the last coordinate is the latest fix. ``speed``
    is SOG in KNOTS (AIS 0.1-kn resolution); ``publish_vessel`` masks the
    102.3-kn "not available" sentinel.
  * Digitraffic (Finland/Baltic) — live MQTT 3.1.1 over WSS. We speak the wire
    protocol directly over ``websockets`` (no MQTT dependency): CONNECT →
    SUBSCRIBE ``vessels-v2/+/location`` → decode PUBLISH frames. The MMSI is in
    the topic; the payload is ``{lat, lon, sog, cog, heading, …}`` with ``sog``
    in KNOTS.

There is NO keyless GLOBAL AIS — these are dense regional feeds (Norway +
Baltic). Worldwide vessels still require AISStream (key, on-demand).
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import ssl
import time
from typing import Any

import websockets

from app import ais_firehose
from app.config import get_settings
from app.correlate.types import Observation
from app.routes import ais as ais_routes
from app.upstream import get_client

log = logging.getLogger(__name__)

_KYSTDATAHUSET_URL = "https://kystdatahuset.no/ws/api/ais/realtime/geojson"
_DIGITRAFFIC_MQTT_URL = "wss://meri.digitraffic.fi:443/mqtt"
_DIGITRAFFIC_TOPIC = "vessels-v2/+/location"
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_tasks: list[asyncio.Task[None]] = []
_stats: dict[str, Any] = {
    "kystdatahuset_vessels": 0,
    "digitraffic_connected": False,
    "digitraffic_messages": 0,
    "vesselfinder_vessels": 0,
    "marinetraffic_vessels": 0,
    "myshiptracking_vessels": 0,
    # Age of the sidecar union we last REFUSED, 0 while it is publishing. Non-zero
    # means the feeder's browser is wedged and its ~22k global MMSIs are absent
    # from the union by design, not by accident.
    "myshiptracking_stale_s": 0,
    "shipxplorer_vessels": 0,
}


def stats() -> dict[str, Any]:
    s = get_settings()
    return {
        **_stats,
        "kystdatahuset_enabled": s.ais_kystdatahuset_enabled,
        "digitraffic_mqtt_enabled": s.ais_digitraffic_mqtt_enabled,
        "vesselfinder_sidecar_enabled": s.ais_vesselfinder_sidecar_enabled,
        "marinetraffic_sidecar_enabled": s.ais_marinetraffic_sidecar_enabled,
        "myshiptracking_sidecar_enabled": s.ais_myshiptracking_sidecar_enabled,
        "shipxplorer_enabled": s.ais_shipxplorer_enabled,
        "coverage": (
            "Norway (Kystdatahuset) + Baltic (Digitraffic) regional + "
            "MyShipTracking sidecar (global MMSI-keyed ~22k) + "
            "ShipXplorer direct httpx (global MMSI-keyed ~32k, incl sat AIS) + "
            "MarineTraffic / VesselFinder sidecars when enabled"
        ),
    }


# ── Kystdatahuset (Norway) — REST GeoJSON poll ────────────────────────────────


def _latest_fix(geometry: dict[str, Any]) -> tuple[float, float] | None:
    """Return ``(lon, lat)`` of the latest fix from a GeoJSON geometry."""
    coords = geometry.get("coordinates")
    gtype = geometry.get("type")
    if gtype == "Point" and isinstance(coords, list) and len(coords) >= 2:
        return float(coords[0]), float(coords[1])
    if gtype == "LineString" and isinstance(coords, list) and coords:
        last = coords[-1]
        if isinstance(last, list) and len(last) >= 2:
            return float(last[0]), float(last[1])
    return None


async def _publish_kystdatahuset_features(features: list[dict[str, Any]]) -> int:
    """Publish every vessel feature; returns the count published. Testable offline."""
    published = 0
    for feat in features:
        try:
            geom = feat.get("geometry") or {}
            fix = _latest_fix(geom)
            if fix is None:
                continue
            lon, lat = fix
            props = feat.get("properties") or {}
            mmsi = props.get("mmsi")
            if mmsi is None:
                continue
            ok = await ais_firehose.publish_vessel(
                mmsi,
                lat,
                lon,
                sog=props.get("speed"),
                cog=props.get("cog"),
                heading=props.get("true_heading"),
                name=props.get("ship_name"),
                ship_type=props.get("ship_type"),
                source="kystdatahuset",
            )
            published += int(ok)
        except Exception:  # noqa: BLE001 — never let one bad feature stop the poll
            continue
    return published


async def _run_kystdatahuset() -> None:
    interval = get_settings().ais_kystdatahuset_interval_s
    client = get_client()
    backoff = interval
    while True:
        try:
            r = await client.get(
                _KYSTDATAHUSET_URL,
                headers={"User-Agent": _UA, "Accept": "application/json"},
                timeout=30.0,
            )
            if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                features = (r.json().get("features")) or []
                n = await _publish_kystdatahuset_features(features)
                _stats["kystdatahuset_vessels"] = n
                backoff = interval
            else:
                backoff = min(backoff * 2, 600.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("kystdatahuset poll error: %s", e)
            backoff = min(backoff * 2, 600.0)
        await asyncio.sleep(max(interval, backoff))


# ── Digitraffic (Finland/Baltic) — minimal MQTT 3.1.1 over WSS ─────────────────


def _enc_remaining_length(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n > 0:
            b |= 0x80
        out.append(b)
        if n == 0:
            break
    return bytes(out)


def _connect_packet(client_id: str = "osint-geoint") -> bytes:
    # variable header: proto name "MQTT", level 4, clean-session flag, keepalive 60
    vh = b"\x00\x04MQTT\x04\x02\x00\x3c"
    payload = len(client_id).to_bytes(2, "big") + client_id.encode()
    body = vh + payload
    return b"\x10" + _enc_remaining_length(len(body)) + body


def _subscribe_packet(topic: str, packet_id: int = 1) -> bytes:
    body = packet_id.to_bytes(2, "big") + len(topic).to_bytes(2, "big") + topic.encode() + b"\x00"
    return b"\x82" + _enc_remaining_length(len(body)) + body


def _parse_packets(buf: bytes) -> tuple[list[tuple[int, int, bytes]], bytes]:
    """Parse complete MQTT packets from ``buf``.

    Returns ``([(packet_type, byte0, body), …], remainder)``. A WS frame may
    carry partial / multiple MQTT packets, so the caller accumulates the
    remainder across reads.
    """
    out: list[tuple[int, int, bytes]] = []
    i, n = 0, len(buf)
    while i < n:
        b0 = buf[i]
        ptype = b0 >> 4
        mult, rl, j = 1, 0, i + 1
        while True:
            if j >= n:
                return out, buf[i:]  # length incomplete
            d = buf[j]
            rl += (d & 0x7F) * mult
            mult *= 128
            j += 1
            if not (d & 0x80):
                break
            if mult > 128**4:
                return out, b""  # malformed; drop
        if j + rl > n:
            return out, buf[i:]  # body incomplete
        out.append((ptype, b0, buf[j : j + rl]))
        i = j + rl
    return out, b""


def _decode_publish(byte0: int, body: bytes) -> tuple[str, bytes] | None:
    """Extract ``(topic, payload)`` from a PUBLISH packet body."""
    if len(body) < 2:
        return None
    qos = (byte0 >> 1) & 3
    tlen = int.from_bytes(body[0:2], "big")
    if len(body) < 2 + tlen:
        return None
    topic = body[2 : 2 + tlen].decode("utf-8", "replace")
    off = 2 + tlen + (2 if qos > 0 else 0)
    return topic, body[off:]


async def _handle_publish(topic: str, payload: bytes) -> None:
    # topic: vessels-v2/<mmsi>/location
    parts = topic.split("/")
    if len(parts) < 2:
        return
    mmsi = parts[1]
    try:
        d = json.loads(payload)
    except Exception:  # noqa: BLE001
        return
    if d.get("lat") is None or d.get("lon") is None:
        return
    await ais_firehose.publish_vessel(
        mmsi,
        d.get("lat"),
        d.get("lon"),
        sog=d.get("sog"),
        cog=d.get("cog"),
        heading=d.get("heading"),
        source="digitraffic",
    )


async def _run_digitraffic_mqtt() -> None:
    backoff = 1.0
    while True:
        session_up_at: float | None = None  # set on SUBACK; gates the backoff reset
        try:
            ctx = ssl.create_default_context()
            async with websockets.connect(
                _DIGITRAFFIC_MQTT_URL, subprotocols=["mqtt"], ssl=ctx, ping_interval=None
            ) as ws:
                await ws.send(_connect_packet())
                buf = b""
                subscribed = False
                last_send = time.monotonic()
                while True:
                    # Wake at least every 25 s to send a PINGREQ (keepalive 60 s).
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=25.0)
                        buf += msg if isinstance(msg, bytes) else msg.encode()
                        packets, buf = _parse_packets(buf)
                        for ptype, b0, body in packets:
                            if ptype == 2:  # CONNACK
                                if len(body) > 1 and body[1] == 0 and not subscribed:
                                    await ws.send(_subscribe_packet(_DIGITRAFFIC_TOPIC))
                                    last_send = time.monotonic()
                                    _stats["digitraffic_connected"] = True
                            elif ptype == 9:  # SUBACK
                                subscribed = True
                                # Do NOT reset backoff here. Digitraffic SUBACKs
                                # then 429-drops us seconds later; resetting on
                                # every micro-session was the 1/2/4s reconnect
                                # spam. Only a session that SURVIVES clears it.
                                session_up_at = time.monotonic()
                            elif ptype == 3:  # PUBLISH
                                pub = _decode_publish(b0, body)
                                if pub is not None:
                                    _stats["digitraffic_messages"] += 1
                                    await _handle_publish(*pub)
                    except TimeoutError:
                        pass
                    if time.monotonic() - last_send > 25.0:
                        await ws.send(b"\xc0\x00")  # PINGREQ
                        last_send = time.monotonic()
        except asyncio.CancelledError:
            _stats["digitraffic_connected"] = False
            raise
        except Exception as e:  # noqa: BLE001
            _stats["digitraffic_connected"] = False
            # Reset to fast retry only after a session that stayed up long enough
            # to be real (>60s); otherwise keep doubling so a 429-storm backs off
            # to minutes instead of hammering once a second.
            if session_up_at is not None and time.monotonic() - session_up_at > 60.0:
                backoff = 1.0
            delay = backoff * (0.5 + random.random())  # jitter: avoid lockstep retry
            log.warning("digitraffic mqtt error, reconnecting in %.0fs: %s", delay, e)
            await asyncio.sleep(delay)
            backoff = min(backoff * 2, 300.0)


# ── VesselFinder headless sidecar (keyless GLOBAL) — poll vessels.json ─────────


def _publish_vesselfinder(vessels: list[dict[str, Any]]) -> int:
    """Bulk-load sidecar vessels into the observation store. Testable offline.

    NOT routed through ais_firehose.publish_vessel per-vessel: that does a
    /ws/ais broadcast + a history write on EVERY call, which at ~21k vessels per
    cycle measured ~23s of event-loop work AND would flood /ws/ais with unchanged
    fixes. The sidecar's vessels render via the snapshot POLL layer
    (/api/maritime/snapshot reads store.latest("vessel")), so we write the store
    ONCE via add_many (evict-once) and refresh the shared MMSI→name cache so
    labels resolve. Only mmsi/lat/lon/name are carried — sog/cog/heading/type
    stay None (the packed payload's remaining bytes aren't identified, and we
    don't guess); shipType is backfilled from the cross-source cache when another
    feed has already typed that MMSI, so the icon category survives.
    """
    now = time.time()
    batch: list[Observation] = []
    for v in vessels:
        try:
            mmsi = int(v["mmsi"])
            lat = float(v["lat"])
            lon = float(v["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        name = v.get("name")
        if name:
            ais_firehose._remember_name(mmsi, name)
        batch.append(
            Observation(
                id=f"vessel:{mmsi}",
                source="vesselfinder",
                t=now,
                lon=lon,
                lat=lat,
                emits_kind="vessel",
                attrs={
                    "mmsi": mmsi,
                    "name": ais_firehose._name_by_mmsi.get(mmsi),
                    "sog": None,
                    "cog": None,
                    "heading": None,
                    "shipType": ais_routes._ship_type_by_mmsi.get(mmsi),
                },
            )
        )
    if batch:
        ais_firehose.store.add_many(batch)
    return len(batch)


async def _run_vesselfinder_sidecar() -> None:
    s = get_settings()
    interval = s.ais_vesselfinder_sidecar_interval_s
    url = s.ais_vesselfinder_sidecar_url
    client = get_client()
    backoff = interval
    while True:
        try:
            r = await client.get(url, timeout=60.0)
            if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                vessels = (r.json().get("vessels")) or []
                n = _publish_vesselfinder(vessels)
                _stats["vesselfinder_vessels"] = n
                backoff = interval
            else:
                backoff = min(backoff * 2, 300.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — sidecar may be cold/booting; retry
            log.warning("vesselfinder sidecar poll error: %s", e)
            backoff = min(backoff * 2, 300.0)
        await asyncio.sleep(max(interval, backoff))


# ── MarineTraffic headless sidecar (keyless GLOBAL, primary) — poll vessels.json ─


def _publish_marinetraffic(vessels: list[dict[str, Any]]) -> int:
    """Bulk-load MarineTraffic sidecar vessels into the observation store.

    Same bulk (add_many, not per-vessel publish_vessel) contract as
    :func:`_publish_vesselfinder` — the vessels render via the snapshot POLL layer
    (/api/maritime/snapshot), so a per-vessel /ws/ais broadcast + history write on
    ~15k vessels would waste seconds of event-loop time for no gain.

    MarineTraffic carries NO MMSI in its tile payload (only its own SHIP_ID), so
    these are keyed under a distinct id namespace ``vessel:mt-<ship_id>`` and are
    NOT deduped against the MMSI-keyed feeds. Unlike VesselFinder it DOES carry
    sog/cog/heading/shipType, so those flow straight through to the icon + panel.
    """
    now = time.time()
    batch: list[Observation] = []
    for v in vessels:
        try:
            ship_id = str(v["ship_id"])
            lat = float(v["lat"])
            lon = float(v["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not ship_id or not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        batch.append(
            Observation(
                id=f"vessel:mt-{ship_id}",
                source="marinetraffic",
                t=now,
                lon=lon,
                lat=lat,
                emits_kind="vessel",
                attrs={
                    "mmsi": None,
                    "shipId": ship_id,
                    "name": v.get("name"),
                    "sog": v.get("sog"),
                    "cog": v.get("cog"),
                    "heading": v.get("heading"),
                    "shipType": v.get("shipType"),
                    "flag": v.get("flag"),
                    "length": v.get("length"),
                    "destination": v.get("destination"),
                },
            )
        )
    if batch:
        ais_firehose.store.add_many(batch)
    return len(batch)


async def _run_marinetraffic_sidecar() -> None:
    s = get_settings()
    interval = s.ais_marinetraffic_sidecar_interval_s
    url = s.ais_marinetraffic_sidecar_url
    client = get_client()
    backoff = interval
    while True:
        try:
            r = await client.get(url, timeout=60.0)
            if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                vessels = (r.json().get("vessels")) or []
                n = _publish_marinetraffic(vessels)
                _stats["marinetraffic_vessels"] = n
                backoff = interval
            else:
                backoff = min(backoff * 2, 300.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — sidecar may be cold/booting; retry
            log.warning("marinetraffic sidecar poll error: %s", e)
            backoff = min(backoff * 2, 300.0)
        await asyncio.sleep(max(interval, backoff))


# ── MyShipTracking headless sidecar (keyless GLOBAL, MMSI-keyed primary) ────────


def _publish_myshiptracking(
    vessels: list[dict[str, Any]], obs_t: float | None = None
) -> int:
    """Bulk-load MyShipTracking sidecar vessels into the observation store.

    Same bulk (add_many) contract as the other sidecars. Unlike MarineTraffic,
    MyShipTracking carries a real 9-digit MMSI, so vessels key on the STANDARD
    ``vessel:<mmsi>`` id and dedup (freshest-wins) against Digitraffic/Kystdatahuset
    and any other MMSI feed. Carries sog/cog/name; shipType is left None and
    backfilled from the cross-source cache when another feed has typed that MMSI
    (MyShipTracking's row type code is its own taxonomy, not the AIS numeric type
    the icon dispatch expects, so we don't guess it).

    ``obs_t`` is the sidecar's ``last_good`` — when its last world sweep actually
    landed. Pass it: the sidecar keeps serving the previous union when the site
    blocks it, so wall-clock ``now`` would stamp a frozen cache as a live fix and
    it would then out-rank real fixes AND never age out of retention. None (a
    pre-``last_good`` sidecar) falls back to now.
    """
    now = obs_t if obs_t is not None else time.time()
    batch: list[Observation] = []
    for v in vessels:
        try:
            mmsi = int(v["mmsi"])
            lat = float(v["lat"])
            lon = float(v["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        name = v.get("name")
        if name:
            ais_firehose._remember_name(mmsi, name)
        batch.append(
            Observation(
                id=f"vessel:{mmsi}",
                source="myshiptracking",
                t=now,
                lon=lon,
                lat=lat,
                emits_kind="vessel",
                attrs={
                    "mmsi": mmsi,
                    "name": ais_firehose._name_by_mmsi.get(mmsi),
                    "sog": v.get("sog"),
                    "cog": v.get("cog"),
                    "heading": None,
                    "shipType": ais_routes._ship_type_by_mmsi.get(mmsi),
                },
            )
        )
    if batch:
        ais_firehose.store.add_many(batch)
    return len(batch)


def _myshiptracking_stale_age(body: dict[str, Any], cap: float) -> float | None:
    """Age of the sidecar's union, but only when it is too old to publish.

    The feeder keeps serving its last successful world sweep when the site stops
    answering its browser, and its ``now`` is the SERVE time — so a wedged sidecar
    advertises an hour-old union as current. ``last_good`` is the honest stamp.

    Returns None (→ publish) when the union is within ``cap``, or when the sidecar
    predates ``last_good`` and we genuinely cannot tell its age.
    """
    last_good = body.get("last_good")
    if not isinstance(last_good, (int, float)) or last_good <= 0:
        return None
    age = time.time() - float(last_good)
    return age if age > cap else None


async def _run_myshiptracking_sidecar() -> None:
    s = get_settings()
    interval = s.ais_myshiptracking_sidecar_interval_s
    url = s.ais_myshiptracking_sidecar_url
    client = get_client()
    backoff = interval
    while True:
        try:
            r = await client.get(url, timeout=60.0)
            if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                body = r.json()
                vessels = body.get("vessels") or []
                stale = _myshiptracking_stale_age(body, s.ais_myshiptracking_sidecar_max_age_s)
                if stale is not None:
                    # The sidecar's browser lost the site and is replaying its last
                    # union. Go SILENT rather than republish it: the store keys on
                    # vessel:<mmsi>, so a stale global tier would overwrite the live
                    # fix ShipXplorer/AISStream/Digitraffic just wrote for that same
                    # MMSI, and re-stamping it every poll would pin it in retention
                    # forever. Silence lets the frozen fixes age out and the live
                    # sources take the MMSI back.
                    _stats["myshiptracking_vessels"] = 0
                    _stats["myshiptracking_stale_s"] = int(stale)
                    log.warning(
                        "myshiptracking sidecar stale (%ds old, cap %gs) — not publishing "
                        "%d cached vessels",
                        int(stale), s.ais_myshiptracking_sidecar_max_age_s, len(vessels),
                    )
                else:
                    n = _publish_myshiptracking(vessels, body.get("last_good"))
                    _stats["myshiptracking_vessels"] = n
                    _stats["myshiptracking_stale_s"] = 0
                backoff = interval
            else:
                backoff = min(backoff * 2, 300.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — sidecar may be cold/booting; retry
            log.warning("myshiptracking sidecar poll error: %s", e)
            backoff = min(backoff * 2, 300.0)
        await asyncio.sleep(max(interval, backoff))


# ── ShipXplorer DIRECT httpx (keyless GLOBAL, no browser sidecar) ───────────────

# data.shipxplorer.com/live answers a plain httpx GET as long as the browser-ish
# Referer/Origin are present; a bare client 500s. NOT Cloudflare-gated.
_SHIPXPLORER_HEADERS = {
    "user-agent": _UA,
    "accept": "application/json, text/plain, */*",
    "referer": "https://www.shipxplorer.com/",
    "origin": "https://www.shipxplorer.com",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
}
_SHIPXPLORER_TYPES = [
    "CARGO", "FISHING", "HSC", "OTHER", "PASSENGER",
    "PLEASURE", "SAILING", "TANKER", "TUG", "UNKNOWN",
]
# Row layout of each vessel array in the /live response (validated live 2026-07-05):
#   [0]=? [1]=lat [2]=lon [3]=last_ts_ms [4]=? [5]=sog [6]="AIS"/"SAT"
#   [7]=typeName [8]=MMSI(int) [9]=? [10]=status ...
_SX_LAT, _SX_LON, _SX_SOG, _SX_MMSI = 1, 2, 5, 8


def _parse_shipxplorer(payload: Any) -> list[dict[str, Any]]:
    """Parse a ShipXplorer /live body into vessel dicts. Testable offline.

    The body is a JSON list ``[vesselsById, {"total":N,...}, [], {}]`` where
    ``vesselsById`` maps a ShipXplorer id -> a positional attribute array. We only
    trust rows with a valid 9-digit MMSI + in-range lat/lon, so a schema drift
    thins the feed toward zero rather than emitting garbage.
    """
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
        return []
    out: list[dict[str, Any]] = []
    for a in payload[0].values():
        if not isinstance(a, list) or len(a) <= _SX_MMSI:
            continue
        mmsi = a[_SX_MMSI]
        lat = a[_SX_LAT]
        lon = a[_SX_LON]
        if not isinstance(mmsi, int) or mmsi < 100000000 or mmsi >= 1000000000:
            continue
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        sog = a[_SX_SOG] if len(a) > _SX_SOG else None
        out.append({
            "mmsi": mmsi,
            "lat": float(lat),
            "lon": float(lon),
            "sog": sog if isinstance(sog, (int, float)) else None,
        })
    return out


def _publish_shipxplorer(vessels: list[dict[str, Any]]) -> int:
    """Bulk-load ShipXplorer vessels into the store (MMSI-keyed, dedups)."""
    now = time.time()
    batch: list[Observation] = []
    for v in vessels:
        try:
            mmsi = int(v["mmsi"])
            lat = float(v["lat"])
            lon = float(v["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        batch.append(
            Observation(
                id=f"vessel:{mmsi}",
                source="shipxplorer",
                t=now,
                lon=lon,
                lat=lat,
                emits_kind="vessel",
                attrs={
                    "mmsi": mmsi,
                    "name": ais_firehose._name_by_mmsi.get(mmsi),
                    "sog": v.get("sog"),
                    "cog": None,
                    "heading": None,
                    "shipType": ais_routes._ship_type_by_mmsi.get(mmsi),
                },
            )
        )
    if batch:
        ais_firehose.store.add_many(batch)
    return len(batch)


async def _fetch_shipxplorer() -> list[dict[str, Any]]:
    """One world-bbox pull (zoom 6 returns the full ~32k set uncapped)."""
    s = get_settings()
    params = [
        ("vessel", ""), ("port", ""), ("zoom", str(s.ais_shipxplorer_zoom)),
        ("vesselid", ""), ("bounds", "85,180,-85,-180"), ("timestamp", "false"),
        ("lastReport", "3600"), ("designator", "iata"), ("os", "web"),
        ("ais", "true"), ("sate", "true"),
    ] + [("types[]", t) for t in _SHIPXPLORER_TYPES]
    r = await get_client().get(
        s.ais_shipxplorer_url, params=params, headers=_SHIPXPLORER_HEADERS, timeout=30.0
    )
    if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
        return []
    return _parse_shipxplorer(r.json())


async def _run_shipxplorer() -> None:
    s = get_settings()
    interval = s.ais_shipxplorer_interval_s
    backoff = interval
    while True:
        try:
            vessels = await _fetch_shipxplorer()
            n = _publish_shipxplorer(vessels)
            _stats["shipxplorer_vessels"] = n
            backoff = interval if n else min(backoff * 2, 300.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — transient upstream; retry
            log.warning("shipxplorer poll error: %s", e)
            backoff = min(backoff * 2, 300.0)
        await asyncio.sleep(max(interval, backoff))


# ── lifecycle ─────────────────────────────────────────────────────────────────


def start() -> None:
    """Start the configured extra keyless AIS sources (no-op when disabled)."""
    s = get_settings()
    if s.ais_kystdatahuset_enabled and not _running("kystdatahuset"):
        _tasks.append(asyncio.create_task(_run_kystdatahuset(), name="ais_kystdatahuset"))
    if s.ais_digitraffic_mqtt_enabled and not _running("digitraffic"):
        _tasks.append(asyncio.create_task(_run_digitraffic_mqtt(), name="ais_digitraffic_mqtt"))
    if s.ais_vesselfinder_sidecar_enabled and not _running("vesselfinder"):
        _tasks.append(
            asyncio.create_task(_run_vesselfinder_sidecar(), name="ais_vesselfinder_sidecar")
        )
    if s.ais_marinetraffic_sidecar_enabled and not _running("marinetraffic"):
        _tasks.append(
            asyncio.create_task(_run_marinetraffic_sidecar(), name="ais_marinetraffic_sidecar")
        )
    if s.ais_myshiptracking_sidecar_enabled and not _running("myshiptracking"):
        _tasks.append(
            asyncio.create_task(_run_myshiptracking_sidecar(), name="ais_myshiptracking_sidecar")
        )
    if s.ais_shipxplorer_enabled and not _running("shipxplorer"):
        _tasks.append(asyncio.create_task(_run_shipxplorer(), name="ais_shipxplorer"))


def _running(tag: str) -> bool:
    return any(tag in (t.get_name() or "") and not t.done() for t in _tasks)


async def stop() -> None:
    """Cancel all extra AIS tasks; safe when none are running."""
    tasks = list(_tasks)
    _tasks.clear()
    for t in tasks:
        t.cancel()
    for t in tasks:
        try:
            await t
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
