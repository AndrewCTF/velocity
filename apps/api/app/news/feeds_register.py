"""Expanded, categorized register of world-news RSS feeds.

Verified-feeds contract: every entry below was probed live (httpx, browser
UA, 12 s timeout, IPv4-forced transport since host IPv6 is broken) and only
kept if the response was HTTP 200 AND :func:`app.news.sources.parse_feed_bytes`
extracted at least one item. Outlets whose native RSS 403/404'd but that are
still worth corroboration are carried via the existing Google-News
``source:<name>`` search pattern (:func:`app.news.sources.google_news_search`),
which is itself pre-verified (same host/parser as the wire feeds in
``sources.py``). Re-probe before adding new entries; don't hand-type a URL
you haven't fetched.

``REGISTER`` is additive to :data:`app.news.sources.FEEDS` — ``fetch_all``
unions the two (plus :data:`app.news.sources.CONFLICT_FEEDS`) by default.
Tier-2 entries are fetched in rotation rather than on every cycle so a 100+
feed register doesn't trip upstream throttling; tier-1 entries are always
included.
"""

from __future__ import annotations

from app.news.sources import Source, google_news_search

CATEGORIES: tuple[str, ...] = (
    "general",
    "wire",
    "government",
    "regional",
    "intel",
    "cyber",
    "tech",
    "finance",
)

# Every `leaning` value used anywhere in REGISTER must have an entry here,
# bucketed into the coarse political-lean groups the debias engine reasons
# over. "state" covers state-owned/state-affiliated outlets and official
# government releases regardless of which government.
LEANING_BUCKETS: dict[str, str] = {
    "un": "wire",
    "wire": "wire",
    "government": "state",
    "ru-state": "state",
    "cn-state": "state",
    "tr-state": "state",
    "ir-state": "state",
    "left": "left",
    "center-left": "left",
    "center": "center",
    "center-right": "right",
    "right": "right",
    "intel": "center",
    "cyber": "center",
    "tech": "center",
    "finance": "center",
}


REGISTER: list[Source] = [
    # ── general (mainstream world-news desks) ──────────────────────────────
    Source("UN News", "https://news.un.org/feed/subscribe/en/news/all/rss.xml", "un", "global", category="wire", tier=1),
    Source("CBC World", "https://www.cbc.ca/webfeed/rss/rss-world", "center-left", "CA", category="general", tier=1),
    Source("Euronews", "https://www.euronews.com/rss", "center", "EU", category="general", tier=1),
    Source("Le Monde EN", "https://www.lemonde.fr/en/rss/une.xml", "center-left", "FR", category="general", tier=2),
    Source("Spiegel International", "https://www.spiegel.de/international/index.rss", "center-left", "DE", category="general", tier=2),
    Source("NY Post", "https://nypost.com/feed/", "right", "US", category="general", tier=1),
    Source("Washington Times", "https://www.washingtontimes.com/rss/headlines/news/world/", "right", "US", category="general", tier=2),
    Source("National Review", "https://www.nationalreview.com/feed/", "right", "US", category="general", tier=2),
    Source("The Intercept", "https://theintercept.com/feed/?rss", "left", "US", category="general", tier=1),
    Source("Mother Jones", "https://www.motherjones.com/feed/", "left", "US", category="general", tier=2),
    Source("Vox", "https://www.vox.com/rss/index.xml", "left", "US", category="general", tier=1),
    Source("CBC Politics", "https://www.cbc.ca/webfeed/rss/rss-politics", "center-left", "CA", category="general", tier=2),
    Source("El Pais English", "https://feeds.elpais.com/mrss-s/pages/ep/site/english.elpais.com/portada", "center-left", "ES", category="general", tier=1),
    Source("Telegraph", google_news_search('source:"The Telegraph"'), "right", "UK", category="general", tier=2),
    Source("Spectator", google_news_search('source:"The Spectator"'), "right", "UK", category="general", tier=2),
    Source("Washington Examiner", google_news_search('source:"Washington Examiner"'), "right", "US", category="general", tier=2),
    Source("The Economist", google_news_search('source:"The Economist"'), "center-right", "UK", category="general", tier=1),

    # ── wire ─────────────────────────────────────────────────────────────
    Source("ReliefWeb", "https://reliefweb.int/updates/rss.xml", "wire", "global", category="wire", tier=1),
    Source("AFP", google_news_search('source:AFP OR source:"Agence France-Presse"'), "wire", "global", category="wire", tier=1),

    # ── government / official ───────────────────────────────────────────
    Source("DoD Releases", "https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945", "government", "US", category="government", tier=1),
    Source("IAEA", "https://www.iaea.org/feeds/topnews", "government", "IAEA", category="government", tier=1),
    Source("UK MoD", "https://www.gov.uk/government/organisations/ministry-of-defence.atom", "government", "UK", category="government", tier=1),
    Source("State Dept Press", google_news_search('source:"State Department" OR source:"U.S. Department of State"'), "government", "US", category="government", tier=2),
    Source("NATO News", google_news_search("source:NATO"), "government", "NATO", category="government", tier=2),

    # ── regional (country/region desks, incl. state media) ─────────────
    Source("ABC AU", "https://www.abc.net.au/news/feed/51120/rss.xml", "center", "AU", category="regional", tier=1),
    Source("Politico EU", "https://www.politico.eu/feed/", "center", "EU", category="regional", tier=2),
    Source("The Hindu International", "https://www.thehindu.com/news/international/feeder/default.rss", "center", "IN", category="regional", tier=1),
    Source("Times of India World", "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms", "center", "IN", category="regional", tier=1),
    Source("SCMP", "https://www.scmp.com/rss/91/feed", "center", "HK", category="regional", tier=1),
    Source("Straits Times", "https://www.straitstimes.com/news/world/rss.xml", "center", "SG", category="regional", tier=1),
    Source("Jerusalem Post", "https://www.jpost.com/rss/rssfeedsfrontpage.aspx", "center-right", "IL", category="regional", tier=1),
    Source("Moscow Times", "https://www.themoscowtimes.com/rss/news", "center", "RU", category="regional", tier=1),
    Source("Africanews", "https://www.africanews.com/feed/rss", "center", "Africa", category="regional", tier=1),
    Source("AllAfrica", "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf", "center", "Africa", category="regional", tier=2),
    Source("MercoPress", "https://en.mercopress.com/rss/", "center", "SouthAmerica", category="regional", tier=2),
    Source("RT", "https://www.rt.com/rss/news/", "ru-state", "RU", category="regional", tier=1),
    Source("TASS", "https://tass.com/rss/v2.xml", "ru-state", "RU", category="regional", tier=1),
    Source("CGTN", "https://www.cgtn.com/subscribe/rss/section/world.xml", "cn-state", "CN", category="regional", tier=1),
    Source("Xinhua EN", "http://www.xinhuanet.com/english/rss/worldrss.xml", "cn-state", "CN", category="regional", tier=1),
    Source("Anadolu", "https://www.aa.com.tr/en/rss/default?cat=guncel", "tr-state", "TR", category="regional", tier=2),
    Source("Press TV", "https://www.presstv.ir/rss.xml", "ir-state", "IR", category="regional", tier=2),
    Source("France24 Africa", "https://www.france24.com/en/africa/rss", "center", "FR", category="regional", tier=2),
    Source("Channel News Asia", "https://www.channelnewsasia.com/rssfeeds/8395986", "center", "SG", category="regional", tier=2),
    Source("Bangkok Post", "https://www.bangkokpost.com/rss/data/topstories.xml", "center", "TH", category="regional", tier=2),
    Source("Dawn Pakistan", "https://www.dawn.com/feeds/home", "center", "PK", category="regional", tier=1),
    Source("Al-Monitor", "https://www.al-monitor.com/rss.xml", "center", "mideast", category="regional", tier=2),
    Source("Daily Maverick", "https://www.dailymaverick.co.za/rss/", "center-left", "ZA", category="regional", tier=2),
    Source("Buenos Aires Herald", "https://buenosairesherald.com/feed", "center", "AR", category="regional", tier=2),
    Source("Rio Times", "https://riotimesonline.com/feed/", "center", "BR", category="regional", tier=2),
    Source("Global News Canada", "https://globalnews.ca/feed/", "center", "CA", category="regional", tier=2),
    Source("New Zealand Herald World", "https://www.nzherald.co.nz/arc/outboundfeeds/rss/section/world/?outputType=xml", "center", "NZ", category="regional", tier=2),
    Source("RNZ", "https://www.rnz.co.nz/rss/world.xml", "center", "NZ", category="regional", tier=2),
    Source("Yonhap", "https://en.yna.co.kr/RSS/news.xml", "center", "KR", category="regional", tier=1),
    Source("NHK World", "https://www3.nhk.or.jp/rss/news/cat0.xml", "center", "JP", category="regional", tier=1),
    Source("Taipei Times", "https://www.taipeitimes.com/xml/index.rss", "center", "TW", category="regional", tier=1),
    Source("Vietnam News", "https://vietnamnews.vn/rss/politics-laws.rss", "government", "VN", category="regional", tier=2),
    Source("Egypt Independent", "https://egyptindependent.com/feed/", "center", "EG", category="regional", tier=2),
    Source("Middle East Eye", "https://www.middleeasteye.net/rss", "left", "mideast", category="regional", tier=1),
    Source("Middle East Monitor", "https://www.middleeastmonitor.com/feed/", "left", "mideast", category="regional", tier=2),
    Source("Turkish Minute", "https://www.turkishminute.com/feed/", "center", "TR", category="regional", tier=2),
    Source("TVN24 Poland", "https://tvn24.pl/najnowsze.xml", "center", "PL", category="regional", tier=2),
    Source("Prague Morning", "https://praguemorning.cz/feed/", "center", "CZ", category="regional", tier=2),
    Source("The Local Sweden", "https://www.thelocal.se/feeds/rss.php", "center", "SE", category="regional", tier=2),
    Source("NL Times", "https://nltimes.nl/rss.xml", "center", "NL", category="regional", tier=2),
    Source("The Local Germany", "https://www.thelocal.de/feeds/rss.php", "center", "DE", category="regional", tier=2),
    Source("Local Italy", "https://www.thelocal.it/feeds/rss.php", "center", "IT", category="regional", tier=2),
    Source("Times of Israel", google_news_search('source:"Times of Israel"'), "center-right", "IL", category="regional", tier=1),
    Source("Kyiv Independent", google_news_search('source:"Kyiv Independent"'), "center", "UA", category="regional", tier=1),
    Source("Japan Times", google_news_search('source:"Japan Times"'), "center", "JP", category="regional", tier=2),
    Source("Korea Herald", google_news_search('source:"Korea Herald"'), "center", "KR", category="regional", tier=2),
    Source("Al Arabiya", google_news_search('source:"Al Arabiya"'), "center", "SA", category="regional", tier=2),
    Source("Arab News", google_news_search('source:"Arab News"'), "center", "SA", category="regional", tier=2),
    Source("Haaretz", google_news_search("source:Haaretz"), "center-left", "IL", category="regional", tier=2),

    # ── intel / defense ─────────────────────────────────────────────────
    Source("War on the Rocks", "https://warontherocks.com/feed/", "intel", "US", category="intel", tier=1),
    Source("Bellingcat", "https://www.bellingcat.com/feed/", "intel", "global", category="intel", tier=1),
    Source("The War Zone", "https://www.twz.com/feed", "intel", "US", category="intel", tier=1),
    Source("Naval News", "https://www.navalnews.com/feed/", "intel", "global", category="intel", tier=2),
    Source("Defense One", "https://www.defenseone.com/rss/all/", "intel", "US", category="intel", tier=1),
    Source("Breaking Defense", google_news_search('source:"Breaking Defense"'), "intel", "US", category="intel", tier=2),

    # ── cyber ────────────────────────────────────────────────────────────
    Source("Krebs on Security", "https://krebsonsecurity.com/feed/", "cyber", "US", category="cyber", tier=1),
    Source("The Record", "https://therecord.media/feed", "cyber", "US", category="cyber", tier=1),
    Source("The Hacker News", "https://feeds.feedburner.com/TheHackersNews", "cyber", "global", category="cyber", tier=1),
    Source("Dark Reading", "https://www.darkreading.com/rss.xml", "cyber", "US", category="cyber", tier=2),
    Source("SecurityWeek", "https://www.securityweek.com/feed/", "cyber", "US", category="cyber", tier=2),
    Source("CyberScoop", "https://cyberscoop.com/feed/", "cyber", "US", category="cyber", tier=2),
    Source("BleepingComputer", google_news_search("source:BleepingComputer"), "cyber", "US", category="cyber", tier=2),

    # ── tech ─────────────────────────────────────────────────────────────
    Source("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index", "tech", "US", category="tech", tier=1),
    Source("The Verge", "https://www.theverge.com/rss/index.xml", "tech", "US", category="tech", tier=1),
    Source("TechCrunch", "https://techcrunch.com/feed/", "tech", "US", category="tech", tier=1),
    Source("Wired", "https://www.wired.com/feed/rss", "tech", "US", category="tech", tier=1),
    Source("Engadget", "https://www.engadget.com/rss.xml", "tech", "US", category="tech", tier=2),
    Source("ZDNet", "https://www.zdnet.com/news/rss.xml", "tech", "US", category="tech", tier=2),

    # ── finance ──────────────────────────────────────────────────────────
    Source("WSJ World", "https://feeds.a.dj.com/rss/RSSWorldNews.xml", "center-right", "US", category="finance", tier=1),
    Source("MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories/", "center", "US", category="finance", tier=1),
    Source("Deutsche Welle Business", "https://rss.dw.com/rdf/rss-en-bus", "center", "DE", category="finance", tier=2),
    Source("Investing.com News", "https://www.investing.com/rss/news.rss", "center", "US", category="finance", tier=2),
    Source("Yahoo Finance", "https://finance.yahoo.com/news/rssindex", "center", "US", category="finance", tier=1),
    Source("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "finance", "global", category="finance", tier=2),
    Source("Barron's", google_news_search("source:Barron's"), "center", "US", category="finance", tier=2),
    Source("Financial Times", google_news_search('source:"Financial Times"'), "center-right", "UK", category="finance", tier=1),
    Source("Bloomberg", google_news_search("source:Bloomberg"), "center", "US", category="finance", tier=1),
]
