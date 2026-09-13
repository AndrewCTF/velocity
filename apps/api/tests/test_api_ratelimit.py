"""G11: a generous per-client cap on every /api/ path, on top of the compute cap.

Health / status / config stay exempt (the browser needs them to render and the
operator needs them to diagnose a throttled box).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import ratelimit
from app.config import Settings
from app.main import create_app


def _settings(**over: object) -> Settings:
    base: dict[str, object] = dict(
        api_key="", supabase_url="", supabase_anon_key="", supabase_jwt_secret=""
    )
    base.update(over)
    return Settings(**base)  # type: ignore[arg-type]


def test_default_is_generous() -> None:
    # The 1 Hz ADS-B poll alone is 60/min; a globe session adds many 5 s layer polls.
    assert Settings().api_ratelimit_per_min >= 1200


def test_general_api_path_is_limited(monkeypatch) -> None:
    monkeypatch.setattr(ratelimit, "get_settings", lambda: _settings(api_ratelimit_per_min=3))
    with TestClient(create_app()) as c:
        codes = [c.get("/api/alerts/deliveries").status_code for _ in range(4)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429


def test_one_bucket_across_api_paths(monkeypatch) -> None:
    monkeypatch.setattr(ratelimit, "get_settings", lambda: _settings(api_ratelimit_per_min=2))
    with TestClient(create_app()) as c:
        assert c.get("/api/alerts/deliveries").status_code == 200
        assert c.get("/api/alerts/rules").status_code == 200
        r = c.get("/api/alerts/deliveries")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1


def test_health_status_config_are_exempt(monkeypatch) -> None:
    monkeypatch.setattr(ratelimit, "get_settings", lambda: _settings(api_ratelimit_per_min=1))
    with TestClient(create_app()) as c:
        for path in ("/api/health", "/api/config", "/api/status"):
            assert all(c.get(path).status_code != 429 for _ in range(3)), path


def test_zero_disables_general_limit(monkeypatch) -> None:
    monkeypatch.setattr(ratelimit, "get_settings", lambda: _settings(api_ratelimit_per_min=0))
    with TestClient(create_app()) as c:
        assert all(c.get("/api/alerts/deliveries").status_code == 200 for _ in range(5))


def test_compute_cap_still_applies_under_general_cap(monkeypatch) -> None:
    monkeypatch.setattr(
        ratelimit, "get_settings",
        lambda: _settings(api_ratelimit_per_min=100, ratelimit_compute_per_min=2),
    )
    with TestClient(create_app()) as c:
        codes = [c.get("/api/recon/jobs/deadbeef00").status_code for _ in range(3)]
    assert codes == [404, 404, 429]
