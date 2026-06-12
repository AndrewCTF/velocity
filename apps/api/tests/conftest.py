"""Pytest fixtures: isolate test settings from real .env / env vars."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

# MUST be set before any TestClient lifespan runs: `with TestClient(app)`
# executes the app lifespan, which would otherwise start the correlate
# runner's background loops — several of which fire REAL upstream HTTP
# (OpenSky, airplanes.live) on their first tick. Unit tests must never
# touch the network.
os.environ.setdefault("OSINT_DISABLE_BACKGROUND", "1")

from app.config import Settings, get_settings  # noqa: E402
from app.main import create_app  # noqa: E402

# One tile-cache dir per test session — _test_settings() is called per
# request via dependency_overrides, and a fresh mkdtemp per call would
# defeat the disk cache the tile tests assert on.
_TEST_TILE_DIR = tempfile.mkdtemp(prefix="osint-test-tiles-")


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
        tile_cache_dir=_TEST_TILE_DIR,
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
