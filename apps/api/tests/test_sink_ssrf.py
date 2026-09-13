"""G7: an alert-rule sink_url is PUBLIC-ONLY unless the operator allowlisted it.

``op.http``'s LAN default is untouched (the operator's control server lives on
the LAN, and those blocks are operator-gated); alert rules are analyst-reachable,
so their webhook must not be aimable at loopback / LAN / metadata services.
"""

from __future__ import annotations

import asyncio
import socket

import pytest
from fastapi.testclient import TestClient

from app import netguard
from app.intel import alert_rules_local, watch
from app.workflows import control
from app.workflows.store import WorkflowError

_DNS = {
    "loopback.evil.example": "127.0.0.1",
    "hooks.public.example": "93.184.216.34",
    "control.lan.example": "192.168.1.50",
}


@pytest.fixture(autouse=True)
def _fake_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake(host, *a, **kw):  # type: ignore[no-untyped-def]
        try:
            ip = _DNS.get(host) or str(__import__("ipaddress").ip_address(host))
        except ValueError as exc:
            raise socket.gaierror(str(exc)) from exc
        fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
        return [(fam, socket.SOCK_STREAM, 0, "", (ip, 0))]

    monkeypatch.setattr(control.socket, "getaddrinfo", fake)
    monkeypatch.delenv("WORKFLOWS_HTTP_ALLOW_HOSTS", raising=False)


_BAD = [
    "http://127.0.0.1/hook",
    "http://10.0.0.1/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://100.64.0.1/hook",  # CGNAT
    "http://169.254.169.254/latest",
    "https://loopback.evil.example/hook",
]


def _rule(url: str) -> dict:
    return {"label": "x", "lat": 1, "lon": 2, "channel": "webhook", "sink_url": url}


@pytest.mark.parametrize("url", _BAD)
def test_create_refuses_non_public_sink(client: TestClient, url: str) -> None:
    r = client.post("/api/alerts/rules", json=_rule(url))
    assert r.status_code == 422, r.text


def test_create_accepts_public_sink(client: TestClient) -> None:
    r = client.post("/api/alerts/rules", json=_rule("https://hooks.public.example/x"))
    assert r.status_code == 201, r.text


def test_create_accepts_allowlisted_lan_sink(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "control.lan.example")
    r = client.post("/api/alerts/rules", json=_rule("http://control.lan.example/hook"))
    assert r.status_code == 201, r.text


def test_op_http_lan_default_unchanged() -> None:
    control.check_url("http://192.168.1.50/command")  # no raise: BYO LAN posture
    control.check_url("http://127.0.0.1:9000/command")
    with pytest.raises(WorkflowError):
        control.check_sink_url("http://192.168.1.50/command")


def test_ip_classifier_is_shared() -> None:
    from app.intel import evidence
    from app.news import images

    for ip in ("127.0.0.1", "10.0.0.1", "::ffff:127.0.0.1", "100.64.0.1", "fe80::1"):
        assert netguard.is_non_public_ip(ip)
        assert evidence._ip_is_blocked(ip)
        assert control._ip_is_private(ip)
        assert images._is_non_public(__import__("ipaddress").ip_address(ip))
    assert not netguard.is_non_public_ip("93.184.216.34")


def test_send_public_only_blocks_rebind_to_loopback(monkeypatch) -> None:
    """Delivery re-resolves: a host that passed at create but now points at
    loopback is refused before any connection (https included)."""

    class _Boom:
        async def request(self, *a, **k):  # type: ignore[no-untyped-def]
            raise AssertionError("must not connect")

    monkeypatch.setattr(control, "_client", lambda: _Boom())
    for url in ("https://loopback.evil.example/h", "http://loopback.evil.example/h",
                "http://[::ffff:127.0.0.1]/h"):
        res = asyncio.run(control.send("POST", url, headers={}, json_body={}, public_only=True))
        assert res.ok is False and res.error and "public" in res.error


def test_delivery_refuses_non_public_sink(monkeypatch) -> None:
    called: list[str] = []

    async def _fake_send(method, url, **kw):  # type: ignore[no-untyped-def]
        called.append(url)
        return control.HttpResult(status=204, ok=True, json=None, text="", error=None)

    monkeypatch.setattr(control, "send", _fake_send)
    cand = watch._Candidate(
        entity_id="e1", kind="quake", lon=2.0, lat=1.0, severity_rank=3, summary="q"
    )
    rule = {"id": "r1", "label": "x", "channel": "webhook",
            "sink_url": "http://loopback.evil.example/hook"}
    asyncio.run(watch._deliver_sinks(rule, cand, "enter"))
    assert called == []
    rows = asyncio.run(alert_rules_local.recent_deliveries())
    assert rows and rows[0]["ok"] is False
