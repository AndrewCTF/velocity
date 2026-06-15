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
import ssl
import time
from typing import Any

import websockets

from app import ais_firehose
from app.config import get_settings
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
}


def stats() -> dict[str, Any]:
    s = get_settings()
    return {
        **_stats,
        "kystdatahuset_enabled": s.ais_kystdatahuset_enabled,
        "digitraffic_mqtt_enabled": s.ais_digitraffic_mqtt_enabled,
        "coverage": "Norway (Kystdatahuset) + Baltic (Digitraffic) — regional, NOT global",
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
                                backoff = 1.0
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
            log.warning("digitraffic mqtt error, reconnecting in %.0fs: %s", backoff, e)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)


# ── lifecycle ─────────────────────────────────────────────────────────────────


def start() -> None:
    """Start the configured extra keyless AIS sources (no-op when disabled)."""
    s = get_settings()
    if s.ais_kystdatahuset_enabled and not _running("kystdatahuset"):
        _tasks.append(asyncio.create_task(_run_kystdatahuset(), name="ais_kystdatahuset"))
    if s.ais_digitraffic_mqtt_enabled and not _running("digitraffic"):
        _tasks.append(asyncio.create_task(_run_digitraffic_mqtt(), name="ais_digitraffic_mqtt"))


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
