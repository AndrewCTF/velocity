"""lod1 reaches Overpass through the shared IPv4-pinned httpx client (not stdlib
urllib) and still walks the mirror list when one throttles."""

from __future__ import annotations

import asyncio

import httpx

from app.intel import lod1


def test_overpass_uses_shared_client_and_falls_back(monkeypatch) -> None:
    calls: list[str] = []

    class _Client:
        async def post(self, url, **kw):  # type: ignore[no-untyped-def]
            calls.append(url)
            req = httpx.Request("POST", url)
            if len(calls) == 1:
                return httpx.Response(429, request=req)
            return httpx.Response(200, json={"elements": []}, request=req)

    async def _nosleep(_s: float) -> None:
        return None

    monkeypatch.setattr(lod1, "get_client", lambda: _Client())
    monkeypatch.setattr(lod1.asyncio, "sleep", _nosleep)
    out = asyncio.run(lod1._overpass_query("[out:json];"))
    assert out == {"elements": []}
    assert len(calls) == 2 and calls[0] != calls[1]
    assert "urllib" not in lod1.__dict__
