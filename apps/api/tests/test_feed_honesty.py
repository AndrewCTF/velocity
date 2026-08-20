"""A feed may be empty. It may not be empty and silent about why.

The 2026-08-20 route sweep (docs/audits/2026-08-20-api-sweep.md) swept 207 GET
routes and found 17 answering HTTP 200 with an empty body, with nothing in the
process able to say which had a dead upstream behind them. These guards hold the
three pieces that fixed that: the registry records failures, the layer that can
see a semantic failure reports it, and the list of what is NOT measured stays
true.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from app import upstream
from app.routes import _feedgeo as fg


@pytest.fixture(autouse=True)
def _clean_registry():
    upstream._SOURCES.clear()
    yield
    upstream._SOURCES.clear()


def _client(handler) -> upstream._InstrumentedClient:
    """The REAL instrumented client over a mock transport.

    Deliberately not a mock client object: ~20 tests in this suite replace
    upstream._CLIENT wholesale, and a client swapped for a mock carries no
    instrumentation, so a guard built that way would pass against code that
    records nothing. The transport is mocked; the class under test is not, and
    no network is touched.
    """
    return upstream._InstrumentedClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_connect_error_is_recorded() -> None:
    """The case that chose this design.

    An httpx *response hook* fires only after the request succeeds, so
    ConnectError / ReadTimeout never reach it and a hook-based registry would
    read green exactly when an upstream is unreachable. Capturing in send()
    is what makes this test possible at all.
    """

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope", request=request)

    async with _client(boom) as c:
        with pytest.raises(httpx.ConnectError):
            await c.get("https://dead.example/feed.json")

    rows = {r["host"]: r for r in upstream.source_health()}
    assert rows["dead.example"]["state"] == "failing"
    assert rows["dead.example"]["fail"] == 1
    assert "ConnectError" in rows["dead.example"]["last_error"]


@pytest.mark.asyncio
async def test_success_and_http_error_are_distinguished() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        code = 403 if "blocked" in str(request.url) else 200
        return httpx.Response(code, json={"ok": True})

    async with _client(handler) as c:
        await c.get("https://good.example/a.json")
        await c.get("https://blocked.example/a.json")

    rows = {r["host"]: r for r in upstream.source_health()}
    assert rows["good.example"]["state"] == "ok"
    assert rows["good.example"]["latency_ms"] is not None
    assert rows["blocked.example"]["state"] == "failing"
    assert rows["blocked.example"]["last_status"] == 403


def test_never_attempted_is_not_healthy() -> None:
    """'unknown' is a third state. Conflating it with green is the defect
    /api/status carried for two hardcoded feeds and four key-presence checks."""
    upstream._source_row("never.example")
    row = next(r for r in upstream.source_health() if r["host"] == "never.example")
    assert row["state"] == "unknown"
    assert row["last_success"] is None


def test_registry_is_bounded() -> None:
    """Host keys are attacker-influenceable through any route that fetches a
    user-supplied URL, so the dict cannot grow without limit."""
    for i in range(upstream._MAX_SOURCE_HOSTS + 50):
        upstream._source_row(f"h{i}.example")
    assert len(upstream._SOURCES) <= upstream._MAX_SOURCE_HOSTS


@pytest.mark.asyncio
async def test_200_with_a_non_json_body_is_recorded_as_a_failure(monkeypatch) -> None:
    """The failure no client-level capture point can see.

    airplanes.live throttles with HTTP 200 + text/plain. On the wire that is a
    success, so the registry would go green at the exact moment the feed dies
    its most common death. _feedgeo is the layer that knows better.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="rate limited, try later")

    c = _client(handler)
    monkeypatch.setattr(fg, "get_client", lambda: c)
    with pytest.raises(HTTPException) as exc:
        await fg.fetch_json("https://throttled.example/data.json")
    assert exc.value.status_code == 502
    await c.aclose()

    rows = {r["host"]: r for r in upstream.source_health()}
    assert rows["throttled.example"]["state"] == "failing"
    assert "non-JSON" in rows["throttled.example"]["last_error"]


# ── anti-rot guards ──────────────────────────────────────────────────────────
#
# The two claims this work makes are "we measure our upstreams" and "an empty
# feed says why". Both rot the moment someone adds a client or a swallow without
# reading this file, and both rot INVISIBLY -- the product keeps working and
# just stops being honest. These fail loudly instead.

import ast  # noqa: E402
import pathlib  # noqa: E402
import re  # noqa: E402

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# Ad-hoc clients that talk to LOCALHOST sidecars. They are covered by the
# sidecar rows in /api/status and are not external sources, so they do not
# belong in the unmeasured list.
_LOCALHOST_CLIENTS = {
    "adsb_sidecar.py", "ais_sidecar.py", "browser_fetch.py", "llamacpp_sidecar.py",
    "vllm_sidecar.py", "mavlink_sidecar.py", "routes/ai_models.py",
}


def test_unmeasured_list_matches_the_tree() -> None:
    """Every external upstream that builds its own httpx client is declared.

    /api/status/sources can only see calls through the shared client. A client
    added elsewhere and left off the unmeasured list makes that endpoint quietly
    incomplete, which is the same overclaim it was built to end.
    """
    from app.routes.status import _UNMEASURED

    declared = {w.rsplit(":", 1)[0] for w, _ in _UNMEASURED}
    found: set[str] = set()
    for f in sorted(APP.rglob("*.py")):
        rel = str(f.relative_to(APP))
        if rel == "upstream.py" or rel in _LOCALHOST_CLIENTS:
            continue
        if re.search(r"httpx\.(Async)?Client\(", f.read_text()):
            found.add(rel)
    missing = found - declared
    assert not missing, (
        "these build their own httpx client and are invisible to "
        f"/api/status/sources, but are not declared in _UNMEASURED: {sorted(missing)}"
    )
    stale = declared - found
    assert not stale, f"_UNMEASURED names files with no httpx client any more: {sorted(stale)}"


# Broad handlers around a _feedgeo fetch that deliberately do NOT state a reason,
# and why. Adding a line here is a decision: it says an operator seeing this
# route empty does not need to know whether it was asked.
_SILENT_OK: dict[str, str] = {
    "routes/spacewx.py": "three NOAA sub-feeds merged into one collection; any one "
                         "failing must not 502 the other two, and the route has no "
                         "per-sub-feed slot to report into",
}


def test_a_swallowed_feed_failure_states_a_reason() -> None:
    """An empty layer and an unasked layer must not look identical.

    The 2026-08-20 sweep found 17 routes answering 200 with an empty body. This
    holds the ones fed by _feedgeo to the `degraded`/`note` shape the codebase
    already uses (routes/events.py), so they land in the sweep's `200-degraded`
    bucket rather than `200-empty`.
    """
    offenders: list[str] = []
    for f in sorted(APP.rglob("*.py")):
        rel = str(f.relative_to(APP))
        if rel in _SILENT_OK:
            continue
        src = f.read_text()
        try:
            tree = ast.parse(src)
        except SyntaxError:  # pragma: no cover
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Try):
                continue
            called = {
                c.func.attr for c in ast.walk(node)
                if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute)
            }
            if not ({"fetch_json", "fetch_text"} & called):
                continue
            for h in node.handlers:
                if not (isinstance(h.type, ast.Name)
                        and h.type.id in ("Exception", "BaseException")):
                    continue
                body = ast.unparse(ast.Module(body=h.body, type_ignores=[]))
                honest = (
                    "degraded" in body or "note" in body or "error" in body
                    or "raise" in body
                )
                if not honest:
                    offenders.append(f"{rel}:{h.lineno}")
    assert not offenders, (
        "these swallow an upstream failure and answer empty without saying so. "
        "Use fg.degraded_fc(...) / fg.degraded(...), re-raise, or record an "
        f"exception in _SILENT_OK with the reason: {offenders}"
    )
