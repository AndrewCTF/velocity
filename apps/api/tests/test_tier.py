"""Commercial-source gating — resolve_commercial truth table + route wiring."""

from __future__ import annotations

from types import SimpleNamespace

import app.tier as tier
from app.tier import commercial_request, resolve_commercial


def _patch_settings(monkeypatch, *, commercial_mode: bool, allow_nc_for_free: bool = False):
    monkeypatch.setattr(
        tier,
        "get_settings",
        lambda: SimpleNamespace(
            commercial_mode=commercial_mode, allow_nc_for_free=allow_nc_for_free
        ),
    )


def test_paid_is_always_commercial(monkeypatch) -> None:
    # A paying customer must get commercial-legal sources regardless of deployment.
    _patch_settings(monkeypatch, commercial_mode=False)
    assert resolve_commercial("paid") is True
    _patch_settings(monkeypatch, commercial_mode=True)
    assert resolve_commercial("paid") is True


def test_free_follows_deployment_and_optin(monkeypatch) -> None:
    _patch_settings(monkeypatch, commercial_mode=True, allow_nc_for_free=False)
    assert resolve_commercial("free") is True  # commercial deploy, no NC opt-in
    _patch_settings(monkeypatch, commercial_mode=True, allow_nc_for_free=True)
    assert resolve_commercial("free") is False  # operator opted free users into NC
    _patch_settings(monkeypatch, commercial_mode=False)
    assert resolve_commercial("free") is False  # non-commercial deploy


def test_absent_header_follows_deployment(monkeypatch) -> None:
    _patch_settings(monkeypatch, commercial_mode=True)
    assert resolve_commercial(None) is True
    _patch_settings(monkeypatch, commercial_mode=False)
    assert resolve_commercial(None) is False
    assert resolve_commercial("") is False


def test_imagery_aoi_drops_maxar_for_commercial(client) -> None:
    """A commercial-tier request to /api/imagery/aoi must omit Maxar (CC BY-NC)
    and report it disabled — no network needed (Maxar search is skipped)."""
    client.app.dependency_overrides[commercial_request] = lambda: True
    try:
        r = client.get(
            "/api/imagery/aoi",
            params={"before": "2025-03-20", "after": "2025-04-05", "lat": 21.97, "lon": 96.08},
        )
    finally:
        client.app.dependency_overrides.pop(commercial_request, None)
    assert r.status_code == 200
    body = r.json()
    assert body["commercial"] is True
    assert body["maxar"]["before_items"] == []
    assert body["maxar"]["after_items"] == []
    assert "disabled" in body["maxar"]["note"].lower()
