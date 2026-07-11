"""Guard tests for the committed places reference JSON built by
``scripts/build_places_data.py`` (docs/places-airspace-plan.md §1).

Pure file-load assertions — no network, no FastAPI app. Row-count floors are
set a safety margin below what a live rebuild actually produced (see the
script's own stdout for the exact live counts) so a small future upstream
shrink doesn't fail CI, while still catching a broken/empty build.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_DATA = Path(__file__).resolve().parent.parent / "app" / "data"


@lru_cache(maxsize=1)
def _airports() -> list[dict[str, Any]]:
    return json.loads((_DATA / "airports.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _airports_detail() -> dict[str, Any]:
    return json.loads((_DATA / "airports_detail.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _ports() -> list[dict[str, Any]]:
    return json.loads((_DATA / "ports.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _ports_detail() -> dict[str, Any]:
    return json.loads((_DATA / "ports_detail.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _bases() -> list[dict[str, Any]]:
    return json.loads((_DATA / "bases.json").read_text(encoding="utf-8"))


# ── airports.json ────────────────────────────────────────────────────────────


def test_airports_row_count_floor() -> None:
    # Live rebuild produced 5,276 (large+medium OurAirports rows); floor set
    # a safety margin below that.
    assert len(_airports()) >= 5000


def test_airports_backward_compat_keys() -> None:
    required = {"name", "iata", "icao", "lat", "lon", "type", "iso"}
    for row in _airports():
        assert required <= row.keys(), row
        assert row["type"] in ("large", "medium"), row


def test_airports_new_v2_keys() -> None:
    new_keys = {"elevation_ft", "municipality", "scheduled_service", "military"}
    for row in _airports():
        assert new_keys <= row.keys(), row
        assert isinstance(row["scheduled_service"], bool), row
        assert isinstance(row["military"], bool), row


def test_airports_military_flag_hits_some_rows() -> None:
    # Regex AFB|Air Force Base|Naval Air|NAS |Army Airfield|MCAS should match
    # a non-trivial number of named military fields, but not everything.
    hits = sum(1 for r in _airports() if r["military"])
    assert 50 <= hits <= 1000, hits


def test_airports_lax_present_v2() -> None:
    lax = next(r for r in _airports() if r["iata"] == "LAX")
    assert lax["icao"] == "KLAX"
    assert lax["type"] == "large"
    assert lax["iso"] == "US"
    assert lax["elevation_ft"] is not None


# ── airports_detail.json ─────────────────────────────────────────────────────


def test_airports_detail_keyed_by_icao_for_large_medium_only() -> None:
    detail = _airports_detail()
    icaos = {r["icao"] for r in _airports() if r["icao"]}
    assert detail.keys() <= icaos, "detail has keys outside the large/medium airport set"
    assert len(detail) >= 4000


def test_airports_detail_shape() -> None:
    detail = _airports_detail()
    for ident, rec in list(detail.items())[:200]:
        assert "runways" in rec and "frequencies" in rec, (ident, rec)
        for rwy in rec["runways"]:
            assert {"le_ident", "he_ident", "length_ft", "width_ft", "surface", "lighted", "closed", "ils_category"} <= rwy.keys()
        for freq in rec["frequencies"]:
            assert {"type", "desc", "mhz"} <= freq.keys()


def test_ils_category_kjfk_04r_is_iiib() -> None:
    kjfk = _airports_detail()["KJFK"]
    rwy = next(r for r in kjfk["runways"] if r["le_ident"] == "04R")
    assert rwy["ils_category"] == "IIIB", rwy


def test_ils_category_kjfk_all_six_ends_match_live_sample() -> None:
    # Live NASR sample (effective 2026-06-11): 04R=IIIB, 13L=II, 22L=III,
    # 04L/22R/31L/31R=I.
    kjfk = _airports_detail()["KJFK"]
    by_end: dict[str, str | None] = {}
    for rwy in kjfk["runways"]:
        by_end[rwy["le_ident"]] = rwy.get("ils_category_le", rwy["ils_category"])
        by_end[rwy["he_ident"]] = rwy.get("ils_category_he")
    assert by_end["04R"] == "IIIB", by_end
    assert by_end["13L"] == "II", by_end
    assert by_end["22L"] == "III", by_end
    for end in ("04L", "22R", "31L", "31R"):
        assert by_end[end] == "I", (end, by_end)


def test_ils_category_null_outside_us() -> None:
    detail = _airports_detail()
    by_icao = {r["icao"]: r for r in _airports()}
    checked = 0
    for icao, rec in detail.items():
        row = by_icao.get(icao)
        if row is None or row["iso"] == "US":
            continue
        for rwy in rec["runways"]:
            assert rwy["ils_category"] is None, (icao, rwy)
            checked += 1
    assert checked > 1000, "expected many non-US runway rows to sanity-check"


def test_ils_category_some_us_airport_has_a_category() -> None:
    detail = _airports_detail()
    by_icao = {r["icao"]: r for r in _airports()}
    hits = 0
    for icao, rec in detail.items():
        row = by_icao.get(icao)
        if row is None or row["iso"] != "US":
            continue
        hits += sum(1 for rwy in rec["runways"] if rwy["ils_category"] is not None)
    assert hits > 0


# ── ports.json / ports_detail.json ───────────────────────────────────────────


def test_ports_row_count_floor() -> None:
    # Live WPI rebuild produced 3,804 rows (replacing the old 1.1k set).
    assert len(_ports()) >= 3500


def test_ports_backward_compat_keys() -> None:
    for row in _ports():
        assert {"name", "lat", "lon", "wpi"} <= row.keys(), row
        assert row["wpi"]


def test_ports_detail_keyed_by_wpi() -> None:
    detail = _ports_detail()
    wpis = {r["wpi"] for r in _ports()}
    assert detail.keys() <= wpis
    assert len(detail) >= 3500


def test_ports_detail_string_fields_and_sparse_max_vessel() -> None:
    detail = _ports_detail()
    string_fields = {
        "harborSize", "harborType", "shelter", "repairs", "dryDock", "railway",
        "portSecurity", "harborUse",
    }
    max_vessel_fields = {"maxVesselLength", "maxVesselBeam", "maxVesselDraft"}
    any_max_vessel = 0
    for wpi, rec in detail.items():
        # Not every field is guaranteed present (source is sparse) but keys
        # that ARE present must be plain strings, not letter codes.
        for k in string_fields & rec.keys():
            assert isinstance(rec[k], str) and rec[k], (wpi, k, rec[k])
        for k in max_vessel_fields & rec.keys():
            assert rec[k] > 0, (wpi, k, rec[k])
            any_max_vessel += 1
    assert any_max_vessel > 0, "expected some ports to carry max-vessel dimensions"


def test_ports_detail_rotterdam_and_keppel_singapore() -> None:
    rows = {r["name"]: r["wpi"] for r in _ports()}
    detail = _ports_detail()

    rotterdam_wpi = rows["Rotterdam"]
    rd = detail[rotterdam_wpi]
    assert rd["harborSize"] == "Large"
    assert rd["repairs"] == "Major"

    keppel_wpi = next(v for k, v in rows.items() if "Singapore" in k)
    kp = detail[keppel_wpi]
    assert kp["harborSize"] == "Large"


def test_ports_detail_op_status_absent_when_wpi_lacks_it() -> None:
    # Honesty constraint (§7): no fabricated live closure/op-status field.
    for rec in _ports_detail().values():
        assert "opStatus" not in rec and "op_status" not in rec


# ── bases.json ────────────────────────────────────────────────────────────


def test_bases_row_count_floor() -> None:
    # Live Wikidata rebuild produced 7,183 de-duped rows (spec estimate 7,195).
    assert len(_bases()) >= 7000


def test_bases_shape_and_branch_vocab() -> None:
    for row in _bases():
        assert {"name", "lat", "lon", "branch"} <= row.keys(), row
        assert row["branch"] in ("air", "naval", "army"), row
        assert -90.0 <= row["lat"] <= 90.0
        assert -180.0 <= row["lon"] <= 180.0


def test_bases_no_duplicate_qid_leakage() -> None:
    # build_bases dedupes by QID keeping the most-specific branch; a coarse
    # proxy check is that (name, lat, lon) triples are not wildly duplicated.
    # A handful of coincidental duplicates are expected in crowdsourced
    # Wikidata (distinct QIDs for the same physical base) — bound, don't
    # require zero.
    keys = [(r["name"], round(r["lat"], 4), round(r["lon"], 4)) for r in _bases()]
    dupes = len(keys) - len(set(keys))
    assert dupes <= 20, f"{dupes} coincidental (name,lat,lon) duplicates — investigate if this grows"
