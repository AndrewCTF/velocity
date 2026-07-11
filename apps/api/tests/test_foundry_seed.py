"""Guards for POST /api/foundry/seed/reference (built-in reference datasets)."""

from __future__ import annotations

import pytest

from app import places
from app.foundry import seed


@pytest.fixture(autouse=True)
def _small_reference(monkeypatch):
    """Keep the seed fast/deterministic: shrink the big place loaders."""
    monkeypatch.setattr(places, "airports", lambda: [{"name": "A1", "iata": "A1", "icao": "AAA1", "lat": 1.0, "lon": 2.0}])
    monkeypatch.setattr(places, "ports", lambda: [{"name": "P1", "lat": 1.0, "lon": 2.0, "wpi": "1"}])
    monkeypatch.setattr(places, "bases", lambda: [{"name": "B1", "lat": 1.0, "lon": 2.0, "branch": "air"}])
    monkeypatch.setattr(places, "infrastructure", lambda: [
        {"id": "WRI1", "category": "power", "subcategory": "nuclear power station", "name": "N1",
         "lat": 1.0, "lon": 2.0, "capacity_mw": 100.0, "source": "wri-gppd-v1.3"}
    ])
    monkeypatch.setattr(places, "military", lambda: [
        {"id": "mirta-1", "category": "military_installation", "name": "Fort T", "lat": 1.0, "lon": 2.0,
         "source": "esri-federal-mirta"}
    ])


def test_seed_creates_reference_datasets(client):
    r = client.post("/api/foundry/seed/reference")
    assert r.status_code == 200
    results = {x["dataset"]: x for x in r.json()["results"]}
    assert set(results) == set(seed.reference_sources())
    for name in ("ref_airports", "ref_ports", "ref_bases", "ref_infrastructure", "ref_military",
                 "ref_country_indicators"):
        assert results[name]["status"] == "seeded", results[name]
        assert results[name]["rows"] > 0
    # datasets are visible through the normal Foundry API with rows + schema
    ds = client.get("/api/foundry/datasets").json()
    names = {d["name"] for d in ds}
    assert {"ref_airports", "ref_infrastructure", "ref_military"} <= names


def test_seed_idempotent_then_refresh(client):
    assert client.post("/api/foundry/seed/reference").status_code == 200
    r2 = client.post("/api/foundry/seed/reference")
    statuses = {x["dataset"]: x["status"] for x in r2.json()["results"]}
    assert all(s in ("exists", "empty") for s in statuses.values()), statuses
    r3 = client.post("/api/foundry/seed/reference", params={"refresh": "true"})
    statuses3 = {x["dataset"]: x["status"] for x in r3.json()["results"]}
    assert statuses3["ref_airports"] == "seeded"


def test_country_resources_flattened():
    rows = seed._country_resource_rows()
    # 53-country catalog ships in-repo; every row is one resource with its country context.
    assert len(rows) > 100
    sample = rows[0]
    assert {"country_code", "country", "region", "resource", "url", "category", "keyless"} <= set(sample)
