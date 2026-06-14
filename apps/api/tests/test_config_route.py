"""GET /api/config — contract test.

The shape must match packages/shared/src/config.ts (RuntimeConfig). Field
names go out in JS-camelCase so the frontend can consume them directly.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_returns_runtime_config_with_camel_case_keys(client: TestClient) -> None:
    r = client.get("/api/config")
    assert r.status_code == 200
    body = r.json()

    # camelCase contract — frontend reads these names verbatim
    assert set(body.keys()) == {
        "cesiumIonToken",
        "googleApiKey",
        "features",
        "classification",
        "buildId",
    }
    assert body["cesiumIonToken"] == "test-ion-token"
    # googleApiKey is a client-side Maps key (referrer-restricted), like the ion
    # token; empty in tests since conftest sets no gmaps_key.
    assert isinstance(body["googleApiKey"], str)
    assert body["classification"] == "UNCLAS"
    assert body["buildId"] == "test"
    assert body["features"] == {"enableGoogle3D": False}


def test_features_toggle_is_present_even_when_false(client: TestClient) -> None:
    # frontend depends on the key existing; never let it become optional.
    r = client.get("/api/config")
    body = r.json()
    assert "enableGoogle3D" in body["features"]
    assert isinstance(body["features"]["enableGoogle3D"], bool)


def test_does_not_leak_third_party_secrets(client: TestClient) -> None:
    """Plan §locked-decisions #3: only the ion token may leave the backend."""
    r = client.get("/api/config")
    body = r.json()
    serialized = repr(body).lower()
    forbidden = [
        "client_secret",
        "aisstream_key",
        "firms_map_key",
        "gfw_token",
        "cdse",
        "gmaps",
        "opensky",
    ]
    for needle in forbidden:
        assert needle not in serialized, f"forbidden secret leaked: {needle}"


def test_health_endpoint(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
