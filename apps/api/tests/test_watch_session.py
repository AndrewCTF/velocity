"""``/api/alerts/watch-session`` — the authed handoff that makes the geofence
evaluator (``intel.watch``) live without a service-role key.

The background evaluator has no request of its own, so it cannot forge a token
for its per-user RLS reads (``alert_rules`` / ``objects`` / ``links``). This
route is the bridge: a signed-in browser POSTs here so its Supabase access
token is captured into ``watch._SESSIONS``; the loop then sweeps that registry
and reads each session's rules with the caller's own token (RLS-scoped). These
tests pin the contract WITHOUT a live Supabase or network — the upstream is
mocked / the route's effect on the in-process registry is asserted directly:

  - keyless (no Supabase configured, the default test posture) both verbs
    degrade to the shared ``local`` identity via ``current_user_or_local``
    instead of a dead 401 — same predicate ``routes/alert_rules.py`` uses,
  - with Supabase configured both verbs still require a signed-in user,
  - POST registers the caller's id+token into the evaluator's session registry,
  - POST is idempotent on ``user_id`` and REFRESHES the stored token (the
    periodic re-POST is what keeps a long-lived tab's token from going stale),
  - DELETE drops the session, and is idempotent (an already-absent session is a
    no-op, still ``ok``),
  - the honest caveat is exercised: a stale/expired token left in the registry
    makes the loop's reads 401 → ``_list_enabled_rules`` returns ``[]`` so the
    session evaluates to ZERO firings (goes quiet, never crashes) — it stays
    registered until the next re-POST refreshes it or the DELETE removes it.

Also covers ``GET /api/alerts/standing`` (the level-view read path next to this
same write path), which shares the identical ``current_user_or_local`` gate.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import keys as keys_mod
from app.config import Settings
from app.intel import watch
from app.keys import UserCtx, current_user_or_local
from app.routes import alerts as alerts_mod


@pytest.fixture(autouse=True)
def _clean_registry() -> None:
    """Each test starts and ends with an empty session registry."""
    watch._SESSIONS.clear()
    watch.reset_state()
    yield
    watch._SESSIONS.clear()
    watch.reset_state()


# A mutable holder so a test can change the identity/token the route's
# ``current_user_or_local`` dependency resolves to between calls (mirrors a
# browser re-POSTing with a rotated access token).
_CALLER = {"user_id": "u1", "token": "tok-1"}


def _fake_user() -> UserCtx:
    return UserCtx(_CALLER["user_id"], _CALLER["token"])


def _configure_supabase(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same helper as ``test_alert_rules.py::_configure_supabase`` — patch the
    name each module actually calls (``get_settings`` is memoized) so exactly
    this test sees Supabase as configured and ``current_user_or_local`` stops
    degrading to the shared ``local`` identity.
    """
    fake = Settings(supabase_url="http://x", supabase_anon_key="anon")
    monkeypatch.setattr(keys_mod, "get_settings", lambda: fake)
    monkeypatch.setattr(alerts_mod, "get_settings", lambda: fake)


# ── auth gate ───────────────────────────────────────────────────────────────────


def test_watch_session_keyless_local_identity(client: TestClient) -> None:
    # No Supabase configured (default test settings) → current_user_or_local
    # degrades to the shared "local" identity instead of a dead 401 — same
    # contract test_alert_rules.py asserts for the rule-CRUD routes.
    r = client.post("/api/alerts/watch-session")
    assert r.status_code == 200
    assert [c.user_id for c in watch.active_sessions()] == ["local"]

    r = client.delete("/api/alerts/watch-session")
    assert r.status_code == 200
    assert watch.active_sessions() == []


def test_watch_session_requires_auth_when_supabase_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure_supabase(monkeypatch)
    # No signed-in user and Supabase IS configured: current_user_or_local falls
    # through to current_user's strict token check, for BOTH verbs.
    assert client.post("/api/alerts/watch-session").status_code == 401
    assert client.delete("/api/alerts/watch-session").status_code == 401
    # …and nothing leaked into the registry.
    assert watch.active_sessions() == []


# ── POST registers the caller's token for the loop's RLS reads ───────────────────


def test_post_registers_caller_token(client: TestClient) -> None:
    _CALLER.update(user_id="u1", token="tok-1")
    client.app.dependency_overrides[current_user_or_local] = _fake_user
    try:
        r = client.post("/api/alerts/watch-session")
        assert r.status_code == 200
        assert r.json() == {"ok": True, "active_sessions": 1}
        # The caller's id+token are now visible to the evaluator — this is the
        # exact ctx the background loop will use for that user's RLS reads.
        sessions = watch.active_sessions()
        assert [c.user_id for c in sessions] == ["u1"]
        assert sessions[0].token == "tok-1"
    finally:
        client.app.dependency_overrides.pop(current_user_or_local, None)


def test_post_is_idempotent_and_refreshes_token(client: TestClient) -> None:
    # The frontend re-POSTs on an interval; each re-POST must REFRESH the stored
    # token (so it never goes stale) WITHOUT duplicating the session. This is the
    # mechanism that keeps a long-lived tab's reads from 401ing as the token
    # rotates — register_session is idempotent on user_id.
    client.app.dependency_overrides[current_user_or_local] = _fake_user
    try:
        _CALLER.update(user_id="u1", token="tok-1")
        client.post("/api/alerts/watch-session")
        # same user signs back with a rotated token (refresh in flight)
        _CALLER.update(user_id="u1", token="tok-2")
        r = client.post("/api/alerts/watch-session")
        assert r.json()["active_sessions"] == 1  # not duplicated
        sessions = watch.active_sessions()
        assert len(sessions) == 1
        assert sessions[0].token == "tok-2"  # refreshed, not stale
    finally:
        client.app.dependency_overrides.pop(current_user_or_local, None)


# ── DELETE drops the caller's session (idempotent) ───────────────────────────────


def test_delete_unregisters_caller_session(client: TestClient) -> None:
    _CALLER.update(user_id="u1", token="tok-1")
    client.app.dependency_overrides[current_user_or_local] = _fake_user
    try:
        client.post("/api/alerts/watch-session")
        assert len(watch.active_sessions()) == 1

        r = client.delete("/api/alerts/watch-session")
        assert r.status_code == 200
        assert r.json() == {"ok": True, "active_sessions": 0}
        assert watch.active_sessions() == []

        # Idempotent: deleting an already-absent session is a clean no-op (the
        # tab-close DELETE may race the loop / a prior delete).
        r2 = client.delete("/api/alerts/watch-session")
        assert r2.status_code == 200
        assert r2.json()["active_sessions"] == 0
    finally:
        client.app.dependency_overrides.pop(current_user_or_local, None)


def test_only_callers_own_session_is_dropped(client: TestClient) -> None:
    # DELETE keys on the caller's own user_id, so one user signing out must not
    # evict another user's still-live session from the shared registry.
    watch.register_session(UserCtx("other", "tok-other"))
    _CALLER.update(user_id="u1", token="tok-1")
    client.app.dependency_overrides[current_user_or_local] = _fake_user
    try:
        client.post("/api/alerts/watch-session")
        assert {c.user_id for c in watch.active_sessions()} == {"u1", "other"}
        client.delete("/api/alerts/watch-session")
        # only u1 left the registry; 'other' is untouched
        assert [c.user_id for c in watch.active_sessions()] == ["other"]
    finally:
        client.app.dependency_overrides.pop(current_user_or_local, None)


# ── GET /api/alerts/standing — same keyless contract as the write path above ─────


def test_standing_detections_keyless_local_identity(client: TestClient) -> None:
    # No Supabase configured: the LEVEL-view read path must be reachable with
    # no browser ever having signed in, exactly like the rule-CRUD routes —
    # this was the gap (write path keyless, read path hard-401) the persona
    # report caught.
    r = client.get("/api/alerts/standing")
    assert r.status_code == 200
    body = r.json()
    assert body == {"detections": [], "counts": {}, "as_of": body["as_of"]}


def test_standing_detections_requires_auth_when_supabase_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure_supabase(monkeypatch)
    assert client.get("/api/alerts/standing").status_code == 401


# ── honest caveat: a stale/expired token goes quiet, it does not crash ───────────


class _ExpiredTokenResp:
    """PostgREST's answer when the bearer token has expired — RLS denies it."""

    status_code = 401

    def json(self) -> object:  # pragma: no cover - not reached on a 401 path
        return {"message": "JWT expired"}


class _ExpiredTokenClient:
    """Stands in for httpx: every request comes back 401 (expired token)."""

    async def __aenter__(self) -> _ExpiredTokenClient:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def get(self, *a: object, **k: object) -> _ExpiredTokenResp:
        return _ExpiredTokenResp()


def _settings_with_supabase() -> Settings:
    # A configured store, so _list_enabled_rules actually attempts the read (and
    # thus hits the 401) rather than short-circuiting on a missing supabase_url.
    return Settings(supabase_url="http://x", supabase_anon_key="anon")


def test_stale_token_session_goes_quiet_not_crash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The caveat from the route docstring, made concrete: a session whose stored
    # token has since expired stays in the registry, but the loop's RLS read for
    # it 401s. _list_enabled_rules swallows that (returns []), so evaluate_session
    # produces ZERO firings — no exception escapes to stall the sweep. The fix for
    # the staleness is the periodic re-POST (refresh) or the unmount DELETE; until
    # then the session is simply silent.
    monkeypatch.setattr(watch, "_client", lambda: _ExpiredTokenClient())
    cand = watch._Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")

    fired = asyncio.run(
        watch.evaluate_session(
            UserCtx("stale", "expired-token"), _settings_with_supabase(), [cand]
        )
    )
    assert fired == 0  # quiet, not crashed


def test_evaluate_all_isolates_a_stale_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # End to end through the sweep: a registered session with a dead token must
    # not take down evaluate_all(). With no snapshot/brief reachable in the test
    # app (background disabled), the sweep still returns cleanly (0 firings).
    monkeypatch.setattr(watch, "_client", lambda: _ExpiredTokenClient())
    watch.register_session(UserCtx("stale", "expired-token"))

    async def _patched_snapshot() -> dict:
        return {"features": []}

    async def _patched_brief(*a: object, **k: object) -> dict:
        return {"incidents": []}

    # global_snapshot is imported lazily inside evaluate_all; patch the module
    # attribute the lazy import resolves to. brief() is reached via the module's
    # ``incidents`` import — patch both so the sweep stays hermetic (no fan-out).
    from app.intel import incidents as incidents_mod
    from app.routes import adsb as adsb_routes

    monkeypatch.setattr(adsb_routes, "global_snapshot", _patched_snapshot)
    monkeypatch.setattr(incidents_mod, "brief", _patched_brief)

    total = asyncio.run(watch.evaluate_all())
    assert total == 0
    # the stale session is still registered (only a re-POST refresh or DELETE
    # removes it) — the loop just read nothing for it
    assert [c.user_id for c in watch.active_sessions()] == ["stale"]
