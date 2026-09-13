"""The Telegram public-preview parser, against a body captured from t.me.

Fixture is a real t.me/s/Faytuks page (2026-08-21), not a hand-written one:
the 2026-08-06 mega-ledger wave shipped parsers written against imagined shapes
and had to be corrected three days later, which is why _feedgeo.cached and
degraded_fc exist at all. Write the parser test against a real body first.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.routes.mega_feeds import TELEGRAM_CHANNELS, _parse_telegram

_FIXTURE = Path(__file__).parent / "fixtures" / "telegram_faytuks.html"


@pytest.fixture(scope="module")
def html() -> str:
    return _FIXTURE.read_text(encoding="utf-8")


def test_parses_messages_from_a_real_body(html: str) -> None:
    msgs = _parse_telegram(html, "Faytuks", 50)
    assert len(msgs) >= 10, "the captured page carries well over ten messages"
    assert all(m["text"] for m in msgs), "a message with no text must be dropped"


def test_every_message_carries_a_permalink(html: str) -> None:
    """A scraped line a human cannot go and check is not an OSINT source."""
    msgs = _parse_telegram(html, "Faytuks", 50)
    assert all(m["url"].startswith("https://t.me/Faytuks/") for m in msgs)
    # data-post is per-message, so permalinks must be distinct.
    assert len({m["url"] for m in msgs}) == len(msgs)


def test_text_date_and_link_stay_aligned(html: str) -> None:
    """The bug the rewrite fixed.

    The previous parser gathered texts and <time> stamps into two flat lists and
    zipped them by index, so a photo-only message — or any <time> outside a
    message block — shifted every timestamp after it onto the wrong text. Parsing
    within one container per message makes that structurally impossible, and
    ascending permalink ids alongside non-decreasing timestamps is what proves
    the pairing held.
    """
    msgs = _parse_telegram(html, "Faytuks", 50)
    dated = [m for m in msgs if "datetime" in m]
    assert len(dated) >= 10
    ids = [int(m["url"].rsplit("/", 1)[1]) for m in dated]
    assert ids == sorted(ids), "permalink ids must stay in page order"
    stamps = [m["datetime"] for m in dated]
    assert stamps == sorted(stamps), "timestamps must ascend with the ids"


def test_limit_is_honoured(html: str) -> None:
    assert len(_parse_telegram(html, "Faytuks", 3)) == 3


def test_html_tags_are_stripped_but_line_breaks_survive(html: str) -> None:
    msgs = _parse_telegram(html, "Faytuks", 50)
    assert not any("<" in m["text"] and ">" in m["text"] for m in msgs)
    assert any("\n" in m["text"] for m in msgs), "<br> should become a newline"


def test_the_allowlist_grew_and_has_no_duplicates() -> None:
    """It is an allowlist, and it is the security boundary on this route.

    `channel` is interpolated straight into a t.me URL, so the 400 on an unknown
    value is what keeps this a scraper rather than a fetch-any-URL proxy. Every
    entry here was probed live and returned at least one message before it was
    added.
    """
    assert len(TELEGRAM_CHANNELS) == len(set(TELEGRAM_CHANNELS))
    assert len(TELEGRAM_CHANNELS) >= 19
    for original in ("intelslava", "clashreport", "PikudHaOref_all"):
        assert original in TELEGRAM_CHANNELS, "never drop a working channel"
    assert all(
        c and "/" not in c and ".." not in c for c in TELEGRAM_CHANNELS
    ), "a channel name must not be able to escape the t.me/s/<channel> path"
