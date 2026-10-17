"""The tile process: the API's tile routes on an event loop of their own."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_the_tile_process_serves_tiles_and_nothing_else() -> None:
    from app.tiles_main import app

    with TestClient(app) as client:
        # A tile route answered by the tile router (zoom 16 is past the terrain
        # pyramid, so this never leaves the process), under the API's headers.
        r = client.get("/tiles/terrain/16/0/0.png")
        assert r.status_code == 400
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["x-frame-options"] == "DENY"
        # Nothing else is mounted: no feeds, no docs, no second copy of the API.
        for path in ("/api/health", "/api/status/perf", "/docs", "/openapi.json"):
            assert client.get(path).status_code == 404, path


def test_a_page_on_this_machine_may_read_tiles_from_the_tile_process() -> None:
    """The mesh is fetched from this port directly, so every tile is a
    cross-origin read: the API's own origins are allowed, nobody else's."""
    from app.tiles_main import app

    with TestClient(app) as client:
        ours = client.get("/tiles/terrain/16/0/0.png", headers={"Origin": "http://localhost:5173"})
        assert ours.headers["access-control-allow-origin"] == "http://localhost:5173"
        theirs = client.get("/tiles/terrain/16/0/0.png", headers={"Origin": "http://evil.example"})
        assert "access-control-allow-origin" not in theirs.headers
