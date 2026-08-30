"""/api/audit must be readable on the deployment that actually writes the log.

The route 503'd whenever ``supabase_url`` was unset and read Supabase
PostgREST. But ``intel/action_log_local.py`` exists precisely BECAUSE a keyless
boot used to 502 on the final step of every governed action, and
``intel/actions.py`` writes every one of them to ``./data/action_log.db``. So
on the default keyless deployment the platform dutifully audited every action
into a file that no route could open.

"An unaudited action must not silently succeed" held. "An operator can see what
the system did" did not.
"""

from __future__ import annotations

import pytest

from app.intel import action_log_local


@pytest.fixture()
def _local_log(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """Point the local action log at a scratch DB so a test never reads or
    writes the operator's real ./data/action_log.db."""
    action_log_local.override_db_path(str(tmp_path / "action_log.db"))
    yield
    action_log_local.override_db_path(None)


async def _append(action: str, target: str, ts: str) -> None:
    await action_log_local.append_row(
        {"user_id": "local", "action": action, "target_id": target, "params": {}, "ts": ts}
    )


def test_a_keyless_deployment_can_read_its_own_audit_log(client, _local_log) -> None:
    import anyio

    anyio.run(_append, "vessel.flag", "vessel:123", "2026-08-30T10:00:00Z")
    anyio.run(_append, "case.export", "situation:abc", "2026-08-30T11:00:00Z")

    r = client.get("/api/audit")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [row["action"] for row in rows] == ["case.export", "vessel.flag"], rows
    assert rows[0]["target_id"] == "situation:abc"


def test_it_no_longer_503s_without_supabase(client, _local_log) -> None:
    """The exact regression: an empty log is an empty list, not an outage."""
    r = client.get("/api/audit")
    assert r.status_code == 200
    assert r.json() == []


def test_since_filters_the_local_rows(client, _local_log) -> None:
    import anyio

    anyio.run(_append, "old", "x:1", "2026-08-29T10:00:00Z")
    anyio.run(_append, "new", "x:2", "2026-08-30T10:00:00Z")

    r = client.get("/api/audit?since=2026-08-30T00:00:00Z")
    assert r.status_code == 200
    assert [row["action"] for row in r.json()] == ["new"]


def test_limit_is_still_bounded(client, _local_log) -> None:
    r = client.get("/api/audit?limit=5000")
    assert r.status_code == 422, "the list-route limit bound must survive the rewrite"
