"""MarineTraffic bridge — offline parse/normalize + dormant-without-key contract."""

from __future__ import annotations

import asyncio
from typing import Any

from app import marinetraffic


def test_start_dormant_without_key(monkeypatch) -> None:
    # No key → start() must no-op (never spawn a poll task), so it's free when
    # unconfigured. We assert via the stats flag without needing a running loop.
    from app.config import Settings

    monkeypatch.setattr(marinetraffic, "get_settings", lambda: Settings(marinetraffic_key=""))
    marinetraffic.start()
    assert marinetraffic.stats()["enabled"] is False


def test_publish_normalizes_marinetraffic_rows(monkeypatch) -> None:
    captured: list[dict[str, Any]] = []

    async def fake_publish(mmsi, lat, lon, **kw):  # noqa: ANN001, ANN003
        captured.append({"mmsi": mmsi, "lat": lat, "lon": lon, **kw})
        return True

    monkeypatch.setattr(marinetraffic.ais_firehose, "publish_vessel", fake_publish)

    rows = [
        # jsono (MarineTraffic field names)
        {"MMSI": "636092000", "LAT": "20.5", "LON": "115.2", "SPEED": "12.3", "COURSE": "180", "HEADING": "178", "SHIPNAME": "EVER GIVEN", "SHIPTYPE": "70"},
        # lower-case variant
        {"mmsi": 257758700, "lat": 60.1, "lon": 24.9, "sog": 0.0, "name": "FINLANDIA"},
        # missing position → skipped
        {"MMSI": "111", "SHIPNAME": "NO POS"},
        # not a dict → skipped
        ["positional", "row"],
    ]
    n = asyncio.run(marinetraffic._publish(rows))
    assert n == 2
    assert captured[0]["mmsi"] == "636092000"
    assert captured[0]["lat"] == 20.5 and captured[0]["lon"] == 115.2
    assert captured[0]["sog"] == 12.3 and captured[0]["name"] == "EVER GIVEN"
    assert captured[0]["source"] == "marinetraffic"
    assert captured[1]["name"] == "FINLANDIA"
