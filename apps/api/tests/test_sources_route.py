"""GET /api/intel/sources must enumerate every key-gated feed (honesty:
a feed that silently needs a key shouldn't look 'always on')."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings


@pytest.fixture(autouse=True)
def _no_opensky_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep these tests hermetic. ``intel_sources`` calls ``get_settings()``
    directly (not via Depends), so the dev .env's real OpenSky creds would
    otherwise leak in and the new working-probe would fire a real OAuth POST.
    Default to creds-free here; probe tests re-patch as needed."""
    from app.routes import intel

    monkeypatch.setattr(
        intel,
        "get_settings",
        lambda: Settings(opensky_client_id="", opensky_client_secret=""),
    )


def test_sources_lists_all_key_gated(client: TestClient) -> None:
    r = client.get("/api/intel/sources")
    assert r.status_code == 200
    kg = r.json()["key_gated"]
    # The four previously-listed plus the three that were silently omitted.
    for feed in (
        "aisstream",
        "firms_fires",
        "opensky_authed",
        "gfw_dark_vessels",
        "acled_events",
        "cloudflare_outages",
        "openaip",
    ):
        assert feed in kg, f"{feed} missing from key_gated"
        assert isinstance(kg[feed], bool)


def test_sources_has_honesty_note(client: TestClient) -> None:
    b = client.get("/api/intel/sources").json()
    assert "key_gated_note" in b and "degraded" in b


def test_opensky_authed_working_null_when_unconfigured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # With NO OpenSky creds: `opensky_authed` is the CONFIGURED bool (False),
    # and the probe-backed working signal is null (no creds to probe) — never a
    # fabricated True, and no upstream call is made.
    # (intel_sources calls get_settings() directly, not via Depends, so we
    # patch the module-level reference to stay hermetic regardless of the dev
    # .env's real creds.)
    from app.routes import intel

    monkeypatch.setattr(
        intel,
        "get_settings",
        lambda: Settings(opensky_client_id="", opensky_client_secret=""),
    )
    b = client.get("/api/intel/sources").json()
    assert b["key_gated"]["opensky_authed"] is False
    assert b["opensky_authed_working"] is None


def test_opensky_authed_working_false_when_probe_fails(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Creds CONFIGURED but the OAuth probe fails ("Invalid client") → configured
    # stays True, but working is honestly False (CLAUDE.md: configured != working).
    from app.routes import aviation, intel

    monkeypatch.setattr(
        intel,
        "get_settings",
        lambda: Settings(
            opensky_client_id="cid", opensky_client_secret="csec"
        ),
    )

    class _DeadTM:
        async def get(self) -> str:
            raise RuntimeError("Invalid client")

    monkeypatch.setattr(aviation, "_token_manager", lambda _s: _DeadTM())

    b = client.get("/api/intel/sources").json()
    assert b["key_gated"]["opensky_authed"] is True  # configured
    assert b["opensky_authed_working"] is False  # but proven not working


def test_opensky_authed_working_true_when_token_issued(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.routes import aviation, intel

    monkeypatch.setattr(
        intel,
        "get_settings",
        lambda: Settings(
            opensky_client_id="cid", opensky_client_secret="csec"
        ),
    )

    class _LiveTM:
        async def get(self) -> str:
            return "a-real-token"

    monkeypatch.setattr(aviation, "_token_manager", lambda _s: _LiveTM())

    b = client.get("/api/intel/sources").json()
    assert b["opensky_authed_working"] is True
