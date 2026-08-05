"""The three primary emitters, and the arithmetic that makes surge a finding."""

from __future__ import annotations

import pytest

from app.routes import primary


def test_kp_bands_follow_noaas_own_g_scale() -> None:
    # G1 begins at Kp 5. Below that is quiet or unsettled, and calling a Kp 4
    # "minor storm" would put an alert on the map for a normal afternoon.
    assert primary._kp_band(0) == "quiet"
    assert primary._kp_band(3.9) == "quiet"
    assert primary._kp_band(4) == "unsettled"
    assert primary._kp_band(5) == "G1 minor"
    assert primary._kp_band(6) == "G2 moderate"
    assert primary._kp_band(7) == "G3 strong"
    assert primary._kp_band(9) == "G4 severe"


def test_the_surge_station_list_is_well_formed() -> None:
    seen = set()
    for sid, name, lat, lon in primary.SURGE_STATIONS:
        assert sid.isdigit(), sid
        assert sid not in seen, f"{sid} listed twice"
        seen.add(sid)
        assert name
        assert -90 <= lat <= 90 and -180 <= lon <= 180, name


@pytest.mark.asyncio
async def test_surge_compares_the_same_minute_not_the_last_of_each(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The defect this guards: the prediction series runs on a 6-minute grid and
    # keeps going past the last observation. Taking the last of each subtracts
    # two different moments, which reports the tide's own slope as surge.
    observed = {"data": [{"t": "2026-08-05 13:18", "v": "0.512"}]}
    predictions = {
        "predictions": [
            {"t": "2026-08-05 13:12", "v": "0.400"},
            {"t": "2026-08-05 13:18", "v": "0.429"},
            {"t": "2026-08-05 13:24", "v": "0.460"},  # later than any observation
        ]
    }

    class FakeResponse:
        def __init__(self, body: dict[str, object]) -> None:
            self._body = body

        def json(self) -> dict[str, object]:
            return self._body

    class FakeClient:
        async def get(self, url: str, **kw: object) -> FakeResponse:  # noqa: ANN401
            params = kw.get("params") or {}
            return FakeResponse(
                predictions if params.get("product") == "predictions" else observed  # type: ignore[union-attr]
            )

    monkeypatch.setattr(primary, "get_client", lambda: FakeClient())
    got = await primary._station_surge("8518750")
    assert got is not None
    obs, pred, t = got
    assert t == "2026-08-05 13:18"
    assert pred == 0.429  # the matching minute, NOT 0.460
    assert round(obs - pred, 3) == 0.083


@pytest.mark.asyncio
async def test_a_station_with_no_matching_minute_is_dropped_not_guessed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def __init__(self, body: dict[str, object]) -> None:
            self._body = body

        def json(self) -> dict[str, object]:
            return self._body

    class FakeClient:
        async def get(self, url: str, **kw: object) -> FakeResponse:  # noqa: ANN401
            params = kw.get("params") or {}
            if params.get("product") == "predictions":  # type: ignore[union-attr]
                return FakeResponse({"predictions": [{"t": "2026-08-05 09:00", "v": "0.1"}]})
            return FakeResponse({"data": [{"t": "2026-08-05 13:18", "v": "0.512"}]})

    monkeypatch.setattr(primary, "get_client", lambda: FakeClient())
    assert await primary._station_surge("8518750") is None


@pytest.mark.asyncio
async def test_a_rate_limited_launch_upstream_is_not_an_empty_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Launch Library answers a rate-limited caller with a 200 carrying no
    # `results` key. Rendering that as "no launches" would be a confident lie
    # about a manifest that is never empty.
    class FakeResponse:
        status_code = 200

        def json(self) -> dict[str, object]:
            return {"detail": "Request was throttled."}

    class FakeClient:
        async def get(self, url: str, **kw: object) -> FakeResponse:  # noqa: ANN401
            return FakeResponse()

    monkeypatch.setattr(primary, "get_client", lambda: FakeClient())
    env = await primary._launches(10)
    assert env["reached"] is False
    assert env["features"] == []
    assert "did not answer" in env["note"]
