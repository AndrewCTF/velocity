"""Honesty guard for the landing-capability rating (docs/places-airspace-plan.md §7).

A CAT I/II/III string may only ever come from FAA NASR runway rows; the
worldwide tier is ALWAYS labeled derived and never contains "CAT".
"""

from __future__ import annotations

from app import places


def test_derived_tier_always_flagged_and_never_a_cat_string():
    cases = [
        None,
        {},
        {"runways": []},
        {"ils_present": True, "runways": [{"lighted": True, "length_ft": 12000}]},
        {"ils_present": False, "runways": [{"lighted": True, "length_ft": 4000}]},
        {"ils_present": False, "runways": [{"lighted": False}]},
    ]
    for detail in cases:
        cap = places.approach_capability(detail)
        assert cap["approach_capability_derived"] is True
        assert "CAT" not in cap["approach_capability"]
        assert isinstance(cap["approach_capability_basis"], list) and cap["approach_capability_basis"]


def test_tiers():
    assert (
        places.approach_capability({"ils_present": True, "runways": [{"lighted": True}]})["approach_capability"]
        == "precision (ILS present)"
    )
    assert (
        places.approach_capability({"runways": [{"lighted": True}]})["approach_capability"]
        == "non-precision/visual (lighted)"
    )
    assert (
        places.approach_capability({"runways": [{"lighted": False}]})["approach_capability"]
        == "visual only (no ILS/lighting on record)"
    )


def test_nasr_categories_surface_in_basis_only_when_present():
    detail = {
        "runways": [
            {"lighted": True, "length_ft": 14511, "ils_category_le": "IIIB", "ils_category_he": "III",
             "ils_category": "IIIB"},
        ]
    }
    cap = places.approach_capability(detail)
    assert cap["ils_present"] is True
    assert any("FAA NASR" in b for b in cap["approach_capability_basis"])
    # Closed runways contribute nothing.
    cap2 = places.approach_capability({"runways": [{"closed": True, "ils_category": "II", "lighted": True}]})
    assert cap2["approach_capability"] == "visual only (no ILS/lighting on record)"


def test_no_fabricated_cat_in_dataset():
    """Every ils_category* string in the shipped dataset must be a NASR value
    on a US airport — non-US rows stay null."""
    detail = places.airports_detail()
    idx = {str(a.get("icao") or ""): a for a in places.airports()}
    offenders = []
    for ident, rec in detail.items():
        for r in rec.get("runways", []):
            if any(r.get(k) for k in ("ils_category", "ils_category_le", "ils_category_he")):
                iso = str((idx.get(ident) or {}).get("iso") or "")
                if iso != "US":
                    offenders.append((ident, iso))
    assert not offenders, offenders[:10]


def test_enrich_airport_carries_derived_fields():
    import asyncio

    from app.routes.entity import _enrich_airport

    out = asyncio.run(_enrich_airport("KJFK"))
    assert out["approach_capability_derived"] is True
    assert out["approach_capability"].startswith("precision")
    assert out["ils_present"] is True
