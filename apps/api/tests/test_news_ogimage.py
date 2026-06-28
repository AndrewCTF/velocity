# apps/api/tests/test_news_ogimage.py
from app.news.images import parse_og_image

def test_parse_og_image_property():
    html = '<head><meta property="og:image" content="https://i.ex/x.jpg"></head>'
    assert parse_og_image(html) == "https://i.ex/x.jpg"

def test_parse_twitter_image_fallback():
    html = '<meta name="twitter:image" content="https://i.ex/t.png">'
    assert parse_og_image(html) == "https://i.ex/t.png"

def test_parse_none():
    assert parse_og_image("<html><body>no meta</body></html>") == ""
