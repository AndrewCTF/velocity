"""Tip-and-cue — observe→observe collection triggered by a fired alert.

When a dark-zone alert fires (a vessel goes dark / a dark-vessel incident inside
a watch AOI), the system acts on its own observation: it triggers an OPEN-SOURCE
look — a Sentinel-1 SAR dark-vessel pass over the alert's area — with no human in
the loop and without tasking anything it does not own. This is the civilian
analog of sensor tasking: we cannot re-task a satellite, but we CAN pull the next
already-collected SAR scene over the spot and check for a vessel with no AIS.

``intel/sar_vessels.detect_dark_vessels`` is keyed by a named AOI and needs CDSE
credentials; this module maps a firing's coordinates onto a configured AOI and
degrades honestly when no AOI covers the point or SAR imagery is unavailable.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.intel import sar_vessels

log = logging.getLogger("velocity.cue")

CUE_TIMEOUT_S: float = 25.0
# Kinds whose firing is worth an automatic SAR look (dark-zone signals).
CUE_KINDS: frozenset[str] = frozenset(("ais_gap", "dark_vessel"))


def aoi_for_point(lon: float, lat: float) -> str | None:
    """The configured SAR AOI key whose bbox contains (lon, lat), or None."""
    for name, (_label, (lon0, lat0, lon1, lat1)) in sar_vessels.AOIS.items():
        if lon0 <= lon <= lon1 and lat0 <= lat <= lat1:
            return name
    return None


async def run(lon: float, lat: float) -> dict[str, Any]:
    """Trigger a SAR dark-vessel look for the point. Always returns a status dict
    (never raises) so the caller can attach it to the alert regardless of outcome.

    Statuses: ``no_sar_aoi`` (point outside every configured AOI), ``timeout``,
    ``sar_unavailable`` (no imagery — typically missing CDSE creds), ``error``,
    or ``ok`` with the dark-vessel count.
    """
    aoi = aoi_for_point(lon, lat)
    if not aoi:
        return {"status": "no_sar_aoi", "note": "no Sentinel-1 AOI covers this point"}
    try:
        res = await asyncio.wait_for(sar_vessels.detect_dark_vessels(aoi=aoi), CUE_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {"status": "timeout", "aoi": aoi}
    except Exception as exc:  # noqa: BLE001 — collection is best-effort
        log.debug("cue: SAR look failed for %s: %s", aoi, exc)
        return {"status": "error", "aoi": aoi, "detail": str(exc)[:200]}
    summary = res.get("summary") or {}
    if summary.get("error"):
        return {"status": "sar_unavailable", "aoi": aoi, "detail": summary["error"]}
    return {
        "status": "ok",
        "aoi": aoi,
        "dark": summary.get("dark"),
        "detections": len(res.get("features") or []),
    }
