"""MarineTraffic global AIS bridge (PAID, key-gated).

Unlike the keyless Norway/Baltic feeds (which only cover Northern Europe),
MarineTraffic is a commercial provider with GLOBAL coverage — but it needs a
paid API key (``MARINETRAFFIC_KEY``) and typically IP-whitelists the servers
that may use it. Off unless a key is set; when on, it polls the configured
export endpoint and feeds the SAME vessel store + ``/ws/ais`` broadcast as every
other source, via :func:`app.ais_firehose.publish_vessel`, so MarineTraffic
vessels appear on the map identically to the keyless ones.

The export URL is configurable (``MARINETRAFFIC_URL``) because the exact path /
parameters depend on your MarineTraffic plan (e.g. ``exportvessels`` PS07 area
export). The default targets the ``jsono`` (array-of-objects) protocol; the
parser also tolerates a positional-array response. NOTE: MarineTraffic, like the
other aggregators, may refuse datacenter egress — probe reachability from the
deployment host before relying on it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app import ais_firehose
from app.config import get_settings
from app.upstream import get_client

log = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_task: asyncio.Task[None] | None = None
_stats: dict[str, Any] = {"enabled": False, "vessels": 0, "last_error": None}


def stats() -> dict[str, Any]:
    return dict(_stats)


def _num(v: Any) -> float | None:
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _get(row: dict[str, Any], *keys: str) -> Any:
    """First present value among `keys` (case-insensitive MarineTraffic fields)."""
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    lower = {str(k).lower(): val for k, val in row.items()}
    for k in keys:
        v = lower.get(k.lower())
        if v not in (None, ""):
            return v
    return None


async def _publish(rows: list[Any]) -> int:
    """Publish each MarineTraffic vessel row → unified store/broadcast. Testable."""
    published = 0
    for row in rows:
        try:
            if not isinstance(row, dict):
                continue
            mmsi = _get(row, "MMSI", "mmsi")
            lat = _num(_get(row, "LAT", "lat", "LATITUDE"))
            lon = _num(_get(row, "LON", "lon", "LONGITUDE"))
            if mmsi is None or lat is None or lon is None:
                continue
            ok = await ais_firehose.publish_vessel(
                mmsi,
                lat,
                lon,
                sog=_num(_get(row, "SPEED", "sog", "SOG")),
                cog=_num(_get(row, "COURSE", "cog", "COG")),
                heading=_num(_get(row, "HEADING", "heading")),
                name=_get(row, "SHIPNAME", "NAME", "name"),
                ship_type=_get(row, "SHIPTYPE", "TYPE_NAME", "ship_type", "TYPE"),
                source="marinetraffic",
            )
            published += int(ok)
        except Exception:  # noqa: BLE001 — one bad row must not stop the poll
            continue
    return published


async def _run() -> None:
    s = get_settings()
    url = s.marinetraffic_url.replace("{key}", s.marinetraffic_key)
    client = get_client()
    interval = max(30.0, s.marinetraffic_interval_s)
    backoff = interval
    while True:
        try:
            r = await client.get(
                url, headers={"User-Agent": _UA, "Accept": "application/json"}, timeout=30.0
            )
            if r.status_code == 200:
                data = r.json()
                rows = data if isinstance(data, list) else (
                    data.get("data") or data.get("vessels") or []
                )
                n = await _publish(rows if isinstance(rows, list) else [])
                _stats["vessels"] = n
                _stats["last_error"] = None
                backoff = interval
            else:
                _stats["last_error"] = f"HTTP {r.status_code}"
                backoff = min(backoff * 2, 900.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("marinetraffic poll error: %s", e)
            _stats["last_error"] = str(e)[:140]
            backoff = min(backoff * 2, 900.0)
        await asyncio.sleep(max(interval, backoff))


def start() -> None:
    """Start the poll loop — only when enabled AND a key is set (else dormant)."""
    global _task
    s = get_settings()
    if not (s.marinetraffic_enabled and s.marinetraffic_key):
        _stats["enabled"] = False
        return
    if _task and not _task.done():
        return
    _stats["enabled"] = True
    _task = asyncio.create_task(_run())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _task = None
    _stats["enabled"] = False
