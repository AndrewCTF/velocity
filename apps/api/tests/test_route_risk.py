"""score_route_risk — threat-aware route scoring (the Gotham least-risk / EMI axis).

Pure, no I/O: proves a route through a jamming cell scores risk by severity and
exposure, a clear route scores 0, and emi_resistance mirrors risk.
"""

from __future__ import annotations

from app.routes.route import score_route_risk

# One HIGH jamming cell at (10, 50), ~50 km ring.
HIGH = [{"lon": 10.0, "lat": 50.0, "severity": "high", "radius_km": 50.0}]
MED = [{"lon": 10.0, "lat": 50.0, "severity": "medium", "radius_km": 50.0}]


def test_clear_route_zero_risk() -> None:
    route = [[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]  # far from any threat
    s = score_route_risk(route, HIGH)
    assert s["risk"] == 0.0
    assert s["emi_resistance"] == 100.0
    assert s["worst_severity"] == "none"
    assert s["exposed_pts"] == 0


def test_route_fully_in_high_cell_is_max_risk() -> None:
    route = [[10.0, 50.0], [10.05, 50.05], [9.95, 49.98]]  # all within ~50 km
    s = score_route_risk(route, HIGH)
    assert s["risk"] == 100.0
    assert s["emi_resistance"] == 0.0
    assert s["worst_severity"] == "high"
    assert s["exposed_pts"] == 3


def test_medium_scores_lower_than_high() -> None:
    route = [[10.0, 50.0], [10.02, 50.02]]
    assert score_route_risk(route, MED)["risk"] < score_route_risk(route, HIGH)["risk"]
    # medium weight 2/3 → ~66.7 when fully exposed
    assert score_route_risk(route, MED)["risk"] == 66.7


def test_partial_exposure_scales() -> None:
    # 2 of 4 vertices inside the HIGH cell → avg weight (3+3+0+0)/(4*3) = 0.5 → 50
    route = [[10.0, 50.0], [10.02, 50.02], [0.0, 0.0], [1.0, 1.0]]
    s = score_route_risk(route, HIGH)
    assert s["risk"] == 50.0
    assert s["exposed_pts"] == 2
    assert s["worst_severity"] == "high"


def test_empty_route() -> None:
    s = score_route_risk([], HIGH)
    assert s["risk"] == 0.0 and s["total_pts"] == 0
