"""Unit tests for `app/osint/sources/video.py` — no live network.

The finding this connector exists to produce is the three-way one: live, gone
but provably real (the thumbnail still serves), and never there. A test that
only checked "found true/false" would not notice the middle case collapsing.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.osint.sources import video as V

_LIVE_OEMBED = {
    "title": "Rick Astley - Never Gonna Give You Up",
    "author_name": "Rick Astley",
    "author_url": "https://www.youtube.com/@RickAstleyYT",
    "provider_name": "YouTube",
}


class _Resp:
    def __init__(self, status: int, body: Any = None, content: bytes = b"") -> None:
        self.status_code = status
        self._body = body
        self.content = content

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("no json")
        return self._body


def _patch(monkeypatch: pytest.MonkeyPatch, table: dict[str, _Resp]):  # type: ignore[no-untyped-def]
    """Route by url fragment: oembed vs each thumbnail size."""

    class C:
        seen: list[str] = []

        async def get(self, url: str, **kw: object) -> _Resp:
            C.seen.append(url)
            for frag, resp in table.items():
                if frag in url:
                    if isinstance(resp, Exception):
                        raise resp
                    return resp
            return _Resp(404)

    c = C()
    C.seen = []
    monkeypatch.setattr(V, "get_client", lambda: c)
    return C


# ── id extraction ─────────────────────────────────────────────────────────


def test_youtube_id_from_every_url_shape() -> None:
    assert V.youtube_id("dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert V.youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s") == "dQw4w9WgXcQ"
    assert V.youtube_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert V.youtube_id("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert V.youtube_id("https://www.youtube.com/embed/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert V.youtube_id("https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert V.youtube_id("https://example.com/nothing") is None
    assert V.youtube_id("short") is None


# ── the three outcomes ────────────────────────────────────────────────────


async def test_live_video(monkeypatch) -> None:
    _patch(monkeypatch, {
        "oembed": _Resp(200, _LIVE_OEMBED),
        "maxresdefault": _Resp(200, content=b"x" * 20000),
    })
    out = await V.youtube_video("https://youtu.be/dQw4w9WgXcQ")
    assert out["checked"] is True and out["found"] is True
    assert out["title"].startswith("Rick Astley")
    assert out["channel"] == "Rick Astley"
    assert out["thumbnail_exists"] is True
    assert out["thumbnail_url"].endswith("maxresdefault.jpg")
    assert "status" not in out


async def test_removed_but_the_thumbnail_proves_it_existed(monkeypatch) -> None:
    _patch(monkeypatch, {
        "oembed": _Resp(400),
        "maxresdefault": _Resp(404, content=b"x" * 1097),   # the grey placeholder
        "hqdefault": _Resp(200, content=b"x" * 18000),
    })
    out = await V.youtube_video("dQw4w9WgXcQ")
    assert out["checked"] is True and out["found"] is False
    assert out["thumbnail_exists"] is True
    assert "still serves" in out["status"]
    assert out["thumbnail_url"].endswith("hqdefault.jpg")


async def test_never_existed(monkeypatch) -> None:
    _patch(monkeypatch, {"oembed": _Resp(400), "img.youtube.com": _Resp(404, content=b"x" * 900)})
    out = await V.youtube_video("ZZZZZZZZZZZ")
    assert out["checked"] is True and out["found"] is False
    assert out["thumbnail_exists"] is False
    assert "never public" in out["status"]
    # The url is still returned: it is the input to the reverse-image pivots.
    assert out["thumbnail_url"]


async def test_a_200_placeholder_does_not_count_as_a_thumbnail(monkeypatch) -> None:
    # If the CDN starts 200-ing its grey placeholder, size is the only thing
    # left that tells a real thumbnail from it.
    _patch(monkeypatch, {"oembed": _Resp(400), "img.youtube.com": _Resp(200, content=b"x" * 900)})
    out = await V.youtube_video("ZZZZZZZZZZZ")
    assert out["thumbnail_exists"] is False


async def test_total_outage_is_not_a_finding(monkeypatch) -> None:
    _patch(monkeypatch, {"": RuntimeError("dns")})
    monkeypatch.setattr(V, "get_client", lambda: _Boom())
    out = await V.youtube_video("dQw4w9WgXcQ")
    assert out["checked"] is False and out["found"] is False
    assert out["note"]


class _Boom:
    async def get(self, url: str, **kw: object) -> None:
        raise RuntimeError("network down")


async def test_invalid_target_never_fetches(monkeypatch) -> None:
    monkeypatch.setattr(V, "get_client", lambda: _Boom())
    out = await V.youtube_video("https://example.com/not-a-video")
    assert out["checked"] is False and "not a YouTube" in out["note"]
