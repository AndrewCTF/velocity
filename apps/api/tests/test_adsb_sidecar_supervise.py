"""The tar1090 sidecar must be restarted when it stops SERVING — and never
restarted merely for having no aircraft yet.

`start()` only ever ran once, at lifespan boot, so a sidecar that died afterwards
stayed dead until the next backend restart: the feed tier went silently empty and
the snapshot quietly fell back to the OpenSky floor. The AIS twin proved this is
not theoretical (2026-07-15 post-mortem, docs/decisions.md) — a restart's start()
adopted the OUTGOING backend's sidecar, still listening, moments before that
backend's stop() killed it.

Supervising THIS feed was deferred that day because the obvious implementation is
a trap: `_already_healthy()` requires `total > 0`, and index.js binds its HTTP
port BEFORE browser init, so a sidecar still clearing Cloudflare answers with
zero aircraft for ~5-60s. A supervisor triggering on that would respawn-storm the
platform's most critical feed (the >=8000 floor, ADSB_SIDECAR_ONLY=1). Hence two
distinct predicates: _serving() = liveness, _already_healthy() = liveness + data.
These tests pin that distinction.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import pytest

from app import adsb_sidecar


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

    monkeypatch.setattr(adsb_sidecar.httpx, "AsyncClient", _Client)


async def _run_one_supervise_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drive EXACTLY one supervise() iteration (it loops forever by design).

    supervise() sleeps at the top of each pass, so letting the first sleep
    through and cancelling at the second bounds it to one pass deterministically.
    """
    calls = {"n": 0}

    async def _sleep(_s: float) -> None:
        calls["n"] += 1
        if calls["n"] > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(adsb_sidecar.asyncio, "sleep", _sleep)
    with contextlib.suppress(asyncio.CancelledError):
        await adsb_sidecar.supervise(interval_s=0)
    assert calls["n"] == 2, "supervise() must sleep between passes"


def _capture_start(monkeypatch: pytest.MonkeyPatch) -> list[bool]:
    started: list[bool] = []

    async def _fake_start() -> None:
        started.append(True)

    monkeypatch.setattr(adsb_sidecar, "start", _fake_start)
    return started


async def test_dead_port_is_restarted(monkeypatch: pytest.MonkeyPatch) -> None:
    started = _capture_start(monkeypatch)
    _patch_health(monkeypatch, ConnectionRefusedError("nothing on :8090"))
    await _run_one_supervise_pass(monkeypatch)
    assert started == [True]


async def test_warming_sidecar_with_zero_aircraft_is_left_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE hazard this supervisor was deferred over.

    index.js serves before the browser clears Cloudflare, so total=0 is the
    NORMAL state for the first ~5-60s. Restarting on it would kill the browser
    mid-clear, and the replacement would land in the same state — a storm on the
    >=8000-aircraft feed, forever.
    """
    started = _capture_start(monkeypatch)
    _patch_health(monkeypatch, _Resp(200, {"total": 0, "sources": {}}))
    await _run_one_supervise_pass(monkeypatch)
    assert started == [], "a serving sidecar must never be restarted for having no aircraft yet"


async def test_dry_but_serving_sidecar_is_left_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    # A sidecar whose pages went dry re-inits them every READ_MS and relaunches a
    # crashed browser itself. Respawning throws that self-heal away and buys
    # another Cloudflare clear. Answering == working or already healing.
    started = _capture_start(monkeypatch)
    _patch_health(
        monkeypatch,
        _Resp(200, {"total": 0, "sources": {"https://globe.airplanes.live/": {"aircraft": 0, "age_s": 900}}}),
    )
    await _run_one_supervise_pass(monkeypatch)
    assert started == []


async def test_healthy_sidecar_is_left_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    started = _capture_start(monkeypatch)
    _patch_health(monkeypatch, _Resp(200, {"total": 13000, "sources": {}}))
    await _run_one_supervise_pass(monkeypatch)
    assert started == []


async def test_serving_and_healthy_are_different_questions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The distinction the whole design rests on: a warming sidecar is SERVING but
    # not yet HEALTHY. If these ever collapse into one predicate, the supervisor
    # storms and start() evicts a live sidecar mid-warm.
    _patch_health(monkeypatch, _Resp(200, {"total": 0}))
    assert await adsb_sidecar._serving() is True
    assert await adsb_sidecar._already_healthy() is False

    _patch_health(monkeypatch, _Resp(200, {"total": 13000}))
    assert await adsb_sidecar._serving() is True
    assert await adsb_sidecar._already_healthy() is True

    _patch_health(monkeypatch, ConnectionRefusedError("dead"))
    assert await adsb_sidecar._serving() is False
    assert await adsb_sidecar._already_healthy() is False


async def test_supervise_survives_a_failing_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    # Supervision must never die — a raising probe would otherwise silently end
    # supervision for the life of the process, which is the bug it exists to fix.
    _capture_start(monkeypatch)

    async def _boom() -> bool:
        raise RuntimeError("ss blew up")

    monkeypatch.setattr(adsb_sidecar, "_serving", _boom)
    await _run_one_supervise_pass(monkeypatch)  # must not raise


@pytest.fixture(autouse=True)
def _reset_module_state() -> Any:
    adsb_sidecar._proc = None
    adsb_sidecar._reuse_pid = None
    yield
    adsb_sidecar._proc = None
    adsb_sidecar._reuse_pid = None


def _patch_start_internals(monkeypatch: pytest.MonkeyPatch, holder: int | None) -> dict:
    """Stub everything start() reaches for except the adopt/evict decision."""
    seen: dict = {"killed": [], "spawned": False}

    async def _kill(pid: int) -> None:
        seen["killed"].append(pid)

    async def _wait(_proc: Any) -> None:
        return None

    async def _spawn(*a: Any, **k: Any) -> Any:
        seen["spawned"] = True
        raise FileNotFoundError("node")  # stop start() right after the decision

    monkeypatch.setattr(adsb_sidecar, "_port_holder_pid", lambda: holder)
    monkeypatch.setattr(adsb_sidecar, "_kill_pid", _kill)
    monkeypatch.setattr(adsb_sidecar, "_wait_for_aircraft", _wait)
    monkeypatch.setattr(adsb_sidecar.asyncio, "create_subprocess_exec", _spawn)
    return seen


async def test_start_adopts_a_warming_holder_instead_of_evicting_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Port held + serving + no aircraft = a sidecar still clearing Cloudflare.

    Evicting it throws away a good sidecar mid-warm; spawning a duplicate would
    just EADDRINUSE and die, leaving neither. Adopt and wait.
    """
    seen = _patch_start_internals(monkeypatch, holder=4242)
    _patch_health(monkeypatch, _Resp(200, {"total": 0}))
    await adsb_sidecar.start()
    assert seen["killed"] == [], "must not kill a sidecar that is serving"
    assert seen["spawned"] is False, "must not spawn a duplicate onto a held port"
    assert adsb_sidecar._reuse_pid == 4242, "must adopt it so stop() can tear it down"


async def test_start_evicts_a_holder_that_holds_the_port_without_serving(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Wedged or foreign: it would EADDRINUSE the replacement, so it has to go.
    seen = _patch_start_internals(monkeypatch, holder=4242)
    _patch_health(monkeypatch, ConnectionRefusedError("holding the port, not answering"))
    await adsb_sidecar.start()
    assert seen["killed"] == [4242]
    assert seen["spawned"] is True


async def test_start_reuses_a_healthy_sidecar_without_touching_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _patch_start_internals(monkeypatch, holder=4242)
    _patch_health(monkeypatch, _Resp(200, {"total": 13000}))
    await adsb_sidecar.start()
    assert seen["killed"] == [] and seen["spawned"] is False
    assert adsb_sidecar._reuse_pid == 4242


async def test_start_spawns_when_the_port_is_free(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _patch_start_internals(monkeypatch, holder=None)
    _patch_health(monkeypatch, ConnectionRefusedError("free"))
    await adsb_sidecar.start()
    assert seen["killed"] == [] and seen["spawned"] is True


def test_stop_escalates_for_a_reused_pid_not_only_a_spawned_child() -> None:
    src = adsb_sidecar.Path(adsb_sidecar.__file__).read_text()
    stop_body = src.split("async def stop(", 1)[1]
    assert "_kill_pid" in stop_body, "stop() must route every pid through the escalating kill"
    assert "SIGKILL" in src
