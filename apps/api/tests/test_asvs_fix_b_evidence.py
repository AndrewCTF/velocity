"""ASVS fixes on the evidence locker: pinned URL capture (V1.3.6), declared vs
detected media type (V2.2.1, V5.2.2), a total-bytes cap answering 507 (V2.4.1),
a sanitized Content-Disposition fallback (V5.4.2), and no second write path to
``evidence:`` objects through the generic ontology routes (V2.2.1).

Offline: DNS and the HTTP transport are both stubbed.
"""

from __future__ import annotations

import asyncio
import base64
import socket

import httpx
import pytest
from fastapi.testclient import TestClient

from app.intel import evidence as ev
from app.keys import UserCtx
from app.routes.evidence import _content_disposition

_CTX = UserCtx("local", "")
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


# ── V1.3.6: connect to the address that was validated ─────────────────────────


def _addrinfo(ip: str) -> list[tuple]:
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (ip, 0))]


def test_url_capture_pins_the_validated_address_against_rebinding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The name answers public first, then 127.0.0.1. Whatever httpx would
    resolve later, the request must go to the address that passed the check,
    with the real name kept in Host and (for https) SNI."""
    answers = iter(["93.184.216.34", "127.0.0.1", "127.0.0.1"])
    lookups: list[str] = []

    def fake_getaddrinfo(host, *a, **k):  # noqa: ANN001, ANN002, ANN003
        lookups.append(host)
        return _addrinfo(next(answers))

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>ok</p>")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(ev, "get_client", lambda: client)

    obj = asyncio.run(ev.capture_url(_CTX, "https://rebind.example.test/page?q=1"))

    assert len(seen) == 1
    req = seen[0]
    assert req.url.host == "93.184.216.34", "must connect to the validated address"
    assert req.url.path == "/page" and req.url.query == b"q=1"
    assert req.headers["host"] == "rebind.example.test"
    assert req.extensions.get("sni_hostname") == "rebind.example.test"
    assert lookups == ["rebind.example.test"], "one resolution per hop, no second lookup"
    # Provenance names the URL the analyst asked for, not the pinned address.
    assert obj.props["final_url"] == "https://rebind.example.test/page?q=1"


def test_redirect_hop_is_revalidated_and_pinned_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    """A relative Location joins against the NAMED url, and the next hop's name
    is resolved and checked again — here it rebinds to loopback and is refused."""
    table = {"a.example.test": "93.184.216.34", "b.example.test": "127.0.0.1"}
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, *a, **k: _addrinfo(table[host]))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://b.example.test/x"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(ev, "get_client", lambda: client)
    with pytest.raises(ev.EvidenceError):
        asyncio.run(ev.capture_url(_CTX, "http://a.example.test/start"))


def test_pinned_request_keeps_ports_and_brackets_ipv6() -> None:
    url, headers, ext = ev._pinned_request("http://user:pw@name.test:8080/p", "2001:db8::1")
    assert url == "http://[2001:db8::1]:8080/p"
    assert headers == {"Host": "name.test:8080", "Connection": "close"}
    assert ext == {}


# ── V2.2.1 / V5.2.2: declared type validated, detected type stored ────────────


def test_capture_stores_declared_and_detected_types_without_rejecting() -> None:
    async def run() -> None:
        png = await ev.capture_bytes(
            _CTX, data=_PNG, media_type="image/png", capture_method=ev.METHOD_FILE
        )
        assert png.props["media_type"] == "image/png"
        assert png.props["detected_media_type"] == "image/png"
        assert ev.served_media_type(png.props) == "image/png"

        # Declared a PNG, the bytes are HTML: kept (custody), served as octet-stream.
        lie = await ev.capture_bytes(
            _CTX, data=b"<html><script>x</script>", media_type="image/png",
            capture_method=ev.METHOD_FILE,
        )
        assert lie.props["media_type"] == "image/png"
        assert lie.props["detected_media_type"] is None
        # HTML has no signature, so nothing contradicts it — but a PNG signature
        # declared as text/html does:
        swapped = await ev.capture_bytes(
            _CTX, data=_PNG + b"1", media_type="text/html", capture_method=ev.METHOD_FILE
        )
        assert swapped.props["detected_media_type"] == "image/png"
        assert ev.served_media_type(swapped.props) == "application/octet-stream"

        # A malformed declared type is recorded as octet-stream, never verbatim.
        bad = await ev.capture_bytes(
            _CTX, data=b"abc", media_type="text/html\r\nX-Evil: 1",
            capture_method=ev.METHOD_FILE,
        )
        assert bad.props["media_type"] == "application/octet-stream"

    asyncio.run(run())


def test_screenshot_route_refuses_a_malformed_media_type(client: TestClient) -> None:
    b64 = base64.b64encode(_PNG).decode()
    r = client.post(
        "/api/evidence/capture/screenshot",
        json={"data_base64": b64, "media_type": "image/png\r\nSet-Cookie: a=b"},
    )
    assert r.status_code == 422
    ok = client.post("/api/evidence/capture/screenshot", json={"data_base64": b64})
    assert ok.status_code == 200, ok.text
    assert ok.json()["props"]["detected_media_type"] == "image/png"


def test_blob_route_serves_octet_stream_when_bytes_contradict_the_declared_type(
    client: TestClient,
) -> None:
    r = client.post(
        "/api/evidence/upload",
        files={"file": ("shot.html", _PNG + b"2", "text/html")},
    )
    assert r.status_code == 200, r.text
    sha = r.json()["props"]["sha256"]
    blob = client.get(f"/api/evidence/{sha}/blob")
    assert blob.status_code == 200
    assert blob.headers["content-type"].startswith("application/octet-stream")


# ── V2.2.1: no second write path to evidence objects ──────────────────────────


def test_generic_ontology_routes_refuse_evidence_writes(client: TestClient) -> None:
    sha = "a" * 64
    r = client.post(
        "/api/ontology/object",
        json={"id": f"evidence:{sha}", "kind": "evidence", "props": {"sha256": "../../x"}},
    )
    assert r.status_code == 403
    forged = client.post(
        "/api/ontology/object",
        json={"id": "person:x", "kind": "person", "props": {"custody": {"action": "created"}}},
    )
    assert forged.status_code == 403
    promote = client.post(
        "/api/ontology/promote", json={"id": f"evidence:{sha}", "props": {"sha256": "../x"}}
    )
    assert promote.status_code == 403
    by_kind = client.post(
        "/api/ontology/promote", json={"id": "aircraft:abc123", "props": {"kind": "evidence"}}
    )
    assert by_kind.status_code == 403


# ── V2.4.1: total bytes cap → 507 ─────────────────────────────────────────────


def test_total_bytes_cap_answers_507_and_dedup_is_free(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EVIDENCE_MAX_TOTAL_BYTES", "100")
    first = client.post("/api/evidence/upload", files={"file": ("a.bin", b"x" * 60, "text/plain")})
    assert first.status_code == 200, first.text
    # Identical bytes are content-addressed and cost nothing.
    again = client.post("/api/evidence/upload", files={"file": ("a.bin", b"x" * 60, "text/plain")})
    assert again.status_code == 200
    over = client.post("/api/evidence/upload", files={"file": ("b.bin", b"y" * 60, "text/plain")})
    assert over.status_code == 507
    assert "EVIDENCE_MAX_TOTAL_BYTES" in over.json()["detail"]
    monkeypatch.setenv("EVIDENCE_MAX_TOTAL_BYTES", "0")  # 0 disables the cap
    assert client.post(
        "/api/evidence/upload", files={"file": ("b.bin", b"y" * 60, "text/plain")}
    ).status_code == 200


def test_total_is_measured_from_disk_after_a_restart(tmp_path, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("EVIDENCE_MAX_TOTAL_BYTES", "50")
    ev.override_evidence_dir(str(tmp_path / "ev"))
    shard = tmp_path / "ev" / "ab"
    shard.mkdir(parents=True)
    (shard / ("ab" + "0" * 62)).write_bytes(b"z" * 45)
    try:
        with pytest.raises(ev.EvidenceStorageFull):
            asyncio.run(
                ev.capture_bytes(_CTX, data=b"q" * 10, media_type="text/plain",
                                 capture_method=ev.METHOD_FILE)
            )
    finally:
        ev.override_evidence_dir(None)


# ── V5.4.2: quoted-string fallback ────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    ["evil\\", "tab\there.txt", "nul\x00.txt", 'q"uote.txt', "crlf\r\nX: y", "semi;colon=1"],
)
def test_content_disposition_fallback_is_a_safe_quoted_string(name: str) -> None:
    header = _content_disposition(name, "attachment")
    fallback = header.split('filename="', 1)[1].split('"', 1)[0]
    assert all(c.isalnum() or c in "._ -" for c in fallback), fallback
    assert "\\" not in header.split("filename*=", 1)[0]
    assert all(0x20 <= ord(c) < 0x7F for c in header)
    assert header.endswith("filename*=UTF-8''" + __import__("urllib.parse").parse.quote(name, safe=""))
