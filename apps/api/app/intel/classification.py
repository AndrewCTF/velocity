"""US IC classification markings + clearance logic — the Gotham-substrate ACL spine.

A classified row carries a level on the 0..4 ladder plus positive ``compartments``
the reader must hold. A reader may see a row iff ``row.level <= reader.clearance``
AND every compartment the row requires is one the reader holds. The Postgres RLS
policies (see ``supabase/migrations/0001_gotham_substrate_acl_audit.sql``) enforce
this for real; this module is the single source of truth for the ladder + the
human-readable marking string, used by the API and mirrored by the frontend
(``apps/web/src/security/classification.ts``).

Compartments are modelled as POSITIVE grants (to read a ``FVEY`` row you must hold
``FVEY``). True dissemination caveats with negative semantics (NOFORN etc.) are a
v2 refinement; v1 treats every caveat as a positive grant — documented simplification.
"""

from __future__ import annotations

UNCLASSIFIED = 0
CUI = 1
CONFIDENTIAL = 2
SECRET = 3
TOP_SECRET = 4

MIN_LEVEL = UNCLASSIFIED
MAX_LEVEL = TOP_SECRET

LABELS: dict[int, str] = {
    UNCLASSIFIED: "UNCLASSIFIED",
    CUI: "CUI",
    CONFIDENTIAL: "CONFIDENTIAL",
    SECRET: "SECRET",
    TOP_SECRET: "TOP SECRET",
}

# Accept names + common abbreviations when parsing a level from text/JSON.
_BY_NAME: dict[str, int] = {
    "UNCLASSIFIED": UNCLASSIFIED, "UNCLAS": UNCLASSIFIED, "U": UNCLASSIFIED,
    "CUI": CUI,
    "CONFIDENTIAL": CONFIDENTIAL, "C": CONFIDENTIAL,
    "SECRET": SECRET, "S": SECRET,
    "TOP SECRET": TOP_SECRET, "TOPSECRET": TOP_SECRET, "TS": TOP_SECRET,
}


def clamp(level: object) -> int:
    """Coerce anything to a valid ladder level; out-of-range/garbage → UNCLASSIFIED.

    Least-privilege on garbage: an unparseable level becomes UNCLASSIFIED (0),
    never a higher level by accident.
    """
    try:
        lv = int(level)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return MIN_LEVEL
    return max(MIN_LEVEL, min(lv, MAX_LEVEL))


def parse_level(value: object) -> int:
    """Parse a level from an int or a name/abbrev string. Garbage → UNCLASSIFIED."""
    if isinstance(value, bool):  # bool is an int subclass — reject explicitly
        return MIN_LEVEL
    if isinstance(value, (int, float)):
        return clamp(int(value))
    if isinstance(value, str):
        v = value.strip().upper()
        if not v:
            return MIN_LEVEL
        if v.lstrip("-").isdigit():
            return clamp(int(v))
        return _BY_NAME.get(v, MIN_LEVEL)
    return MIN_LEVEL


def label(level: object) -> str:
    return LABELS[clamp(level)]


def _norm_comps(compartments: object) -> list[str]:
    if not compartments:
        return []
    if isinstance(compartments, str):
        compartments = [compartments]
    try:
        items = list(compartments)  # type: ignore[arg-type]
    except TypeError:
        return []
    return sorted({str(c).strip().upper() for c in items if str(c).strip()})


def marking(level: object, compartments: object = None) -> str:
    """Banner string, e.g. ``SECRET//FVEY/REL`` or ``UNCLASSIFIED``."""
    comps = _norm_comps(compartments)
    base = label(level)
    return base + ("//" + "/".join(comps) if comps else "")


def can_read(
    user_clearance: object,
    user_compartments: object,
    row_level: object,
    row_compartments: object,
) -> bool:
    """Mirror of the RLS predicate — the in-process defense-in-depth check.

    True iff the row's level is within the user's clearance AND the user holds
    every compartment the row requires.
    """
    if clamp(row_level) > clamp(user_clearance):
        return False
    need = set(_norm_comps(row_compartments))
    have = set(_norm_comps(user_compartments))
    return need.issubset(have)


def holds(user_compartments: object, want_compartments: object) -> bool:
    """True iff the user holds every compartment in ``want`` (case-insensitive).

    The compartment half of the create-ceiling check: a user may only tag a row
    with compartments they themselves hold (mirrors the RLS ``compartments <@
    current_compartments()`` restrictive policy).
    """
    have = set(_norm_comps(user_compartments))
    return set(_norm_comps(want_compartments)).issubset(have)


def redact_for(
    user_clearance: object,
    user_compartments: object,
    rows: list[dict],
    *,
    level_key: str = "classification",
    comp_key: str = "compartments",
) -> list[dict]:
    """Drop rows the user may not read. Belt-and-suspenders for any path that
    reads with a service-role/over-broad token instead of relying on RLS."""
    return [
        r
        for r in rows
        if can_read(user_clearance, user_compartments, r.get(level_key, 0), r.get(comp_key))
    ]


def redact_features(
    user_clearance: object,
    user_compartments: object,
    fc: object,
    *,
    level_key: str = "classification",
    comp_key: str = "compartments",
) -> object:
    """Drop GeoJSON features the user may not read, keyed off ``properties``.

    A FeatureCollection carries its level in ``feature["properties"]``, not at the
    top level — so ``redact_for`` (which reads top-level keys) can't filter it.
    Returns the same envelope with ``features`` filtered. Anything that isn't a
    FeatureCollection (no list ``features``) is returned unchanged — live OSINT
    feeds carry no classification, so this is a no-op on them; the teeth land on
    classified ontology-backed collections.
    """
    if not isinstance(fc, dict) or not isinstance(fc.get("features"), list):
        return fc
    kept = [
        f
        for f in fc["features"]
        if isinstance(f, dict)
        and can_read(
            user_clearance,
            user_compartments,
            (f.get("properties") or {}).get(level_key, 0),
            (f.get("properties") or {}).get(comp_key),
        )
    ]
    return {**fc, "features": kept}


if __name__ == "__main__":  # tiny self-check (ponytail: one runnable check)
    assert marking(SECRET, ["NOFORN"]) == "SECRET//NOFORN"
    assert marking(0) == "UNCLASSIFIED"
    assert marking(TOP_SECRET, ["fvey", "rel"]) == "TOP SECRET//FVEY/REL"
    assert parse_level("secret") == SECRET and parse_level("TS") == TOP_SECRET
    assert parse_level(99) == TOP_SECRET and parse_level("junk") == UNCLASSIFIED
    assert parse_level(True) == UNCLASSIFIED  # bool rejected
    assert can_read(2, [], 3, []) is False  # clearance too low
    assert can_read(3, [], 3, []) is True
    assert can_read(4, [], 3, ["NOFORN"]) is False  # missing compartment
    assert can_read(4, ["NOFORN"], 3, ["noforn"]) is True  # case-insensitive
    assert redact_for(2, [], [{"classification": 3}, {"classification": 1}]) == [{"classification": 1}]
    _fc = {"type": "FeatureCollection", "features": [
        {"properties": {"classification": 3}}, {"properties": {"classification": 0}}]}
    assert [f["properties"]["classification"] for f in redact_features(0, [], _fc)["features"]] == [0]
    assert len(redact_features(3, [], _fc)["features"]) == 2
    assert redact_features(0, [], {"count": 1}) == {"count": 1}  # non-FC unchanged
    print("classification self-check OK")
