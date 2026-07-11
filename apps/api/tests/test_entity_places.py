"""GET /api/entity/{airport,port,satellite}:... enrichment shape tests.

airport:/port: are pure local lookups (app.places' data already loaded) — the
shared `client` fixture (conftest.py) is fine, no network involved. satellite:
hits app.satcat, which is monkeypatched to a fixture CSV (no live CelesTrak
call) via app.satcat.get_client, per the pattern in test_maritime_warnings.py.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import satcat as satcat_mod
from app.routes import entity

SATCAT_FIXTURE = (Path(__file__).parent / "fixtures" / "satcat_sample.csv").read_text()


# ── airport: ─────────────────────────────────────────────────────────────


def test_entity_airport_by_icao_shape(client: TestClient) -> None:
    r = client.get("/api/entity/airport:KJFK")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "airport"
    assert body["icao"] == "KJFK"
    assert body["iata"] == "JFK"
    assert body["runway_count"] >= 1
    assert isinstance(body["runways"], list) and body["runways"]
    assert any(rw.get("ils_category") for rw in body["runways"])
    assert body["max_runway_length_ft"] and body["max_runway_length_ft"] > 0
    assert body["frequencies"]
    assert body["liveatc_url"] == "https://www.liveatc.net/search/?icao=KJFK"
    assert body["candidate_mounts"] == [
        "https://s1-fmt2.liveatc.net/kjfk_twr",
        "https://s1-bos.liveatc.net/kjfk_twr",
    ]
    assert body["candidate_mounts_best_effort"] is True
    assert isinstance(body["military"], bool)
    assert body["elevation_ft"] is not None
    assert body["municipality"]


def test_entity_airport_by_iata_resolves_same_record(client: TestClient) -> None:
    r_iata = client.get("/api/entity/airport:JFK")
    r_icao = client.get("/api/entity/airport:KJFK")
    assert r_iata.status_code == r_icao.status_code == 200
    assert r_iata.json()["icao"] == r_icao.json()["icao"] == "KJFK"


def test_entity_airport_unknown_404(client: TestClient) -> None:
    r = client.get("/api/entity/airport:ZZZZ99")
    assert r.status_code == 404


def test_entity_airport_malformed_id_400(client: TestClient) -> None:
    r = client.get("/api/entity/airport:" + "x" * 40)
    assert r.status_code == 400


# ── port: ────────────────────────────────────────────────────────────────


def test_entity_port_rotterdam_shape(client: TestClient) -> None:
    r = client.get("/api/entity/port:31140")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "port"
    assert body["wpi"] == "31140"
    assert "Rotterdam" in body["name"]
    assert "repairs" in body
    assert "dryDock" in body
    # No live closure feed — op_status must stay honestly "Unknown" (§7).
    assert body["op_status"] == "Unknown"


def test_entity_port_unknown_wpi_404(client: TestClient) -> None:
    r = client.get("/api/entity/port:999999999")
    assert r.status_code == 404


def test_entity_port_non_numeric_id_400(client: TestClient) -> None:
    r = client.get("/api/entity/port:not-a-wpi")
    assert r.status_code == 400


# ── satellite: (via SAT_TAIL_RE / literal "satellite:") ─────────────────────


def _make_satcat_app(monkeypatch):
    class FakeResponse:
        status_code = 200
        text = SATCAT_FIXTURE

    class FakeClient:
        async def get(self, url, params=None, headers=None):
            return FakeResponse()

    satcat_mod.cache.invalidate("satcat:rows")
    monkeypatch.setattr(satcat_mod, "get_client", lambda: FakeClient())

    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(entity.router)
    return TestClient(app)


def test_entity_satellite_literal_kind_shape(monkeypatch) -> None:
    tc = _make_satcat_app(monkeypatch)
    r = tc.get("/api/entity/satellite:25544")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "satellite"
    assert body["norad_cat_id"] == "25544"
    assert body["object_name"] == "ISS (ZARYA)"
    assert body["owner"] == "ISS"
    assert body["launch_date"] == "1998-11-20"
    assert body["launch_site"] == "TYMSC"
    assert body["decay_date"] is None
    assert body["period"] == 92.97
    assert body["inclination"] == 51.63
    assert body["apogee"] == 424.0
    assert body["perigee"] == 415.0
    assert body["rcs"] == 399.0524
    assert body["source"] == "CelesTrak SATCAT"


def test_entity_satellite_globe_clicked_id_tail_scheme(monkeypatch) -> None:
    """The real globe-clicked id from SatelliteAdapter.ts is shaped
    '<descriptor-id>:sat:<norad>' (e.g. 'space.celestrak.stations:sat:25544')
    — multiple colons, no literal 'satellite:' or 'sat:' kind. The route must
    recover the NORAD id from the id's TAIL, not its (meaningless) head."""
    tc = _make_satcat_app(monkeypatch)
    r = tc.get("/api/entity/space.celestrak.stations:sat:25544")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "satellite"
    assert body["norad_cat_id"] == "25544"
    assert body["object_name"] == "ISS (ZARYA)"


def test_entity_satellite_unknown_norad_404(monkeypatch) -> None:
    tc = _make_satcat_app(monkeypatch)
    r = tc.get("/api/entity/satellite:99999999")
    assert r.status_code == 404
