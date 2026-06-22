"""Unit tests for on-demand tasking adapters (B5) + POST /api/imagery/task.

Pure logic + mocked Settings — NO network, NO real provider creds, NO secrets.
Covers: the provider capability map, the HONEST degraded response when a
provider is unconfigured (no fake order id, names the missing env var), the
commercial gate on the route (402 for a free/non-commercial request), the
degraded-200 path for a commercial request with no creds wired, and validation.

Settings has ``extra='ignore'`` so undeclared tasking-cred fields can't be
injected via the constructor; the configured-path tests use a SimpleNamespace
(``tasking._token`` reads via getattr, so a duck-typed settings object works).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app.config import Settings
from app.imagery import tasking
from app.intel.geo import BBox
from app.tier import commercial_request

_AOI = BBox(96.0, 21.9, 96.2, 22.1)


# ── provider capability map ───────────────────────────────────────────────────


def test_providers_present_and_unconfigured_by_default() -> None:
    s = Settings()  # no tasking creds
    provs = tasking.providers(s)
    ids = {p.id for p in provs}
    assert ids == {"iceye", "umbra", "planet"}
    assert all(p.configured is False for p in provs)
    assert tasking.any_configured(s) is False


def test_provider_as_dict_exposes_env_name_not_value() -> None:
    s = SimpleNamespace(iceye_api_token="super-secret-token")
    d = tasking.provider("iceye", s).as_dict()
    assert d["configured"] is True
    # the env-var NAME is surfaced for the operator; the VALUE never is
    assert d["credential_env"] == "ICEYE_API_TOKEN"
    assert "super-secret-token" not in str(d)


def test_token_missing_attr_is_empty_not_error() -> None:
    # A deployment whose Settings hasn't declared the field → unconfigured, not
    # an AttributeError.
    assert tasking._token(Settings(), "umbra_api_token") == ""


# ── submit_task: honest degraded path ─────────────────────────────────────────


def test_submit_task_degraded_when_unconfigured() -> None:
    async def run() -> None:
        out = await tasking.submit_task("iceye", _AOI, settings=Settings())
        assert out["status"] == "degraded"
        assert out["order_id"] is None  # NEVER a fabricated order
        assert out["configured"] is False
        assert out["provider"] == "iceye"
        assert "ICEYE_API_TOKEN" in out["remediation"]
        assert out["aoi"] == _AOI.as_dict()

    asyncio.run(run())


def test_submit_task_configured_dispatches_but_stays_honest() -> None:
    """A configured provider passes the configured gate and reaches its adapter,
    which is intentionally the single honest 'not yet wired' degraded path (the
    real STAPI order is a future per-provider turn). Still no fake order id."""

    async def run() -> None:
        s = SimpleNamespace(planet_api_key="paid-key")
        out = await tasking.submit_task("planet", _AOI, settings=s)
        assert out["status"] == "degraded"
        assert out["order_id"] is None
        assert out["configured"] is True
        assert "not yet wired" in out["reason"].lower()

    asyncio.run(run())


def test_submit_task_unknown_provider_raises() -> None:
    async def run() -> None:
        try:
            await tasking.submit_task("blacksky", _AOI, settings=Settings())
        except KeyError:
            return
        raise AssertionError("unknown provider should raise KeyError")

    asyncio.run(run())


# ── route: GET providers (capability, reachable) ──────────────────────────────


def test_tasking_providers_route(client) -> None:
    r = client.get("/api/imagery/tasking/providers")
    assert r.status_code == 200
    body = r.json()
    assert {p["id"] for p in body["providers"]} == {"iceye", "umbra", "planet"}
    assert body["any_configured"] is False
    # no secret leaked — only env-var names
    assert all("credential_env" in p for p in body["providers"])


# ── route: POST task — commercial gate + degraded body ────────────────────────


def test_task_free_request_402(client) -> None:
    """Tasking is a commercial capability. A free/non-commercial request (the
    default test settings have commercial_mode False, no paid header) is refused
    with 402 — never served a fake/free order."""
    r = client.post(
        "/api/imagery/task",
        json={"provider": "iceye", "lat": 21.97, "lon": 96.08},
    )
    assert r.status_code == 402


def test_task_commercial_unconfigured_returns_degraded(client) -> None:
    """A commercial/paid request passes the gate but, with no provider creds
    wired, gets an honest degraded body (HTTP 200) — not an order, not a 500."""
    client.app.dependency_overrides[commercial_request] = lambda: True
    try:
        r = client.post(
            "/api/imagery/task",
            json={"provider": "umbra", "lat": 21.97, "lon": 96.08, "radius_km": 5},
        )
    finally:
        client.app.dependency_overrides.pop(commercial_request, None)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "degraded"
    assert body["order_id"] is None
    assert body["provider"] == "umbra"
    assert "UMBRA_API_TOKEN" in body["remediation"]


def test_task_bad_provider_400(client) -> None:
    client.app.dependency_overrides[commercial_request] = lambda: True
    try:
        r = client.post(
            "/api/imagery/task",
            json={"provider": "nope", "lat": 21.97, "lon": 96.08},
        )
    finally:
        client.app.dependency_overrides.pop(commercial_request, None)
    assert r.status_code == 400


def test_task_missing_coords_422(client) -> None:
    # lat/lon are required typed fields on the Pydantic body → FastAPI 422
    # before the handler runs (the commercial gate is a Depends, evaluated
    # after body validation).
    client.app.dependency_overrides[commercial_request] = lambda: True
    try:
        r = client.post("/api/imagery/task", json={"provider": "iceye"})
    finally:
        client.app.dependency_overrides.pop(commercial_request, None)
    assert r.status_code == 422
