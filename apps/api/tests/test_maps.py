"""Shared named COP — save/load over the LOCAL ontology store + the /ws/cop hub.

Hermetic (no live Supabase / network). Covers:
- CopState / object coercion round-trips (a saved map is a `map:` ontology object).
- The keyless-local route contract (2026-07-07 revoke of the old 401/503
  contract — docs/decisions.md): every route works with no Supabase.
- Namespace defence (a non-`map:` id is rejected 400).
- Save → list → load happy path against the real SQLite registry on a temp DB,
  asserting the picture (viewport + layers + filters + selection + imagery)
  survives.
- The `_CopHub` fan-out unit (sender excluded, slow follower dropped, room reaped).
- A real `/ws/cop` follow-along round-trip: one socket's viewport delta reaches a
  second socket in the same room, and the auth gate rejects a keyless upgrade when
  auth is enabled.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.routes.maps import (
    CopState,
    MapIn,
    SavedMap,
    Viewport,
    _CopHub,
    _from_object,
    _to_object,
)

# ── pure coercion: state ↔ ontology object ──────────────────────────────────────


def _sample_state() -> CopState:
    return CopState(
        viewport=Viewport(lon=56.3, lat=26.5, height=350_000, heading=0.1, pitch=-1.2),
        layers=["adsb.global", "maritime.ais"],
        imagery={
            "provider": "gibs",
            "layer": "VIIRS_TrueColor",
            "date": "2026-06-21",
            "maxZ": 9,
            "opacity": 0.8,
        },
        selection="aircraft:4ca7b3",
        filters=[{"facet": "aircraftCategory", "value": "military", "mode": "only"}],
    )


def test_to_object_carries_map_kind_in_props() -> None:
    body = MapIn(name="Hormuz watch", state=_sample_state())
    obj = _to_object("map:abc123", body, "2026-06-21T00:00:00Z")
    # Structural kind stays the catch-all; the semantic kind lives in props (so a
    # list query filters props->>kind and other ontology nodes don't leak in).
    assert obj.kind == "object"
    assert obj.props["kind"] == "map"
    assert obj.props["name"] == "Hormuz watch"
    assert obj.props["state"]["selection"] == "aircraft:4ca7b3"
    assert obj.props["updated_at"] == "2026-06-21T00:00:00Z"


def test_round_trip_object_to_saved_map() -> None:
    body = MapIn(name="Hormuz watch", state=_sample_state())
    obj = _to_object("map:abc123", body, "2026-06-21T00:00:00Z")
    obj.created_at = "2026-06-20T00:00:00Z"
    sm = _from_object(obj)
    assert sm is not None
    assert sm.id == "map:abc123"
    assert sm.name == "Hormuz watch"
    assert sm.state.viewport is not None and sm.state.viewport.lon == 56.3
    assert sm.state.layers == ["adsb.global", "maritime.ais"]
    assert sm.state.imagery is not None and sm.state.imagery.provider == "gibs"
    assert sm.state.filters[0].value == "military"
    assert sm.created_at == "2026-06-20T00:00:00Z"


def test_from_object_skips_non_map() -> None:
    from app.intel.ontology import Object

    # An alert / aircraft / investigation object is NOT a map → None (filtered out).
    assert _from_object(Object(id="aircraft:abc", props={})) is None
    assert _from_object(Object(id="alert:x", props={"kind": "alert"})) is None


def test_from_object_tolerates_malformed_state() -> None:
    from app.intel.ontology import Object

    # A map row whose state blob is junk loads as an EMPTY picture, never crashes.
    obj = Object(id="map:x", props={"kind": "map", "name": "broken", "state": 12345})
    sm = _from_object(obj)
    assert sm is not None and sm.name == "broken"
    assert sm.state.layers == [] and sm.state.viewport is None


# ── keyless-local route contract ─────────────────────────────────────────────────


def test_maps_routes_work_keyless(client: TestClient) -> None:
    # No Supabase → the shared "local" identity + SQLite store: the list is an
    # honest empty [], an unknown map is 404 — not a dead 401/503.
    r = client.get("/api/maps")
    assert r.status_code == 200 and r.json() == []
    assert client.get("/api/maps/map:abc").status_code == 404


def test_save_map_rejects_foreign_namespace(client: TestClient) -> None:
    # An explicit id that doesn't start with map: is a 400 BEFORE any store call —
    # a client must not park arbitrary objects through this route.
    r = client.post("/api/maps", json={"name": "x", "id": "aircraft:pwn"})
    assert r.status_code == 400


# ── save → list → load against the real local registry (temp DB) ─────────────────


def test_save_list_load_round_trip(client: TestClient) -> None:
    # SAVE
    payload = {
        "name": "Hormuz watch",
        "state": {
            "viewport": {"lon": 56.3, "lat": 26.5, "height": 350000},
            "layers": ["adsb.global"],
            "selection": "aircraft:4ca7b3",
            "filters": [
                {"facet": "aircraftCategory", "value": "military", "mode": "only"}
            ],
        },
    }
    r = client.post("/api/maps", json=payload)
    assert r.status_code == 201, r.text
    saved = SavedMap(**r.json())
    assert saved.id.startswith("map:")
    assert saved.name == "Hormuz watch"

    # LIST — the saved map shows up, filtered to kind=map.
    r = client.get("/api/maps")
    assert r.status_code == 200
    ids = [m["id"] for m in r.json()]
    assert saved.id in ids

    # LOAD — the picture round-trips intact.
    r = client.get(f"/api/maps/{saved.id}")
    assert r.status_code == 200
    loaded = SavedMap(**r.json())
    assert loaded.state.viewport is not None
    assert loaded.state.viewport.lat == 26.5
    assert loaded.state.layers == ["adsb.global"]
    assert loaded.state.selection == "aircraft:4ca7b3"
    assert loaded.state.filters[0].value == "military"

    # OVERWRITE by id — re-save replaces rather than duplicating.
    payload2 = {"id": saved.id, "name": "Hormuz watch v2", "state": {"layers": []}}
    r = client.post("/api/maps", json=payload2)
    assert r.status_code == 201
    r = client.get("/api/maps")
    assert [m["id"] for m in r.json()].count(saved.id) == 1
    assert client.get(f"/api/maps/{saved.id}").json()["name"] == "Hormuz watch v2"

    # DELETE.
    assert client.delete(f"/api/maps/{saved.id}").status_code == 204
    assert client.get(f"/api/maps/{saved.id}").status_code == 404


def test_load_missing_map_404(client: TestClient) -> None:
    assert client.get("/api/maps/map:nope").status_code == 404


# ── _CopHub fan-out (pure) ───────────────────────────────────────────────────────


def test_cop_hub_excludes_sender_and_reaches_room() -> None:
    hub = _CopHub()
    a = hub.subscribe("map:1")
    b = hub.subscribe("map:1")
    other = hub.subscribe("map:2")  # different room — must NOT receive
    sent = hub.publish("map:1", {"kind": "viewport", "lon": 1}, exclude=a)
    assert sent == 1  # only b (a is the sender, other is a different room)
    assert b.get_nowait()["lon"] == 1
    assert a.empty() and other.empty()


def test_cop_hub_drops_on_full_queue() -> None:
    hub = _CopHub()
    q = hub.subscribe("map:1")
    # Fill the bounded queue, then a publish must skip (never block/raise).
    for i in range(q.maxsize):
        q.put_nowait({"n": i})
    sent = hub.publish("map:1", {"kind": "viewport"}, exclude=None)
    assert sent == 0  # the only follower's queue was full → dropped, not awaited


def test_cop_hub_reaps_empty_room() -> None:
    hub = _CopHub()
    q = hub.subscribe("map:1")
    assert hub.room_size("map:1") == 1
    hub.unsubscribe("map:1", q)
    assert hub.room_size("map:1") == 0
    # internal dict entry is gone (no unbounded growth of joined-once ids)
    assert "map:1" not in hub._rooms


# ── /ws/cop round-trip + auth gate ───────────────────────────────────────────────


def test_ws_cop_follow_along_round_trip(client: TestClient) -> None:
    # Default test settings have auth DISABLED (no api_key / supabase), so the WS
    # connects keyless — require_ws_key returns True. Two sockets in the same room:
    # one publishes a viewport delta, the other receives it.
    with client.websocket_connect("/ws/cop?map=map:room1") as lead:
        join_lead = lead.receive_json()
        assert join_lead["kind"] == "joined" and join_lead["map"] == "map:room1"
        with client.websocket_connect("/ws/cop?map=map:room1") as follower:
            follower.receive_json()  # follower's own "joined" frame
            # Lead drives: send a viewport delta. It must reach the follower, NOT
            # echo back to the lead.
            lead.send_json({"kind": "viewport", "lon": 56.3, "lat": 26.5, "height": 350000})
            got = follower.receive_json()
            assert got["kind"] == "viewport"
            assert got["lon"] == 56.3
            assert got["map"] == "map:room1"  # re-stamped server-side


def test_ws_cop_requires_map_id(client: TestClient) -> None:
    # No ?map= → the server accepts then sends an error + closes 1008.
    with client.websocket_connect("/ws/cop") as ws:
        msg = ws.receive_json()
        assert msg["kind"] == "error"


def test_ws_cop_auth_gate_rejects_keyless_when_enabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # With auth ENABLED (an api_key set), a keyless /ws/cop upgrade must be
    # rejected at require_ws_key — BEFORE accept — closing the socket. Mirrors the
    # /ws/alerts gate; proves the WS invariant holds. require_ws_key reads settings
    # via app.auth.get_settings() directly (NOT the DI override), so patch THAT.
    from starlette.testclient import WebSocketDenialResponse

    from app import auth as auth_mod

    def _auth_settings() -> Settings:
        return Settings(api_key="secret", cors_origins="http://localhost")

    monkeypatch.setattr(auth_mod, "get_settings", _auth_settings)
    with pytest.raises((WebSocketDenialResponse, Exception)):
        with client.websocket_connect("/ws/cop?map=map:1"):
            pass
