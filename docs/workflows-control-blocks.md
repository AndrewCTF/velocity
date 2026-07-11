# Workflows — control blocks (external actuation)

The Workflows app can reach OUT of the platform to an operator-run endpoint:
call an HTTP API, fire a webhook, or command a drone / robot / device. Four
blocks do this:

| Block | Category | What it does |
|-------|----------|--------------|
| `op.http` | op (0–1 in) | HTTP request to any server; response becomes rows, or one request per input row. The universal in/out primitive. |
| `control.webhook` | control | POST rows to a URL — batch (all rows) or per-row. |
| `control.drone` | control | Command a drone/UAV via your ground-control server (auto-nav `goto`, plus takeoff/land/rtl/orbit/follow/arm/disarm/pause). |
| `control.device` | control | Command any controllable item (relay, gimbal, PTZ camera, rover, siren…). |

The platform stays protocol-agnostic: a control block speaks the JSON envelope
below to a **control server** that translates it to whatever your hardware
speaks. For drones the repo ships a first-class one — the **MAVLink bridge**
(see below) — so you don't have to write it; for anything else you run a small
server that accepts the envelope.

## MAVLink bridge (first-class drone control server)

`apps/api/app/mavlink_bridge.py` is a ready-made control server that translates
`drone.command` envelopes into standard MAVLink and forwards them to a vehicle
or a SITL (ArduPilot / PX4). Two ways to run it:

- **As a managed sidecar.** Set `mavlink_bridge_enabled=true` (env
  `MAVLINK_BRIDGE_ENABLED=true`) and, for a real uplink,
  `MAVLINK_BRIDGE_CONNECT=udpout:127.0.0.1:14550` (or `/dev/ttyACM0,57600`). The
  API boots it on `mavlink_bridge_port` (default 9010) and tears it down on
  shutdown, same as the AIS/ADS-B feeders. OFF by default — a bridge that
  auto-connects to a drone at boot is not implicit.
- **Standalone.** `PORT=9010 MAVLINK_CONNECT=udpout:127.0.0.1:14550
  python -m app.mavlink_bridge` (from `apps/api`).

Then point `control.drone.server_url` at `http://127.0.0.1:9010`.

`pymavlink` is an optional extra (`pip install -e '.[mavlink]'` in `apps/api`).
**Without pymavlink or a connect string the bridge runs "log-only"** — it plans
the exact MAVLink each command maps to and returns it, but sends nothing, so you
can build and rehearse a drone workflow end to end with no vehicle. Command →
MAVLink mapping: `goto`→`SET_POSITION_TARGET_GLOBAL_INT` (GUIDED),
`takeoff`→`MAV_CMD_NAV_TAKEOFF`, `land`→`MAV_CMD_NAV_LAND`,
`rtl`→`MAV_CMD_NAV_RETURN_TO_LAUNCH`, `arm`/`disarm`→`MAV_CMD_COMPONENT_ARM_DISARM`,
`orbit`→`MAV_CMD_DO_ORBIT`, `pause`→`MAV_CMD_DO_PAUSE_CONTINUE`. `GET /health`
and `GET /status` (token-gated) report mode + recent commands. The bridge issues
only commands your autopilot already gates (arming checks, geofence stay in
force); `goto` assumes GUIDED, like any GCS.

For non-drone hardware, or to translate the envelope yourself, run your own
server per the contract below.

## Safety model (read before pointing a block at real hardware)

All safety plumbing is in `apps/api/app/workflows/control.py`:

- **Preview never actuates.** In the editor's live preview, `control.*` blocks
  and any unsafe `op.http` method (POST/PUT/PATCH/DELETE) run *dry* — the
  envelope is built and returned so you can see exactly what would be sent, but
  no request leaves the box. GET/HEAD preview live (read-only). Only a real
  **run** actuates.
- **Per-run dispatch budget.** At most `MAX_DISPATCHES_PER_RUN = 200` outbound
  calls per run, shared across every control block, so a `per_row` loop over a
  large table can't fire thousands of commands. Each block also has its own
  `max_dispatch` cap.
- **Kill-switch.** `WORKFLOWS_CONTROL_ENABLED=0` forces every control block into
  dry-run everywhere (not just preview). Default is enabled.
- **Host allowlist (optional).** `WORKFLOWS_HTTP_ALLOW_HOSTS=host1,host2` limits
  outbound to those hosts; anything else is refused (403). Unset = any host
  (BYO-compute posture). Localhost is never implicitly blocked — your control
  server is often on the same machine.
- **Auth without secrets in the spec.** Every control block takes an `auth_env`
  = the *name* of an environment variable holding a bearer token. The token is
  read at run time and sent as `Authorization: Bearer <token>`; only the env var
  name is stored in the saved workflow.
- Same posture as `op.python`: this is a single-operator local tool, not a
  hostile-tenant sandbox.

## Wire contract

Every `control.*` envelope is a single JSON object, POSTed with
`content-type: application/json` to `{server_url}{path}` (`path` defaults to
`/command`). Common fields: `type`, `ts` (unix seconds), `source`
(`workflow:{id}`).

### `control.drone` → `drone.command`

```json
{
  "type": "drone.command",
  "command": "goto",
  "vehicle": "drone-1",
  "ts": 1752192000.12,
  "source": "workflow:wf_ab12",
  "waypoint": { "lat": 25.28, "lon": 55.32, "alt_m": 120.0 },
  "params": { "speed_ms": 12.0, "radius_m": 80.0 }
}
```

`command` ∈ `goto | takeoff | land | rtl | orbit | arm | disarm | follow | pause`.
`waypoint` is present only when the row had lat/lon (goto/orbit/follow);
`takeoff` carries `alt_m` at the top level; `rtl/land/arm/disarm/pause` need only
`vehicle`. `params` is present only if you set speed/radius.

**Auto-navigation** = wire a data source into it: e.g.
`source.aircraft → op.geo (within_radius of a point) → control.drone (goto)`
sends the vehicle to the detected target's coordinates. `mode=first` sends one
command to the top row; `mode=per_row` fans out one command per row (swarm /
multi-waypoint patrol), capped by `max_dispatch`.

### `control.device` → `device.command`

```json
{
  "type": "device.command",
  "device": "relay-3",
  "command": "set_relay",
  "payload": { "state": "on", "channel": 2 },
  "ts": 1752192000.12,
  "source": "workflow:wf_ab12"
}
```

`payload` is the named `payload_columns` of the row, or every non-`_`-prefixed
column if you leave that blank.

### `control.webhook`

Batch: `{"type":"workflow.webhook","source":"…","count":N,"rows":[…]}` (rows
capped at 100). Per-row: `{"type":"workflow.row","source":"…","row":{…}}`.

## Response

Return any JSON. `2xx` = accepted. The block annotates each dispatched row with
the outcome under `_drone` / `_device` / `_webhook` (`dispatched`, `status`,
`ok`, `response`, or `error`) so a downstream block can branch on it. A non-2xx
or a transport error fails only that row, never the run.

## Reference control server (~40 lines)

For drones, use the built-in MAVLink bridge above. For a **device** controller
(relay/gimbal/rover) or any custom endpoint, here is a minimal server that
accepts every envelope and logs it — swap the `TODO`s for your GPIO/ROS/HTTP
bridge. Run it, point a block at `http://127.0.0.1:9010`, and do a real run.

```python
# control_server.py — python control_server.py  (stdlib only, no deps)
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        kind = body.get("type")
        if kind == "drone.command":
            cmd, veh, wp = body.get("command"), body.get("vehicle"), body.get("waypoint")
            print(f"[drone] {veh} {cmd} {wp or ''}")
            # TODO: pymavlink → e.g. goto: mav.mav.set_position_target_global_int_send(...)
        elif kind == "device.command":
            print(f"[device] {body.get('device')} {body.get('command')} {body.get('payload')}")
            # TODO: drive your GPIO / relay / PTZ here
        else:
            print(f"[webhook] {body.get('count', 1)} row(s)")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true, "accepted": true}')

    def log_message(self, *a):  # quiet
        pass

if __name__ == "__main__":
    print("control server on http://127.0.0.1:9010")
    HTTPServer(("127.0.0.1", 9010), Handler).serve_forever()
```

If you protect it with a token, set `WORKFLOWS_*` nothing — instead export the
token under a name (e.g. `export DRONE_SERVER_TOKEN=…`) and put that env var
name in the block's **Bearer-token env var** field; the server then checks the
`Authorization: Bearer …` header.
