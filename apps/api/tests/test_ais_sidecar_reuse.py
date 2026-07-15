"""A wedged AIS feeder must not be adopted across a backend restart.

Post-mortem (2026-07-15): the MyShipTracking feeder's browser lost the site and
fell back to replaying its last world sweep. It kept answering /health 200 the
whole time, so ``_already_healthy`` — which accepted ANY 200 — re-adopted it on
every boot. The frozen union outlived restarts, 21944 of 57174 vessels in
/api/maritime/snapshot were 14-minute-old positions served as live, and the
feeder ignored the SIGTERM that stop() sent (it only escalated to SIGKILL for a
SPAWNED child, never for a reused pid), so nothing ever reclaimed the port.

Health is therefore two things — the server answers, AND its union is recent
enough to be worth publishing.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import pytest

from app import ais_sidecar


class _Resp:
    def __init__(self, status_code: int, body: Any = None) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> Any:
        return self._body


def _patch_health(monkeypatch: pytest.MonkeyPatch, resp: _Resp | Exception) -> None:
    class _Client:
        def __init__(self, *a: Any, **k: Any) -> None: ...

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *a: Any) -> bool:
            return False

        async def get(self, url: str) -> _Resp:
            if isinstance(resp, Exception):
                raise resp
            return resp

    monkeypatch.setattr(ais_sidecar.httpx, "AsyncClient", _Client)


def _sidecar(cap: float | None = 180.0) -> ais_sidecar._Sidecar:
    return ais_sidecar._Sidecar(
        "probe", "ais-myshiptracking-feeder", 8093, lambda: True,
        max_age_s=(lambda: cap) if cap is not None else None,
    )


async def test_fresh_union_is_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_health(monkeypatch, _Resp(200, {"total": 22837, "age_s": 30}))
    assert await _sidecar()._already_healthy() is True


async def test_cold_sidecar_is_reused_before_its_first_scrape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The first world-grid sweep takes ~15-30s and reports age_s: null. The poller
    # tolerates an empty union, so a warming feeder is healthy — NOT stale.
    _patch_health(monkeypatch, _Resp(200, {"total": 0, "age_s": None}))
    assert await _sidecar()._already_healthy() is True


async def test_wedged_feeder_replaying_an_old_union_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The exact shape served at 21:20 on 2026-07-15: HTTP 200, a full-looking
    # 22837-vessel union, every position 27 minutes old.
    _patch_health(monkeypatch, _Resp(200, {"total": 22837, "age_s": 1631}))
    assert await _sidecar()._already_healthy() is False


async def test_no_cap_configured_keeps_the_plain_200_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Feeders without a staleness cap (marinetraffic/vesselfinder) must not start
    # failing health on an age_s they never promised.
    _patch_health(monkeypatch, _Resp(200, {"total": 5, "age_s": 99999}))
    assert await _sidecar(cap=None)._already_healthy() is True


async def test_unparseable_or_dead_health_is_unhealthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_health(monkeypatch, _Resp(500, None))
    assert await _sidecar()._already_healthy() is False
    _patch_health(monkeypatch, ConnectionRefusedError("nothing on the port"))
    assert await _sidecar()._already_healthy() is False


async def test_supervise_restarts_a_feeder_that_stopped_serving(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """start() ran once at boot, so a feeder that died later stayed dead.

    2026-07-15: a restart's start() adopted the OUTGOING backend's sidecar (still
    listening, health 200) moments before that backend's stop() killed it. :8093
    was dead for the rest of the process; the poller just backed off against a
    closed port and the tier went silently empty.
    """
    sc = _sidecar()
    monkeypatch.setattr(ais_sidecar, "_SIDECARS", [sc])
    started: list[str] = []

    async def _record() -> None:
        started.append(sc.name)

    monkeypatch.setattr(sc, "start", _record)

    # Dead port → unhealthy → restart.
    _patch_health(monkeypatch, ConnectionRefusedError("dead"))
    await _run_one_supervise_pass(monkeypatch)
    assert started == ["probe"]

    # Healthy → left alone.
    started.clear()
    _patch_health(monkeypatch, _Resp(200, {"total": 22837, "age_s": 30}))
    await _run_one_supervise_pass(monkeypatch)
    assert started == []

    # Up but wedged on a stale union → also restarted (start() evicts the holder).
    _patch_health(monkeypatch, _Resp(200, {"total": 22837, "age_s": 1631}))
    await _run_one_supervise_pass(monkeypatch)
    assert started == ["probe"]


async def _run_one_supervise_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drive EXACTLY one supervise() iteration (it loops forever by design).

    supervise() sleeps at the top of each pass, so letting the first sleep through
    and cancelling at the second bounds it to one pass deterministically — no
    reliance on how many times the loop gets scheduled before a cancel lands.
    """
    calls = {"n": 0}

    async def _sleep(_s: float) -> None:
        calls["n"] += 1
        if calls["n"] > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(ais_sidecar.asyncio, "sleep", _sleep)
    with contextlib.suppress(asyncio.CancelledError):
        await ais_sidecar.supervise(interval_s=0)
    assert calls["n"] == 2, "supervise() must sleep between passes"


def test_stop_escalates_for_a_reused_pid_not_only_a_spawned_child() -> None:
    # The wedged feeder ignored SIGTERM (still LISTENing 12s later, gone 2s after
    # SIGKILL). stop() must escalate for reuse_pid too, or the port stays blocked
    # and the next boot re-adopts the same frozen process.
    src = (ais_sidecar.Path(ais_sidecar.__file__)).read_text()
    stop_body = src.split("async def stop(", 1)[1]
    assert "_kill_pid" in stop_body, "stop() must route every pid through the escalating kill"
    assert "SIGKILL" in src
