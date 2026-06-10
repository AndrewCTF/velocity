"""Settings smoke test — ensures env vars wire through cleanly."""

from __future__ import annotations

import pytest

from app.config import Settings


def test_settings_defaults() -> None:
    s = Settings()
    assert s.api_port == 8000
    assert s.classification == "UNCLAS"
    assert s.enable_google_3d is False


def test_settings_accept_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CESIUM_ION_TOKEN", "abc123")
    monkeypatch.setenv("ENABLE_GOOGLE_3D", "true")
    monkeypatch.setenv("API_PORT", "9000")
    s = Settings()
    assert s.cesium_ion_token == "abc123"
    assert s.enable_google_3d is True
    assert s.api_port == 9000
