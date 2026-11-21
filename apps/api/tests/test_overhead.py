"""Tests for GET /api/overhead, the nearest-aircraft payload for desk displays.

Fixtures go through the production feature builder (``adsb._aircraft_geojson``),
so a renamed snapshot field fails here instead of passing against an invented
shape. The route runs end to end through the REAL ``global_snapshot()`` over a
seeded snapshot: no fan-out, no network. An autouse tripwire fails any test in
this module that tries to send an HTTP request.
"""

from __future__ import annotations

import ast
import asyncio
import json
import math
import pathlib
import time
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth, upstream
from app.config import get_settings
from app.main import create_app
from app.routes import adsb as adsb_routes
from app.routes import overhead

T0 = 1_760_000_000.0  # the pinned "now" for the route
URL = "/api/overhead"
KM_PER_DEG = 6371.0088 * math.pi / 180.0  # the sphere haversine_km measures on
KEY = "overhead-test-static-key-0123456789abcdef"


def _raw(icao: str, lat: float, lon: float, **kw: Any) -> dict[str, Any]:
    """A readsb record, the vocabulary the aggregators speak. ``None`` drops a key."""
    rec: dict[str, Any] = {
        "hex": icao,
        "lat": lat,
        "lon": lon,
        "flight": "TST123 ",
        "t": "A320",
        "alt_baro": 36000,
        "gs": 450.0,
        "track": 90.0,
        "seen_pos": 1.0,
        "_seen_at": T0,
    }
    rec.update(kw)
    return {k: v for k, v in rec.items() if v is not None}


def _at(icao: str, north_km: float, east_km: float, **kw: Any) -> dict[str, Any]:
    """An aircraft this far north and east of (0, 0). Small-angle exact at the equator."""
    return _raw(icao, north_km / KM_PER_DEG, east_km / KM_PER_DEG, **kw)


def _north(icao: str, km: float, **kw: Any) -> dict[str, Any]:
    """An aircraft ``km`` due north of (0, 0), along a meridian."""
    return _at(icao, km, 0.0, **kw)


def _seed(
    monkeypatch: pytest.MonkeyPatch,
    *raws: dict[str, Any],
    refreshed_ago: float | None = 1.0,
) -> None:
    """Load a snapshot the way the refresher leaves it, minus the refresher.

    ``_SNAPSHOT_STARTED`` makes the real ``global_snapshot()`` skip its cold-start
    fan-out; ``refreshed_ago=None`` is a snapshot that has never refreshed.
    """
    fc = adsb_routes._aircraft_geojson(list(raws))
    monkeypatch.setattr(adsb_routes, "_LATEST_SNAPSHOT", fc)
    monkeypatch.setattr(adsb_routes, "_SNAPSHOT_STARTED", True)
    at = 0.0 if refreshed_ago is None else time.monotonic() - refreshed_ago
    monkeypatch.setattr(adsb_routes, "_LATEST_SNAPSHOT_AT", at)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Tripwire: record and refuse every async httpx send and shared-client lookup."""
    calls: list[str] = []

    async def _refuse(self: httpx.AsyncClient, request: httpx.Request, **_kw: Any) -> None:
        calls.append(str(request.url))
        raise AssertionError(f"outbound HTTP from the overhead route: {request.url}")

    def _no_shared_client() -> None:
        calls.append("get_client()")
        raise AssertionError("the overhead route took the shared upstream client")

    monkeypatch.setattr(httpx.AsyncClient, "send", _refuse)
    monkeypatch.setattr(upstream, "get_client", _no_shared_client)
    return calls


@pytest.fixture
def api(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # A key exported in the developer's shell must not turn these into 401s.
    monkeypatch.setattr("app.auth._auth_enabled", lambda _s: False)
    monkeypatch.setattr(overhead, "_now", lambda: T0)
    return client


def _get(api: TestClient, **params: Any) -> Any:
    params.setdefault("lat", 0.0)
    params.setdefault("lon", 0.0)
    return api.get(URL, params=params)


def _ids(body: dict[str, Any]) -> list[str]:
    return [a["id"] for a in body["aircraft"]]


# ── ordering, limit, radius ─────────────────────────────────────────────────


def test_aircraft_come_back_nearest_first(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    kms = {"000006": 24.0, "000001": 3.0, "000004": 18.0, "000002": 7.0, "000005": 22.0, "000003": 12.0}
    _seed(monkeypatch, *(_north(i, km) for i, km in kms.items()))  # deliberately shuffled
    r = _get(api, limit=20)
    assert r.status_code == 200, r.text
    body = r.json()
    assert _ids(body) == ["000001", "000002", "000003", "000004", "000005", "000006"]
    dists = [a["dist_km"] for a in body["aircraft"]]
    assert dists == sorted(dists)
    assert dists == [pytest.approx(kms[i], abs=0.05) for i in _ids(body)]


def test_limit_caps_the_list_and_defaults_to_five(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, *(_north(f"{n:06x}", 2.0 * n) for n in range(1, 9)))
    assert _ids(_get(api, limit=3).json()) == ["000001", "000002", "000003"]
    assert len(_get(api).json()["aircraft"]) == 5
    assert len(_get(api, limit=1).json()["aircraft"]) == 1


def test_radius_filters_by_great_circle_distance(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _north("000001", 10.0), _north("000002", 24.0), _north("000003", 26.0),
          _north("000004", 100.0))
    assert _ids(_get(api).json()) == ["000001", "000002"]  # default radius is 25 km
    assert _ids(_get(api, radius_km=30).json()) == ["000001", "000002", "000003"]
    assert _ids(_get(api, radius_km=250).json()) == ["000001", "000002", "000003", "000004"]
    assert _ids(_get(api, radius_km=5).json()) == []


def test_radius_is_a_circle_not_a_latitude_band(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Each of the "out" contacts is inside the latitude band the cheap pre-filter
    # lets through, so only the exact distance test can reject it.
    _seed(
        monkeypatch,
        _at("0000a1", 24.0, 0.0),  # in
        _at("0000a2", 0.0, 24.0),  # in
        _at("0000a3", 17.5, 17.5),  # in, 24.75 km on the diagonal
        _at("0000b1", 0.0, 26.0),  # out, due east
        _at("0000b2", 18.5, 18.5),  # out, 26.16 km on the diagonal
        _at("0000b3", 0.0, -60.0),  # out, due west
    )
    assert sorted(_ids(_get(api, limit=20).json())) == ["0000a1", "0000a2", "0000a3"]


def test_two_contacts_at_one_spot_keep_a_stable_order(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _north("00000b", 5.0), _north("00000a", 5.0))
    assert _ids(_get(api).json()) == ["00000a", "00000b"]


@pytest.mark.parametrize(
    ("center", "plane", "dist_km", "bearing"),
    [
        ((0.0, 179.95), (0.0, -179.95), 11.1, 90.0),  # across the antimeridian, due east
        ((89.9, 0.0), (89.9, 180.0), 22.2, 0.0),  # over the pole, due "north"
        ((0.0, 0.0), (0.1, 0.0), 11.1, 0.0),
        ((0.0, 0.0), (0.0, 0.1), 11.1, 90.0),
        ((0.0, 0.0), (-0.1, 0.0), 11.1, 180.0),
        ((0.0, 0.0), (0.0, -0.1), 11.1, 270.0),
    ],
)
def test_distance_and_bearing_are_exact_where_a_bbox_would_fail(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    center: tuple[float, float],
    plane: tuple[float, float],
    dist_km: float,
    bearing: float,
) -> None:
    _seed(monkeypatch, _raw("000001", *plane))
    body = _get(api, lat=center[0], lon=center[1]).json()
    assert [(a["dist_km"], a["bearing_deg"]) for a in body["aircraft"]] == [(dist_km, bearing)]


def test_a_bearing_that_rounds_to_360_is_reported_as_0(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 0.00004 deg west of due north is a true bearing of 359.977.
    _seed(monkeypatch, _raw("000001", 0.1, -0.00004))
    assert _get(api).json()["aircraft"][0]["bearing_deg"] == 0.0


# ── what is reported, and how ───────────────────────────────────────────────


def test_response_shape_units_and_rounding(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch, _raw("4CA7B3", 0.0, 0.1, flight="BAW123 ", _seen_at=T0 - 4, seen_pos=3.0))
    r = _get(api, lat=0.0, lon=0.0, radius_km=25, limit=5)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.json() == {
        "as_of": int(T0),
        "center": [0.0, 0.0],
        "radius_km": 25.0,
        "aircraft": [
            {
                "id": "4ca7b3",  # bare lower-case hex, no "aircraft:" prefix
                "callsign": "BAW123",
                "type": "A320",
                "alt_ft": 36000,  # ft in, ft out, not metres and not a float
                "gs_kt": 450,
                "dist_km": 11.1,
                "bearing_deg": 90.0,
                "age_s": 7,  # 4 s since received + 3 s old on arrival
            }
        ],
    }
    # Whole numbers must stay JSON integers; an ESP32 prints a float as "36000.0".
    assert b'"alt_ft":36000,' in r.content and b'"gs_kt":450,' in r.content


def test_center_echoes_lat_then_lon(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch)
    body = _get(api, lat=12.5, lon=-45.25, radius_km=40.5).json()
    assert (body["center"], body["radius_km"]) == ([12.5, -45.25], 40.5)


def test_altitude_and_speed_survive_the_snapshot_unit_round_trip() -> None:
    # The snapshot stores metres and m/s; the display wants the feet and knots the
    # feed sent. Run every whole value through the REAL builder and back.
    feet = range(-1500, 60001)
    fc = adsb_routes._aircraft_geojson(
        [_raw(f"{i:06x}", 0.0, 0.0, alt_baro=ft, gs=float(i % 1301)) for i, ft in enumerate(feet)]
    )
    assert len(fc["features"]) == len(feet)
    for i, (ft, f) in enumerate(zip(feet, fc["features"], strict=True)):
        assert overhead._alt_ft(f["properties"]) == ft
        assert overhead._gs_kt(f["properties"]) == i % 1301


def test_age_is_rounded_to_whole_seconds(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch, _north("000001", 1.0, _seen_at=T0, seen_pos=2.6),
          _north("000002", 2.0, _seen_at=T0, seen_pos=2.4))
    assert [a["age_s"] for a in _get(api).json()["aircraft"]] == [3, 2]


def test_values_the_feed_did_not_send_are_null_not_zero_and_not_an_error(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Bare position only: no callsign, type, altitude, speed or position age.
    _seed(monkeypatch, _raw("000001", 0.0, 0.05, flight=None, t=None, alt_baro=None, gs=None,
                            seen_pos=None))
    r = _get(api)
    assert r.status_code == 200, r.text
    assert r.json()["aircraft"] == [
        {"id": "000001", "callsign": None, "type": None, "alt_ft": None, "gs_kt": None,
         "dist_km": 5.6, "bearing_deg": 90.0, "age_s": 0}
    ]
    assert b'"alt_ft":null' in r.content  # the key is present, so a parser sees an explicit null


def test_geometric_altitude_is_the_fallback_when_there_is_no_barometric(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _raw("000001", 0.0, 0.05, alt_baro=None, alt_geom=12000))
    assert _get(api).json()["aircraft"][0]["alt_ft"] == 12000


def test_registration_stands_in_for_a_missing_callsign_and_junk_is_null(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _north("000001", 1.0, flight=None, r="N123AB"),
          _north("000002", 2.0, flight="@@@@@@@@"), _north("000003", 3.0, flight="        "))
    assert [a["callsign"] for a in _get(api).json()["aircraft"]] == ["N123AB", None, None]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize("axis", ["lat", "lon"])
def test_one_corrupt_coordinate_in_the_snapshot_is_skipped_not_a_500(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, axis: str, bad: float
) -> None:
    # json.loads accepts NaN/Infinity, so an upstream can hand the snapshot one.
    # math.sin(inf) raises; it must cost that contact, not every display.
    lat, lon = (bad, 0.0) if axis == "lat" else (0.0, bad)
    _seed(monkeypatch, _raw("000002", lat, lon), _north("000001", 4.0))
    r = _get(api)
    assert r.status_code == 200, r.text
    assert _ids(r.json()) == ["000001"]


def test_aircraft_on_the_ground_are_not_overhead(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _north("000001", 2.0, alt_baro="ground", gs=0), _north("000002", 5.0))
    assert _ids(_get(api).json()) == ["000002"]


# ── freshness: age of the DATA, not of the response ─────────────────────────


def test_a_fix_is_listed_until_it_is_older_than_the_live_line(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = adsb_routes._FRESH_POS_S
    _seed(
        monkeypatch,
        _north("000001", 1.0, _seen_at=T0 - live, seen_pos=0.0),  # exactly on the line: kept
        _north("000002", 2.0, _seen_at=T0 - live - 1, seen_pos=0.0),  # one second past: dropped
    )
    body = _get(api).json()
    assert [(a["id"], a["age_s"]) for a in body["aircraft"]] == [("000001", int(live))]


def test_a_cached_tier_cannot_pass_as_fresh_on_a_small_seen_pos(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # apps/api/CLAUDE.md: raw seen_pos_s is the age at UPSTREAM serve time. This
    # contact says "1 s old" but was received 15 minutes ago; its age is 901 s.
    _seed(
        monkeypatch,
        _north("000001", 1.0, _seen_at=T0 - 900, seen_pos=1.0),
        # The straggler pattern: received just now, position already 10 minutes old.
        _north("000002", 2.0, _seen_at=T0, seen_pos=600.0),
        _north("000003", 3.0, _seen_at=T0 - 2, seen_pos=1.0),
    )
    body = _get(api).json()
    assert [(a["id"], a["age_s"]) for a in body["aircraft"]] == [("000003", 3)]


def test_an_unknown_age_is_kept_and_reported_as_null(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _north("000001", 1.0, _seen_at=None, seen_pos=None))
    body = _get(api).json()
    assert [(a["id"], a["age_s"]) for a in body["aircraft"]] == [("000001", None)]


# ── a dead feed must not read as empty skies ────────────────────────────────


def test_empty_skies_over_a_live_feed_is_a_200_with_no_aircraft(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _north("000001", 90.0), refreshed_ago=2.0)
    r = _get(api)
    assert r.status_code == 200
    assert r.json()["aircraft"] == []


@pytest.mark.parametrize("refreshed_ago", [None, adsb_routes._SNAPSHOT_STALE_S + 5.0])
def test_empty_answer_from_a_snapshot_that_stopped_refreshing_is_a_503(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, refreshed_ago: float | None
) -> None:
    _seed(monkeypatch, _north("000001", 90.0), refreshed_ago=refreshed_ago)
    r = _get(api)
    assert r.status_code == 503
    assert r.json() == {"detail": "aircraft feed is not live"}


def test_a_non_empty_answer_is_never_a_503(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    # Every listed fix carries its own honest age, so the list needs no extra caveat.
    _seed(monkeypatch, _north("000001", 4.0), refreshed_ago=adsb_routes._SNAPSHOT_STALE_S + 5.0)
    assert _ids(_get(api).json()) == ["000001"]


# ── size, bounds ────────────────────────────────────────────────────────────


def test_payload_stays_under_4_kb_even_with_worst_case_strings(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    crowd = [
        _raw(f"{n:06x}", (n % 40) * 0.004, ((n // 40) % 40) * 0.004, flight="ABCDEFGH", t="A388",
             alt_baro=-1000 - n, gs=999.0 + n)
        for n in range(1, 120)
    ]
    _seed(monkeypatch, *crowd)
    for limit in (5, 20):
        r = _get(api, limit=limit, radius_km=250)
        assert len(r.json()["aircraft"]) == limit
        assert len(r.content) < 4096, f"limit={limit}: {len(r.content)} bytes"


@pytest.mark.parametrize(
    "params",
    [
        {"lat": 90.0001},
        {"lat": -90.0001},
        {"lon": 180.0001},
        {"lon": -180.0001},
        {"radius_km": 0.99},
        {"radius_km": 250.01},
        {"radius_km": 0},
        {"radius_km": -5},
        {"limit": 0},
        {"limit": 21},
        {"limit": -1},
        {"limit": 2.5},
        {"lat": "north"},
        {"lat": "nan"},
        {"lat": "inf"},
        {"lon": "-inf"},
        {"radius_km": "nan"},
    ],
)
def test_out_of_range_or_malformed_params_are_422(api: TestClient, params: dict[str, Any]) -> None:
    assert _get(api, **params).status_code == 422


@pytest.mark.parametrize("params", [{"lon": 0.0}, {"lat": 0.0}, {}])
def test_lat_and_lon_are_required(api: TestClient, params: dict[str, Any]) -> None:
    assert api.get(URL, params=params).status_code == 422


def test_the_bounds_themselves_are_accepted(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch, _north("000001", 1.0))
    for params in (
        {"lat": 90.0}, {"lat": -90.0}, {"lon": 180.0}, {"lon": -180.0},
        {"radius_km": 1}, {"radius_km": 250}, {"limit": 1}, {"limit": 20},
    ):
        assert _get(api, **params).status_code == 200, params


# ── no upstream cost, same auth as every other /api read ────────────────────


def test_it_reads_the_snapshot_once_and_sends_no_http_request(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, _no_network: list[str]
) -> None:
    _seed(monkeypatch, _north("000001", 4.0))
    real = adsb_routes.global_snapshot
    reads: list[int] = []

    async def spy() -> dict[str, Any]:
        reads.append(1)
        return await real()

    monkeypatch.setattr(adsb_routes, "global_snapshot", spy)
    assert _get(api).status_code == 200
    assert len(reads) == 1
    assert _no_network == []


def test_the_tripwire_is_armed(_no_network: list[str]) -> None:
    # Control for the test above: without it, "no calls" could just mean "never wired".
    async def attempt() -> None:
        async with httpx.AsyncClient() as c:
            await c.get("http://aggregator.invalid/v2/point/0/0/25")

    with pytest.raises(AssertionError, match="outbound HTTP"):
        asyncio.run(attempt())
    assert _no_network == ["http://aggregator.invalid/v2/point/0/0/25"]


def test_a_display_poll_does_not_re_arm_the_fast_snapshot_cadence(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A 10 s poller must not keep the refresher at 1 Hz (idle back-pressure).
    _seed(monkeypatch, _north("000001", 4.0))
    demand: list[int] = []
    monkeypatch.setattr(adsb_routes, "note_demand", lambda: demand.append(1))
    assert _get(api).status_code == 200
    assert demand == []


_NETWORK_MODULES = ("httpx", "requests", "aiohttp", "urllib", "urllib3", "http", "socket", "ssl",
                    "websockets", "app.upstream")


def _network_imports(source: str) -> list[str]:
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            imported.add(node.module or "")
    return sorted(
        m for m in imported if any(m == b or m.startswith(b + ".") for b in _NETWORK_MODULES)
    )


def test_the_module_imports_nothing_that_can_open_a_connection() -> None:
    assert _network_imports(pathlib.Path(overhead.__file__).read_text()) == []
    # Control: the detector does flag the imports it is looking for.
    probe = "import httpx\nfrom app.upstream import get_client\nfrom urllib.request import urlopen\n"
    assert _network_imports(probe) == ["app.upstream", "httpx", "urllib.request"]


def _keyed_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Mirrors tests/test_ingest_webhook.py::_keyed_app. conftest clears the
    # settings cache again after every test.
    monkeypatch.setenv("API_KEY", KEY)
    get_settings.cache_clear()
    auth.reset_state()
    monkeypatch.setattr(overhead, "_now", lambda: T0)
    return TestClient(create_app())


def test_a_keyed_box_gates_it_like_every_other_read(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch, _north("000001", 4.0))
    with _keyed_client(monkeypatch) as c:
        params = {"lat": 0.0, "lon": 0.0}
        assert c.get(URL, params=params).status_code == 401
        assert c.get(URL, params=params, headers={"X-API-Key": "x" * 40}).status_code == 401
        ok = c.get(URL, params=params, headers={"X-API-Key": KEY})
        assert ok.status_code == 200, ok.text
        assert _ids(json.loads(ok.content)) == ["000001"]


def test_an_open_box_serves_it_without_a_credential(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(monkeypatch, _north("000001", 4.0))
    assert _get(api).status_code == 200
