"""Keyless AIS firehose — Kystverket public NMEA stream (Northern Europe).

The browser AIS layer (``/ws/ais``) normally needs an ``AISSTREAM_KEY``. Norway's
Kystverket publishes an anonymous, unauthenticated AIS NMEA feed over TCP
(``153.44.253.27:5631``) covering Norwegian + adjacent waters at firehose rates.
We connect once, decode with :mod:`pyais` (NMEA TAG-block strip + multipart
reassembly), and feed the SAME observation store + browser broadcast the
AISStream bridge uses (:mod:`app.routes.ais`). Result: vessels appear on the
globe with zero API keys configured.

This complements, not replaces, AISStream: when an ``AISSTREAM_KEY`` is set both
upstreams fan out to the same clients and the freshest fix per MMSI wins.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from pyais import decode

from app.config import get_settings
from app.correlate.store import store
from app.correlate.types import Observation
from app.routes import ais as ais_routes

log = logging.getLogger(__name__)

_task: asyncio.Task[None] | None = None

# Static vessel names arrive on type 5/24 messages; position reports (1/2/3/18)
# don't carry them, so cache by MMSI like ais.py does for ship type.
_name_by_mmsi: dict[int, str] = {}
_NAME_CACHE_MAX = 50_000

# Message types carrying a usable lat/lon fix vs. static voyage data.
_STATIC_TYPES = frozenset({5, 19, 24})  # 19 carries both a fix and static data

# pyais leaves AIS "not available" sentinels in decoded fields.
_HEADING_NA = 511
_SOG_NA = 102.3  # 1023 raw → 102.3 kn
_COG_NA = 360.0

_stats: dict[str, Any] = {
    "connected": False,
    "messages": 0,
    "positions": 0,
    "last_msg_t": None,
}


def stats() -> dict[str, Any]:
    """Firehose health for /api/intel/sources + diagnostics."""
    s = get_settings()
    return {
        **_stats,
        "enabled": s.ais_firehose_enabled,
        "host": f"{s.ais_firehose_host}:{s.ais_firehose_port}",
        "coverage": "Norway + Arctic/North Sea (regional, NOT global)",
        "names_cached": len(_name_by_mmsi),
    }


def _remember_name(mmsi: int, name: str | None) -> None:
    if not name:
        return
    name = name.strip().rstrip("@").strip()  # AIS pads static fields with '@'
    if not name:
        return
    if mmsi not in _name_by_mmsi and len(_name_by_mmsi) >= _NAME_CACHE_MAX:
        _name_by_mmsi.pop(next(iter(_name_by_mmsi)), None)  # FIFO evict
    _name_by_mmsi[mmsi] = name


async def publish_vessel(
    mmsi: Any,
    lat: Any,
    lon: Any,
    *,
    sog: float | None = None,
    cog: float | None = None,
    heading: float | None = None,
    name: str | None = None,
    ship_type: Any = None,
    source: str = "",
) -> bool:
    """Normalize one vessel fix → store + history + browser broadcast.

    Shared by every keyless AIS source (Kystverket NMEA, Kystdatahuset REST,
    Digitraffic MQTT) so they all feed the same /ws/ais layer, observation
    store, and the cross-source name/ship-type caches keyed by MMSI. Returns
    True when a frame was broadcast.
    """
    try:
        mmsi = int(mmsi)
    except (TypeError, ValueError):
        return False
    try:
        latf, lonf = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    if not (-90.0 <= latf <= 90.0) or not (-180.0 <= lonf <= 180.0):
        return False

    if name:
        _remember_name(mmsi, name if isinstance(name, str) else str(name))
    if ship_type is not None:
        try:
            ais_routes._remember_ship_type(mmsi, int(ship_type))
        except (TypeError, ValueError):
            pass

    # Clean AIS "not available" sentinels.
    if isinstance(sog, (int, float)) and sog >= _SOG_NA:
        sog = None
    if isinstance(cog, (int, float)) and cog >= _COG_NA:
        cog = None
    if heading == _HEADING_NA:
        heading = None

    name_out = _name_by_mmsi.get(mmsi)
    ship_type_out = ais_routes._ship_type_by_mmsi.get(mmsi)
    out: dict[str, Any] = {
        "kind": "vessel",
        "id": f"vessel:{mmsi}",
        "mmsi": mmsi,
        "name": name_out,
        "lat": latf,
        "lon": lonf,
        "msgType": None,
        "t": None,
        "shipType": ship_type_out,
        "sog": sog,
        "cog": cog,
        "heading": heading,
        "source": source,
    }
    try:
        store.add(
            Observation(
                id=f"vessel:{mmsi}",
                source=source or "ais",
                t=time.time(),
                lon=lonf,
                lat=latf,
                emits_kind="vessel",
                attrs={
                    "mmsi": mmsi,
                    "name": name_out,
                    "sog": sog,
                    "cog": cog,
                    "heading": heading,
                    "shipType": ship_type_out,
                },
            )
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        from app import history  # noqa: PLC0415

        history.ingest_vessels(
            [{"id": f"vessel:{mmsi}", "lon": lonf, "lat": latf, "cog": cog, "name": name_out}]
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await ais_routes._broadcast(json.dumps(out, separators=(",", ":")))
    except Exception:  # noqa: BLE001
        return False
    return True


def _strip_tag(line: str) -> str:
    r"""Strip a leading NMEA TAG block (``\s:…,c:…*hh\``) before the ``!`` sentence."""
    if line.startswith("\\"):
        end = line.find("\\", 1)
        if end != -1:
            return line[end + 1 :]
    return line


def _handle_sentence(
    sent: str, frag: dict[tuple[str, str, int], dict[int, str]]
) -> dict[str, Any] | None:
    """Reassemble a (possibly multipart) ``!`` sentence and decode it.

    ``frag`` accumulates partial groups across calls; returns the decoded
    ``asdict()`` once a full message is available, else ``None``.
    """
    parts = sent.split(",")
    if len(parts) < 7:
        return None
    try:
        total = int(parts[1])
        idx = int(parts[2])
    except ValueError:
        return None
    gid, chan = parts[3], parts[4]
    if total == 1:
        group = [sent]
    else:
        key = (chan, gid, total)
        frag.setdefault(key, {})[idx] = sent
        if len(frag[key]) < total:
            if len(frag) > 5000:  # guard against unbounded growth on lossy links
                frag.clear()
            return None
        group = [frag[key][i] for i in sorted(frag[key])]
        frag.pop(key, None)
    try:
        return decode(*group).asdict()
    except Exception:  # noqa: BLE001 — malformed/unsupported sentence → skip
        return None


def _emit(d: dict[str, Any]) -> str | None:
    """Turn a decoded AIS dict into a normalized vessel frame, feed the store.

    Returns the JSON frame to broadcast (same schema as ``ais._normalize``), or
    ``None`` when the message has no usable position fix.
    """
    mmsi = d.get("mmsi")
    if mmsi is None:
        return None
    mmsi = int(mmsi)
    mt = d.get("msg_type")

    if mt in _STATIC_TYPES:
        _remember_name(mmsi, d.get("shipname"))
        st = d.get("ship_type")
        if st is not None:
            # pyais returns an IntEnum; store the plain int code (0-99).
            ais_routes._remember_ship_type(mmsi, int(st))

    lat, lon = d.get("lat"), d.get("lon")
    if lat is None or lon is None or lat == 91.0 or lon == 181.0:
        return None
    try:
        latf, lonf = float(lat), float(lon)
    except (TypeError, ValueError):
        return None

    sog = d.get("speed")
    cog = d.get("course")
    heading = d.get("heading")
    if isinstance(sog, (int, float)) and sog >= _SOG_NA:
        sog = None
    if isinstance(cog, (int, float)) and cog >= _COG_NA:
        cog = None
    if heading == _HEADING_NA:
        heading = None

    ship_type = ais_routes._ship_type_by_mmsi.get(mmsi)
    name = _name_by_mmsi.get(mmsi)
    out: dict[str, Any] = {
        "kind": "vessel",
        "id": f"vessel:{mmsi}",
        "mmsi": mmsi,
        "name": name,
        "lat": latf,
        "lon": lonf,
        "msgType": mt,
        "t": None,
        "shipType": ship_type,
        "sog": sog,
        "cog": cog,
        "heading": heading,
        "source": "kystverket",
    }

    # Feed the fusion observation store (same as the AISStream bridge) so
    # correlation rules see keyless vessels too. Never break the loop on error.
    try:
        store.add(
            Observation(
                id=f"vessel:{mmsi}",
                source="kystverket",
                t=time.time(),
                lon=lonf,
                lat=latf,
                emits_kind="vessel",
                attrs={
                    "mmsi": mmsi,
                    "name": name,
                    "sog": sog,
                    "cog": cog,
                    "heading": heading,
                    "shipType": ship_type,
                },
            )
        )
    except Exception:  # noqa: BLE001
        pass

    # Mirror into the history store for replay, if it's running.
    try:
        from app import history  # noqa: PLC0415 — optional, lazy to avoid import cycle

        history.ingest_vessels(
            [{"id": f"vessel:{mmsi}", "lon": lonf, "lat": latf, "cog": cog, "name": name}]
        )
    except Exception:  # noqa: BLE001
        pass

    return json.dumps(out, separators=(",", ":"))


async def _run() -> None:
    s = get_settings()
    host, port = s.ais_firehose_host, s.ais_firehose_port
    frag: dict[tuple[str, str, int], dict[int, str]] = {}
    backoff = 1.0
    while True:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            _stats["connected"] = True
            backoff = 1.0
            log.info("AIS firehose connected to %s:%s", host, port)
            try:
                while True:
                    raw = await reader.readline()
                    if not raw:
                        raise ConnectionError("firehose closed by peer")
                    sent = _strip_tag(raw.decode("ascii", "replace").strip())
                    if not sent.startswith("!"):
                        continue
                    d = _handle_sentence(sent, frag)
                    if d is None:
                        continue
                    _stats["messages"] += 1
                    _stats["last_msg_t"] = time.time()
                    frame = _emit(d)
                    if frame is not None:
                        _stats["positions"] += 1
                        await ais_routes._broadcast(frame)
            finally:
                # Close + drain the socket before reconnecting so the FD is
                # released promptly. wait_closed() can itself raise on an
                # already-broken peer — that's exactly when we're here, so
                # swallow it rather than masking the real error.
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:  # noqa: BLE001
                    pass
        except asyncio.CancelledError:
            _stats["connected"] = False
            raise
        except Exception as e:  # noqa: BLE001
            _stats["connected"] = False
            log.warning("AIS firehose error, reconnecting in %.1fs: %s", backoff, e)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def start() -> None:
    """Start the keyless firehose (no-op when disabled or already running)."""
    global _task
    if not get_settings().ais_firehose_enabled:
        return
    if _task is None or _task.done():
        _task = asyncio.create_task(_run())


async def stop() -> None:
    """Cancel the firehose task; safe when none is running."""
    global _task
    task = _task
    _task = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
