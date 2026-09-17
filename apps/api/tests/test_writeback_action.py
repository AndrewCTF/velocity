"""The ``writeback`` action: a governed write OUT to a system the operator runs.

Until this wave every registered action wrote into the platform's own stores —
the ontology, the target board, an alert rule. The critique that prompted W4
was specific: "actions that write back to source systems" is the thing a
console does that a dashboard does not, and this repo had none.

What is proven here, in order of how much it would hurt to get wrong:

  * one REAL non-dry-run POST against a loopback listener in this process, so
    "it reaches an endpoint" is a socket that received bytes, not a mock that
    was called. The listener's captured body is asserted, and so is the
    response code the audit row recorded.
  * the SSRF policy is ``op.http``'s, reused unchanged: an allow-list miss and
    the cloud-metadata address are both 403, and both refuse on the DRY RUN
    path too, so a rehearsal cannot be used to probe the network.
  * the audit row carries the sha256 of the payload and never the payload.
    An audit store that accumulates copies of the records it audits is a second
    copy of someone's business data in a place nobody is guarding.
  * ``operator_only`` bites on a multi-user deployment, on the direct route and
    on proposal approval.
  * the whole thing works KEYLESS: propose → list → approve with no Supabase,
    which is what ``routes/actions.py`` switching to ``current_user_or_local``
    bought (it was ``current_user``, i.e. 401 on the default deployment).

The loopback listener is ``http.server`` in a thread rather than
``asyncio.start_server`` (``tests/test_mqtt_client.py``'s idiom): ``TestClient``
drives the app from a portal thread with its own event loop, so a listener
built on the test's loop would never be serving while the request is in flight.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app import security as security_mod
from app.config import get_settings
from app.foundry.store import FoundryStore
from app.intel import action_log_local

# ── a real loopback listener ─────────────────────────────────────────────────


class _Received:
    """What the listener actually got, read back by the test."""

    def __init__(self) -> None:
        self.path: str | None = None
        self.method: str | None = None
        self.body: bytes = b""
        self.auth: str | None = None


def _make_handler(seen: _Received) -> type[BaseHTTPRequestHandler]:
    class _Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _capture(self) -> None:
            seen.method = self.command
            seen.path = self.path
            seen.auth = self.headers.get("Authorization")
            length = int(self.headers.get("Content-Length") or 0)
            seen.body = self.rfile.read(length) if length else b""
            payload = b'{"created": true}'
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_POST = _capture
        do_PUT = _capture
        do_PATCH = _capture

        def log_message(self, *args: object) -> None:  # keep pytest output clean
            return

    return _Handler


@pytest.fixture
def listener() -> Iterator[tuple[str, _Received]]:
    seen = _Received()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(seen))
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}", seen
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=5)


@pytest.fixture(autouse=True)
def _control_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """The control kill switch and the allow-list are process env, not Settings.
    Pin both per test so one test's allow-list cannot leak into the next."""
    monkeypatch.delenv("WORKFLOWS_HTTP_ALLOW_HOSTS", raising=False)
    monkeypatch.delenv("WORKFLOWS_HTTP_BLOCK_PRIVATE", raising=False)
    monkeypatch.setenv("WORKFLOWS_CONTROL_ENABLED", "1")


PAYLOAD = {"case_id": "CASE-7", "note": "vessel dark since 0412Z", "severity": 3}
PAYLOAD_SHA = hashlib.sha256(
    json.dumps(PAYLOAD, sort_keys=True, separators=(",", ":")).encode("utf-8")
).hexdigest()


def _audit_rows() -> list[dict]:
    import asyncio

    return asyncio.run(action_log_local.list_rows(50))


# ── keyless propose → approve, dry run ───────────────────────────────────────


def test_keyless_propose_list_approve_of_a_dry_run(
    client: TestClient, listener: tuple[str, _Received]
) -> None:
    """The whole HITL loop with no Supabase anywhere.

    This is the case ``routes/actions.py`` could not serve at all before W4:
    every handler depended on ``current_user``, which can only resolve against
    Supabase, so the default deployment got a 401 on its own action queue.
    """
    base, seen = listener
    proposed = client.post(
        "/api/actions/proposals",
        json={
            "name": "writeback",
            "params": {
                "target": "http",
                "url": f"{base}/cases",
                "payload": PAYLOAD,
                "dry_run": True,
            },
            "confidence": 0.8,
        },
    )
    assert proposed.status_code == 200, proposed.text
    pid = proposed.json()["id"]
    assert proposed.json()["operator_only"] is True

    pending = client.get("/api/actions/proposals")
    assert pending.status_code == 200, pending.text
    assert [r["id"] for r in pending.json()] == [pid]

    approved = client.post(f"/api/actions/proposals/{pid}/approve")
    assert approved.status_code == 200, approved.text
    detail = approved.json()["detail"]
    assert detail["dry_run"] is True
    assert detail["payload_sha256"] == PAYLOAD_SHA
    # A dry run is a rehearsal, not a request: nothing reached the listener.
    assert seen.method is None

    rows = _audit_rows()
    assert rows and rows[0]["action"] == "writeback"
    assert rows[0]["params"]["dry_run"] is True


def test_the_audit_row_carries_the_hash_and_never_the_payload(
    client: TestClient, listener: tuple[str, _Received]
) -> None:
    base, _ = listener
    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "http",
            "url": f"{base}/cases",
            "payload": PAYLOAD,
            "dry_run": True,
        },
    )
    assert r.status_code == 200, r.text
    row = _audit_rows()[0]
    blob = json.dumps(row)
    assert PAYLOAD_SHA in blob
    for secret in ("vessel dark since 0412Z", "CASE-7"):
        assert secret not in blob, "the audit row kept a copy of the record"


# ── the real thing: one live POST ────────────────────────────────────────────


def test_a_live_post_reaches_the_listener_and_the_audit_records_its_status(
    client: TestClient, listener: tuple[str, _Received], monkeypatch: pytest.MonkeyPatch
) -> None:
    base, seen = listener
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "127.0.0.1")
    monkeypatch.setenv("OSINT_TEST_WRITEBACK_TOKEN", "s3cret-bearer")

    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "http",
            "url": f"{base}/cases?ignored=1",
            "method": "POST",
            "auth_env": "OSINT_TEST_WRITEBACK_TOKEN",
            "payload": PAYLOAD,
        },
    )
    assert r.status_code == 200, r.text

    # The listener: a real socket received the real record.
    assert seen.method == "POST"
    assert seen.path == "/cases?ignored=1"
    assert json.loads(seen.body) == PAYLOAD
    # The bearer came from the env var NAME the action carried, never from the
    # proposal body.
    assert seen.auth == "Bearer s3cret-bearer"

    body = r.json()
    assert body["detail"]["dry_run"] is False
    assert body["detail"]["status"] == 201
    assert body["detail"]["ok"] is True
    # The query string is dropped from the recorded endpoint: that is where an
    # API key ends up.
    assert body["target_id"] == f"{base}/cases"

    row = _audit_rows()[0]
    assert row["action"] == "writeback"
    assert row["params"]["status"] == 201
    assert row["params"]["dry_run"] is False
    assert "s3cret-bearer" not in json.dumps(row)


# ── the SSRF policy, reused unchanged ────────────────────────────────────────


def test_a_host_outside_the_allow_list_is_refused(
    client: TestClient, listener: tuple[str, _Received], monkeypatch: pytest.MonkeyPatch
) -> None:
    base, seen = listener
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "erp.example.com")
    r = client.post(
        "/api/actions/writeback",
        json={"target": "http", "url": f"{base}/cases", "payload": PAYLOAD},
    )
    assert r.status_code == 403, r.text
    assert "WORKFLOWS_HTTP_ALLOW_HOSTS" in r.json()["detail"]
    assert seen.method is None


def test_the_cloud_metadata_endpoint_is_refused_even_on_a_dry_run(
    client: TestClient,
) -> None:
    """169.254.169.254 hands out instance credentials and is never a write-back
    target. Checked on the DRY RUN path on purpose: a rehearsal that skipped the
    guard would be a probe with an approval receipt attached."""
    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "http",
            "url": "http://169.254.169.254/latest/meta-data/iam/",
            "payload": PAYLOAD,
            "dry_run": True,
        },
    )
    assert r.status_code == 403, r.text
    assert "link-local" in r.json()["detail"]


def test_a_bearer_token_pasted_into_auth_env_is_refused(
    client: TestClient, listener: tuple[str, _Received]
) -> None:
    """``auth_env`` is the NAME of an environment variable, upper case, exactly
    as a sql connection's ``dsn_env`` is. A lower-case value with punctuation is
    far more likely to be the token itself, and a token in a proposal is a
    secret in a queue."""
    base, _ = listener
    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "http",
            "url": f"{base}/cases",
            "auth_env": "eyJhbGciOiJIUzI1NiJ9.token",
            "payload": PAYLOAD,
            "dry_run": True,
        },
    )
    assert r.status_code == 400, r.text


def test_a_url_that_is_not_http_is_refused(client: TestClient) -> None:
    r = client.post(
        "/api/actions/writeback",
        json={"target": "http", "url": "file:///etc/passwd", "payload": PAYLOAD},
    )
    assert r.status_code == 422, r.text


# ── operator authority ───────────────────────────────────────────────────────


def _make_multi_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make ``require_operator`` believe this deployment can tell two humans
    apart, without minting a Supabase project. The principal stays the keyless
    local analyst, which is exactly the caller the gate must refuse."""
    monkeypatch.setattr(security_mod, "_multi_user", lambda s: True)


def test_a_non_operator_cannot_run_the_writeback_directly(
    client: TestClient, listener: tuple[str, _Received], monkeypatch: pytest.MonkeyPatch
) -> None:
    base, seen = listener
    _make_multi_user(monkeypatch)
    r = client.post(
        "/api/actions/writeback",
        json={"target": "http", "url": f"{base}/cases", "payload": PAYLOAD, "dry_run": True},
    )
    assert r.status_code == 403, r.text
    assert "operator authority" in r.json()["detail"]
    assert seen.method is None


def test_a_non_operator_cannot_approve_a_writeback_proposal(
    client: TestClient, listener: tuple[str, _Received], monkeypatch: pytest.MonkeyPatch
) -> None:
    """And the refusal must not consume the proposal: a queue that empties when
    the wrong person clicks approve loses the operator's work."""
    base, _ = listener
    proposed = client.post(
        "/api/actions/proposals",
        json={
            "name": "writeback",
            "params": {
                "target": "http",
                "url": f"{base}/cases",
                "payload": PAYLOAD,
                "dry_run": True,
            },
        },
    )
    pid = proposed.json()["id"]
    _make_multi_user(monkeypatch)
    denied = client.post(f"/api/actions/proposals/{pid}/approve")
    assert denied.status_code == 403, denied.text
    monkeypatch.undo()
    still_there = client.get("/api/actions/proposals")
    assert [r["id"] for r in still_there.json()] == [pid]


def test_an_analyst_action_is_not_operator_gated(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``operator_only`` is a property of the action, not of the router: the
    four ontology actions must keep working for an analyst on the same
    deployment that refuses a write-back."""
    _make_multi_user(monkeypatch)
    r = client.post(
        "/api/actions/flag_entity",
        json={"target_id": "aircraft:abc123", "note": "checking", "severity": 2},
    )
    assert r.status_code == 200, r.text


# ── bad proposals never enter the queue ──────────────────────────────────────


def test_an_unknown_action_cannot_be_proposed(client: TestClient) -> None:
    r = client.post("/api/actions/proposals", json={"name": "rm_rf", "params": {}})
    assert r.status_code == 404, r.text
    assert client.get("/api/actions/proposals").json() == []


def test_malformed_writeback_params_are_rejected_at_propose_time(client: TestClient) -> None:
    """A proposal that only fails at approval time is worse than one that fails
    now: it sits in the queue looking legitimate until a human signs for it."""
    r = client.post(
        "/api/actions/proposals",
        json={"name": "writeback", "params": {"target": "http", "payload": {"a": 1}}},
    )
    assert r.status_code == 400, r.text
    assert "url" in r.json()["detail"]
    assert client.get("/api/actions/proposals").json() == []


def test_a_table_name_that_is_not_an_identifier_is_rejected(client: TestClient) -> None:
    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "connection",
            "connection_id": "conn_x",
            "table": "cases; DROP TABLE cases",
            "payload": {"a": 1},
        },
    )
    assert r.status_code == 400, r.text


# ── the second target: a Foundry sql connection ──────────────────────────────


def test_writeback_into_a_sql_connection_inserts_a_row(
    client: TestClient, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real SQLite database through SQLAlchemy — the same "prove the wire
    against something real" stance ``tests/test_connections_sql.py`` takes for
    the read direction."""
    import asyncio

    db = tmp_path / "erp.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE case_notes (case_id TEXT, note TEXT, severity INTEGER)")
    con.commit()
    con.close()

    # The connection row holds the NAME of the env var, never the DSN.
    monkeypatch.setenv("OSINT_SQL_DSN_ERP", f"sqlite:///{db}")
    store = FoundryStore(get_settings())
    conn = asyncio.run(
        store.create_connection(
            name="erp-writeback",
            kind="sql",
            dataset_id="ds_test",
            config={"dsn_env": "OSINT_SQL_DSN_ERP", "query": "SELECT 1"},
        )
    )

    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "connection",
            "connection_id": conn["id"],
            "table": "case_notes",
            "payload": PAYLOAD,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["detail"]["rows"] == 1
    assert r.json()["target_id"] == f"connection:{conn['id']}/case_notes"

    con = sqlite3.connect(db)
    got = con.execute("SELECT case_id, note, severity FROM case_notes").fetchall()
    con.close()
    assert got == [("CASE-7", "vessel dark since 0412Z", 3)]

    row = _audit_rows()[0]
    assert row["params"]["table"] == "case_notes"
    assert row["params"]["payload_sha256"] == PAYLOAD_SHA
    assert "vessel dark since 0412Z" not in json.dumps(row)


def test_an_unknown_connection_is_a_404(client: TestClient) -> None:
    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "connection",
            "connection_id": "conn_nope",
            "table": "case_notes",
            "payload": {"a": 1},
        },
    )
    assert r.status_code == 404, r.text


def test_a_dry_run_against_a_connection_writes_nothing(
    client: TestClient, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    db = tmp_path / "erp2.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE case_notes (case_id TEXT, note TEXT, severity INTEGER)")
    con.commit()
    con.close()
    monkeypatch.setenv("OSINT_SQL_DSN_ERP2", f"sqlite:///{db}")
    conn = asyncio.run(
        FoundryStore(get_settings()).create_connection(
            name="erp-dry",
            kind="sql",
            dataset_id="ds_test",
            config={"dsn_env": "OSINT_SQL_DSN_ERP2", "query": "SELECT 1"},
        )
    )
    r = client.post(
        "/api/actions/writeback",
        json={
            "target": "connection",
            "connection_id": conn["id"],
            "table": "case_notes",
            "payload": PAYLOAD,
            "dry_run": True,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["detail"]["rows"] == 0
    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM case_notes").fetchone()[0] == 0
    con.close()


# ── the action is registered as operator-only ────────────────────────────────


def test_the_catalog_marks_writeback_operator_only(client: TestClient) -> None:
    catalog = {a["name"]: a for a in client.get("/api/actions").json()}
    assert catalog["writeback"]["operator_only"] is True
    assert catalog["flag_entity"]["operator_only"] is False
