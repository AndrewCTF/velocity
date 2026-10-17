"""History off must mean nothing is buffered.

With ``history_enabled=False`` the flush task never starts (``history.start``),
so a fix appended to ``_buffer`` stays in RAM forever. Measured on the lite
profile before this guard: the buffer grew ~1,400 fixes/s to 19.4M rows and the
API sat at 9.2 GB RSS after 5 h, on the profile meant for 8 GB boxes.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import history


def _aircraft(n: int) -> list[dict]:
    return [
        {
            "geometry": {"coordinates": [10.0 + i * 0.01, 50.0]},
            "properties": {"icao24": f"ab{i:04x}", "track_deg": 90.0},
        }
        for i in range(n)
    ]


def _vessels(n: int) -> list[dict]:
    return [{"id": f"vessel:2{i:08d}", "lon": 4.0 + i * 0.01, "lat": 52.0} for i in range(n)]


@pytest.fixture()
def clean_buffer(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(history, "_buffer", [])
    monkeypatch.setattr(history, "_last", type(history._last)())
    monkeypatch.setattr(history, "_resolve_vessel", lambda *a, **k: None)
    return monkeypatch


def _settings(enabled: bool):
    real = history.get_settings()
    return lambda: SimpleNamespace(**{**real.__dict__, "history_enabled": enabled})


def test_disabled_history_buffers_nothing(clean_buffer) -> None:
    clean_buffer.setattr(history, "get_settings", _settings(False))
    history.ingest_aircraft(_aircraft(50))
    history.ingest_vessels(_vessels(50))
    assert history._buffer == []


def test_enabled_history_still_buffers(clean_buffer) -> None:
    clean_buffer.setattr(history, "get_settings", _settings(True))
    history.ingest_aircraft(_aircraft(5))
    history.ingest_vessels(_vessels(5))
    assert len(history._buffer) == 10


def test_disabled_history_still_resolves_vessels(clean_buffer) -> None:
    seen: list[str] = []
    clean_buffer.setattr(history, "_resolve_vessel", lambda eid, row: seen.append(eid))
    clean_buffer.setattr(history, "get_settings", _settings(False))
    history.ingest_vessels(_vessels(3))
    assert len(seen) == 3 and history._buffer == []
