"""GET /api/airspace/nas-status — FAA National Airspace System ground stops,
ground delays, arrival/departure delays, and airport closures (2026-07 gaps
wave, task B1c).

Lives beside the existing ``/api/airspace/*`` routes (``routes/airspace.py``,
which owns TFRs) without touching that file — same path prefix, separate
module, wired into the app by the merge owner (see MERGE SPEC in the PR).

Upstream is ``nasstatus.faa.gov``'s XML feed (probed live 2026-07-21): a flat
list of ``Delay_type`` blocks, each holding one of four list shapes —
``Ground_Stop_List``, ``Ground_Delay_List``, ``Arrival_Departure_Delay_List``,
``Airport_Closure_List`` — keyed by 3-letter ``ARPT`` (IATA) codes. The feed
can (and does) repeat a ``Delay_type`` name (two separate "Airport Closures"
blocks were observed live), so ids are disambiguated with a running per
(airport, type) counter rather than assumed unique per block.

Airport coordinates are resolved via the existing ``app.places.airport_by_code``
lookup (``app/data/airports.json``, ~5.3k IATA/ICAO rows) — no new coordinate
table. An ``ARPT`` code absent from that table is skipped and counted in the
FeatureCollection envelope's ``skipped`` field rather than guessed.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException

from app import places
from app.routes import _feedgeo as fg

router = APIRouter(tags=["airspace"])

NAS_STATUS_URL = "https://nasstatus.faa.gov/api/airport-status-information"


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t or None


def _parse(xml_text: str) -> tuple[list[fg.Feature], int]:
    """Parse the FAA NAS status XML into groundstop point Features.

    Returns ``(features, skipped)`` where ``skipped`` counts entries whose
    ``ARPT`` code did not resolve to a known airport.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise HTTPException(502, "upstream returned malformed XML") from exc

    out: list[fg.Feature] = []
    skipped = 0
    seen: defaultdict[tuple[str, str], int] = defaultdict(int)

    def emit(iata: str, dtype: str, props: dict[str, Any]) -> None:
        nonlocal skipped
        row = places.airport_by_code(iata)
        if row is None:
            skipped += 1
            return
        lat, lon = fg.num(row.get("lat")), fg.num(row.get("lon"))
        if lat is None or lon is None:
            skipped += 1
            return
        n = seen[(iata, dtype)]
        seen[(iata, dtype)] += 1
        fid = f"groundstop:{iata}:{dtype}" + (f":{n}" if n else "")
        base = {"kind": "groundstop", "airport": iata, "type": dtype}
        base.update(props)
        out.append(fg.point(fid, lon, lat, base))

    for delay_type in root.findall(".//Delay_type"):
        for prog in delay_type.findall("./Ground_Stop_List/Program"):
            iata = _text(prog.find("ARPT"))
            if not iata:
                continue
            emit(
                iata,
                "ground_stop",
                {
                    "reason": _text(prog.find("Reason")),
                    "avg_delay": None,
                    "until": _text(prog.find("End_Time")),
                },
            )

        for gd in delay_type.findall("./Ground_Delay_List/Ground_Delay"):
            iata = _text(gd.find("ARPT"))
            if not iata:
                continue
            emit(
                iata,
                "ground_delay",
                {
                    "reason": _text(gd.find("Reason")),
                    "avg_delay": _text(gd.find("Avg")),
                    "until": None,
                    "max_delay": _text(gd.find("Max")),
                },
            )

        for delay in delay_type.findall("./Arrival_Departure_Delay_List/Delay"):
            iata = _text(delay.find("ARPT"))
            if not iata:
                continue
            reason = _text(delay.find("Reason"))
            ad_children = delay.findall("Arrival_Departure")
            if not ad_children:
                continue
            for ad in ad_children:
                emit(
                    iata,
                    "arrival_departure_delay",
                    {
                        "reason": reason,
                        "avg_delay": None,
                        "until": None,
                        "direction": (ad.get("Type") or "").lower() or None,
                        "min_delay": _text(ad.find("Min")),
                        "max_delay": _text(ad.find("Max")),
                        "trend": _text(ad.find("Trend")),
                    },
                )

        for closure in delay_type.findall("./Airport_Closure_List/Airport"):
            iata = _text(closure.find("ARPT"))
            if not iata:
                continue
            emit(
                iata,
                "closure",
                {
                    "reason": _text(closure.find("Reason")),
                    "avg_delay": None,
                    "until": _text(closure.find("Reopen")),
                    "start": _text(closure.find("Start")),
                },
            )

    return out, skipped


@router.get("/api/airspace/nas-status")
async def nas_status() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_text(NAS_STATUS_URL)
        features, skipped = _parse(raw)
        envelope = fg.fc(features)
        envelope["skipped"] = skipped
        return envelope

    return await fg.cached("airspace:nasstatus", 300.0, load)
