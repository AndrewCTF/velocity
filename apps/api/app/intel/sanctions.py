"""Sanctions lists as a lookup index over the identifiers the live feeds carry.

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

Three lists load, each with its own parser and its own identifier quirks, and
all three merge into one index where a key maps to every designation that
carries it:

* **OFAC SDN** (CSV) — the only list with aircraft tail numbers and MMSIs.
* **UK OFSI** (CSV) — 81 ships, IMO inside a labelled span in free text.
* **UN Security Council** (XML) — names only, no vessel element at all.

The **EU** FSD export is deliberately not loaded, and the reason is measured
rather than assumed: 25.7 MB for 6,225 entries whose only subject types are
person and entity, 70 occurrences of "IMO" in the whole file, and no vessel
element. It would broaden the name screen and add nothing joinable by hull.

A list that fails to fetch is named in ``failed`` and reported by
``/api/sanctions/summary``. A source that quietly dropped out must never read as
a source that found nothing.

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
    #: Which authority designated it. An analyst screens against several lists
    #: and needs to know WHICH one answered, not just that something did.
    list_name: str = "OFAC SDN"
    list_url: str = "https://sanctionslist.ofac.treas.gov/Home/SdnList"
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
            "list": self.list_name,
            "source_url": self.list_url,
        }


@dataclass
class SanctionsIndex:
    """Designations, plus the identifier maps a live feed can be joined on.

    Every map is key → LIST of designations, not key → one. A hull designated by
    OFAC and by the UK is two designations under one IMO, and the answer an
    analyst needs is "OFAC and UK", not whichever list happened to load first.
    Collapsing that was the shape of the first version and it silently threw
    away the fact that made the screen worth running against several lists.
    """

    fetched_at: float
    rows: int
    #: Lists that actually loaded, and the ones that did not. A source that
    #: failed to fetch must never read as a source that found nothing.
    lists: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)
    designations: list[Designation] = field(default_factory=list)
    by_imo: dict[int, list[Designation]] = field(default_factory=dict)
    by_mmsi: dict[int, list[Designation]] = field(default_factory=dict)
    by_call_sign: dict[str, list[Designation]] = field(default_factory=dict)
    by_tail: dict[str, list[Designation]] = field(default_factory=dict)
    by_name: dict[str, list[Designation]] = field(default_factory=dict)

    def add(self, d: Designation) -> None:
        """Index one designation on every identifier it carries."""
        self.designations.append(d)
        if d.imo:
            self.by_imo.setdefault(d.imo, []).append(d)
        if d.mmsi:
            self.by_mmsi.setdefault(d.mmsi, []).append(d)
        if d.call_sign:
            self.by_call_sign.setdefault(normalize_name(d.call_sign), []).append(d)
        if d.sdn_type == "aircraft":
            # For an aircraft row the NAME field is the tail number.
            self.by_tail.setdefault(normalize_name(d.name), []).append(d)
        if d.sdn_type in ("vessel", "aircraft", "entity"):
            self.by_name.setdefault(normalize_name(d.name), []).append(d)

    def merge(self, other: SanctionsIndex) -> None:
        self.rows += other.rows
        self.lists.extend(other.lists)
        self.failed.update(other.failed)
        for d in other.designations:
            self.add(d)

    def by_list(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for d in self.designations:
            out[d.list_name] = out.get(d.list_name, 0) + 1
        return out

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
        idx.add(d)
    idx.lists = ["OFAC SDN"]
    return idx


# ── UK OFSI consolidated list ───────────────────────────────────────────────
# CSV, two header rows (a "Last Updated" line, then the real header). 36 columns,
# 19,761 rows measured 2026-08-05: 13,863 individuals, 5,817 entities and 81
# ships. The ship identifiers are not columns either — they are labelled spans
# inside `Other Information`, e.g. `(IMO number):7408873 (Flag of ship):North
# Korea (Type of ship):Oil tanker`.
UK_CSV_URL = "https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv"

_UK_IMO_RE = re.compile(r"\(IMO number\)\s*:\s*(\d{7})", re.I)
_UK_FLAG_RE = re.compile(r"\(Flag of ship\)\s*:\s*([^(]+)", re.I)
_UK_TYPE_RE = re.compile(r"\(Type of ship\)\s*:\s*([^(]+)", re.I)
_UK_OWNER_RE = re.compile(r"\(Current owners\)\s*:\s*([^(]+)", re.I)


def parse_uk_csv(text: str) -> SanctionsIndex:
    """Parse the OFSI consolidated list. Pure, testable off a fixture."""
    idx = SanctionsIndex(fetched_at=time.time(), rows=0)
    rows = list(csv.reader(io.StringIO(text)))
    # Find the real header: the first row naming the group column.
    head_i = next((i for i, r in enumerate(rows[:5]) if "Group Type" in r), None)
    if head_i is None:
        return idx
    hdr = rows[head_i]
    col = {h: i for i, h in enumerate(hdr)}

    def cell(r: list[str], name: str) -> str | None:
        i = col.get(name)
        if i is None or i >= len(r):
            return None
        v = r[i].strip()
        return v or None

    for r in rows[head_i + 1 :]:
        if len(r) < len(hdr):
            continue
        idx.rows += 1
        # OFSI splits a name across Name 1..6; Name 6 carries the whole thing
        # for ships and entities and the surname for individuals.
        parts = [cell(r, f"Name {i}") for i in (6, 1, 2, 3, 4, 5)]
        name = next((p for p in parts if p), None)
        if not name:
            continue
        group = (cell(r, "Group Type") or "Entity").lower()
        sdn_type = {"ship": "vessel", "individual": "individual"}.get(group, "entity")
        other = cell(r, "Other Information") or ""
        imo_m = _UK_IMO_RE.search(other)
        gid = cell(r, "Group ID") or "0"
        flag = _UK_FLAG_RE.search(other)
        vtype = _UK_TYPE_RE.search(other)
        owner = _UK_OWNER_RE.search(other)
        idx.add(
            Designation(
                ent_num=int(gid) if gid.isdigit() else 0,
                name=name,
                sdn_type=sdn_type,
                programs=tuple(p for p in [cell(r, "Regime")] if p),
                imo=int(imo_m.group(1)) if imo_m else None,
                vessel_type=vtype.group(1).strip() if vtype else None,
                vessel_flag=flag.group(1).strip() if flag else None,
                vessel_owner=owner.group(1).strip() if owner else None,
                remarks=other or None,
                list_name="UK OFSI",
                list_url="https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets",
            )
        )
    idx.lists = ["UK OFSI"]
    return idx


# ── UN Security Council consolidated list ───────────────────────────────────
# 2 MB XML, 736 individuals and 275 entities measured 2026-08-05. No vessel
# element at all, so this list contributes names and nothing joinable by hull.
# It is carried because the UN list is the one every other regime derives from,
# and a screen that cannot say "and the UN" is answering a narrower question
# than the analyst asked.
UN_XML_URL = "https://scsanctions.un.org/resources/xml/en/consolidated.xml"


def parse_un_xml(text: str) -> SanctionsIndex:
    """Parse the UN consolidated list. Pure, testable off a fixture."""
    from xml.etree import ElementTree as ET  # noqa: PLC0415 — stdlib, parse-time only

    idx = SanctionsIndex(fetched_at=time.time(), rows=0)
    try:
        root = ET.fromstring(text)  # noqa: S314 — a government XML feed, not user input
    except ET.ParseError:
        return idx
    for tag, kind in (("INDIVIDUAL", "individual"), ("ENTITY", "entity")):
        for el in root.iter(tag):
            idx.rows += 1
            first = (el.findtext("FIRST_NAME") or "").strip()
            second = (el.findtext("SECOND_NAME") or "").strip()
            third = (el.findtext("THIRD_NAME") or "").strip()
            name = " ".join(p for p in (first, second, third) if p)
            if not name:
                continue
            ref = (el.findtext("DATAID") or "0").strip()
            idx.add(
                Designation(
                    ent_num=int(ref) if ref.isdigit() else 0,
                    name=name,
                    sdn_type=kind,
                    programs=tuple(
                        p for p in [(el.findtext("UN_LIST_TYPE") or "").strip()] if p
                    ),
                    remarks=(el.findtext("COMMENTS1") or "").strip() or None,
                    list_name="UN Security Council",
                    list_url="https://www.un.org/securitycouncil/content/un-sc-consolidated-list",
                )
            )
    idx.lists = ["UN Security Council"]
    return idx


# The EU FSD XML is deliberately NOT loaded. Measured 2026-08-05: 25.7 MB for
# 6,225 entries whose only subject types are P (person) and E (entity), with 70
# occurrences of "IMO" in the whole file and no vessel element. EU vessel
# designations live in the regulation annexes, not in this export, so paying
# 25 MB per refresh would broaden the NAME screen and add nothing joinable by
# hull. Revisit when the EU publishes vessels in a machine-readable export.


async def _fetch(url: str, *, follow: bool = False) -> str:
    r = await get_client().get(url, timeout=90.0, follow_redirects=follow)
    r.raise_for_status()
    return r.text


async def _load() -> SanctionsIndex:
    """Load every list, tolerating the loss of any one of them.

    A list that failed to fetch is recorded by name in `failed`. A screen that
    quietly drops a source and still answers "no designation" is worse than one
    that does not run at all, so the miss path reports which lists were actually
    consulted.
    """
    merged = SanctionsIndex(fetched_at=time.time(), rows=0)
    sources: list[tuple[str, str, bool, Any]] = [
        # 302 to a presigned us-gov-west-1 S3 URL, so this one follows redirects.
        ("OFAC SDN", SDN_CSV_URL, True, parse_sdn_csv),
        ("UK OFSI", UK_CSV_URL, True, parse_uk_csv),
        ("UN Security Council", UN_XML_URL, True, parse_un_xml),
    ]
    texts = await asyncio.gather(
        *(_fetch(url, follow=follow) for _, url, follow, _ in sources),
        return_exceptions=True,
    )
    for (name, _url, _follow, parser), text in zip(sources, texts, strict=True):
        if isinstance(text, BaseException):
            merged.failed[name] = str(text)[:200]
            continue
        # Tens of MB of CSV and XML. Off the loop: this runs once per TTL and it
        # would stall every other request for the duration when it does.
        try:
            merged.merge(await asyncio.to_thread(parser, text))
        except Exception as exc:  # noqa: BLE001 — one bad list must not lose the others
            merged.failed[name] = f"parse failed: {exc}"[:200]
    return merged


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
    #: Every list that carries this identifier. "OFAC and the UK and the UN" is
    #: a materially different answer from "OFAC", and the first version of this
    #: could only ever say the latter.
    lists: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            **self.designation.as_dict(),
            "matched_on": self.matched_on,
            "confidence": self.confidence,
            "lists": list(self.lists or (self.designation.list_name,)),
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
    if imo and (ds := idx.by_imo.get(int(imo))):
        return Match(ds[0], "imo", "exact", tuple(sorted({d.list_name for d in ds})))
    if mmsi and (ds := idx.by_mmsi.get(int(mmsi))):
        return Match(ds[0], "mmsi", "exact", tuple(sorted({d.list_name for d in ds})))
    if call_sign and (ds := idx.by_call_sign.get(normalize_name(call_sign))):
        return Match(ds[0], "call_sign", "probable", tuple(sorted({d.list_name for d in ds})))
    if name:
        hits = idx.by_name.get(normalize_name(name)) or []
        vessels = [d for d in hits if d.sdn_type == "vessel"]
        if vessels:
            lists = tuple(sorted({d.list_name for d in vessels}))
            # Several designated hulls share the name. Report the first and say
            # so rather than picking silently.
            on = "name" if len(vessels) == 1 else "name (ambiguous)"
            return Match(vessels[0], on, "probable", lists)
    return None


def match_aircraft(
    idx: SanctionsIndex, *, registration: str | None = None, name: str | None = None
) -> Match | None:
    """Best single match for an aircraft. Tail number is the identifier OFAC
    designates on, so registration is the only exact key here."""
    if registration and (ds := idx.by_tail.get(normalize_name(registration))):
        return Match(ds[0], "registration", "exact", tuple(sorted({d.list_name for d in ds})))
    if name:
        named = idx.by_name.get(normalize_name(name)) or []
        hits = [d for d in named if d.sdn_type == "aircraft"]
        if hits:
            return Match(hits[0], "name", "probable", tuple(sorted({d.list_name for d in hits})))
    return None
