"""CelesTrak answers a repeat pull inside its 2h window with 403, not 304.

Body, captured live 2026-08-21:

    GP data has not updated since your last successful download of
    GROUP=active at 2026-08-21 13:05:49 UTC. Data is updated once every
    2 hours.

Keyed by (source IP, GROUP). routes/space.py used to turn that into
HTTPException(502) and the satellite layer went empty. Because the 2h TtlCache
lives in the process, every restart re-pulled into a guaranteed 403 for the rest
of the window — the real mechanism behind the "restart the backend ONCE and
wait" note in /CLAUDE.md, which had been attributed to burst rate-limiting.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from app import upstream
from app.routes import space

_BODY = (
    "GP data has not updated since your last successful download of "
    "GROUP=active at 2026-08-21 13:05:49 UTC. Data is updated once every "
    "2 hours."
)

_TLE = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   26233.54791667  .00016717  00000-0  10270-3 0  9007\n"
    "2 25544  51.6392 339.1516 0004115  84.1516 276.0000 15.49309620    07\n"
)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Point the disk cache at a tmp dir and clear the in-process caches."""
    monkeypatch.setattr(space, "_disk_path", lambda g: tmp_path / f"{g}.tle")
    upstream.cache.invalidate("celestrak:active")
    upstream._SOURCES.clear()
    yield
    upstream.cache.invalidate("celestrak:active")
    upstream._SOURCES.clear()


def _client(handler):
    return upstream._InstrumentedClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_not_modified_serves_last_good_across_a_restart(monkeypatch) -> None:
    """The case the fix exists for: warm, drop the process cache, pull again."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(200, text=_TLE)
        return httpx.Response(403, text=_BODY)

    client = _client(handler)
    monkeypatch.setattr(upstream, "_CLIENT", client)
    try:
        first = await space.gp(group="active", limit=10)
        assert first["count"] == 1
        assert first.get("stale") is not True

        # Exactly what a restart does: the in-process TTL cache is gone, the
        # disk copy is not.
        upstream.cache.invalidate("celestrak:active")

        second = await space.gp(group="active", limit=10)
    finally:
        await client.aclose()

    assert second["count"] == 1, "a restart inside the 2h window must not empty the layer"
    assert second["stale"] is True
    assert second["age_s"] >= 0
    assert second["items"][0]["OBJECT_NAME"] == "ISS (ZARYA)"


@pytest.mark.asyncio
async def test_not_modified_reads_ok_in_the_health_registry(monkeypatch) -> None:
    """send() books a failure on the 403; serving last-good flips it back to ok.

    The fail counter still moves, which is honest about the wire, but the state
    must not say `failing` for a host that told us we are up to date.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text=_BODY)

    (space._disk_path("active")).write_text(_TLE, encoding="utf-8")
    client = _client(handler)
    monkeypatch.setattr(upstream, "_CLIENT", client)
    try:
        out = await space.gp(group="active", limit=10)
    finally:
        await client.aclose()

    assert out["count"] == 1
    row = {r["host"]: r for r in upstream.source_health()}["celestrak.org"]
    assert row["state"] == "ok"
    assert row["last_status"] == 304, "report it as the 304 it actually is"
    assert row["fail"] == 1, "the wire really did answer 403; do not hide that"


@pytest.mark.asyncio
async def test_a_real_403_still_fails(monkeypatch) -> None:
    """Only the not-modified body is special. Any other 403 is a refusal."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="Forbidden")

    (space._disk_path("active")).write_text(_TLE, encoding="utf-8")
    client = _client(handler)
    monkeypatch.setattr(upstream, "_CLIENT", client)
    try:
        with pytest.raises(HTTPException) as err:
            await space.gp(group="active", limit=10)
    finally:
        await client.aclose()
    assert err.value.status_code == 502


@pytest.mark.asyncio
async def test_not_modified_with_no_disk_copy_still_502s(monkeypatch) -> None:
    """Never invent data. No last-good means the honest answer is still 502."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text=_BODY)

    client = _client(handler)
    monkeypatch.setattr(upstream, "_CLIENT", client)
    try:
        with pytest.raises(HTTPException):
            await space.gp(group="active", limit=10)
    finally:
        await client.aclose()
