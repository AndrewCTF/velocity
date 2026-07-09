"""Situations — Gotham aggregate object over the LOCAL ontology store + events lane.

Hermetic (no live Supabase / network). Covers:
- Object coercion round-trips (a situation is a `situation:` ontology object,
  semantic kind in props.kind).
- The keyless-local route contract (2026-07-07 revoke of the old 401/503
  contract — docs/decisions.md): every route works with no Supabase.
- Namespace defence (a non-`situation:` id is rejected 400).
- create → link child → get-detail folding (the /link write + traverse-folded
  neighbourhood) against the real SQLite registry on a temp DB.
- The /api/timeline/events lane shaping (public route, two discrete lanes).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.intel.ontology import Object
from app.routes.situations import SituationIn, _from_object, _to_object

# ── pure coercion ─────────────────────────────────────────────────────────────


def test_to_object_carries_situation_kind_in_props() -> None:
    body = SituationIn(
        name="South China Sea",
        severity="high",
        status="active",
        centroid={"lat": 20.0, "lon": 115.0},
        radius_km=300,
        summary="PLA exercise growing in scope.",
    )
    obj = _to_object("situation:abc123", body, "2026-06-22T00:00:00Z")
    assert obj.kind == "object"  # structural kind stays catch-all
    assert obj.props["kind"] == "situation"
    assert obj.props["name"] == "South China Sea"
    assert obj.props["severity"] == "high"
    assert obj.props["centroid"] == {"lat": 20.0, "lon": 115.0}


def test_round_trip_object_to_situation() -> None:
    body = SituationIn(name="Hormuz", severity="critical", centroid={"lat": 26.5, "lon": 56.3})
    obj = _to_object("situation:h1", body, "2026-06-22T00:00:00Z")
    obj.created_at = "2026-06-21T00:00:00Z"
    sit = _from_object(obj)
    assert sit is not None
    assert sit.id == "situation:h1" and sit.name == "Hormuz"
    assert sit.severity == "critical"
    assert sit.centroid is not None and sit.centroid.lat == 26.5
    assert sit.created_at == "2026-06-21T00:00:00Z"


def test_from_object_skips_non_situation_and_clamps_bad_enum() -> None:
    assert _from_object(Object(id="aircraft:abc", props={})) is None
    # A situation row with a junk severity falls back to a safe default (never 500).
    sit = _from_object(Object(id="situation:x", props={"kind": "situation", "severity": "bogus"}))
    assert sit is not None and sit.severity == "med" and sit.status == "active"


# ── keyless-local route contract ─────────────────────────────────────────────────


def test_situation_routes_work_keyless(client: TestClient) -> None:
    # No Supabase → the shared "local" identity + SQLite store: the list is an
    # honest empty [], an unknown detail is 404 — not a dead 401/503.
    r = client.get("/api/situations")
    assert r.status_code == 200 and r.json() == []
    assert client.get("/api/situations/situation:missing").status_code == 404


def test_create_rejects_foreign_namespace(client: TestClient) -> None:
    r = client.post("/api/situations", json={"name": "x", "id": "aircraft:pwn"})
    assert r.status_code == 400


# ── create → link → detail against the real local registry (temp DB) ─────────────


def test_create_link_detail_round_trip(client: TestClient) -> None:
    r = client.post("/api/situations", json={"name": "SCS", "severity": "high"})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert sid.startswith("situation:")

    # LINK an incident as a child.
    r = client.post(
        f"/api/situations/{sid}/link",
        json={"dst": "incident:xyz", "rel": "contains"},
    )
    assert r.status_code == 200, r.text

    # Move 1: linking PROMOTES the child to a real ontology object row (before
    # this it existed only as a traversal-derived stub → GET object was a 404).
    assert client.get("/api/ontology/object/incident:xyz").status_code == 200

    # DETAIL folds the child in (derived stub) + the contains edge.
    r = client.get(f"/api/situations/{sid}")
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["situation"]["name"] == "SCS"
    child_ids = [o["id"] for o in detail["objects"]]
    assert "incident:xyz" in child_ids
    assert any(
        lk["rel"] == "contains" and lk["dst"] == "incident:xyz"
        for lk in detail["links"]
    )

    # LIST shows the situation.
    assert sid in [s["id"] for s in client.get("/api/situations").json()]

    # DELETE removes it (and is a no-op the second time).
    assert client.delete(f"/api/situations/{sid}").status_code == 204
    assert client.get(f"/api/situations/{sid}").status_code == 404
    assert client.delete(f"/api/situations/{sid}").status_code == 204


# ── timeline events lanes (public route) ──────────────────────────────────────


def test_timeline_events_returns_two_lanes(client: TestClient) -> None:
    r = client.get("/api/timeline/events")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "window" in body and "from" in body["window"]
    lane_ids = {ln["id"] for ln in body["lanes"]}
    assert lane_ids == {"incidents", "signals"}
    for ln in body["lanes"]:
        assert "color" in ln and isinstance(ln["events"], list)
