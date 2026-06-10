"""Pytest fixtures: isolate test settings from real .env / env vars."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import create_app


def _test_settings() -> Settings:
    return Settings(
        cesium_ion_token="test-ion-token",
        enable_google_3d=False,
        classification="UNCLAS",
        build_id="test",
        opensky_client_id="",
        opensky_client_secret="",
        aisstream_key="",
        firms_map_key="",
        gfw_token="",
        cdse_client_id="",
        cdse_client_secret="",
        gmaps_key="",
        database_url="postgresql+asyncpg://test:test@localhost:5432/test",
        redis_url="redis://localhost:6379/0",
        cors_origins="http://localhost:8080",
    )


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app()
    app.dependency_overrides[get_settings] = _test_settings
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
