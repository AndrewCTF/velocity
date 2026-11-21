"""/api/maritime/military — which live AIS contacts count as military, and why."""

from __future__ import annotations

import pytest

from app.routes.maritime import military_reason


@pytest.mark.parametrize(
    ("props", "why"),
    [
        ({"shipType": 35, "name": "POSEIDON"}, "ais_type_35"),
        ({"shipType": "35"}, "ais_type_35"),
        ({"name": "USNS BRUCE HEEZEN", "mmsi": 369970000}, "hull_prefix:USNS"),
        ({"name": "knm hitra", "mmsi": 259000000}, "hull_prefix:KNM"),
        ({"name": "HMS FALKEN", "mmsi": 265500000}, "hull_prefix:HMS"),  # Swedish navy
        # Prefix on a hull from the wrong country = a private boat's name.
        ({"name": "HMS BUBBLES", "mmsi": 341000000}, None),
        ({"name": "ITS MY LIFE", "mmsi": 368000000}, None),
        ({"name": "JS FALCON", "mmsi": 268000000}, None),
        ({"name": "NATO WARSHIP A900"}, "name"),
        ({"name": "US COAST GUARD 45"}, "name"),
        # Civilian names that a loose match used to catch.
        ({"name": "KRISTIN ALEXIS"}, None),
        ({"name": "INSPIRER"}, None),
        ({"name": "SPIRIT OF NAVY PIER"}, None),
        ({"name": "LE SURCOUF"}, None),
        ({"shipType": 70, "name": "EVER GIVEN"}, None),
    ],
)
def test_military_reason(props: dict, why: str | None) -> None:
    assert military_reason(props) == why


def _snapshot(parked_only: bool = False) -> dict:
    def f(mmsi: int, name: str, t: int) -> dict:
        return {"type": "Feature", "id": f"v{mmsi}",
                "geometry": {"type": "Point", "coordinates": [5.0, 60.0]},
                "properties": {"mmsi": mmsi, "name": name, "shipType": t}}

    return {"type": "FeatureCollection", "features": [
        f(257000001, "NATO WARSHIP", 0),   # name only
        f(257000002, "EVER GIVEN", 70),    # civilian
        f(257000003, "SLEIPNER", 35),      # AIS-declared
        f(257000004, "KV BISON", 0),       # registry, no AIS hint at all
    ]}


@pytest.fixture
def _fakes(monkeypatch):  # type: ignore[no-untyped-def]
    from app.intel import naval_registry
    from app.routes import maritime

    async def registry() -> dict[int, str]:
        return {257000004: "NoCGV Bison"}

    monkeypatch.setattr(maritime, "vessel_snapshot", _snapshot)
    monkeypatch.setattr(naval_registry, "naval_mmsis", registry)


def _ids(body: dict) -> list:
    return [(x["properties"]["mmsi"], x["properties"]["confidence"]) for x in body["features"]]


def test_default_returns_every_tier_labelled(client, _fakes) -> None:  # type: ignore[no-untyped-def]
    assert _ids(client.get("/api/maritime/military").json()) == [
        (257000001, "name"), (257000003, "declared"), (257000004, "registry")
    ]


def test_a_complete_answer_carries_no_amber_note(client, _fakes) -> None:  # type: ignore[no-untyped-def]
    body = client.get("/api/maritime/military").json()
    assert "note" not in body and "AIS-dark" in body["summary"]


def test_min_confidence_narrows(client, _fakes) -> None:  # type: ignore[no-untyped-def]
    assert _ids(client.get("/api/maritime/military?min_confidence=declared").json()) == [
        (257000003, "declared"), (257000004, "registry")
    ]
    assert _ids(client.get("/api/maritime/military?min_confidence=registry").json()) == [
        (257000004, "registry")
    ]


def test_registry_parse_keeps_nine_digit_mmsis() -> None:
    from app.intel.naval_registry import parse

    body = {"results": {"bindings": [
        {"mmsi": {"value": "303902000"}, "sLabel": {"value": "USCGC Healy"}},
        {"mmsi": {"value": "12345"}, "sLabel": {"value": "bad"}},
        {"mmsi": {"value": "n/a"}},
    ]}}
    assert parse(body) == {303902000: "USCGC Healy"}
    assert parse(None) == {}
