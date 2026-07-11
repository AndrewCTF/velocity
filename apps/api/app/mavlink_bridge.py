"""MAVLink bridge — the first-class drone control server.

The Workflows ``control.drone`` block POSTs a ``drone.command`` JSON envelope
(contract: ``docs/workflows-control-blocks.md``) to a control server. THIS is
that server: it translates the envelope into standard MAVLink and forwards it to
a vehicle (real, or a SITL like ArduPilot / PX4). Run it as a sidecar
(``python -m app.mavlink_bridge``, managed by ``app.mavlink_sidecar``) or
standalone pointing at your own autopilot.

Two layers, split so the translation is testable without a vehicle or the
optional ``pymavlink`` dependency:

  * ``plan_mavlink(envelope)`` — PURE. Envelope → a list of ``MavIntent`` (an
    abstract "send this MAVLink message" description). No I/O, no pymavlink.
  * ``MavlinkLink`` — lazily imports pymavlink, connects on first use, and
    turns intents into real ``mav.*_send`` calls. With no pymavlink OR no
    connection string it degrades to **log-only**: it echoes the planned
    intents so a workflow can be rehearsed end to end without an uplink.

Safety: the bridge only issues the standard commands your autopilot already
gates (it does not bypass arming checks / geofence). ``goto`` assumes the
vehicle is in GUIDED/OFFBOARD — same as any MAVLink GCS. An optional bearer
token (``MAVLINK_BRIDGE_TOKEN``) matches the block's ``auth_env`` field.
"""

from __future__ import annotations

import json
import logging
import os
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

log = logging.getLogger("mavlink_bridge")

# ── intents (abstract MAVLink messages) ──────────────────────────────────────


@dataclass
class MavIntent:
    """One MAVLink message to emit, described abstractly.

    ``kind`` selects the pymavlink call in ``MavlinkLink._emit``:
      * ``command_long`` — ``command_long_send`` (``command`` + 7 ``params``);
      * ``command_int``  — ``command_int_send`` (lat/lon carried as scaled ints);
      * ``position_target_global`` — ``set_position_target_global_int_send``
        (the standard GUIDED "fly here").
    ``command`` is the MAV_CMD *name* (resolved to the numeric enum at send
    time) so the pure layer never imports pymavlink."""

    kind: str
    command: str = ""
    params: list[float] = field(default_factory=list)
    lat: float | None = None
    lon: float | None = None
    alt_m: float | None = None
    note: str = ""

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"kind": self.kind}
        if self.command:
            d["command"] = self.command
        if self.params:
            d["params"] = self.params
        for k in ("lat", "lon", "alt_m"):
            if getattr(self, k) is not None:
                d[k] = getattr(self, k)
        if self.note:
            d["note"] = self.note
        return d


def _f(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def plan_mavlink(envelope: dict[str, Any]) -> list[MavIntent]:
    """Translate a ``drone.command`` envelope into MAVLink intents. Pure and
    total — an unknown command yields a single ``unsupported`` intent rather
    than raising, so the bridge always answers."""
    command = str(envelope.get("command") or "").lower()
    wp = envelope.get("waypoint") or {}
    lat = _f(wp.get("lat")) if "lat" in wp else None
    lon = _f(wp.get("lon")) if "lon" in wp else None
    alt = (
        _f(wp.get("alt_m"))
        if "alt_m" in wp
        else _f(envelope.get("alt_m"))
        if "alt_m" in envelope
        else None
    )
    params = envelope.get("params") or {}
    speed = _f(params.get("speed_ms")) if "speed_ms" in params else None
    radius = _f(params.get("radius_m")) if "radius_m" in params else None

    if command == "arm":
        return [MavIntent("command_long", "MAV_CMD_COMPONENT_ARM_DISARM", [1, 0, 0, 0, 0, 0, 0])]
    if command == "disarm":
        return [MavIntent("command_long", "MAV_CMD_COMPONENT_ARM_DISARM", [0, 0, 0, 0, 0, 0, 0])]
    if command == "takeoff":
        return [
            MavIntent(
                "command_long", "MAV_CMD_NAV_TAKEOFF", [0, 0, 0, 0, 0, 0, alt or 0.0], alt_m=alt
            )
        ]
    if command == "land":
        return [MavIntent("command_long", "MAV_CMD_NAV_LAND", [0, 0, 0, 0, 0, 0, 0])]
    if command == "rtl":
        return [MavIntent("command_long", "MAV_CMD_NAV_RETURN_TO_LAUNCH", [0, 0, 0, 0, 0, 0, 0])]
    if command == "pause":
        return [MavIntent("command_long", "MAV_CMD_DO_PAUSE_CONTINUE", [0, 0, 0, 0, 0, 0, 0])]
    if command == "goto":
        if lat is None or lon is None:
            return [MavIntent("unsupported", note="goto requires a waypoint lat/lon")]
        return [
            MavIntent(
                "position_target_global", lat=lat, lon=lon, alt_m=alt if alt is not None else 30.0
            )
        ]
    if command == "orbit":
        if lat is None or lon is None:
            return [MavIntent("unsupported", note="orbit requires a waypoint lat/lon")]
        return [
            MavIntent(
                "command_int",
                "MAV_CMD_DO_ORBIT",
                [radius or 50.0, speed or 0.0, 0, 0, 0, 0, alt if alt is not None else 30.0],
                lat=lat,
                lon=lon,
                alt_m=alt if alt is not None else 30.0,
            )
        ]
    if command == "follow":
        return [MavIntent("unsupported", note="follow is autopilot-specific; not mapped")]
    return [MavIntent("unsupported", note=f"unknown command {command!r}")]


# ── the link (lazy pymavlink; log-only fallback) ─────────────────────────────


class MavlinkLink:
    """Sends intents over a MAVLink connection, or logs them when no vehicle /
    pymavlink is available. One connection, reused; target system defaults to 1
    (overridable per envelope with a numeric ``vehicle``)."""

    def __init__(self, connect: str = "") -> None:
        self.connect = (connect or "").strip()
        self._master: Any = None
        self._mavutil: Any = None
        self._error: str | None = None

    @property
    def mode(self) -> str:
        return "mavlink" if self.connect else "log-only"

    @property
    def connected(self) -> bool:
        return self._master is not None

    def _ensure(self) -> bool:
        """Lazily import pymavlink + open the link. Returns False (staying
        log-only) if either is unavailable — never raises into a request."""
        if not self.connect:
            return False
        if self._master is not None:
            return True
        try:
            from pymavlink import (
                mavutil,  # noqa: PLC0415 — optional dep, imported on first real send
            )
        except Exception as exc:  # noqa: BLE001 — pymavlink not installed → log-only
            self._error = f"pymavlink unavailable: {exc}"
            log.warning("MAVLink bridge %s — running log-only", self._error)
            return False
        try:
            self._mavutil = mavutil
            self._master = mavutil.mavlink_connection(self.connect)
            self._master.wait_heartbeat(timeout=10)
            log.info("MAVLink bridge connected on %s", self.connect)
            return True
        except Exception as exc:  # noqa: BLE001 — bad endpoint / no heartbeat → log-only
            self._error = f"connect failed: {exc}"
            self._master = None
            log.warning("MAVLink bridge %s — running log-only", self._error)
            return False

    def _emit(self, intent: MavIntent, target_system: int) -> dict[str, Any]:
        m = self._master
        mav = self._mavutil.mavlink
        cmd = getattr(mav, intent.command, None) if intent.command else None
        if intent.kind == "position_target_global":
            # type_mask 0b0000_1111_1111_1000 = position only (ignore vel/acc/yaw)
            m.mav.set_position_target_global_int_send(
                0,
                target_system,
                0,
                mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                0b0000111111111000,
                int((intent.lat or 0) * 1e7),
                int((intent.lon or 0) * 1e7),
                intent.alt_m or 0.0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
            )
        elif intent.kind == "command_int":
            m.mav.command_int_send(
                target_system,
                0,
                mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                cmd,
                0,
                0,
                intent.params[0] if intent.params else 0,
                intent.params[1] if len(intent.params) > 1 else 0,
                intent.params[2] if len(intent.params) > 2 else 0,
                intent.params[3] if len(intent.params) > 3 else 0,
                int((intent.lat or 0) * 1e7),
                int((intent.lon or 0) * 1e7),
                intent.alt_m or 0.0,
            )
        else:  # command_long
            p = (intent.params + [0.0] * 7)[:7]
            m.mav.command_long_send(target_system, 0, cmd, 0, *p)
        return {"sent": True, **intent.to_json()}

    def send(self, envelope: dict[str, Any]) -> dict[str, Any]:
        """Plan + emit. Always returns a result dict (never raises); on any
        transport error the intent is reported ``sent: False`` with the error."""
        intents = plan_mavlink(envelope)
        target = 1
        veh = envelope.get("vehicle")
        if isinstance(veh, str) and veh.isdigit():
            target = int(veh)
        live = self._ensure()
        planned = [i.to_json() for i in intents]
        if not live:
            return {
                "mode": "log-only",
                "sent": False,
                "planned": planned,
                **({"error": self._error} if self._error else {}),
            }
        results = []
        for intent in intents:
            if intent.kind == "unsupported":
                results.append({"sent": False, **intent.to_json()})
                continue
            try:
                results.append(self._emit(intent, target))
            except Exception as exc:  # noqa: BLE001 — one bad send doesn't crash the bridge
                results.append({"sent": False, "error": str(exc), **intent.to_json()})
        return {"mode": "mavlink", "target_system": target, "results": results}


# ── HTTP server ──────────────────────────────────────────────────────────────


class _State:
    def __init__(self, link: MavlinkLink, token: str) -> None:
        self.link = link
        self.token = token
        self.log: deque[dict[str, Any]] = deque(maxlen=200)
        self.count = 0


def _handle_command(state: _State, body: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one envelope. drone.command → MAVLink; device.command / webhook
    are accepted and logged (this bridge actuates drones; a device/relay needs a
    device controller, but we 200 so a mixed workflow doesn't error)."""
    kind = str(body.get("type") or "")
    state.count += 1
    if kind == "drone.command":
        result = state.link.send(body)
        entry = {"command": body.get("command"), "vehicle": body.get("vehicle"), "result": result}
        state.log.appendleft(entry)
        return {"ok": True, "accepted": True, **result}
    if kind == "device.command":
        state.log.appendleft({"device": body.get("device"), "command": body.get("command")})
        log.info("device.command logged (no device controller): %s", body.get("command"))
        return {
            "ok": True,
            "accepted": True,
            "mode": "log-only",
            "note": "device commands are logged only",
        }
    state.log.appendleft({"webhook": kind or "unknown", "count": body.get("count")})
    return {"ok": True, "accepted": True, "mode": "log-only"}


def make_handler(state: _State) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, code: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authed(self) -> bool:
            if not state.token:
                return True
            return self.headers.get("Authorization", "") == f"Bearer {state.token}"

        def do_GET(self) -> None:  # noqa: N802 — stdlib handler name
            if self.path.startswith("/health"):
                self._send(
                    200,
                    {
                        "ok": True,
                        "mode": state.link.mode,
                        "connected": state.link.connected,
                        "commands": state.count,
                    },
                )
            elif self.path.startswith("/status"):
                if not self._authed():
                    self._send(401, {"ok": False, "error": "unauthorized"})
                    return
                self._send(
                    200,
                    {
                        "ok": True,
                        "mode": state.link.mode,
                        "commands": state.count,
                        "recent": list(state.log)[:50],
                    },
                )
            else:
                self._send(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 — stdlib handler name
            if not self._authed():
                self._send(401, {"ok": False, "error": "unauthorized"})
                return
            try:
                n = int(self.headers.get("content-length", 0) or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, json.JSONDecodeError) as exc:
                self._send(400, {"ok": False, "error": f"bad json: {exc}"})
                return
            if not isinstance(body, dict):
                self._send(400, {"ok": False, "error": "body must be a JSON object"})
                return
            try:
                self._send(200, _handle_command(state, body))
            except Exception as exc:  # noqa: BLE001 — a bad envelope never 500s the bridge
                log.exception("bridge command failed")
                self._send(200, {"ok": False, "error": str(exc)})

        def log_message(self, *_a: Any) -> None:  # silence default stderr spam
            pass

    return Handler


def build_server(port: int, connect: str = "", token: str = "") -> ThreadingHTTPServer:
    state = _State(MavlinkLink(connect), token)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    server.bridge_state = state  # type: ignore[attr-defined] — exposed for tests
    return server


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    port = int(os.environ.get("PORT", "9010"))
    connect = os.environ.get("MAVLINK_CONNECT", "")
    token = os.environ.get("MAVLINK_BRIDGE_TOKEN", "")
    server = build_server(port, connect, token)
    log.info(
        "MAVLink bridge on http://127.0.0.1:%d (mode=%s, connect=%r)",
        port,
        server.bridge_state.link.mode,
        connect,
    )  # type: ignore[attr-defined]
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
