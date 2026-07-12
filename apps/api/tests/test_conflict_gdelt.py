"""Guards for /api/conflict/live (GDELT slices, keyless honest degrade)."""

from __future__ import annotations

import asyncio

import httpx

from app.intel import conflict


def test_fetch_slice_swallows_httpx_error(monkeypatch):
    # A transport error on one 15-min slice must not propagate — the load()
    # gather is unguarded, so a raised httpx.HTTPError would 500 the layer.
    class _Boom:
        async def get(self, *a, **k):
            raise httpx.ConnectError("boom")

    monkeypatch.setattr(conflict, "get_client", lambda: _Boom())
    out = asyncio.run(conflict._fetch_slice("20260101000000"))
    assert out == []
