"""MAVLink bridge — envelope→MAVLink translation, log-only fallback, HTTP server.

Hermetic: no pymavlink, no vehicle. The translation layer (``plan_mavlink``) is
pure; the link runs log-only (no MAVLINK_CONNECT); the HTTP server is exercised
over 127.0.0.1 loopback against our own thread (not the network).
"""

from __future__ import annotations

import threading

import httpx
import pytest

from app import mavlink_bridge as mb


def _drone(command: str, **kw) -> dict:
    env = {"type": "drone.command", "command": command, "vehicle": "drone-1", **kw}
    return env


# ── plan_mavlink (pure) ──────────────────────────────────────────────────────


def test_plan_goto_is_position_target() -> None:
    intents = mb.plan_mavlink(_drone("goto", waypoint={"lat": 25.1, "lon": 55.2, "alt_m": 120.0}))
    assert len(intents) == 1
    i = intents[0]
    assert i.kind == "position_target_global"
    assert (i.lat, i.lon, i.alt_m) == (25.1, 55.2, 120.0)


def test_plan_goto_without_waypoint_is_unsupported() -> None:
    intents = mb.plan_mavlink(_drone("goto"))
    assert intents[0].kind == "unsupported"


def test_plan_arm_disarm_param1() -> None:
    assert mb.plan_mavlink(_drone("arm"))[0].params[0] == 1
    assert mb.plan_mavlink(_drone("disarm"))[0].params[0] == 0
    assert mb.plan_mavlink(_drone("arm"))[0].command == "MAV_CMD_COMPONENT_ARM_DISARM"


def test_plan_takeoff_alt_in_param7() -> None:
    i = mb.plan_mavlink(_drone("takeoff", waypoint={"alt_m": 50.0}))[0]
    assert i.command == "MAV_CMD_NAV_TAKEOFF"
    assert i.params[6] == 50.0


def test_plan_rtl_and_land_commands() -> None:
    assert mb.plan_mavlink(_drone("rtl"))[0].command == "MAV_CMD_NAV_RETURN_TO_LAUNCH"
    assert mb.plan_mavlink(_drone("land"))[0].command == "MAV_CMD_NAV_LAND"


def test_plan_orbit_is_command_int() -> None:
    i = mb.plan_mavlink(_drone("orbit", waypoint={"lat": 1.0, "lon": 2.0}, params={"radius_m": 80.0}))[0]
    assert i.kind == "command_int"
    assert i.command == "MAV_CMD_DO_ORBIT"
    assert i.params[0] == 80.0


def test_plan_unknown_command_is_unsupported_not_raise() -> None:
    i = mb.plan_mavlink(_drone("self_destruct"))[0]
    assert i.kind == "unsupported"
    assert "self_destruct" in i.note


# ── MavlinkLink (log-only) ───────────────────────────────────────────────────


def test_link_log_only_when_no_connect() -> None:
    link = mb.MavlinkLink(connect="")
    assert link.mode == "log-only"
    res = link.send(_drone("goto", waypoint={"lat": 1.0, "lon": 2.0}))
    assert res["mode"] == "log-only"
    assert res["sent"] is False
    assert res["planned"][0]["kind"] == "position_target_global"


def test_link_log_only_when_pymavlink_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    # A connect string is set but pymavlink import fails → still log-only, no raise.
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name.startswith("pymavlink"):
            raise ModuleNotFoundError("no pymavlink")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    link = mb.MavlinkLink(connect="udpout:127.0.0.1:14550")
    res = link.send(_drone("rtl"))
    assert res["mode"] == "log-only"
    assert "pymavlink" in (res.get("error") or "")


# ── _handle_command ──────────────────────────────────────────────────────────


def test_handle_drone_command_returns_planned() -> None:
    state = mb._State(mb.MavlinkLink(""), token="")
    out = mb._handle_command(state, _drone("goto", waypoint={"lat": 1.0, "lon": 2.0}))
    assert out["ok"] is True
    assert out["planned"][0]["kind"] == "position_target_global"
    assert state.count == 1


def test_handle_device_command_logged() -> None:
    state = mb._State(mb.MavlinkLink(""), token="")
    out = mb._handle_command(state, {"type": "device.command", "device": "relay-1", "command": "on"})
    assert out["ok"] is True
    assert out["mode"] == "log-only"


# ── HTTP server (loopback) ───────────────────────────────────────────────────


class _RunningBridge:
    def __init__(self, token: str = "") -> None:
        self.server = mb.build_server(0, connect="", token=token)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> _RunningBridge:
        self.thread.start()
        return self

    def __exit__(self, *_a) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def test_http_health_and_command() -> None:
    with _RunningBridge() as b:
        h = httpx.get(f"{b.base}/health", timeout=3.0).json()
        assert h["ok"] is True
        assert h["mode"] == "log-only"
        r = httpx.post(
            f"{b.base}/command",
            json=_drone("goto", waypoint={"lat": 1.0, "lon": 2.0}),
            timeout=3.0,
        ).json()
        assert r["accepted"] is True
        assert r["planned"][0]["kind"] == "position_target_global"


def test_http_token_enforced() -> None:
    with _RunningBridge(token="sekret") as b:
        # no auth → 401
        assert httpx.post(f"{b.base}/command", json=_drone("rtl"), timeout=3.0).status_code == 401
        # correct bearer → 200
        ok = httpx.post(
            f"{b.base}/command", json=_drone("rtl"),
            headers={"Authorization": "Bearer sekret"}, timeout=3.0,
        )
        assert ok.status_code == 200
        assert ok.json()["accepted"] is True
        # health needs no auth
        assert httpx.get(f"{b.base}/health", timeout=3.0).status_code == 200


def test_http_bad_json_is_400_not_500() -> None:
    with _RunningBridge() as b:
        r = httpx.post(f"{b.base}/command", content=b"not json", timeout=3.0)
        assert r.status_code == 400
