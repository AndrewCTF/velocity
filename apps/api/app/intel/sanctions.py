"""OFAC SDN as a lookup index over the identifiers the live feeds already carry.

Commercial maritime-risk products (Windward, Kpler, Pole Star) charge five
figures a year for one question: *is the ship I am looking at sanctioned?* The
underlying list is published by the US Treasury, free, with no key, and it names
the vessels by IMO, MMSI and call sign and the aircraft by tail number. What is
sold is not the data, it is the join. So this module does the join.

Source: ``sanctionslistservice.ofac.treas.gov/api/download/sdn.csv``. 12 columns,
no header, ``-0-`` for null:

    ent_num, name, sdn_type, program, title, call_sign, vessel_type,
    tonnage, gross_registered_tonnage, vessel_flag, vessel_owner, remarks

Measured 2026-08-05: 19,182 rows, of which 7,473 individual, 1,524 vessel, 344
aircraft and 9,840 untyped (companies and other entities). 792 vessel rows carry
an MMSI in ``remarks``, and effectively all of them carry an IMO there in the
form ``Vessel Registration Identification IMO 9187629``.

Only OFAC is read here. The EU consolidated list, UK OFSI and the UN Security
Council list are the same shape of work and are the next batch; naming them is
not the same as having them, so ``/api/sanctions/summary`` reports the list it
actually loaded and nothing else.

Provenance tier: registry (docs/plan-99-2026-08.md §0). A designation is an
authority asserting a legal status, not a sensor reporting a measurement, and
the panel says so.
"""

from __future__ import annotations

import asyncio
import csv
import io
import re
import time
from dataclasses import dataclass, field
from typing import Any

from app.upstream import cache, get_client

SDN_CSV_URL = "https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv"

# The list changes on the order of once a day. Six hours keeps a long-running
# process current without hammering Treasury, and a cold start pays one 5.6 MB
# fetch.
_TTL_S = 6 * 3600

_NULL = "-0-"

_IMO_RE = re.compile(r"\bIMO\s*(\d{7})\b", re.I)
_MMSI_RE = re.compile(r"\bMMSI\s*(\d{9})\b", re.I)


def _clean(v: str | None) -> str | None:
    """CSV cell → value or None. OFAC writes null as ``-0-``, often padded."""
    if v is None:
        return None
    s = v.strip()
    if not s or s == _NULL:
        return None
    return s


def normalize_name(name: str) -> str:
    """Fold a vessel or company name for matching.

    AIS names arrive uppercased, space-padded and inconsistently punctuated, so
    a literal comparison against the SDN spelling misses most of the fleet.
    Everything that is not a letter or a digit goes, which is deliberately
    aggressive: this key is only ever used as a CANDIDATE generator, and every
    candidate is reported with the identifier that produced it so an analyst can
    see whether the join rests on a name or on an IMO.
    """
    return re.sub(r"[^A-Z0-9]+", "", name.upper())


@dataclass(frozen=True)
class Designation:
    """One SDN row, reduced to what a lookup needs."""

    ent_num: int
    name: str
    sdn_type: str  # 'individual' | 'vessel' | 'aircraft' | 'entity'
    programs: tuple[str, ...]
    imo: int | None = None
    mmsi: int | None = None
    call_sign: str | None = None
    vessel_type: str | None = None
    vessel_flag: str | None = None
    vessel_owner: str | None = None
    remarks: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ent_num": self.ent_num,
            "name": self.name,
            "type": self.sdn_type,
            "programs": list(self.programs),
            "imo": self.imo,
            "mmsi": self.mmsi,
            "call_sign": self.call_sign,
            "vessel_type": self.vessel_type,
            "vessel_flag": self.vessel_flag,
            "vessel_owner": self.vessel_owner,
            "remarks": self.remarks,
            "list": "OFAC SDN",
            "source_url": "https://sanctionslist.ofac.treas.gov/Home/SdnList",
        }


@dataclass
class SanctionsIndex:
    """Designations, plus the identifier maps a live feed can be joined on."""

    fetched_at: float
    rows: int
    designations: list[Designation] = field(default_factory=list)
    by_imo: dict[int, Designation] = field(default_factory=dict)
    by_mmsi: dict[int, Designation] = field(default_factory=dict)
    by_call_sign: dict[str, Designation] = field(default_factory=dict)
    by_tail: dict[str, Designation] = field(default_factory=dict)
    # Name collisions are real ("EBANO" is not a unique hull), so a name maps to
    # a LIST. Collapsing it to one would silently pick a designation.
    by_name: dict[str, list[Designation]] = field(default_factory=dict)

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for d in self.designations:
            out[d.sdn_type] = out.get(d.sdn_type, 0) + 1
        return out

    def programs(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for d in self.designations:
            for p in d.programs:
                out[p] = out.get(p, 0) + 1
        return out


def parse_sdn_csv(text: str) -> SanctionsIndex:
    """Parse the SDN CSV into an index. Pure, so it is testable off a fixture."""
    idx = SanctionsIndex(fetched_at=time.time(), rows=0)
    for row in csv.reader(io.StringIO(text)):
        # The file ends with a one-cell footer row.
        if len(row) < 12:
            continue
        idx.rows += 1
        ent = _clean(row[0])
        name = _clean(row[1])
        if not ent or not name or not ent.isdigit():
            continue
        raw_type = _clean(row[2])
        sdn_type = raw_type or "entity"
        program = _clean(row[3]) or ""
        remarks = _clean(row[11])
        blob = remarks or ""

        imo_m = _IMO_RE.search(blob)
        mmsi_m = _MMSI_RE.search(blob)
        d = Designation(
            ent_num=int(ent),
            name=name,
            sdn_type=sdn_type,
            # OFAC packs multiple programs into one cell as "] [".
            programs=tuple(p for p in re.split(r"\]\s*\[|;\s*", program.strip("[]")) if p),
            imo=int(imo_m.group(1)) if imo_m else None,
            mmsi=int(mmsi_m.group(1)) if mmsi_m else None,
            call_sign=_clean(row[5]),
            vessel_type=_clean(row[6]),
            vessel_flag=_clean(row[9]),
            vessel_owner=_clean(row[10]),
            remarks=remarks,
        )
        idx.designations.append(d)

        if d.imo:
            idx.by_imo.setdefault(d.imo, d)
        if d.mmsi:
            idx.by_mmsi.setdefault(d.mmsi, d)
        if d.call_sign:
            idx.by_call_sign.setdefault(normalize_name(d.call_sign), d)
        if d.sdn_type == "aircraft":
            # For an aircraft row the NAME field is the tail number.
            idx.by_tail.setdefault(normalize_name(d.name), d)
        if d.sdn_type in ("vessel", "aircraft", "entity"):
            idx.by_name.setdefault(normalize_name(d.name), []).append(d)
    return idx


async def _load() -> SanctionsIndex:
    # 302 to a presigned us-gov-west-1 S3 URL. The shared client does not follow
    # redirects by default, and the redirect IS the download here.
    r = await get_client().get(SDN_CSV_URL, timeout=60.0, follow_redirects=True)
    r.raise_for_status()
    # 5.6 MB and ~19k rows of regex. Off the loop: this runs once per TTL but it
    # would stall every other request for the duration when it does.
    return await asyncio.to_thread(parse_sdn_csv, r.text)


async def get_index() -> SanctionsIndex:
    """The cached index. One fetch per TTL, shared across every caller."""
    return await cache.get_or_fetch("sanctions:ofac:sdn", _TTL_S, _load)


# ── matching ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Match:
    designation: Designation
    #: Which identifier produced the hit. An analyst treats an `imo` match and a
    #: `name` match very differently, so the panel never shows one without it.
    matched_on: str
    confidence: str  # 'exact' | 'probable'

    def as_dict(self) -> dict[str, Any]:
        return {
            **self.designation.as_dict(),
            "matched_on": self.matched_on,
            "confidence": self.confidence,
        }


def match_vessel(
    idx: SanctionsIndex,
    *,
    imo: int | None = None,
    mmsi: int | None = None,
    call_sign: str | None = None,
    name: str | None = None,
) -> Match | None:
    """Best single match for a vessel, strongest identifier first.

    IMO is a hull's permanent number and is exact. MMSI is reassigned when a
    ship reflags and is the identifier a shadow-fleet operator changes first, so
    it is strong but not permanent, and it is still called exact here because
    the number itself is on the list. A call sign or a name is a candidate only.
    """
    if imo and (d := idx.by_imo.get(int(imo))):
        return Match(d, "imo", "exact")
    if mmsi and (d := idx.by_mmsi.get(int(mmsi))):
        return Match(d, "mmsi", "exact")
    if call_sign and (d := idx.by_call_sign.get(normalize_name(call_sign))):
        return Match(d, "call_sign", "probable")
    if name:
        hits = idx.by_name.get(normalize_name(name)) or []
        vessels = [d for d in hits if d.sdn_type == "vessel"]
        if len(vessels) == 1:
            return Match(vessels[0], "name", "probable")
        if vessels:
            # Several designated hulls share the name. Report the first and say
            # so rather than picking silently.
            return Match(vessels[0], "name (ambiguous)", "probable")
    return None


def match_aircraft(
    idx: SanctionsIndex, *, registration: str | None = None, name: str | None = None
) -> Match | None:
    """Best single match for an aircraft. Tail number is the identifier OFAC
    designates on, so registration is the only exact key here."""
    if registration and (d := idx.by_tail.get(normalize_name(registration))):
        return Match(d, "registration", "exact")
    if name:
        named = idx.by_name.get(normalize_name(name)) or []
        hits = [d for d in named if d.sdn_type == "aircraft"]
        if hits:
            return Match(hits[0], "name", "probable")
    return None
