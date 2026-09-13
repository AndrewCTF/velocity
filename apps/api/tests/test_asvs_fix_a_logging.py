"""ASVS 5.0 fixes, backend logging and audit: secrets in upstream URLs (V16.2.5),
log injection (V16.4.1), the who of a refusal (V16.2.1), validation rejections
(V16.3.3), upstream TLS failures (V16.3.4), generic upstream errors (V16.5.1),
the audit trail's client IP (V15.3.4), tamper resistance (V16.4.2), audit
retention (V14.2.4) and secrets files (V13.3.1)."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import ssl

import httpx
import pytest
from fastapi.testclient import TestClient

from app import audit, logging_setup, upstream
from app.config import Settings, get_settings
from app.keys import UserCtx
from app.main import create_app
from tests._authkit import ALICE, bearer, mint, multi_user

# ── V16.2.5: an API key in an upstream URL never reaches the log ─────────────


def test_httpx_request_lines_do_not_log_at_info(caplog):
    logging_setup.configure("info")
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() >= logging.WARNING

    async def _go():
        transport = httpx.MockTransport(lambda req: httpx.Response(200, text="ok"))
        async with httpx.AsyncClient(transport=transport) as c:
            await c.get("https://firms.example/api/area/csv/SECRETMAPKEY/VIIRS/world/1")

    with caplog.at_level(logging.INFO):
        asyncio.run(_go())
    assert "SECRETMAPKEY" not in caplog.text


def test_access_log_redacts_credential_named_query_values():
    from app.auth import RedactKeyFilter

    rec = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, '%s "%s"', ("1.2.3.4", "GET /x?token=T0K&map_key=MK&q=ok"), None
    )
    RedactKeyFilter().filter(rec)
    line = rec.getMessage()
    assert "T0K" not in line and "MK&" not in line and "q=ok" in line


# ── V16.4.1: control characters cannot forge log lines ──────────────────────


def test_formatter_escapes_control_characters_and_line_separators():
    fmt = logging_setup.build_formatter()
    rec = logging.LogRecord(
        "app.security", logging.WARNING, __file__, 1,
        "forbidden path=%s", ("/api/x\x1b[31m\u2028auth success\r\nfake",), None,
    )
    line = fmt.format(rec)
    for raw in ("\x1b", "\u2028", "\r", "\n"):
        assert raw not in line
    assert "\\x1b" in line and "\\u2028" in line


def test_formatter_keeps_tracebacks_multiline():
    fmt = logging_setup.build_formatter()
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        rec = logging.LogRecord("x", logging.ERROR, __file__, 1, "failed", None, sys.exc_info())
    assert "\nTraceback" in fmt.format(rec)


# ── V16.2.1: a refusal line names who was refused ───────────────────────────


def test_forbidden_line_carries_the_principal_not_the_token(monkeypatch, caplog):
    caplog.set_level(logging.WARNING)
    multi_user(monkeypatch, url=False)
    tok = mint()
    with TestClient(create_app()) as c:
        assert c.get("/api/workflows", headers=bearer(tok)).status_code == 403
    lines = [r.getMessage() for r in caplog.records if "forbidden" in r.getMessage()]
    assert lines and f"principal={ALICE}" in lines[0], lines
    assert tok not in caplog.text


# ── V16.3.3: input-validation rejections are logged with field names only ────


def test_validation_rejections_are_logged_without_values(client, caplog):
    caplog.set_level(logging.INFO)
    r = client.get("/api/aviation/states", params={"lamin": "SECRETVALUE"})
    assert r.status_code == 422
    r = client.get("/api/aviation/states", params={"lamin": "1"})
    assert r.status_code == 400
    lines = [m.getMessage() for m in caplog.records if m.name == "app.security"]
    assert any("status=422" in ln and "fields=query.lamin" in ln for ln in lines), lines
    assert any("status=400" in ln and "/api/aviation/states" in ln for ln in lines), lines
    # (The test client's own request logger prints the URL; the app's does not.)
    assert not any("SECRETVALUE" in ln for ln in lines)


# ── V16.3.4: an upstream TLS failure is a WARNING line ──────────────────────


def test_upstream_tls_failure_is_logged(caplog):
    upstream._tls_logged_at.clear()

    def handler(request):
        raise httpx.ConnectError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", request=request
        ) from ssl.SSLCertVerificationError("bad cert")

    async def _go():
        async with upstream._InstrumentedClient(transport=httpx.MockTransport(handler)) as c:
            with pytest.raises(httpx.ConnectError):
                await c.get("https://mitm.example/feed?key=NOPE")

    with caplog.at_level(logging.WARNING, logger="app.security"):
        asyncio.run(_go())
        asyncio.run(_go())  # once per host per interval
    lines = [r.getMessage() for r in caplog.records if "upstream tls failure" in r.getMessage()]
    assert len(lines) == 1, lines
    assert "host=mitm.example" in lines[0] and "NOPE" not in caplog.text


# ── V16.5.1: the aviation route does not echo upstream internals ────────────


def test_aviation_upstream_errors_are_generic(client, monkeypatch):
    from app.routes import aviation

    async def _boom(tm, bbox):
        raise httpx.ConnectError("connect to secret-internal-host:8443 failed")

    async def _status(tm, bbox):
        req = httpx.Request("GET", "https://opensky.example")
        raise httpx.HTTPStatusError(
            "x", request=req, response=httpx.Response(503, text="INTERNAL-UPSTREAM-BODY", request=req)
        )

    monkeypatch.setattr(aviation, "fetch_states", _boom)
    r = client.get("/api/aviation/states", params={"lamin": 1.5, "lomin": 2, "lamax": 3, "lomax": 4})
    assert r.status_code == 502 and "secret-internal-host" not in r.text
    monkeypatch.setattr(aviation, "fetch_states", _status)
    r = client.get("/api/aviation/states", params={"lamin": 1.25, "lomin": 2, "lamax": 3, "lomax": 4})
    assert r.status_code == 503 and "INTERNAL-UPSTREAM-BODY" not in r.text


# ── V15.3.4: the audit row records the client, not the proxy ────────────────


def test_audit_row_ip_uses_the_forwarded_client_behind_a_trusted_proxy(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.2")
    get_settings.cache_clear()

    class _Client:
        host = "10.0.0.2"

    class _Req:
        client = _Client()
        headers = {"x-forwarded-for": "203.0.113.9", "user-agent": "ua"}

    assert asyncio.run(audit.audit(UserCtx("local", ""), "a", "r", request=_Req())) is True  # type: ignore[arg-type]
    con = sqlite3.connect(audit._local_db_path())
    try:
        assert con.execute("SELECT ip FROM audit_log").fetchone()[0] == "203.0.113.9"
    finally:
        con.close()


# ── V16.4.2: append-only triggers and a hash chain ──────────────────────────


def _rows(n: int) -> None:
    for i in range(n):
        assert asyncio.run(audit.audit(UserCtx("local", ""), f"act{i}", "r", str(i))) is True


def test_local_audit_log_refuses_update_and_delete():
    _rows(2)
    con = sqlite3.connect(audit._local_db_path())
    try:
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            con.execute("UPDATE audit_log SET action='x'")
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            con.execute("DELETE FROM audit_log")
    finally:
        con.close()


def test_hash_chain_detects_an_edited_row():
    _rows(3)
    assert audit.verify_local_chain_sync() == {"ok": True, "rows": 3, "first_bad_id": None}
    con = sqlite3.connect(audit._local_db_path())
    try:
        # A process holding the file can always drop the trigger; the chain is
        # what makes that edit visible.
        con.execute("DROP TRIGGER audit_log_no_update")
        con.execute("UPDATE audit_log SET action='rewritten' WHERE action='act1'")
        con.commit()
    finally:
        con.close()
    out = audit.verify_local_chain_sync()
    assert out["ok"] is False and out["first_bad_id"] == 2


# ── V14.2.4: audit retention ────────────────────────────────────────────────


def test_prune_removes_rows_older_than_the_retention_and_keeps_the_chain_valid():
    audit._write_local_sync({
        "user_id": "local", "action": "act0", "resource_type": "r", "target_id": None,
        "classification": 0, "params": {}, "actor_email": None, "ts": "2020-01-01T00:00:00Z",
    })
    _rows(3)
    assert audit.prune_local_sync(0) == 0  # 0 = keep forever
    assert audit.prune_local_sync(30) == 1
    rows = audit.list_local_rows_sync(10)
    assert sorted(r["action"] for r in rows) == ["act0", "act1", "act2"]
    assert audit.verify_local_chain_sync()["ok"] is True
    # The triggers are back after a prune.
    con = sqlite3.connect(audit._local_db_path())
    try:
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            con.execute("DELETE FROM audit_log")
    finally:
        con.close()


def test_audit_writes_prune_on_the_configured_retention(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(audit, "prune_local_sync", lambda days: calls.append(days) or 0)
    monkeypatch.setattr(audit, "_last_prune", 0.0)
    monkeypatch.setenv("AUDIT_RETENTION_DAYS", "90")
    get_settings.cache_clear()
    _rows(2)
    assert calls == [90]  # at most once per interval, not per write


# ── V13.3.1: secrets from files ─────────────────────────────────────────────


def test_settings_read_secrets_from_a_secrets_dir(tmp_path, monkeypatch):
    monkeypatch.delenv("API_KEY", raising=False)
    (tmp_path / "api_key").write_text("from-a-secrets-file-" + "x" * 20)
    s = Settings(_secrets_dir=str(tmp_path), _env_file=None)
    assert s.api_key == "from-a-secrets-file-" + "x" * 20


def test_audit_verify_route_reports_the_chain(client):
    _rows(2)
    r = client.get("/api/audit/verify")
    assert r.status_code == 200 and r.json() == {"ok": True, "rows": 2, "first_bad_id": None}


def test_audit_verify_route_is_role_gated_in_multi_user_mode(monkeypatch):
    multi_user(monkeypatch, url=False)
    with TestClient(create_app()) as c:
        assert c.get("/api/audit/verify", headers=bearer(mint())).status_code == 403
