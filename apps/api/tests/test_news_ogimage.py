# apps/api/tests/test_news_ogimage.py
import asyncio

from app.news.images import _is_public_url, fetch_og_image, parse_og_image


def test_parse_og_image_property():
    html = '<head><meta property="og:image" content="https://i.ex/x.jpg"></head>'
    assert parse_og_image(html) == "https://i.ex/x.jpg"

def test_parse_twitter_image_fallback():
    html = '<meta name="twitter:image" content="https://i.ex/t.png">'
    assert parse_og_image(html) == "https://i.ex/t.png"

def test_parse_none():
    assert parse_og_image("<html><body>no meta</body></html>") == ""


# ── SSRF guard (offline: literal IPs + bad schemes resolve without network) ──

def test_is_public_url_rejects_loopback_and_metadata_and_private():
    # Literal IPs parse directly — no DNS, so these assertions are offline-safe.
    assert asyncio.run(_is_public_url("http://127.0.0.1/x")) is False
    assert asyncio.run(_is_public_url("http://169.254.169.254/latest/meta-data")) is False
    assert asyncio.run(_is_public_url("http://10.0.0.5/x")) is False
    assert asyncio.run(_is_public_url("http://[::1]/x")) is False

def test_is_public_url_rejects_non_http_scheme():
    assert asyncio.run(_is_public_url("file:///etc/passwd")) is False
    assert asyncio.run(_is_public_url("ftp://example.com/x")) is False

def test_fetch_og_image_blocks_internal_without_fetching():
    # A loopback target must short-circuit to "" before any GET is attempted.
    assert asyncio.run(fetch_og_image("http://127.0.0.1:8000/admin")) == ""
