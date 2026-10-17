"""focus_area polygon support.

/api/intel/area only knows a circle, so a ring is fetched as its bounding circle and
the bundle that comes back is clipped to the ring inside the MCP tool. Nothing here
touches the network: ``M._get`` is replaced.

The clip tests do NOT hand-write the bundle. They run the real
``analytics.area_intel`` (the code behind the route) with its three in-process inputs
faked (the AOI fetch, the vessel store, the alert bus) and JSON-roundtrip the result
the way HTTP would. That ties the fixture to the real bundle shape, and lets
``test_every_positioned_list_in_the_bundle_is_one_the_clip_knows`` fail the day
analytics adds a point-bearing list that the clip would otherwise let through.
"""

from __future__ import annotations

import copy
import json
import math
import time
from typing import Any

import pytest
from mcp.server.fastmcp.exceptions import ToolError

from app import mcp_server as M
from app.correlate.types import Alert, Observation
from app.geo.adminshapes import _ring_contains
from app.intel import analytics
from app.intel.geo import NM_TO_KM, haversine_km
from app.routes.jamming import _hex_cell, _hex_center

# A "C" opening east. Its notch (lon 1.5..4, lat 1.5..2.5) lies inside the ring's
# convex hull AND inside its bounding circle, but outside the ring itself: exactly
# the case a circle-only (or hull-only) filter gets wrong.
RING = [
    (0.0, 0.0), (4.0, 0.0), (4.0, 1.5), (1.5, 1.5),
    (1.5, 2.5), (4.0, 2.5), (4.0, 4.0), (0.0, 4.0),
]
IN_BOTTOM, IN_SPINE, IN_TOP = (2.0, 0.7), (0.7, 2.0), (2.0, 3.3)
NOTCH, WEST = (3.0, 2.0), (-0.6, 2.0)
# Density cells are kept by their centre. 0.5 deg puts every fixture point's cell
# centre on the same side of the ring as the point itself.
CELL_DEG = 0.5

CLIPPED_LISTS = (
    "aircraft.sample",
    "density.cells",
    "gps_jamming.cells",
    "gps_jamming.affected_aircraft_sample",
    "vessels.vessels",
    "anomalies.emergency_aircraft",
    "anomalies.jamming_hotspots",
    "anomalies.dark_vessel_candidates",
    "anomalies.fusion_alerts",
)


@pytest.fixture(autouse=True)
def _no_autostart(monkeypatch: pytest.MonkeyPatch) -> None:
    # Never spawn a real uvicorn from a test if a call slips past the _get fake.
    monkeypatch.setenv("OSINT_MCP_NO_AUTOSTART", "1")
    M._BACKEND_READY = False
    M._BACKEND_PROC = None


class World:
    """The in-process inputs ``analytics.area_intel`` reads, plus a fake ``M._get``.

    One object plays the AOI loader (``focus``), the vessel store (``latest``) and
    the alert bus (``recent_shared``); the fixture below wires it into analytics."""

    def __init__(self) -> None:
        self.features: list[dict[str, Any]] = []
        self.vessels: list[Observation] = []
        self.alerts: list[Alert] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.raw: dict[str, Any] = {}  # the last UNCLIPPED bundle the fake route served

    async def focus(
        self, lat: float, lon: float, radius_nm: float = 200.0, label: str | None = None
    ) -> dict[str, Any]:
        return {
            "aoi": {"id": "test", "center": {"lat": lat, "lon": lon}, "radius_nm": radius_nm},
            "fc": {"type": "FeatureCollection", "features": self.features},
            "mode": "direct",
            "host": "test",
        }

    def latest(self, kind: str | None = None) -> list[Observation]:
        return [o for o in self.vessels if kind is None or o.emits_kind == kind]

    def recent_shared(self, n: int = 50) -> list[Alert]:
        return list(self.alerts)

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        p = dict(params or {})
        self.calls.append((path, p))
        bundle = await analytics.area_intel(
            lat=p["lat"],
            lon=p["lon"],
            radius_nm=p["radius_nm"],
            label=p.get("label"),
            set_primary=p["primary"],
            cell_deg=p["cell_deg"],
        )
        self.raw = json.loads(json.dumps(bundle))
        return json.loads(json.dumps(bundle))  # a fresh copy per call, as HTTP gives


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> World:
    w = World()
    monkeypatch.setattr(analytics.aoi, "focus", w.focus)
    monkeypatch.setattr(analytics, "store", w)
    monkeypatch.setattr(analytics, "bus", w)
    monkeypatch.setattr(analytics, "jamming_recent", lambda n=50: [])
    monkeypatch.setattr(M, "_get", w.get)
    return w


def _aircraft(icao: str, at: tuple[float, float], **props: Any) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [at[0], at[1], 10000.0]},
        "properties": {"icao24": icao, "callsign": f"T{icao}", "nac_p": 9, "nic": 8, **props},
    }


def _vessel(
    n: int, at: tuple[float, float], ship_type: int | None = 70, name: str | None = "V"
) -> Observation:
    return Observation(
        id=f"vessel:{n}", source="test", t=time.time(), lon=at[0], lat=at[1],
        emits_kind="vessel",
        attrs={"mmsi": str(200000000 + n), "name": name, "shipType": ship_type,
               "sog": 5.0, "cog": 90.0},
    )


def _alert(n: int, at: tuple[float, float]) -> Alert:
    return Alert(
        id=f"alert-{n}", rule_id="test", severity="high", t=time.time(),
        lon=at[0], lat=at[1], confidence=0.9, message=f"alert {n}",
    )


def _small_scene(w: World) -> None:
    """11 aircraft, 5 vessels, 2 alerts. Every list in the bundle holds a record
    inside the ring and one outside it, and no list reaches its cap, so every total
    in the bundle is recomputable."""
    hex_in = _hex_center(*_hex_cell(*IN_SPINE))  # (1.074, 1.86): inside the ring
    hex_out = _hex_center(*_hex_cell(*NOTCH))  # (3.222, 1.86): in the notch
    w.features = [
        _aircraft("400001", IN_BOTTOM, squawk="7700"),
        _aircraft("400002", IN_SPINE),
        _aircraft("400003", IN_TOP),
        _aircraft("400004", NOTCH, squawk="7600"),
        _aircraft("400005", WEST),
        *[_aircraft(f"4001{i:02x}", hex_in, nac_p=2) for i in range(3)],  # jammed hex, in
        *[_aircraft(f"4002{i:02x}", hex_out, nac_p=2) for i in range(3)],  # jammed hex, out
    ]
    w.vessels = [
        _vessel(1, (1.0, 0.5)),
        _vessel(2, NOTCH),
        _vessel(3, WEST),
        _vessel(4, (0.7, 3.0), ship_type=None, name=None),  # dark, inside
        _vessel(5, (2.5, 2.0), ship_type=None, name=None),  # dark, in the notch
    ]
    w.alerts = [_alert(1, IN_SPINE), _alert(2, NOTCH)]


def _crowded_scene(w: World) -> None:
    """The small scene plus 60 aircraft and 60 vessels, so the bundle's 50-item
    aircraft and vessel samples are capped."""
    _small_scene(w)
    spots = [IN_BOTTOM, NOTCH, IN_TOP, WEST, IN_SPINE]  # i % 5 in (0, 2, 4) is inside
    w.features += [
        _aircraft(f"4003{i:02x}", (spots[i % 5][0] + i * 0.0005, spots[i % 5][1]))
        for i in range(60)
    ]
    w.vessels += [
        _vessel(100 + i, (spots[i % 5][0] + i * 0.0005, spots[i % 5][1])) for i in range(60)
    ]


def _ring_arg() -> list[list[float]]:
    return [[x, y] for x, y in RING]


async def _focus(**kw: Any) -> dict[str, Any]:
    kw.setdefault("cell_deg", CELL_DEG)
    kw.setdefault("detail", "long")
    return await M.focus_area(0.0, 0.0, polygon=_ring_arg(), **kw)


def _inside(feature_or_row: dict[str, Any]) -> bool:
    if "geometry" in feature_or_row:
        x, y = feature_or_row["geometry"]["coordinates"][:2]
    else:
        x, y = feature_or_row["lon"], feature_or_row["lat"]
    return _ring_contains(RING, x, y)


def _positioned_lists(node: Any, path: str = "") -> dict[str, list[Any]]:
    """Every list in the bundle that holds at least one record with a position."""
    found: dict[str, list[Any]] = {}
    if isinstance(node, dict):
        for key, value in node.items():
            found.update(_positioned_lists(value, f"{path}.{key}" if path else key))
    elif isinstance(node, list) and any(M._rec_lonlat(x) is not None for x in node):
        found[path] = node
    return found


# ── fixture premises ──────────────────────────────────────────────────────────


def test_the_fixture_premises_hold() -> None:
    """The scenes below mean nothing unless the notch and the west point really are
    inside the bounding circle while outside the ring."""
    lat, lon, radius = M._bounding_circle(RING)
    for name, (x, y) in {"notch": NOTCH, "west": WEST}.items():
        assert not _ring_contains(RING, x, y), name
        assert haversine_km(lon, lat, x, y) / NM_TO_KM < radius, name
    for x, y in (IN_BOTTOM, IN_SPINE, IN_TOP):
        assert _ring_contains(RING, x, y)


# ── what is fetched ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_ring_is_fetched_as_its_bounding_circle(world: World) -> None:
    _small_scene(world)
    # lat/lon/radius_nm given alongside a ring are overridden by it
    await M.focus_area(89.0, 179.0, 10.0, "C ring", CELL_DEG, "long", _ring_arg())
    ((path, params),) = world.calls
    assert path == "/api/intel/area"
    assert "polygon" not in params  # not a declared query parameter of the route
    assert params["primary"] is True
    assert params["label"] == "C ring"
    assert params["cell_deg"] == CELL_DEG
    assert (params["lat"], params["lon"]) == (2.0, 2.375)  # vertex mean
    radius = params["radius_nm"]
    assert radius == math.floor(radius)  # a whole nm: aoi._clamp_radius floors with int()
    assert 1 <= radius <= 250
    far_nm = max(haversine_km(params["lon"], params["lat"], x, y) for x, y in RING) / NM_TO_KM
    assert radius >= far_nm + 1.0  # the circle holds every vertex with room to spare


@pytest.mark.asyncio
async def test_closed_and_open_rings_give_the_same_answer(world: World) -> None:
    _small_scene(world)
    open_out = await _focus()
    closed = _ring_arg() + [_ring_arg()[0]]
    closed_out = await M.focus_area(0.0, 0.0, cell_deg=CELL_DEG, detail="long", polygon=closed)
    assert closed_out == open_out
    assert closed_out["polygon_vertices"] == len(RING)


# ── what is kept and dropped ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_inside_the_circle_but_outside_the_ring_is_dropped(world: World) -> None:
    _small_scene(world)
    out = await _focus()

    in_ring = {"400001", "400002", "400003", "400100", "400101", "400102"}
    assert {r["icao24"] for r in out["aircraft"]["sample"]} == in_ring
    # the notch and west aircraft were in the fetched circle, so they were served
    served = {r["icao24"] for r in world.raw["aircraft"]["sample"]}
    assert {"400004", "400005"} <= served

    assert {v["mmsi"] for v in out["vessels"]["vessels"]} == {"200000001", "200000004"}
    an = out["anomalies"]
    assert [a["icao24"] for a in an["emergency_aircraft"]] == ["400001"]  # 7600 in notch gone
    assert [v["mmsi"] for v in an["dark_vessel_candidates"]] == ["200000004"]
    assert len(an["jamming_hotspots"]) == 1
    assert len(out["gps_jamming"]["cells"]) == 1
    assert len(out["gps_jamming"]["affected_aircraft_sample"]) == 3
    # an alert carries its position as geom.coordinates, not lon/lat keys
    assert [a["id"] for a in an["fusion_alerts"]] == ["alert-1"]
    assert out["density"]["cells"]
    assert all(_ring_contains(RING, c["lon"], c["lat"]) for c in out["density"]["cells"])


@pytest.mark.asyncio
async def test_counts_match_the_lists_when_the_bundle_lists_were_complete(world: World) -> None:
    _small_scene(world)
    out = await _focus()

    ac = out["aircraft"]
    assert ac["count"] == len(ac["sample"]) == 6
    assert ac["by_category"] == {"emergency": 1, "airliner": 5}
    assert ac["gnss_degraded"] == 3

    dn = out["density"]
    assert dn["total"] == 6
    assert dn["occupied_cells"] == len(dn["cells"]) == 4
    assert dn["by_category"] == {"emergency": 1, "airliner": 5}
    assert dn["peak_cell"] == dn["cells"][0]
    assert dn["peak_cell"]["count"] == 3

    jm = out["gps_jamming"]["summary"]
    assert (jm["cells_flagged"], jm["high"], jm["medium"], jm["low"]) == (1, 1, 0, 0)

    vs = out["vessels"]
    assert (vs["matched_total"], vs["returned"], vs["truncated"]) == (2, 2, False)
    assert vs["by_category"] == {"cargo": 1, "other": 1}

    # nothing was demoted to a circle-level figure in this section
    for section in ("aircraft", "density", "vessels"):
        assert not [k for k in out[section] if k.endswith("_in_circle")], section
    assert not [k for k in jm if k.endswith("_in_circle")]


@pytest.mark.asyncio
async def test_totals_a_capped_sample_cannot_give_move_to_in_circle(world: World) -> None:
    _crowded_scene(world)
    out = await _focus()
    raw_sample = world.raw["aircraft"]["sample"]
    assert len(raw_sample) == 50 and world.raw["aircraft"]["count"] == 71  # capped, as in prod

    ac = out["aircraft"]
    # 71 is the circle's figure. The ring's own total is NOT len(sample) and not 71.
    assert "count" not in ac and ac["count_in_circle"] == 71
    assert "by_category" not in ac and "gnss_degraded" not in ac
    assert "by_category_in_circle" in ac and "gnss_degraded_in_circle" in ac
    expected = {r["icao24"] for r in raw_sample if _inside(r)}
    assert {r["icao24"] for r in ac["sample"]} == expected and 0 < len(expected) < 50

    vs = out["vessels"]
    assert world.raw["vessels"]["truncated"] is True
    assert "matched_total" not in vs and vs["matched_total_in_circle"] == 65
    assert vs["truncated"] is True  # the list is still a sample of an unknown ring total
    assert vs["returned"] == len(vs["vessels"]) == len([v for v in world.raw["vessels"]["vessels"] if _inside(v)])

    # the density grid lists every aircraft, so it stays exact: 6 small-scene + 36
    # generated aircraft sit inside the ring (and each cell centre is on its side)
    assert out["density"]["total"] == 42
    assert "total_in_circle" not in out["density"]
    assert "_in_circle" in out["polygon_note"]


@pytest.mark.asyncio
async def test_the_threat_verdict_stays_the_circles_and_is_not_recomputed(world: World) -> None:
    _small_scene(world)
    out = await _focus()
    an, raw = out["anomalies"], world.raw["anomalies"]
    assert "score" not in an and "threat_level" not in an
    assert an["score_in_circle"] == raw["score"]  # verbatim
    assert an["threat_level_in_circle"] == raw["threat_level"] == "high"


@pytest.mark.asyncio
async def test_polygon_dropped_names_every_clipped_list(world: World) -> None:
    _small_scene(world)
    out = await _focus()
    assert out["polygon_dropped"] == {
        "aircraft.sample": 5,
        "density.cells": 3,
        "gps_jamming.cells": 1,
        "gps_jamming.affected_aircraft_sample": 3,
        "vessels.vessels": 3,
        "anomalies.emergency_aircraft": 1,
        "anomalies.jamming_hotspots": 1,
        "anomalies.dark_vessel_candidates": 1,
        "anomalies.fusion_alerts": 1,
    }
    assert set(out["polygon_dropped"]) == set(CLIPPED_LISTS)
    assert out["polygon_vertices"] == len(RING)
    assert out["bounding_circle"] == {"lat": 2.0, "lon": 2.375, "radius_nm": 191.0}
    assert "polygon_truncated" not in out  # 191 nm fits the 250 nm cap


@pytest.mark.asyncio
async def test_every_positioned_list_in_the_bundle_is_one_the_clip_knows(world: World) -> None:
    """The guard against silent leakage. If analytics.area_intel grows a list of
    positioned records, the clip does not know it and would pass its out-of-ring
    records straight through: this test names the new path."""
    _small_scene(world)
    await _focus()
    assert set(_positioned_lists(world.raw)) == set(CLIPPED_LISTS)


@pytest.mark.asyncio
@pytest.mark.parametrize("scene", [_small_scene, _crowded_scene], ids=["small", "crowded"])
async def test_no_positioned_record_outside_the_ring_survives(world: World, scene: Any) -> None:
    scene(world)
    out = await _focus()
    lists = _positioned_lists(out)
    assert lists  # not vacuous
    for path, rows in lists.items():
        for row in rows:
            lon, lat = M._rec_lonlat(row)  # type: ignore[misc]
            assert _ring_contains(RING, lon, lat), (path, row)


@pytest.mark.asyncio
async def test_a_record_without_a_position_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    bundle = {
        "vessels": {
            "matched_total": 3, "returned": 3, "truncated": False, "by_category": {"cargo": 3},
            "vessels": [
                {"category": "cargo", "lon": 1.0, "lat": 0.5},
                {"category": "cargo"},
                {"category": "cargo", "lon": None, "lat": None},
            ],
        }
    }

    async def fake_get(path: str, params: Any = None) -> dict[str, Any]:
        return copy.deepcopy(bundle)

    monkeypatch.setattr(M, "_get", fake_get)
    out = await _focus()
    assert [v["lon"] for v in out["vessels"]["vessels"]] == [1.0]
    assert (out["vessels"]["matched_total"], out["vessels"]["returned"]) == (1, 1)
    assert out["polygon_dropped"] == {"vessels.vessels": 2}


# ── detail shaping and non-mutation ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_short_digest_counts_the_clipped_lists(world: World) -> None:
    _crowded_scene(world)
    short = await _focus(detail="short")
    long = await _focus(detail="long")
    clipped = len(long["aircraft"]["sample"])
    assert clipped > 5
    assert len(short["aircraft"]["sample"]) == 5
    assert short["aircraft"]["sample_total"] == clipped  # the filtered size, not 50
    assert short["truncated"] is True and "detail='long'" in short["hint"]
    assert short["polygon_dropped"] == long["polygon_dropped"]
    assert short["polygon_note"] == long["polygon_note"]
    assert not short["polygon_note"].endswith("…")  # the shaper's 240-char cap spared it


@pytest.mark.asyncio
async def test_the_bundle_get_returned_is_not_mutated(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    _small_scene(world)
    await _focus()
    shared = copy.deepcopy(world.raw)
    pristine = copy.deepcopy(shared)

    async def same_object(path: str, params: Any = None) -> dict[str, Any]:
        return shared

    monkeypatch.setattr(M, "_get", same_object)
    first = await _focus()
    second = await _focus()
    assert shared == pristine  # a fake _get that hands back one dict must not be corrupted
    assert first == second


# ── the 250 nm cap ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_ring_over_250_nm_is_answered_and_flagged(world: World) -> None:
    wide = [[-5.0, -1.0], [5.0, -1.0], [5.0, 1.0], [-5.0, 1.0]]  # ~306 nm from its centre
    out = await M.focus_area(0.0, 0.0, cell_deg=CELL_DEG, detail="long", polygon=wide)
    ((_, params),) = world.calls
    assert params["radius_nm"] == 250.0  # clamped, still asked for
    assert (params["lat"], params["lon"]) == (0.0, 0.0)
    assert out["polygon_truncated"] is True
    assert "250" in out["polygon_note"] and "\n" not in out["polygon_note"]
    assert out["bounding_circle"]["radius_nm"] == 250.0
    assert "error" not in out


# ── input validation ──────────────────────────────────────────────────────────

_TRI = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]
_BAD = {
    "nan lon": [[float("nan"), 0.0], *_TRI[1:]],
    "inf lat": [[0.0, float("inf")], *_TRI[1:]],
    "-inf lon": [[float("-inf"), 0.0], *_TRI[1:]],
    "int too large for a float": [[10**400, 0], *_TRI[1:]],
    "lat above 90": [[0.0, 90.5], *_TRI[1:]],
    "lat below -90": [[0.0, -90.5], *_TRI[1:]],
    "lon above 180": [[180.5, 0.0], *_TRI[1:]],
    "lon below -180": [[-180.5, 0.0], *_TRI[1:]],
    "empty": [],
    "two vertices": [[0.0, 0.0], [1.0, 1.0]],
    "closed ring of two distinct points": [[0.0, 0.0], [1.0, 1.0], [0.0, 0.0]],
    "four entries, two distinct": [[0.0, 0.0], [1.0, 1.0], [0.0, 0.0], [1.0, 1.0]],
    "collinear": [[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]],
    "501 vertices": [[i / 1000.0, (i * i % 997) / 1000.0] for i in range(501)],
    "502 entries": [[i / 1000.0, (i * i % 997) / 1000.0] for i in range(502)],
    "vertex of strings": [["a", "b"], *_TRI[1:]],
    "vertex of bools": [[True, False], *_TRI[1:]],
    "vertex of one number": [[0.0], *_TRI[1:]],
    "vertex of four numbers": [[0.0, 0.0, 0.0, 0.0], *_TRI[1:]],
    "vertex that is a scalar": [5.0, *_TRI[1:]],
    "a string": "POLYGON((0 0,1 0,0 1))",
    "a GeoJSON object": {"type": "Polygon", "coordinates": [_TRI]},
}


@pytest.mark.asyncio
@pytest.mark.parametrize("polygon", list(_BAD.values()), ids=list(_BAD))
async def test_invalid_rings_are_rejected_before_the_backend(
    monkeypatch: pytest.MonkeyPatch, polygon: Any
) -> None:
    async def boom(path: str, params: Any = None) -> dict[str, Any]:
        raise AssertionError("an invalid ring must not reach the backend")

    monkeypatch.setattr(M, "_get", boom)
    out = await M.focus_area(0.0, 0.0, polygon=polygon)
    assert out["error"] == "bad_polygon"
    assert isinstance(out["detail"], str) and out["detail"]
    assert "[lon, lat]" in out["hint"]


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), 10**400])
async def test_a_non_finite_coordinate_says_so(monkeypatch: pytest.MonkeyPatch, bad: Any) -> None:
    """NaN and +-inf also fail the range check; the message must name the real cause."""

    async def boom(path: str, params: Any = None) -> dict[str, Any]:
        raise AssertionError("an invalid ring must not reach the backend")

    monkeypatch.setattr(M, "_get", boom)
    out = await M.focus_area(0.0, 0.0, polygon=[[0.0, 0.0], [1.0, 0.0], [0.0, bad]])
    assert out["error"] == "bad_polygon"
    assert "vertex 2" in out["detail"] and "finite" in out["detail"]


@pytest.mark.asyncio
async def test_a_bad_vertex_is_named_by_index(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(path: str, params: Any = None) -> dict[str, Any]:
        raise AssertionError("an invalid ring must not reach the backend")

    monkeypatch.setattr(M, "_get", boom)
    out = await M.focus_area(0.0, 0.0, polygon=[[0.0, 0.0], [1.0, 0.0], [0.0, 91.0]])
    assert out["error"] == "bad_polygon" and "vertex 2" in out["detail"]
    assert "outside -90..90" in out["detail"]


@pytest.mark.asyncio
async def test_a_valid_ring_with_altitude_members_and_ints_is_accepted(world: World) -> None:
    out = await M.focus_area(0.0, 0.0, polygon=[[0, 0, 100], [4, 0, 100], [0, 4, 100]])
    assert "error" not in out
    assert out["polygon_vertices"] == 3


@pytest.mark.asyncio
async def test_a_backend_error_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    async def down(path: str, params: Any = None) -> dict[str, Any]:
        return {"error": "backend_500", "detail": "boom", "url": "http://x"}

    monkeypatch.setattr(M, "_get", down)
    out = await _focus()
    assert out == {"error": "backend_500", "detail": "boom", "url": "http://x"}


# ── the circle form is untouched ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_circle_form_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, dict[str, Any]]] = []
    big = {"aircraft": {"count": 3, "sample": [{"lon": 1, "lat": 1}] * 12}, "threat": "low"}

    async def fake_get(path: str, params: Any = None) -> dict[str, Any]:
        seen.append((path, params))
        return big

    monkeypatch.setattr(M, "_get", fake_get)
    out = await M.focus_area(50.0, 8.0, 150.0, "FRA", 2.0, "long")
    assert out is big  # long is the untouched bundle: no polygon keys, nothing clipped
    assert seen == [
        (
            "/api/intel/area",
            {"lat": 50.0, "lon": 8.0, "radius_nm": 150.0, "label": "FRA",
             "primary": True, "cell_deg": 2.0},
        )
    ]
    short = await M.focus_area(50.0, 8.0)  # default detail is still the short digest
    assert short["aircraft"]["sample_total"] == 12
    assert not [k for k in short if k.startswith("polygon") or k == "bounding_circle"]


# ── the schema the agent sees, and the transport path ─────────────────────────


def test_the_schema_offers_polygon_and_makes_the_centre_optional() -> None:
    tool = M.mcp._tool_manager.get_tool("focus_area")
    assert tool is not None
    # A polygon carries the area by itself, so the centre is no longer required;
    # a call with neither gets a missing_area error (tested below).
    assert not tool.parameters.get("required")
    poly = tool.parameters["properties"]["polygon"]
    kinds = {b.get("type") for b in poly["anyOf"]}
    assert kinds == {"array", "null"}
    arr = next(b for b in poly["anyOf"] if b.get("type") == "array")
    assert arr["items"]["type"] == "array" and arr["items"]["items"]["type"] == "number"
    # the description IS the prompt the model reads: pin the caveats an agent would
    # otherwise get wrong (axis order, the cap, what a *_in_circle total means)
    desc = tool.description
    assert "polygon" in desc and "[lon, lat]" in desc and "longitude" in desc
    assert "FIRST" in desc and "250 nm" in desc and "_in_circle" in desc


@pytest.mark.asyncio
async def test_an_invalid_ring_reaches_the_transport_as_a_tool_error() -> None:
    tool = M.mcp._tool_manager.get_tool("focus_area")
    assert tool is not None
    with pytest.raises(ToolError) as exc:
        await tool.run({"lat": 0.0, "lon": 0.0, "polygon": [[0, 0], [1, 1]]})
    body = json.loads(str(exc.value).split(M._ERROR_PREFIX, 1)[1])
    assert body["error"] == "bad_polygon"


@pytest.mark.asyncio
async def test_a_ring_runs_through_the_registered_tool(world: World) -> None:
    """The path the transport takes: argument validation, then the raising wrapper."""
    _small_scene(world)
    tool = M.mcp._tool_manager.get_tool("focus_area")
    assert tool is not None
    out = await tool.run(
        {"lat": 0.0, "lon": 0.0, "polygon": _ring_arg(), "cell_deg": CELL_DEG, "detail": "long"}
    )
    assert out["bounding_circle"]["radius_nm"] == 191.0
    assert {r["icao24"] for r in out["aircraft"]["sample"]} == {
        "400001", "400002", "400003", "400100", "400101", "400102",
    }


def test_polygon_call_needs_no_centre_and_circle_call_needs_one(monkeypatch) -> None:
    """lat/lon are optional when a polygon carries the area, required otherwise."""
    import asyncio

    from app import mcp_server

    async def _fake_get(path, params=None):  # type: ignore[no-untyped-def]
        return {"aircraft": {"sample": [], "count": 0}}

    monkeypatch.setattr(mcp_server, "_get", _fake_get)
    out = asyncio.run(mcp_server.focus_area())
    assert out.get("error") == "missing_area"
    ring = [[24.0, 54.0], [25.0, 54.0], [24.5, 55.0]]
    out = asyncio.run(mcp_server.focus_area(polygon=ring))
    assert "error" not in out
