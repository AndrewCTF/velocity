"""GET /api/sigint/* — amateur-radio reception reports as geolocated contacts.

PSKReporter is a global, keyless aggregator of automatic reception reports: a
receiving station decodes a digital-mode transmission and publishes who it
heard, from where, on what frequency, at what signal-to-noise. Thousands of
reports land per minute worldwide.

Why it earns a slot here rather than being ham trivia: the platform tracks
aircraft, vessels and satellites and had NOTHING in the radio domain —
`routes/source_catalog.py` carried twelve sdr/sigint/streaming entries and
exactly one route (`airframes` -> /api/acars). `pskreporter` was one of the
entries listed with no way to reach it. Each report is an emitter observed at a
place and a time by an independent third party, which is the same shape as every
other observation on this map, and the receiver/sender pair is a propagation
measurement — HF paths open and close with ionospheric conditions, so a route
that suddenly appears or dies is itself a signal.

Keyless, no account. XML, parsed with the stdlib: this repo deliberately carries
no HTML/XML parser dependency beyond feedparser (see /CLAUDE.md).

Provenance: a report is an ASSERTION by the receiving station, not a
measurement anyone here made. Callsign -> operator identity is public record
(national licence registries); no attempt is made to resolve it.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["sigint"])

PSK_URL = "https://retrieve.pskreporter.info/query"

# PSKReporter asks callers not to poll faster than once every five minutes.
# The TTL is the politeness (same posture as routes/cams.py): one upstream fetch
# per window no matter how many panels are open.
_TTL_S = 300.0

# HF/VHF band edges in Hz. Coarse on purpose — the band label is for grouping
# and colouring, and a report sitting a kilohertz outside an edge is still that
# band's propagation story.
_BANDS: tuple[tuple[int, int, str], ...] = (
    (1_800_000, 2_000_000, "160m"),
    (3_500_000, 4_000_000, "80m"),
    (5_250_000, 5_450_000, "60m"),
    (7_000_000, 7_300_000, "40m"),
    (10_100_000, 10_150_000, "30m"),
    (14_000_000, 14_350_000, "20m"),
    (18_068_000, 18_168_000, "17m"),
    (21_000_000, 21_450_000, "15m"),
    (24_890_000, 24_990_000, "12m"),
    (28_000_000, 29_700_000, "10m"),
    (50_000_000, 54_000_000, "6m"),
    (144_000_000, 148_000_000, "2m"),
)


def band_of(hz: float | None) -> str:
    if hz is None:
        return "unknown"
    for lo, hi, name in _BANDS:
        if lo <= hz <= hi:
            return name
    return "unknown"


def maidenhead_to_lonlat(loc: str) -> tuple[float, float] | None:
    """Maidenhead grid square -> the CENTRE of that square, or None.

    Handles 2, 4 and 6 character locators (field / square / subsquare). The
    returned point is the square's centre, and the square is LARGE: a 4-char
    locator is 1 deg latitude by 2 deg longitude, roughly 111 x 155 km at the
    equator. Callers get `precision_km` alongside so nothing downstream mistakes
    this for a fix. Returning the centre rather than the corner is what keeps
    that error symmetric.
    """
    s = (loc or "").strip().upper()
    if len(s) < 4 or not s[0:2].isalpha() or not s[2:4].isdigit():
        return None
    try:
        lon = (ord(s[0]) - 65) * 20.0 - 180.0
        lat = (ord(s[1]) - 65) * 10.0 - 90.0
        lon += int(s[2]) * 2.0
        lat += int(s[3]) * 1.0
        if len(s) >= 6 and s[4:6].isalpha():
            lon += (ord(s[4]) - 65) * (2.0 / 24.0)
            lat += (ord(s[5]) - 65) * (1.0 / 24.0)
            lon += (2.0 / 24.0) / 2.0
            lat += (1.0 / 24.0) / 2.0
        else:
            lon += 1.0
            lat += 0.5
    except (ValueError, IndexError):
        return None
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        return None
    return lon, lat


def _precision_km(loc: str) -> float:
    return 4.6 if len(loc.strip()) >= 6 else 111.0


def parse_reports(xml: str, limit: int) -> list[fg.Feature]:
    """PSKReporter XML -> Features at the TRANSMITTER's grid square.

    The sender is the emitter, so that is what gets plotted; the receiver rides
    along in properties because the pair is what makes the report a propagation
    measurement rather than a dot.
    """
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise HTTPException(502, f"pskreporter returned unparseable XML: {exc}") from exc

    out: list[fg.Feature] = []
    seen: set[str] = set()
    for r in root.findall("receptionReport"):
        a = r.attrib
        sender = (a.get("senderCallsign") or "").strip()
        loc = (a.get("senderLocator") or "").strip()
        if not sender or not loc:
            continue
        lonlat = maidenhead_to_lonlat(loc)
        if lonlat is None:
            continue
        rx = (a.get("receiverCallsign") or "").strip()
        when = a.get("flowStartSeconds")
        # One emitter can be heard by dozens of receivers in the same window;
        # dedupe to the emitter so the map shows stations, not a starburst.
        key = f"{sender}:{loc}"
        if key in seen:
            continue
        seen.add(key)
        out.append(
            fg.point(
                f"radio_report:{sender}:{loc}",
                lonlat[0],
                lonlat[1],
                {
                    "kind": "radio_report",
                    "callsign": sender,
                    "grid": loc,
                    "precision_km": _precision_km(loc),
                    "heard_by": rx,
                    "heard_by_grid": (a.get("receiverLocator") or "").strip(),
                    "frequency_hz": fg.num(a.get("frequency")),
                    "band": band_of(fg.num(a.get("frequency"))),
                    "mode": (a.get("mode") or "").strip(),
                    "snr_db": fg.num(a.get("sNR")),
                    "country": (a.get("senderDXCC") or "").strip(),
                    "country_code": (a.get("senderDXCCCode") or "").strip(),
                    "t": fg.num(when),
                },
            )
        )
        if len(out) >= limit:
            break
    return out


@router.get("/api/sigint/pskreporter")
async def pskreporter(
    minutes: int = Query(10, ge=1, le=60, description="Look-back window."),
    limit: int = Query(1500, ge=1, le=5000),
) -> dict[str, Any]:
    """Recent amateur-radio reception reports, plotted at the transmitter."""
    key = f"psk:{minutes}:{limit}"

    async def load() -> dict[str, Any]:
        xml = await fg.fetch_text(
            PSK_URL, params={"rronly": "1", "flowStartSeconds": str(-minutes * 60)}
        )
        return fg.fc(parse_reports(xml, limit))

    return await fg.cached(key, _TTL_S, load)
