"""The ``ntfy`` alert channel: a firing lands as a phone notification.

ntfy's JSON publish goes to the server root with the topic in the body, so the
configured topic URL is split before the POST. The SSRF posture is the same as
``discord``/``webhook`` (``test_sink_ssrf.py``): public-only at create AND at
delivery, checked on the URL actually posted to.
"""

from __future__ import annotations

import asyncio
import socket

import pytest
from fastapi.testclient import TestClient

from app.intel import alert_rules_local, watch
from app.routes.alert_rules import ntfy_target
from app.workflows import control

_DNS = {"ntfy.sh": "159.203.148.75", "loopback.evil.example": "127.0.0.1"}


@pytest.fixture(autouse=True)
def _fake_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake(host, *a, **kw):  # type: ignore[no-untyped-def]
        try:
            ip = _DNS.get(host) or str(__import__("ipaddress").ip_address(host))
        except ValueError as exc:
            raise socket.gaierror(str(exc)) from exc
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 0))]

    monkeypatch.setattr(control.socket, "getaddrinfo", fake)
    monkeypatch.delenv("WORKFLOWS_HTTP_ALLOW_HOSTS", raising=False)


def test_ntfy_target_splits_server_and_topic() -> None:
    assert ntfy_target("https://ntfy.sh/my-topic") == ("https://ntfy.sh", "my-topic")
    assert ntfy_target("https://host.example/ntfy/t_1") == ("https://host.example/ntfy", "t_1")
    for bad in ("https://ntfy.sh/", "https://ntfy.sh", "https://ntfy.sh/bad topic",
                "https://ntfy.sh/" + "x" * 65):
        with pytest.raises(ValueError):
            ntfy_target(bad)


def _rule(url: str) -> dict:
    return {"label": "Overhead", "lat": 1, "lon": 2, "channel": "ntfy", "sink_url": url}


def test_create_ntfy_rule(client: TestClient) -> None:
    assert client.post("/api/alerts/rules", json=_rule("https://ntfy.sh/velocity-test")).status_code == 201
    r = client.post("/api/alerts/rules", json=_rule("https://ntfy.sh/"))
    assert r.status_code == 400 and "topic" in r.text
    assert client.post("/api/alerts/rules", json=_rule("https://loopback.evil.example/t")).status_code == 422


def _cand() -> watch._Candidate:
    return watch._Candidate(
        entity_id="ae1234", kind="military_air", lon=2.0, lat=1.0, severity_rank=3,
        summary="RCH123 overhead",
    )


def test_delivery_posts_json_publish_to_server_root(monkeypatch) -> None:
    sent: list[tuple[str, dict]] = []

    async def _fake_send(method, url, **kw):  # type: ignore[no-untyped-def]
        sent.append((url, kw["json_body"]))
        return control.HttpResult(status=200, ok=True, json=None, text="", error=None)

    monkeypatch.setattr(control, "send", _fake_send)
    rule = {"id": "r1", "label": "Overhead", "channel": "ntfy",
            "sink_url": "https://ntfy.sh/velocity-test"}
    asyncio.run(watch._deliver_sinks(rule, _cand(), "enter"))
    assert len(sent) == 1
    url, body = sent[0]
    assert url == "https://ntfy.sh"
    assert body["topic"] == "velocity-test" and body["title"] == "Overhead"
    assert isinstance(body["message"], str) and body["message"]


def test_delivery_refuses_non_public_ntfy_host(monkeypatch) -> None:
    called: list[str] = []

    async def _fake_send(method, url, **kw):  # type: ignore[no-untyped-def]
        called.append(url)
        return control.HttpResult(status=200, ok=True, json=None, text="", error=None)

    monkeypatch.setattr(control, "send", _fake_send)
    rule = {"id": "r2", "label": "x", "channel": "ntfy",
            "sink_url": "https://loopback.evil.example/topic"}
    asyncio.run(watch._deliver_sinks(rule, _cand(), "enter"))
    assert called == []
    rows = asyncio.run(alert_rules_local.recent_deliveries())
    assert rows and rows[0]["ok"] is False
