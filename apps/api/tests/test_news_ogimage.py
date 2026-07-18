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


# ── DNS-rebinding TOCTOU: pin the http fetch to the validated IP ─────────────


def _fake_addrinfo(ip):
    async def _f(host, port):
        return [(2, 1, 6, "", (ip, port or 80))]

    return _f


def test_resolve_public_returns_pin_ip_for_public_host(monkeypatch):
    from app.news import images

    monkeypatch.setattr(images, "_getaddrinfo", _fake_addrinfo("93.184.216.34"))
    ok, pin = asyncio.run(images._resolve_public("http://example.com/a"))
    assert ok is True and pin == "93.184.216.34"


def test_resolve_public_rejects_dns_rebind_to_metadata(monkeypatch):
    from app.news import images

    # A host that resolves to the metadata range is rejected — the SSRF gate.
    monkeypatch.setattr(images, "_getaddrinfo", _fake_addrinfo("169.254.169.254"))
    ok, pin = asyncio.run(images._resolve_public("http://rebind.evil/a"))
    assert ok is False and pin is None


def test_fetch_og_image_pins_http_to_validated_ip(monkeypatch):
    from app.news import images

    monkeypatch.setattr(images, "_getaddrinfo", _fake_addrinfo("93.184.216.34"))
    captured: dict = {}

    class _Resp:
        status_code = 200
        headers: dict = {}
        text = '<meta property="og:image" content="https://i.ex/x.jpg">'

    class _Client:
        async def get(self, url, **kw):
            captured["url"] = url
            captured["host"] = kw.get("headers", {}).get("Host")
            return _Resp()

    monkeypatch.setattr(images, "get_client", lambda: _Client())
    images._cache.clear()
    img = asyncio.run(images.fetch_og_image("http://news.example/story"))
    assert img == "https://i.ex/x.jpg"
    # The GET went to the validated IP, not a re-resolved hostname, and carried
    # the original Host so vhosts still work — the DNS-rebinding gap is closed.
    assert "93.184.216.34" in captured["url"]
    assert captured["host"] == "news.example"
