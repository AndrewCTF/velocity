from app.news.sources import Source, parse_feed_bytes

_SRC = Source("Test", "http://x", "center", "test")

_RSS_WITH_MEDIA = b"""<?xml version="1.0"?>
<rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel>
<item>
  <title>Story with thumbnail</title>
  <link>https://ex.com/a</link>
  <description>body</description>
  <media:thumbnail url="https://img.ex.com/a.jpg"/>
</item>
<item>
  <title>Story with enclosure</title>
  <link>https://ex.com/b</link>
  <enclosure url="https://img.ex.com/b.jpg" type="image/jpeg"/>
</item>
<item>
  <title>Story with no image</title>
  <link>https://ex.com/c</link>
</item>
</channel></rss>"""

def test_parse_extracts_media_image():
    arts = parse_feed_bytes(_RSS_WITH_MEDIA, _SRC)
    by_title = {a.title: a for a in arts}
    assert by_title["Story with thumbnail"].image == "https://img.ex.com/a.jpg"
    assert by_title["Story with enclosure"].image == "https://img.ex.com/b.jpg"
    assert by_title["Story with no image"].image == ""
