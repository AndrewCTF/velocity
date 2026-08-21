"""The browser tier's first production callers.

tools/browser-fetch (:8095) was built, supervised, selftested and — until
2026-08-21 — called by nothing: `grep 'browser_fetch.fetch('` found only the
definition. These guards hold the wiring that gave it a job.

Measured that day, from the dev egress, over the seven register feeds that
answered httpx with 403:

    en.mercopress.com      httpx 403 -> browser 200, 10 items   -> flagged
    tass.com               httpx 403 -> browser 200, 100 items  -> flagged
    riotimesonline.com     httpx 403 -> browser 200, 0 items    -> not flagged
    tvn24.pl               httpx 403 -> browser 403 (headful too)
    dawn.com               httpx 403 -> browser 403 (headful too)
    politico.eu            httpx 403 -> browser 403 (headful too)
    washingtontimes.com    httpx 403 -> browser 403 (headful too)

The last four are the address-level case that no tier opens. Flagging them
anyway would spend a browser launch per feed per cycle to re-learn a permanent
no — which is the auto-escalation ladder rejected on 2026-08-01.
"""

from __future__ import annotations

import httpx
import pytest

from app.news import sources as S
from app.news.feeds_register import REGISTER

_RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel>
<title>T</title><item><title>Headline</title><link>https://e.example/1</link>
<description>d</description></item></channel></rss>"""


def test_only_measured_hosts_carry_the_browser_flag() -> None:
    flagged = sorted(s.name for s in REGISTER if s.browser)
    assert flagged == ["MercoPress", "TASS"], (
        "the flag is set from a measurement, not from hope — re-probe with "
        "tools/browser-fetch before adding to this list"
    )


def test_the_flag_defaults_off() -> None:
    """A new Source must never opt into a browser launch by accident."""
    assert S.Source("X", "https://x.example/f", "center", "XX").browser is False


@pytest.mark.asyncio
async def test_a_flagged_feed_goes_through_the_browser_not_httpx(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_browser(url, **kw):
        calls.append(f"browser:{url}")
        return httpx.Response(200, content=_RSS)

    def no_httpx():
        raise AssertionError("a flagged feed must not touch the httpx client")

    monkeypatch.setattr("app.browser_fetch.fetch", fake_browser)
    monkeypatch.setattr(S, "get_client", no_httpx)

    src = S.Source("MercoPress", "https://en.mercopress.com/rss/", "center", "SA", browser=True)
    arts = await S._fetch_one(src, 10.0)

    assert calls == ["browser:https://en.mercopress.com/rss/"]
    assert [a.title for a in arts] == ["Headline"]


@pytest.mark.asyncio
async def test_an_unflagged_feed_never_starts_a_browser(monkeypatch) -> None:
    async def boom(url, **kw):
        raise AssertionError("plain feeds must stay on httpx")

    monkeypatch.setattr("app.browser_fetch.fetch", boom)
    monkeypatch.setattr(
        S, "get_client",
        lambda: type("C", (), {"get": staticmethod(
            lambda *a, **k: _resp())})(),
    )

    async def _resp():
        return httpx.Response(200, content=_RSS)

    src = S.Source("Plain", "https://plain.example/rss", "center", "XX")
    arts = await S._fetch_one(src, 10.0)
    assert [a.title for a in arts] == ["Headline"]


@pytest.mark.asyncio
async def test_the_tier_being_off_degrades_to_an_empty_feed(monkeypatch) -> None:
    """browser_fetch.fetch returns None when the tier is disabled.

    That must read as "this feed contributed nothing this cycle" — the same
    outcome a 403 produced before — and never as an exception that takes the
    whole batch down.
    """

    async def off(url, **kw):
        return None

    monkeypatch.setattr("app.browser_fetch.fetch", off)
    src = S.Source("TASS", "https://tass.com/rss/v2.xml", "ru-state", "RU", browser=True)
    assert await S._fetch_one(src, 10.0) == []


@pytest.mark.asyncio
async def test_a_browser_403_is_not_parsed_as_a_feed(monkeypatch) -> None:
    """Four of the seven still 403 through Chrome; their block page is not news."""

    async def blocked(url, **kw):
        return httpx.Response(403, content=b"<html>Attention Required</html>")

    monkeypatch.setattr("app.browser_fetch.fetch", blocked)
    src = S.Source("Politico EU", "https://www.politico.eu/feed/", "center", "EU", browser=True)
    assert await S._fetch_one(src, 10.0) == []
