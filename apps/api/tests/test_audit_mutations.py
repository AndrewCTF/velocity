"""G15: every mutating route on the state-changing routers leaves an audit row,
and MCP tool calls are audited at their single dispatch point.

The guard walks the ROUTERS, not ``app.routes`` (an app-level walk passes
vacuously behind ``_IncludedRouter``; see test_security_hardening.py).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app import audit as audit_mod
from app.routes import ai_models, alert_rules, evidence, foundry, ingest, resolve, workflows

_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
_ROUTERS = {
    "workflows": workflows.router,
    "foundry": foundry.router,
    "evidence": evidence.router,
    "ai_models": ai_models.router,
    "ingest": ingest.router,
    "alert_rules": alert_rules.router,
    "resolve": resolve.router,
}


def _settle(until: Callable[[], bool] = lambda: not audit_mod._pending) -> None:
    """Audit runs as a background task on the TestClient's own loop thread;
    wait (bounded) for it instead of awaiting across loops."""
    deadline = time.monotonic() + 3
    while not until() and time.monotonic() < deadline:
        time.sleep(0.01)


def _dep_calls(route: APIRoute) -> set:
    seen, stack = set(), list(route.dependant.dependencies)
    while stack:
        d = stack.pop()
        seen.add(d.call)
        stack.extend(d.dependencies)
    return seen


def test_every_mutating_route_on_audited_routers_audits() -> None:
    missing, count = [], 0
    for name, router in _ROUTERS.items():
        for r in router.routes:
            if isinstance(r, APIRoute) and r.methods & _MUTATING:
                count += 1
                if audit_mod.audit_mutation not in _dep_calls(r):
                    missing.append(f"{name}: {sorted(r.methods)} {r.path}")
    assert count >= 50, count  # the walk really found the routes
    assert missing == []


def test_a_mutation_writes_an_audit_row(client: TestClient, monkeypatch) -> None:
    rows: list[tuple] = []

    async def _rec(ctx, action, resource_type, resource_id="", **kw):  # type: ignore[no-untyped-def]
        rows.append((ctx.user_id, action, resource_type, resource_id, kw.get("detail")))
        return True

    monkeypatch.setattr(audit_mod, "audit", _rec)
    r = client.delete("/api/alerts/rules/rule-123")
    assert r.status_code == 204
    _settle(lambda: bool(rows))
    assert rows, "no audit row for DELETE"
    user, action, rtype, rid, detail = rows[-1]
    assert action == "DELETE /api/alerts/rules/{rule_id}"
    assert rtype == "alerts" and rid == "rule-123" and user == "local"
    assert client.get("/api/alerts/rules").status_code == 200
    _settle()
    assert len(rows) == 1  # reads are not audited


def test_ingest_audit_never_records_the_token(client: TestClient, monkeypatch) -> None:
    rows: list[dict] = []

    async def _rec(ctx, action, resource_type, resource_id="", **kw):  # type: ignore[no-untyped-def]
        rows.append({"user": ctx.user_id, "token": ctx.token, "action": action, **kw})
        return True

    monkeypatch.setattr(audit_mod, "audit", _rec)
    client.post("/api/ingest/ds-1", json=[{"a": 1}], headers={"X-Ingest-Token": "SECRET-TOK"})
    _settle(lambda: bool(rows))
    assert rows and rows[-1]["user"] == "ingest"
    assert "SECRET-TOK" not in repr(rows)


def test_audit_never_blocks_the_request(client: TestClient, monkeypatch) -> None:
    async def _hang(*a, **k):  # type: ignore[no-untyped-def]
        await asyncio.sleep(3600)

    monkeypatch.setattr(audit_mod, "audit", _hang)
    t0 = time.monotonic()
    assert client.delete("/api/alerts/rules/x").status_code == 204
    assert time.monotonic() - t0 < 5


def test_mcp_tool_calls_are_audited(monkeypatch) -> None:
    from app import mcp_server

    rows: list[tuple] = []

    async def _rec(ctx, action, resource_type, resource_id="", **kw):  # type: ignore[no-untyped-def]
        rows.append((ctx.user_id, action, resource_type, resource_id, kw.get("detail")))
        return True

    monkeypatch.setattr(audit_mod, "audit", _rec)

    async def _run() -> None:
        # An unknown tool fails inside the tool manager with no network; the
        # audit row is written at dispatch, before that.
        with pytest.raises(Exception):  # noqa: B017, PT011
            await mcp_server.mcp.call_tool("no_such_tool", {"lat": 1})
        await asyncio.sleep(0)  # let the background audit task run
        await asyncio.gather(*audit_mod._pending)
        assert rows and rows[-1][1] == "mcp.tool no_such_tool"
        assert rows[-1][0] == "mcp" and rows[-1][4] == {"args": ["lat"]}

    asyncio.run(_run())


# ── opt-in READ auditing (audit_reads) ───────────────────────────────────────
#
# ``Settings.audit_reads`` (AUDIT_READS, off by default) extends this same seam
# to GET/HEAD on audited routers. The row names WHAT was read — method + route
# template, plus the NAMES of any path params — and never a param value or any
# query-string value (the MCP no-values rule). Each test below runs against a
# fresh local audit DB (the autouse ``_isolate_audit_db`` fixture) so "one row"
# means exactly one.


def test_get_writes_no_audit_row_when_reads_unaudited(client: TestClient, monkeypatch) -> None:
    """AUDIT_READS unset: a GET on an audited router leaves no audit row.

    This is the guard that keeps the write path byte-for-byte the default: with
    the flag off, a read never reaches the store at all.
    """
    from app.config import get_settings

    monkeypatch.delenv("AUDIT_READS", raising=False)
    get_settings.cache_clear()

    rows: list[tuple] = []

    async def _rec(ctx, action, resource_type, resource_id="", **kw):  # type: ignore[no-untyped-def]
        rows.append((ctx.user_id, action, resource_type, resource_id, kw.get("detail")))
        return True

    monkeypatch.setattr(audit_mod, "audit", _rec)
    assert client.get("/api/foundry/datasets").status_code == 200
    _settle()
    assert rows == [], f"GET wrote an audit row with audit_reads off: {rows}"


def test_get_writes_one_audit_row_when_reads_audited(client: TestClient, monkeypatch) -> None:
    """AUDIT_READS=1: a GET on an audited router writes exactly one row, named
    by method + route path, and the query-string VALUES are never recorded."""
    from app.config import get_settings

    monkeypatch.setenv("AUDIT_READS", "1")
    get_settings.cache_clear()

    qval = "zz-queryval-9f3a"
    r = client.get("/api/foundry/datasets", params={"limit": qval})
    assert r.status_code == 200
    _settle()

    rows = audit_mod.list_local_rows_sync(100)
    assert len(rows) == 1, f"expected exactly one audit row for the GET, got {len(rows)}"
    row = rows[0]
    assert row["action"] == "GET /api/foundry/datasets"
    assert row["user_id"] == "local"
    # No query-string value may ever reach the row.
    assert qval not in repr(row)


def test_get_audit_records_param_names_not_values(client: TestClient, monkeypatch) -> None:
    """The read row keeps the route TEMPLATE (so a param value never leaks into
    the action) and records the path-param NAMES, never their values — the same
    no-values rule the MCP tool-call audit applies to its args."""
    from app.config import get_settings

    monkeypatch.setenv("AUDIT_READS", "1")
    get_settings.cache_clear()

    idval = "zz-dataset-7c21"
    qval = "zz-queryval-4b1d"
    # An unknown dataset 404s inside the handler; the router dependency writes
    # the audit row BEFORE the handler, so the row exists regardless of outcome.
    client.get(f"/api/foundry/datasets/{idval}", params={"limit": qval})
    _settle()

    rows = audit_mod.list_local_rows_sync(100)
    assert len(rows) == 1, f"expected exactly one audit row, got {len(rows)}"
    row = rows[0]
    assert row["action"] == "GET /api/foundry/datasets/{dataset_id}"
    # Names, not values: the param NAME is recorded, its value and any query
    # value are not.
    assert row["params"] == {"path_params": ["dataset_id"]}
    assert idval not in repr(row)
    assert qval not in repr(row)


def test_read_audit_chain_still_verifies(client: TestClient, monkeypatch) -> None:
    """A row written for a GET joins the local hash chain; /api/audit/verify
    still reports the chain intact."""
    from app.config import get_settings

    monkeypatch.setenv("AUDIT_READS", "1")
    get_settings.cache_clear()

    client.get("/api/foundry/datasets", params={"limit": "zz-chain-1111"})
    _settle()
    r = client.get("/api/audit/verify")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True, body
