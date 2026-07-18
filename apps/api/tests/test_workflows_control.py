"""Workflows control blocks — op.http + control.{webhook,drone,device}.

Hermetic: the single network seam ``control.send`` is monkeypatched (conftest's
no-network rule). We assert on the ENVELOPE each block builds, the safety guards
(preview dry-run, run-wide dispatch budget, kill-switch, host allowlist), and
the response→rows parsing — never a real socket.
"""

from __future__ import annotations

import pytest

from app.keys import UserCtx
from app.workflows import blocks as blocks_mod
from app.workflows import control
from app.workflows.blocks import BlockCtx
from app.workflows.store import WorkflowError

_CTX = UserCtx(user_id="local", token="")


def _ctx(preview: bool = False, budget: int = 200) -> BlockCtx:
    c = BlockCtx(user_ctx=_CTX, workflow_id="wf", memory={}, preview=preview)
    c.dispatch_budget = [budget]
    return c


class _Recorder:
    """Fake ``control.send`` — records every call, returns a canned result."""

    def __init__(self, result: control.HttpResult | None = None) -> None:
        self.calls: list[dict] = []
        self.result = result or control.HttpResult(
            status=200, ok=True, json={"ok": True, "accepted": True}, text="", error=None
        )

    async def __call__(self, method, url, *, headers, json_body=None, timeout_s=15.0):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "body": json_body,
                "timeout": timeout_s,
            }
        )
        return self.result


# ── control.drone ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_drone_goto_builds_waypoint_envelope_and_dispatches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    rows = [{"icao24": "abc", "lat": 25.1, "lon": 55.2, "alt_m": 120.0}]
    out = await blocks_mod._run_control_drone(
        {
            "server_url": "http://127.0.0.1:9010",
            "command": "goto",
            "mode": "first",
            "vehicle_col": "icao24",
            "speed_ms": 12.0,
        },
        [rows],
        _ctx(),
    )
    assert len(rec.calls) == 1
    call = rec.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "http://127.0.0.1:9010/command"
    env = call["body"]
    assert env["type"] == "drone.command"
    assert env["command"] == "goto"
    assert env["vehicle"] == "abc"
    assert env["waypoint"] == {"lat": 25.1, "lon": 55.2, "alt_m": 120.0}
    assert env["params"] == {"speed_ms": 12.0}
    assert env["source"] == "workflow:wf"
    assert out[0]["_drone"]["dispatched"] is True
    assert out[0]["_drone"]["ok"] is True


@pytest.mark.asyncio
async def test_drone_preview_never_fires(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    rows = [{"lat": 1.0, "lon": 2.0}]
    out = await blocks_mod._run_control_drone(
        {"server_url": "http://h/x", "command": "goto"}, [rows], _ctx(preview=True)
    )
    assert rec.calls == []  # no network on preview
    assert out[0]["_drone"]["dry_run"] is True
    assert out[0]["_drone"]["dispatched"] is False
    assert out[0]["_drone"]["request"]["command"] == "goto"  # envelope still shown


@pytest.mark.asyncio
async def test_drone_per_row_respects_run_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    rows = [{"lat": i, "lon": i} for i in range(3)]
    out = await blocks_mod._run_control_drone(
        {"server_url": "http://h/x", "command": "goto", "mode": "per_row", "max_dispatch": 10},
        [rows],
        _ctx(budget=1),
    )
    assert len(rec.calls) == 1  # budget exhausted after the first
    fired = [r for r in out if r["_drone"].get("dispatched")]
    exhausted = [r for r in out if r["_drone"].get("reason") == "dispatch budget exhausted"]
    assert len(fired) == 1
    assert len(exhausted) == 2


@pytest.mark.asyncio
async def test_drone_max_dispatch_leaves_extra_rows_untouched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    rows = [{"lat": i, "lon": i} for i in range(5)]
    out = await blocks_mod._run_control_drone(
        {"server_url": "http://h/x", "command": "goto", "mode": "per_row", "max_dispatch": 2},
        [rows],
        _ctx(),
    )
    assert len(rec.calls) == 2
    assert "_drone" in out[0] and "_drone" in out[1]
    assert "_drone" not in out[2]  # past max_dispatch → passthrough


@pytest.mark.asyncio
async def test_drone_rejects_unknown_command() -> None:
    with pytest.raises(WorkflowError):
        await blocks_mod._run_control_drone(
            {"server_url": "http://h/x", "command": "self_destruct"},
            [[{"lat": 1, "lon": 2}]],
            _ctx(),
        )


@pytest.mark.asyncio
async def test_drone_takeoff_has_no_waypoint(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    out = await blocks_mod._run_control_drone(
        {"server_url": "http://h/x", "command": "takeoff", "alt_col": "alt_m"},
        [[{"alt_m": 50.0}]],
        _ctx(),
    )
    env = rec.calls[0]["body"]
    assert env["command"] == "takeoff"
    assert "waypoint" not in env
    assert env["alt_m"] == 50.0
    assert out[0]["_drone"]["dispatched"] is True


# ── control.device ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_device_payload_from_named_columns(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    rows = [{"id": "relay-3", "state": "on", "channel": 2, "_internal": "x"}]
    await blocks_mod._run_control_device(
        {
            "server_url": "http://h",
            "command": "set_relay",
            "device_col": "id",
            "payload_columns": "state,channel",
            "mode": "per_row",
        },
        [rows],
        _ctx(),
    )
    env = rec.calls[0]["body"]
    assert env["type"] == "device.command"
    assert env["device"] == "relay-3"
    assert env["command"] == "set_relay"
    assert env["payload"] == {"state": "on", "channel": 2}


@pytest.mark.asyncio
async def test_device_default_payload_drops_internal_columns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    rows = [{"a": 1, "_http": {"x": 1}}]
    await blocks_mod._run_control_device({"server_url": "http://h", "command": "c"}, [rows], _ctx())
    assert rec.calls[0]["body"]["payload"] == {"a": 1}  # _http dropped


# ── control.webhook ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_webhook_batch_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    rows = [{"x": 1}, {"x": 2}]
    out = await blocks_mod._run_control_webhook(
        {"url": "http://h/hook", "mode": "batch"}, [rows], _ctx()
    )
    assert len(rec.calls) == 1
    env = rec.calls[0]["body"]
    assert env["type"] == "workflow.webhook"
    assert env["count"] == 2
    assert env["rows"] == rows
    assert out == rows  # rows pass through unchanged


# ── op.http ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_http_once_json_list_becomes_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder(control.HttpResult(200, True, [{"a": 1}, {"a": 2}], "", None))
    monkeypatch.setattr(control, "send", rec)
    out = await blocks_mod._run_op_http(
        {"method": "GET", "url": "http://h/data", "response": "json"}, [], _ctx()
    )
    assert out == [{"a": 1}, {"a": 2}]
    assert rec.calls[0]["method"] == "GET"


@pytest.mark.asyncio
async def test_http_json_path_drills(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder(control.HttpResult(200, True, {"result": {"items": [{"n": 1}]}}, "", None))
    monkeypatch.setattr(control, "send", rec)
    out = await blocks_mod._run_op_http(
        {"url": "http://h", "response": "json", "json_path": "result.items"}, [], _ctx()
    )
    assert out == [{"n": 1}]


@pytest.mark.asyncio
async def test_http_get_executes_in_preview_but_post_dry_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(control.HttpResult(200, True, [{"a": 1}], "", None))
    monkeypatch.setattr(control, "send", rec)
    # GET is read-only → runs live even on preview
    await blocks_mod._run_op_http({"method": "GET", "url": "http://h"}, [], _ctx(preview=True))
    assert len(rec.calls) == 1
    # POST mutates → dry-run on preview, no extra call
    out = await blocks_mod._run_op_http(
        {"method": "POST", "url": "http://h", "body": '{"x":1}'}, [[{"x": 1}]], _ctx(preview=True)
    )
    assert len(rec.calls) == 1  # unchanged
    assert out[0]["dry_run"] is True


@pytest.mark.asyncio
async def test_http_per_row_merges_result(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder(control.HttpResult(201, True, {"queued": True}, "", None))
    monkeypatch.setattr(control, "send", rec)
    rows = [{"id": "a"}, {"id": "b"}]
    out = await blocks_mod._run_op_http(
        {"method": "POST", "url": "http://h/{id}", "mode": "per_row"}, [rows], _ctx()
    )
    assert len(rec.calls) == 2
    assert rec.calls[0]["url"] == "http://h/a"
    assert out[0]["id"] == "a"
    assert out[0]["_http"]["status"] == 201


# ── control.py guards (unit) ─────────────────────────────────────────────────


def test_check_url_rejects_non_http() -> None:
    with pytest.raises(WorkflowError):
        control.check_url("ftp://host/x")


def test_check_url_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "good.example, localhost")
    control.check_url("http://good.example/x")  # allowed
    control.check_url("http://localhost:9010/x")  # allowed
    with pytest.raises(WorkflowError):
        control.check_url("http://evil.example/x")  # refused


def test_check_url_blocks_link_local_metadata() -> None:
    # The cloud-metadata IP (169.254.169.254) and its /16 are refused even
    # though localhost/private LAN stay open.
    with pytest.raises(WorkflowError) as exc:
        control.check_url("http://169.254.169.254/latest/meta-data/")
    assert exc.value.status_code == 403
    with pytest.raises(WorkflowError):
        control.check_url("http://169.254.1.2/x")
    control.check_url("http://127.0.0.1:9010/command")  # localhost still fine
    control.check_url("http://192.168.1.50/command")  # private LAN still fine


def test_check_url_blocks_ipv6_and_mapped_metadata() -> None:
    # The IPv4-only guard let the IPv6 metadata surface through: AWS's IPv6 IMDS
    # host (a ULA), IPv6 link-local, and the IPv4-mapped form of 169.254.169.254.
    for url in (
        "http://[fd00:ec2::254]/latest/meta-data/iam/security-credentials/",
        "http://[fe80::1]/x",
        "http://[::ffff:169.254.169.254]/x",
    ):
        with pytest.raises(WorkflowError) as exc:
            control.check_url(url)
        assert exc.value.status_code == 403
    # A normal IPv6 ULA / loopback control server is NOT a metadata endpoint and
    # stays reachable — the BYO posture (private LAN open) must not regress.
    control.check_url("http://[fd12:3456:789a::1]/command")  # IPv6 ULA LAN host
    control.check_url("http://[::1]:9010/command")  # IPv6 loopback


def test_check_url_link_local_allowed_when_explicitly_allowlisted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "169.254.169.254")
    control.check_url("http://169.254.169.254/x")  # operator opted in → allowed


def test_check_url_strict_mode_blocks_private_and_loopback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Default (BYO) posture: LAN + loopback control servers stay reachable.
    control.check_url("http://127.0.0.1:9010/command")
    control.check_url("http://192.168.1.50/command")
    # Strict mode (publicly-exposed box): the same targets are refused.
    monkeypatch.setenv("WORKFLOWS_HTTP_BLOCK_PRIVATE", "1")
    for url in (
        "http://127.0.0.1:9010/command",
        "http://192.168.1.50/command",
        "http://10.0.0.5/x",
        "http://[::1]/x",
    ):
        with pytest.raises(WorkflowError) as exc:
            control.check_url(url)
        assert exc.value.status_code == 403
    # A public host is still fine in strict mode.
    control.check_url("http://example.com/x")


def test_check_url_strict_mode_allowlist_still_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKFLOWS_HTTP_BLOCK_PRIVATE", "1")
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "192.168.1.50")
    control.check_url("http://192.168.1.50/command")  # named internal host → allowed
    with pytest.raises(WorkflowError):
        control.check_url("http://192.168.1.99/command")  # a different LAN host → refused


def _fake_getaddrinfo(monkeypatch: pytest.MonkeyPatch, mapping: dict[str, str]) -> None:
    """Pin socket.getaddrinfo so a hostname resolves to a chosen IP — models a
    DNS-rebinding server that answered differently at request time."""
    import socket as _socket

    def fake(host, *a, **kw):
        ip = mapping[host]
        return [(_socket.AF_INET, _socket.SOCK_STREAM, 0, "", (ip, 0))]

    monkeypatch.setattr(control.socket, "getaddrinfo", fake)


def test_pin_http_url_blocks_dns_rebinding_to_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    """A DNS name that (re)resolves to the link-local/metadata range at request
    time is blocked by _pin_http_url even though check_url passed earlier."""
    _fake_getaddrinfo(monkeypatch, {"rebind.evil.example": "169.254.169.254"})
    url, headers, blocked = control._pin_http_url("http://rebind.evil.example/latest/meta-data/", {})
    assert blocked is not None and "link-local" in blocked


def test_pin_http_url_blocks_ipv6_metadata_rebinding(monkeypatch: pytest.MonkeyPatch) -> None:
    """A name that re-resolves to the AWS IPv6 IMDS host at request time is also
    blocked — the pin guard is no longer IPv4-only."""
    import socket as _socket

    def fake(host, *a, **kw):
        return [(_socket.AF_INET6, _socket.SOCK_STREAM, 0, "", ("fd00:ec2::254", 0, 0, 0))]

    monkeypatch.setattr(control.socket, "getaddrinfo", fake)
    url, headers, blocked = control._pin_http_url("http://rebind6.evil.example/latest/meta-data/", {})
    assert blocked is not None and "link-local" in blocked


def test_pin_http_url_pins_benign_name_to_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    """A benign http DNS name is pinned to its validated IP with the original
    hostname carried in the Host header, so httpx cannot re-resolve elsewhere."""
    _fake_getaddrinfo(monkeypatch, {"control.local.example": "192.168.1.50"})
    url, headers, blocked = control._pin_http_url("http://control.local.example:9010/command", {})
    assert blocked is None
    assert url == "http://192.168.1.50:9010/command"
    assert headers["Host"] == "control.local.example:9010"


def test_pin_http_url_leaves_ip_literals_and_https(monkeypatch: pytest.MonkeyPatch) -> None:
    # IP literal → nothing to rebind, untouched.
    assert control._pin_http_url("http://192.168.1.50/x", {}) == ("http://192.168.1.50/x", {}, None)
    # https → hostname preserved for cert validation (documented residual risk).
    assert control._pin_http_url("https://host.example/x", {}) == ("https://host.example/x", {}, None)


def test_pin_http_url_skips_allowlisted_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "trusted.example")
    assert control._pin_http_url("http://trusted.example/x", {}) == (
        "http://trusted.example/x",
        {},
        None,
    )


@pytest.mark.asyncio
async def test_send_turns_rebind_block_into_row_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A rebind detected at send time fails just that row (HttpResult error),
    preserving send's never-raises / per-row isolation contract."""
    _fake_getaddrinfo(monkeypatch, {"rebind.evil.example": "169.254.169.254"})
    res = await control.send("GET", "http://rebind.evil.example/x", headers={})
    assert res.ok is False and res.status is None
    assert res.error is not None and "link-local" in res.error


def test_control_client_does_not_follow_redirects() -> None:
    # check_url validates only the original URL, so the shared client must not
    # chase a 3xx (which could hop to the link-local/metadata range).
    assert control._client().follow_redirects is False


@pytest.mark.asyncio
async def test_redirect_to_metadata_is_not_followed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 302 to 169.254.169.254 must NOT be followed — the metadata endpoint is
    never reached and its body never returned; the caller sees the raw 3xx."""
    import httpx

    hops: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hops.append(str(request.url))
        if request.url.host == "evil.example":
            return httpx.Response(
                302, headers={"location": "http://169.254.169.254/latest/meta-data/"}
            )
        return httpx.Response(200, text="INSTANCE-CREDENTIALS")

    # Build a client whose redirect policy MIRRORS the real one, so this test
    # fails if the follow_redirects fix is ever reverted to True.
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        follow_redirects=control._client().follow_redirects,
    )
    monkeypatch.setattr(control, "_CLIENT", client)
    try:
        res = await control.send("GET", "http://evil.example/x", headers={})
    finally:
        await client.aclose()

    assert res.status == 302
    assert len(hops) == 1  # only the original host was contacted
    assert all("169.254" not in h for h in hops)
    assert "INSTANCE-CREDENTIALS" not in (res.text or "")


@pytest.mark.asyncio
async def test_dispatch_5xx_is_not_dispatched(monkeypatch: pytest.MonkeyPatch) -> None:
    # An HTTP 500 has error=None but is a rejection — dispatched must be False.
    rec = _Recorder(control.HttpResult(status=500, ok=False, json=None, text="boom", error=None))
    monkeypatch.setattr(control, "send", rec)
    res = await control.dispatch(
        "http://h/x", {"type": "drone.command"}, budget=[10], preview=False
    )
    assert res["dispatched"] is False
    assert res["status"] == 500


def test_kill_switch_forces_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKFLOWS_CONTROL_ENABLED", "0")
    assert control.control_enabled() is False


@pytest.mark.asyncio
async def test_dispatch_dry_run_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(control, "send", rec)
    monkeypatch.setenv("WORKFLOWS_CONTROL_ENABLED", "0")
    res = await control.dispatch(
        "http://h/x", {"type": "drone.command"}, budget=[10], preview=False
    )
    assert rec.calls == []
    assert res["dry_run"] is True
    assert res["reason"] == "control-disabled"


def test_auth_headers_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MY_TOKEN", "sekret")
    assert control.auth_headers("MY_TOKEN") == {"Authorization": "Bearer sekret"}
    assert control.auth_headers("") == {}
    assert control.auth_headers("UNSET_VAR_XYZ") == {}


# ── catalog ──────────────────────────────────────────────────────────────────


def test_catalog_exposes_control_category_and_new_blocks() -> None:
    cat = {b["type"]: b for b in blocks_mod.catalog()}
    for t in ("op.http", "control.webhook", "control.drone", "control.device"):
        assert t in cat, f"missing block {t}"
    assert cat["control.drone"]["category"] == "control"
    assert cat["op.http"]["category"] == "op"
    assert cat["op.http"]["min_inputs"] == 0
    assert len(cat) == 20
