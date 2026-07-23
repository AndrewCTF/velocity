"""Country Instability Index scorer (Phase C, worldmonitor-gaps).

Every signal source is monkeypatched at the name `instability` imported it
under (not the origin module) so these tests never touch the network and
stay independent of the individual feed modules' own test suites.
"""

from __future__ import annotations

import asyncio
import math

import pytest

from app.intel import instability


def _fc(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def _patch_all_sources(
    monkeypatch: pytest.MonkeyPatch,
    *,
    conflict_features: list[dict] | None = None,
    ucdp_features: list[dict] | None = None,
    news_stories: list[dict] | None = None,
    advisories: dict[str, int] | None = None,
    displacement: dict[str, int] | None = None,
    ioda_items: list[dict] | None = None,
    ioda_unavailable: bool = False,
    gdacs_features: list[dict] | None = None,
    quake_features: list[dict] | None = None,
    stress: dict | None = None,
) -> None:
    async def _conflict(hours: int = 72) -> dict:
        return _fc(conflict_features or [])

    async def _ucdp() -> dict:
        return _fc(ucdp_features or [])

    async def _news(kind: str) -> dict | None:
        if news_stories is None:
            return None
        return {"payload": {"stories": news_stories}}

    async def _advisories() -> dict[str, int]:
        return advisories or {}

    async def _displacement() -> dict[str, int]:
        return displacement or {}

    async def _ioda(days: int = 7) -> dict:
        return {"items": ioda_items or [], "unavailable": ioda_unavailable}

    async def _gdacs() -> dict:
        return _fc(gdacs_features or [])

    async def _quakes(range: str = "week") -> dict:
        return _fc(quake_features or [])

    async def _stress() -> dict:
        return stress if stress is not None else {"score": 0.0, "degraded": True}

    monkeypatch.setattr(instability, "conflict_events", _conflict)
    monkeypatch.setattr(instability, "ucdp_events", _ucdp)
    monkeypatch.setattr(instability, "news_latest", _news)
    monkeypatch.setattr(instability, "advisories_summary", _advisories)
    monkeypatch.setattr(instability, "displacement_summary", _displacement)
    monkeypatch.setattr(instability, "load_ioda", _ioda)
    monkeypatch.setattr(instability, "load_gdacs", _gdacs)
    monkeypatch.setattr(instability, "load_quakes", _quakes)
    monkeypatch.setattr(instability, "market_stress", _stress)


# ── hand-computed exact score ────────────────────────────────────────────────


def test_hand_computed_score_for_one_country(monkeypatch: pytest.MonkeyPatch) -> None:
    # UKR: 5 conflict events (word-boundary actor-name match on "Ukraine")
    # + 3 ucdp events (unchanged iso3 tally) = 8 armed_conflict raw.
    # 2 verified news stories (weight 2 each) = 4.0 news_pressure raw.
    # advisory level 4, 150000 displaced, 2 ioda outages, 1 orange gdacs event.
    conflict_feats = [
        {"properties": {"actor1": "Ukraine Government", "actor2": "Unidentified Forces"}}
        for _ in range(5)
    ]
    ucdp_feats = [{"properties": {"iso3": "UKR"}} for _ in range(3)]
    news = [
        {
            "countries": ["UKR"],
            "verification": {"status": "verified-neutral"},
        },
        {
            "countries": ["UKR"],
            "verification": {"status": "contested"},
        },
        {
            "countries": ["FRA"],  # different country — must not leak into UKR
            "verification": {"status": "verified-neutral"},
        },
    ]
    _patch_all_sources(
        monkeypatch,
        conflict_features=conflict_feats,
        ucdp_features=ucdp_feats,
        news_stories=news,
        advisories={"UKR": 4},
        displacement={"UKR": 150_000},
        ioda_items=[
            {"entity": {"type": "country", "code": "UA"}},
            {"entity": {"type": "country", "code": "UA"}},
        ],
        gdacs_features=[
            {"properties": {"country": "Ukraine", "alert": "orange"}},
        ],
        stress={"score": 30.0, "degraded": False},
    )

    rows = asyncio.run(instability.score_all())
    row = next(r for r in rows if r["iso3"] == "UKR")

    by_key = {c["key"]: c for c in row["components"]}

    armed_raw = 8.0
    armed_norm = 100.0 * (1.0 - math.exp(-armed_raw / instability._K_ARMED_CONFLICT))
    assert by_key["armed_conflict"]["raw"] == armed_raw
    assert by_key["armed_conflict"]["normalized"] == round(armed_norm, 2)

    news_raw = 4.0
    news_norm = 100.0 * (1.0 - math.exp(-news_raw / instability._K_NEWS_PRESSURE))
    assert by_key["news_pressure"]["raw"] == news_raw
    assert by_key["news_pressure"]["normalized"] == round(news_norm, 2)

    assert by_key["unrest_advisories"]["raw"] == 4
    assert by_key["unrest_advisories"]["normalized"] == 100.0  # level 4 -> (4-1)/3*100

    disp_norm = 100.0 * math.log10(150_000 + 1.0) / math.log10(instability._DISPLACEMENT_CAP + 1.0)
    assert by_key["displacement"]["raw"] == 150_000
    assert by_key["displacement"]["normalized"] == round(disp_norm, 2)

    infra_raw = 2.0
    infra_norm = 100.0 * (1.0 - math.exp(-infra_raw / instability._K_INFRA_DISRUPTION))
    assert by_key["infra_disruption"]["raw"] == infra_raw
    assert by_key["infra_disruption"]["normalized"] == round(infra_norm, 2)

    hazard_raw = 2.0  # orange weight
    hazard_norm = 100.0 * (1.0 - math.exp(-hazard_raw / instability._K_NATURAL_HAZARD))
    assert by_key["natural_hazard"]["raw"] == hazard_raw
    assert by_key["natural_hazard"]["normalized"] == round(hazard_norm, 2)

    assert by_key["market_risk_off"]["raw"] == 30.0
    assert by_key["market_risk_off"]["normalized"] == 30.0

    # Weighted sum over ALL seven components (all present for UKR), weights
    # renormalized to sum to 1 (they already do, since all are present).
    weight_sum = sum(instability.COMPONENT_WEIGHTS.values())
    assert weight_sum == pytest.approx(1.0)
    expected_score = sum(
        by_key[k]["normalized"] * instability.COMPONENT_WEIGHTS[k]
        for k in instability.COMPONENT_WEIGHTS
    ) / weight_sum
    assert row["score"] == round(expected_score, 1)
    assert set(row["components_present"]) == set(instability.COMPONENT_WEIGHTS)

    # FRA has only 1 non-global signal (a news story) -> below the min-2 floor,
    # so it must not appear even though it appears in the raw news dict.
    assert not any(r["iso3"] == "FRA" for r in rows)


# ── component drop + renormalization ────────────────────────────────────────


def test_missing_component_drops_and_renormalizes(monkeypatch: pytest.MonkeyPatch) -> None:
    # displacement_summary + advisories both empty for RUS but armed_conflict
    # and news_pressure are present -> RUS still scores (2 non-global present),
    # weights renormalize over the components that ARE present, then clamp:
    # armed_conflict's 0.30/0.45=0.667 renormalized share is capped at 0.40
    # (see test_armed_conflict_weight_is_clamped_not_50_percent below), so
    # the two weights no longer sum back to 1.0.
    _patch_all_sources(
        monkeypatch,
        conflict_features=[
            {"properties": {"actor1": "Russian Federation Armed Forces", "actor2": "Rebels"}}
            for _ in range(5)
        ],
        news_stories=[{"countries": ["RUS"], "verification": {"status": "reviewed"}}],
        advisories={},
        displacement={},
        stress=None,  # market source down
    )
    rows = asyncio.run(instability.score_all())
    row = next(r for r in rows if r["iso3"] == "RUS")
    by_key = {c["key"]: c for c in row["components"]}
    assert set(by_key) == {"armed_conflict", "news_pressure"}
    assert by_key["armed_conflict"]["weight"] == instability._MAX_COMPONENT_WEIGHT
    assert by_key["news_pressure"]["weight"] == pytest.approx(0.15 / 0.45, abs=1e-4)
    total_weight = sum(c["weight"] for c in row["components"])
    assert total_weight < 1.0


def test_armed_conflict_weight_is_clamped_not_50_percent(monkeypatch: pytest.MonkeyPatch) -> None:
    # The GBR/AUS bug from the persona findings: with only the 4 baseline
    # components present (armed_conflict + unrest_advisories + displacement +
    # market_risk_off), armed_conflict's base 0.30 used to renormalize up to
    # 0.30/0.60 = 0.50 exactly -- the single noisiest, least-attributable
    # component swinging half the score. The clamp caps it at 0.40 and does
    # NOT redistribute the freed 0.10 to the other three.
    _patch_all_sources(
        monkeypatch,
        conflict_features=[
            {"properties": {"actor1": "Chad Government forces", "actor2": "Rebels"}}
            for _ in range(5)
        ],
        advisories={"TCD": 3},
        displacement={"TCD": 50_000},
        stress={"score": 20.0, "degraded": False},
    )
    rows = asyncio.run(instability.score_all())
    row = next(r for r in rows if r["iso3"] == "TCD")
    by_key = {c["key"]: c for c in row["components"]}
    assert set(by_key) == {
        "armed_conflict", "unrest_advisories", "displacement", "market_risk_off",
    }
    assert by_key["armed_conflict"]["weight"] == instability._MAX_COMPONENT_WEIGHT
    assert by_key["armed_conflict"]["weight"] < 0.5  # never the old 0.30/0.60
    # The other three keep their unclamped renormalized share (0.10/0.60
    # each) -- the clamped-off excess is dropped, not handed to them.
    for key in ("unrest_advisories", "displacement", "market_risk_off"):
        assert by_key[key]["weight"] == pytest.approx(0.10 / 0.60, abs=1e-4)
    total_weight = sum(c["weight"] for c in row["components"])
    assert total_weight == pytest.approx(0.40 + 3 * (0.10 / 0.60), abs=1e-4)
    assert total_weight < 1.0


# ── dead-source tolerance ────────────────────────────────────────────────────


def test_dead_source_does_not_crash_scorer(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("upstream is down")

    _patch_all_sources(
        monkeypatch,
        conflict_features=[
            {"properties": {"actor1": "Sudan Government", "actor2": "Rebels"}}
            for _ in range(3)
        ],
        news_stories=[{"countries": ["SDN"], "verification": {"status": "reviewed"}}],
    )
    monkeypatch.setattr(instability, "load_ioda", _boom)
    monkeypatch.setattr(instability, "load_gdacs", _boom)

    rows = asyncio.run(instability.score_all())
    row = next(r for r in rows if r["iso3"] == "SDN")
    assert "infra_disruption" not in row["components_present"]
    assert "natural_hazard" not in row["components_present"]


# ── min-2-non-global-components rule ────────────────────────────────────────


def test_country_with_only_one_local_component_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_all_sources(
        monkeypatch,
        conflict_features=[{"properties": {"iso3": "MCO"}}],
        stress={"score": 40.0, "degraded": False},
    )
    rows = asyncio.run(instability.score_all())
    assert not any(r["iso3"] == "MCO" for r in rows)


def test_ioda_unavailable_drops_infra_disruption_for_everyone(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_all_sources(
        monkeypatch,
        conflict_features=[
            {"properties": {"actor1": "Yemen Government", "actor2": "Rebels"}}
            for _ in range(4)
        ],
        news_stories=[{"countries": ["YEM"], "verification": {"status": "reviewed"}}],
        ioda_items=[{"entity": {"type": "country", "code": "YE"}}],
        ioda_unavailable=True,
    )
    rows = asyncio.run(instability.score_all())
    row = next(r for r in rows if r["iso3"] == "YEM")
    assert "infra_disruption" not in row["components_present"]


# ── score_and_store ──────────────────────────────────────────────────────────


def test_score_and_store_persists_rows(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from app.intel import instability_local

    instability_local.override_db_path(str(tmp_path / "instability.db"))
    try:
        _patch_all_sources(
            monkeypatch,
            conflict_features=[
                {"properties": {"actor1": "Myanmar Government", "actor2": "Rebels"}}
                for _ in range(4)
            ],
            news_stories=[{"countries": ["MMR"], "verification": {"status": "reviewed"}}],
        )
        n = asyncio.run(instability.score_and_store())
        assert n == 1
        latest = asyncio.run(instability_local.latest_all())
        assert "MMR" in latest
    finally:
        instability_local.override_db_path(None)


def test_ioda_country_parses_live_codf_location_strings() -> None:
    from app.intel.instability import _ioda_country

    # Live shape probed 2026-07-21: codf events carry location "type/code".
    assert _ioda_country({"location": "country/UA"}) == "UKR"
    assert _ioda_country({"location": "country/SD"}) == "SDN"
    assert _ioda_country({"location": "asn/3605"}) is None
    assert _ioda_country({"location": "region/1234"}) is None
