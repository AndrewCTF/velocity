"""Alert-rule routes: auth gate, validation, and CRUD wiring (hermetic).

Two backends, exercised separately: the default test settings carry no
Supabase config, so ``current_user_or_local`` degrades to the shared
``local`` identity and the route serves the local SQLite store (W3,
2026-07-11) — same keyless contract as the ontology routes. A Supabase-
configured deployment (env vars set here for one test at a time) keeps the
original RLS-scoped PostgREST behavior unchanged.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import keys as keys_mod
from app.config import Settings
from app.keys import UserCtx, current_user_or_local
from app.routes import alert_rules as ar


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def _configure_supabase(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make ``current_user_or_local`` and this route's own backend-selection
    both see Supabase as configured, for exactly this test.

    ``app.config.get_settings`` is ``@lru_cache(maxsize=1)`` — the process-wide
    singleton is already memoized (blank supabase, matching the hermetic test
    default and the ``ALLOW_UNAUTHENTICATED=1`` test posture) by the time any
    test runs, so ``monkeypatch.setenv`` has no effect on it. Patch the name
    each module actually calls instead (the standard "patch where it's used"
    fix) rather than touching the global cache or the auth middleware (which
    stays in its normal open test posture) — this isolates exactly the thing
    under test: does the ROUTE fall back to the Supabase REST backend and
    ``current_user``'s strict token check once Supabase is configured.
    """
    fake = Settings(supabase_url="http://x", supabase_anon_key="anon")
    monkeypatch.setattr(keys_mod, "get_settings", lambda: fake)
    monkeypatch.setattr(ar, "get_settings", lambda: fake)


# ── keyless (default test settings: no Supabase) ─────────────────────────────


def test_rules_serve_keyless_with_local_identity(client: TestClient) -> None:
    # No Supabase configured (default test settings) → current_user_or_local
    # degrades to the shared "local" identity instead of a dead 401 — same
    # contract test_ontology_local.py asserts for the ontology routes.
    assert client.get("/api/alerts/rules").status_code == 200
    assert client.get("/api/alerts/rules").json() == []


def test_create_rejects_unknown_kind(client: TestClient) -> None:
    r = client.post(
        "/api/alerts/rules",
        json={"label": "x", "lat": 1, "lon": 2, "kinds": ["bogus"]},
    )
    assert r.status_code == 400


def test_create_rejects_bad_channel(client: TestClient) -> None:
    r = client.post(
        "/api/alerts/rules",
        json={"label": "x", "lat": 1, "lon": 2, "channel": "carrier-pigeon"},
    )
    assert r.status_code == 400


def test_create_rejects_email_until_a_sender_exists(client: TestClient) -> None:
    # "email" used to be accepted and then silently never delivered (nothing
    # sends it). Accepted-but-dead is worse than an honest 400 at creation.
    r = client.post(
        "/api/alerts/rules",
        json={"label": "x", "lat": 1, "lon": 2, "channel": "email"},
    )
    assert r.status_code == 400
    assert "not implemented" in r.json()["detail"]


def test_create_rejects_discord_without_sink_url(client: TestClient) -> None:
    r = client.post(
        "/api/alerts/rules",
        json={"label": "x", "lat": 1, "lon": 2, "channel": "discord"},
    )
    assert r.status_code == 400
    assert "sink_url" in r.json()["detail"]


def test_create_rejects_bad_sink_url(client: TestClient) -> None:
    r = client.post(
        "/api/alerts/rules",
        json={
            "label": "x", "lat": 1, "lon": 2,
            "channel": "webhook", "sink_url": "not-a-url",
        },
    )
    assert r.status_code == 400


def test_create_rejects_neither_identity_nor_aoi(client: TestClient) -> None:
    # Nothing provided (no lat/lon, no icao24/mmsi/callsign) — the model
    # validator has nothing to gate the rule on, so this is a 422, not a
    # silent lat=0/lon=0 (sam-2 finding).
    r = client.post("/api/alerts/rules", json={"label": "x"})
    assert r.status_code == 422
    assert "identity pin" in str(r.json()["detail"])


def test_create_rejects_partial_aoi_without_identity(client: TestClient) -> None:
    # lat given without lon (or vice versa) is never a usable AOI, identity
    # pin or not — reject it rather than coerce the missing half to 0.
    r = client.post("/api/alerts/rules", json={"label": "x", "lat": 26.5})
    assert r.status_code == 422
    assert "lat and lon" in str(r.json()["detail"])


def test_create_identity_only_rule_persists_no_aoi(client: TestClient) -> None:
    # mika-3 / sam-2: an icao24/mmsi/callsign-pinned rule needs no starting
    # coordinate. The created row and the list read-back must carry real
    # nulls, never a fabricated lat=0/lon=0/radius_nm=50.
    r = client.post(
        "/api/alerts/rules",
        json={"label": "THUN EOS watch", "kinds": ["ais_gap"], "mmsi": "244013009"},
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["lat"] is None
    assert created["lon"] is None
    assert created["radius_nm"] is None
    assert created["mmsi"] == "244013009"
    rule_id = created["id"]

    listed = client.get("/api/alerts/rules").json()
    assert len(listed) == 1
    assert listed[0]["lat"] is None
    assert listed[0]["lon"] is None
    assert listed[0]["radius_nm"] is None

    assert client.delete(f"/api/alerts/rules/{rule_id}").status_code == 204


def test_crud_keyless_local_store(client: TestClient) -> None:
    # Local SQLite CRUD path (no Supabase): create, list, delete round-trip.
    r = client.post(
        "/api/alerts/rules",
        json={
            "label": "Hormuz watch",
            "lat": 26.5,
            "lon": 56.3,
            "radius_nm": 80,
            "kinds": ["jamming", "dark_vessel"],
            "min_severity": 2,
            "channel": "discord",
            "sink_url": "https://discord.com/api/webhooks/123/abc",
        },
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["label"] == "Hormuz watch"
    assert created["channel"] == "discord"
    rule_id = created["id"]

    listed = client.get("/api/alerts/rules").json()
    assert [row["id"] for row in listed] == [rule_id]

    assert client.delete(f"/api/alerts/rules/{rule_id}").status_code == 204
    assert client.get("/api/alerts/rules").json() == []


def test_deliveries_endpoint_starts_empty(client: TestClient) -> None:
    r = client.get("/api/alerts/deliveries")
    assert r.status_code == 200
    assert r.json() == {"deliveries": []}


async def test_record_delivery_caps_the_append_only_log(monkeypatch) -> None:
    """alert_deliveries is append-only; record_delivery must bound it so the DB
    can't grow forever once a rule fires on every sweep."""
    from app.intel import alert_rules_local as arl

    monkeypatch.setattr(arl, "DELIVERIES_KEEP", 5)

    def _connect_count() -> int:
        con = arl._connect()
        try:
            return con.execute("SELECT COUNT(*) FROM alert_deliveries").fetchone()[0]
        finally:
            con.close()

    for i in range(12):
        await arl.record_delivery(
            rule_id="r1", entity_id=f"e{i}", transition="enter",
            channel="discord", target="https://x", ok=True, status=200,
            error=None, message=f"m{i}",
        )
    # newest DELIVERIES_KEEP+1 survive (rows with id > max_id - KEEP); the log
    # stays bounded regardless of how many attempts fire.
    assert _connect_count() <= arl.DELIVERIES_KEEP + 1
    recent = await arl.recent_deliveries(limit=100)
    assert [d["entity_id"] for d in recent[:2]] == ["e11", "e10"]  # newest first


# ── Supabase path (unchanged behavior when configured) ────────────────────────


def test_rules_require_auth_when_supabase_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure_supabase(monkeypatch)
    assert client.get("/api/alerts/rules").status_code == 401


def test_crud_with_fake_user_supabase(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure_supabase(monkeypatch)
    client.app.dependency_overrides[current_user_or_local] = _fake_user

    class FakeResp:
        def __init__(self, status: int, payload):  # type: ignore[no-untyped-def]
            self.status_code = status
            self._payload = payload

        def json(self):  # type: ignore[no-untyped-def]
            return self._payload

    class FakeClient:
        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *a):  # type: ignore[no-untyped-def]
            return False

        async def get(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(200, [])

        async def post(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(
                201,
                [{
                    "id": "r1",
                    "label": "Hormuz watch",
                    "lat": 26.5,
                    "lon": 56.3,
                    "radius_nm": 80,
                    "kinds": ["jamming", "dark_vessel"],
                    "min_severity": 2,
                    "channel": "inapp",
                    "enabled": True,
                    "created_at": "2026-06-19T00:00:00Z",
                }],
            )

        async def delete(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(204, None)

    monkeypatch.setattr(ar, "_client", lambda: FakeClient())
    monkeypatch.setattr(ar, "_rest", lambda s: "http://x/rest/v1/alert_rules")

    try:
        assert client.get("/api/alerts/rules").json() == []

        r = client.post(
            "/api/alerts/rules",
            json={
                "label": "Hormuz watch",
                "lat": 26.5,
                "lon": 56.3,
                "radius_nm": 80,
                "kinds": ["jamming", "dark_vessel"],
                "min_severity": 2,
            },
        )
        assert r.status_code == 201
        assert r.json()["id"] == "r1"

        assert client.delete("/api/alerts/rules/r1").status_code == 204
    finally:
        client.app.dependency_overrides.pop(current_user_or_local, None)
