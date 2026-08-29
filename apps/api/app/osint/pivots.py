"""Manual-pivot catalog — the places an analyst opens by hand for a selector.

Sourced from *OSINT Techniques* 11th ed. (Bazzell & Edison, rev. 2025.04.02),
chapters 16 and 23-35. That book's signature artefact is a set of URL templates:
given an email, a handle, a name, a number, here are the twenty-five places to
look. Most of them cannot be a connector — they are captcha'd, paywalled, or
render entirely in JavaScript — but they are still where the intel is. So this
module holds the LINKS and ``app/osint/connectors.py`` holds the FETCHES.

Nothing here touches the network. ``pivots_for`` is pure string formatting, so
a source going down cannot degrade a feed; the cost of a dead entry is one dead
tab, which is the same cost the book's own HTML tools carry.

Deliberately dropped from the book's lists:

  * anything the platform already fetches and mints (crt.sh JSON, RDAP, Shodan
    InternetDB, OTX, Gravatar, GitHub/GitLab, mempool/blockstream, Hudson Rock,
    OpenSanctions, Wikidata) — a link to the same data is noise. Where the
    HUMAN page carries materially more than our JSON (GreyNoise viz, LittleSis
    graph, Aleph document viewer, urlscan screenshot), the link stays.
  * ``theeroticreview`` / ``theotherboard`` (ch. 26) — escort-review sites. The
    book lists them; they have no place in this product.
  * ``dehashed`` (ch. 23/24/26) — paywalled behind a login, so the tab opens on
    a sales page, not a result.
  * ``oldphonebook.com`` / ``americaphonebook.com`` (ch. 26) — plain-HTTP only.
    Every url here is https, so they are out rather than shipped broken.
  * ``nationalnanpa.com`` CO-code reports (ch. 26) and ``breadcrumbs.app``
    (ch. 35) — landing pages with no per-target deep link.

Formats: several sites want a specific rendering of the same selector (a phone
as ``618-462-0000`` here and ``6184620000`` there; a name as ``michael-bazzell``
here and ``michael+bazzell`` there). An entry names the one it wants in ``fmt``;
``raw`` is the default and means the canonical target unchanged.

Placeholders: ``{q}`` is the whole target. The ``coordinate`` kind uses ``{lat}``
and ``{lon}`` instead, because no mapping site takes the pair as one opaque
string and several want longitude first. Both may appear more than once in a
template (Google Maps names the point and then centres on it).
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

# Every kind this catalog answers for. `person`, `phone`, `image` and `company`
# are not machine-classifiable from a bare string, so the caller states them.
KINDS: tuple[str, ...] = (
    "email", "username", "person", "phone",
    "domain", "ip", "wallet", "company", "image", "url",
    "coordinate", "document", "video",
)

# ── the catalog ────────────────────────────────────────────────────────────────

PIVOTS: dict[str, tuple[dict[str, str], ...]] = {
    # ── Ch. 23: email addresses ────────────────────────────────────────────
    "email": (
        {"id": "google", "name": "Google exact phrase", "category": "Search engines",
         "url": "https://www.google.com/search?q=%22{q}%22"},
        {"id": "bing", "name": "Bing", "category": "Search engines",
         "url": "https://www.bing.com/search?q=%22{q}%22"},
        {"id": "yandex", "name": "Yandex", "category": "Search engines",
         "url": "https://yandex.com/search/?text=%22{q}%22"},
        {"id": "cybernews", "name": "Cybernews leak check", "category": "Breach and leak",
         "url": "https://check.cybernews.com/chk/?lang=en_US&e={q}"},
        {"id": "leakix", "name": "LeakIX", "category": "Breach and leak",
         "url": "https://leakix.net/search?scope=leak&q=%22{q}%22"},
        {"id": "psbdmp", "name": "Pastebin dumps · psbdmp", "category": "Breach and leak",
         "url": "https://psbdmp.ws/search/{q}",
         "note": "API unreachable from this egress; the web page still answers"},
        {"id": "intelx", "name": "Intelligence X", "category": "Breach and leak",
         "url": "https://intelx.io/?s={q}"},
        {"id": "cleantalk", "name": "CleanTalk email checker", "category": "Reputation",
         "url": "https://cleantalk.org/email-checker/{q}"},
        {"id": "proton", "name": "Proton key lookup", "category": "Reputation",
         "url": "https://mail-api.proton.me/pks/lookup?op=index&search={q}",
         "note": "a key entry proves the address exists at Proton"},
        {"id": "occrp-data", "name": "OCCRP Data", "category": "Registries and leaks",
         "url": "https://data.occrp.org/search?q={q}"},
        {"id": "aihit", "name": "aiHitData by email", "category": "Registries and leaks",
         "url": "https://www.aihitdata.com/search/companies?k={q}"},
        {"id": "skymem", "name": "Skymem", "category": "Registries and leaks",
         "url": "https://www.skymem.info/srch?q={q}"},
        {"id": "facebook", "name": "Facebook", "category": "Social",
         "url": "https://www.facebook.com/search/top?q=%22{q}%22"},
        {"id": "x", "name": "X (Twitter)", "category": "Social",
         "url": "https://x.com/search?q=%22{q}%22"},
    ),

    # ── Ch. 24: usernames ──────────────────────────────────────────────────
    "username": (
        {"id": "google", "name": "Google exact phrase", "category": "Search engines",
         "url": "https://www.google.com/search?q=%22{q}%22"},
        {"id": "bing", "name": "Bing", "category": "Search engines",
         "url": "https://www.bing.com/search?q=%22{q}%22"},
        {"id": "yandex", "name": "Yandex", "category": "Search engines",
         "url": "https://yandex.com/search/?text=%22{q}%22"},
        {"id": "idcrawl", "name": "IDCrawl", "category": "Handle sweeps",
         "url": "https://www.idcrawl.com/u/{q}"},
        {"id": "instantusername", "name": "Instant Username", "category": "Handle sweeps",
         "url": "https://instantusername.com/?q={q}"},
        {"id": "namechk", "name": "Namechk", "category": "Handle sweeps",
         "url": "https://namechk.com/namechk-plugin-search-results/?n={q}"},
        {"id": "namevine", "name": "NameVine", "category": "Handle sweeps",
         "url": "https://namevine.com/#/{q}"},
        {"id": "namechecker", "name": "Name Checker", "category": "Handle sweeps",
         "url": "https://www.namechecker.org/#{q}"},
        {"id": "checkistan", "name": "Username Checker · Checkistan", "category": "Handle sweeps",
         "url": "https://usernamechecker.checkistan.com/#{q}"},
        {"id": "profilediscover", "name": "ProfileDiscover", "category": "Handle sweeps",
         "url": "https://profilediscover.com/{q}/"},
        {"id": "usersearch", "name": "UserSearch · general", "category": "Handle sweeps",
         "url": "https://usersearch.org/results_normal.php?URL_username={q}"},
        {"id": "usersearch-forums", "name": "UserSearch · forums", "category": "Handle sweeps",
         "url": "https://usersearch.org/results_forums.php?URL_username={q}"},
        {"id": "usersearch-dating", "name": "UserSearch · dating", "category": "Handle sweeps",
         "url": "https://usersearch.org/results_dating.php?URL_username={q}"},
        {"id": "usersearch-crypto", "name": "UserSearch · crypto", "category": "Handle sweeps",
         "url": "https://usersearch.org/results_crypto.php?URL_username={q}"},
        {"id": "social-searcher", "name": "Social Searcher", "category": "Handle sweeps",
         "url": "https://www.social-searcher.com/search-users/?q6={q}"},
        {"id": "x", "name": "X (Twitter)", "category": "Social",
         "url": "https://x.com/{q}"},
        {"id": "instagram", "name": "Instagram", "category": "Social",
         "url": "https://instagram.com/{q}"},
        {"id": "tiktok", "name": "TikTok", "category": "Social",
         "url": "https://www.tiktok.com/@{q}"},
        {"id": "facebook", "name": "Facebook", "category": "Social",
         "url": "https://facebook.com/{q}"},
        {"id": "reddit", "name": "Reddit profile", "category": "Social",
         "url": "https://www.reddit.com/user/{q}"},
        {"id": "youtube", "name": "YouTube", "category": "Social",
         "url": "https://youtube.com/@{q}"},
        {"id": "medium", "name": "Medium", "category": "Social",
         "url": "https://medium.com/@{q}"},
        {"id": "snapchat", "name": "Snapchat", "category": "Social",
         "url": "https://www.snapchat.com/add/{q}"},
        {"id": "tumblr", "name": "Tumblr", "category": "Social",
         "url": "https://{q}.tumblr.com"},
        {"id": "linktree", "name": "Linktree", "category": "Social",
         "url": "https://linktr.ee/{q}"},
        {"id": "gravatar-profile", "name": "Gravatar profile page", "category": "Social",
         "url": "https://gravatar.com/{q}"},
    ),

    # ── Ch. 25: people search engines (free-text name) ──────────────────────
    "person": (
        {"id": "google", "name": "Google exact phrase", "category": "Search engines",
         "url": "https://www.google.com/search?q=%22{q}%22"},
        {"id": "bing", "name": "Bing", "category": "Search engines",
         "url": "https://www.bing.com/search?q=%22{q}%22"},
        {"id": "yandex", "name": "Yandex", "category": "Search engines",
         "url": "https://yandex.com/search/?text=%22{q}%22"},
        {"id": "idcrawl", "name": "IDCrawl", "category": "People search",
         "url": "https://www.idcrawl.com/{q}", "fmt": "dash"},
        {"id": "truepeoplesearch", "name": "TruePeopleSearch", "category": "People search",
         "url": "https://www.truepeoplesearch.com/results?name={q}"},
        {"id": "fastpeoplesearch", "name": "FastPeopleSearch", "category": "People search",
         "url": "https://www.fastpeoplesearch.com/name/{q}", "fmt": "dash"},
        {"id": "searchpeoplefree", "name": "SearchPeopleFree", "category": "People search",
         "url": "https://www.searchpeoplefree.com/find/{q}", "fmt": "dash"},
        {"id": "cyberbackgroundchecks", "name": "CyberBackgroundChecks",
         "category": "People search",
         "url": "https://www.cyberbackgroundchecks.com/people/{q}", "fmt": "dash"},
        {"id": "advancedbackgroundchecks", "name": "AdvancedBackgroundChecks",
         "category": "People search",
         "url": "https://www.advancedbackgroundchecks.com/names/{q}", "fmt": "dash"},
        {"id": "peoplesearchnow", "name": "PeopleSearchNow", "category": "People search",
         "url": "https://www.peoplesearchnow.com/person/{q}", "fmt": "dash"},
        {"id": "addresses", "name": "Addresses.com", "category": "People search",
         "url": "https://www.addresses.com/people/{q}", "fmt": "dash"},
        {"id": "spytox", "name": "Spytox", "category": "People search",
         "url": "https://www.spytox.com/{q}", "fmt": "dash"},
        {"id": "nuwber", "name": "Nuwber", "category": "People search",
         "url": "https://nuwber.com/search?name={q}", "fmt": "dash"},
        {"id": "zabasearch", "name": "ZabaSearch", "category": "People search",
         "url": "https://www.zabasearch.com/people/{q}/", "fmt": "plus"},
        {"id": "thatsthem", "name": "That's Them", "category": "People search",
         "url": "https://thatsthem.com/name/{q}", "fmt": "dash"},
        {"id": "whitepages", "name": "Whitepages", "category": "People search",
         "url": "https://www.whitepages.com/name/{q}", "fmt": "dash"},
        {"id": "spokeo", "name": "Spokeo", "category": "People search",
         "url": "https://www.spokeo.com/{q}", "fmt": "dash"},
        {"id": "clustrmaps", "name": "ClustrMaps", "category": "People search",
         "url": "https://clustrmaps.com/persons/{q}", "fmt": "dash"},
        {"id": "webmii", "name": "WebMii", "category": "People search",
         "url": "https://webmii.com/people?n=%22{q}%22"},
        {"id": "littlesis", "name": "LittleSis power network", "category": "Power and money",
         "url": "https://littlesis.org/search?q={q}",
         "note": "the graph view; the API is wired at /api/osint/littlesis"},
        {"id": "aleph", "name": "OCCRP Aleph", "category": "Power and money",
         "url": "https://aleph.occrp.org/search?q={q}",
         "note": "document viewer; the API is wired at /api/osint/aleph"},
        {"id": "opencorporates-officers", "name": "OpenCorporates officers",
         "category": "Power and money",
         "url": "https://opencorporates.com/officers?q={q}"},
        {"id": "openpayrolls", "name": "OpenPayrolls", "category": "Power and money",
         "url": "https://openpayrolls.com/search/{q}", "fmt": "dash"},
        {"id": "aihit", "name": "aiHitData people", "category": "Power and money",
         "url": "https://www.aihitdata.com/search/companies?t={q}"},
        {"id": "trellis", "name": "Trellis state courts", "category": "Courts and records",
         "url": "https://trellis.law/cases/{q}", "fmt": "dash"},
        {"id": "unicourt", "name": "UniCourt", "category": "Courts and records",
         "url": "https://unicourt.com/search?q={q}"},
        {"id": "muckrock", "name": "MuckRock FOIA", "category": "Courts and records",
         "url": "https://www.muckrock.com/foi/list/?q={q}"},
        {"id": "foia", "name": "FOIA.gov", "category": "Courts and records",
         "url": "https://search.foia.gov/search?affiliate=foia.gov&query={q}"},
        {"id": "social-searcher", "name": "Social Searcher", "category": "Social",
         "url": "https://www.social-searcher.com/search-users/?q6={q}"},
    ),

    # ── Ch. 26: telephone numbers ──────────────────────────────────────────
    "phone": (
        {"id": "google", "name": "Google exact phrase", "category": "Search engines",
         "url": "https://www.google.com/search?q=%22{q}%22", "fmt": "dash"},
        {"id": "bing", "name": "Bing", "category": "Search engines",
         "url": "https://www.bing.com/search?q={q}", "fmt": "dash"},
        {"id": "yandex", "name": "Yandex", "category": "Search engines",
         "url": "https://yandex.com/search/?text={q}", "fmt": "dash"},
        {"id": "truepeoplesearch", "name": "TruePeopleSearch", "category": "Reverse lookup",
         "url": "https://www.truepeoplesearch.com/results?phoneno={q}"},
        {"id": "fastpeoplesearch", "name": "FastPeopleSearch", "category": "Reverse lookup",
         "url": "https://www.fastpeoplesearch.com/{q}", "fmt": "dash"},
        {"id": "searchpeoplefree", "name": "SearchPeopleFree", "category": "Reverse lookup",
         "url": "https://www.searchpeoplefree.com/phone-lookup/{q}", "fmt": "dash"},
        {"id": "cyberbackgroundchecks", "name": "CyberBackgroundChecks",
         "category": "Reverse lookup",
         "url": "https://www.cyberbackgroundchecks.com/phone/{q}", "fmt": "dash"},
        {"id": "advancedbackgroundchecks", "name": "AdvancedBackgroundChecks",
         "category": "Reverse lookup",
         "url": "https://www.advancedbackgroundchecks.com/{q}", "fmt": "dash"},
        {"id": "peoplesearchnow", "name": "PeopleSearchNow", "category": "Reverse lookup",
         "url": "https://www.peoplesearchnow.com/phone/{q}", "fmt": "dash"},
        {"id": "thatsthem", "name": "That's Them", "category": "Reverse lookup",
         "url": "https://thatsthem.com/phone/{q}", "fmt": "dash"},
        {"id": "spytox", "name": "Spytox", "category": "Reverse lookup",
         "url": "https://www.spytox.com/reverse-phone-lookup/{q}", "fmt": "dash"},
        {"id": "usphonebook", "name": "USPhonebook", "category": "Reverse lookup",
         "url": "https://www.usphonebook.com/{q}", "fmt": "dash"},
        {"id": "whitepages", "name": "Whitepages", "category": "Reverse lookup",
         "url": "https://www.whitepages.com/phone/{q}", "fmt": "dash1"},
        {"id": "411", "name": "411.com", "category": "Reverse lookup",
         "url": "https://www.411.com/phone/{q}", "fmt": "dash1"},
        {"id": "zabasearch", "name": "ZabaSearch", "category": "Reverse lookup",
         "url": "https://www.zabasearch.com/phone/{q}"},
        {"id": "nuwber", "name": "Nuwber", "category": "Reverse lookup",
         "url": "https://nuwber.com/search/phone?phone={q}"},
        {"id": "yellowpages", "name": "Yellow Pages", "category": "Reverse lookup",
         "url": "https://people.yellowpages.com/whitepages/phone-lookup?phone={q}"},
        {"id": "numpi", "name": "NumPI", "category": "Carrier and caller ID",
         "url": "https://numpi.com/phone-info/{q}"},
        {"id": "phoneowner", "name": "PhoneOwner", "category": "Carrier and caller ID",
         "url": "https://phoneowner.com/phone/{q}"},
        {"id": "syncme", "name": "Sync.me", "category": "Carrier and caller ID",
         "url": "https://sync.me/search/?number={q}", "fmt": "e164"},
        {"id": "okcaller", "name": "OKCaller", "category": "Carrier and caller ID",
         "url": "https://www.okcaller.com/{q}"},
        {"id": "callersmart", "name": "CallerSmart", "category": "Carrier and caller ID",
         "url": "https://www.callersmart.com/phone-number/{q}", "fmt": "dash"},
        {"id": "whoseno", "name": "WhoseNo", "category": "Carrier and caller ID",
         "url": "https://www.whoseno.com/US/{q}"},
        {"id": "800notes", "name": "800notes complaints", "category": "Carrier and caller ID",
         "url": "https://800notes.com/Phone.aspx/{q}", "fmt": "dash1"},
        {"id": "infotracer", "name": "InfoTracer", "category": "Carrier and caller ID",
         "url": "https://infotracer.com/phone-lookup/results/?phone={q}"},
        {"id": "whatsapp-leak", "name": "WhatsApp leak check", "category": "Breach and leak",
         "url": "https://whatsapp.checkleaked.cc/{q}", "fmt": "e164"},
    ),

    # ── Ch. 32: domain names ───────────────────────────────────────────────
    "domain": (
        {"id": "viewdns-whois", "name": "ViewDNS whois", "category": "Registration",
         "url": "https://viewdns.info/whois/?domain={q}"},
        {"id": "viewdns-reversewhois", "name": "ViewDNS reverse whois", "category": "Registration",
         "url": "https://viewdns.info/reversewhois/?q={q}"},
        {"id": "viewdns-iphistory", "name": "ViewDNS IP history", "category": "Registration",
         "url": "https://viewdns.info/iphistory/?domain={q}"},
        {"id": "whoxy", "name": "Whoxy", "category": "Registration",
         "url": "https://www.whoxy.com/{q}"},
        {"id": "viewdns-reverseip", "name": "ViewDNS reverse IP", "category": "Infrastructure",
         "url": "https://viewdns.info/reverseip/?host={q}&t=1"},
        {"id": "viewdns-dnsreport", "name": "ViewDNS DNS report", "category": "Infrastructure",
         "url": "https://viewdns.info/dnsreport/?domain={q}"},
        {"id": "dnslytics", "name": "DNSlytics", "category": "Infrastructure",
         "url": "https://dnslytics.com/domain/{q}"},
        {"id": "hostio", "name": "Host.io", "category": "Infrastructure",
         "url": "https://host.io/{q}"},
        {"id": "crtsh", "name": "crt.sh certificate log", "category": "Infrastructure",
         "url": "https://crt.sh/?q={q}",
         "note": "the human view; the JSON is wired at /api/osint/certs"},
        {"id": "censys", "name": "Censys", "category": "Infrastructure",
         "url": "https://search.censys.io/search?resource=hosts&q={q}"},
        {"id": "shodan", "name": "Shodan", "category": "Infrastructure",
         "url": "https://www.shodan.io/search?query={q}"},
        {"id": "zoomeye", "name": "ZoomEye", "category": "Infrastructure",
         "url": "https://www.zoomeye.hk/searchResult?q={q}"},
        {"id": "urlscan", "name": "urlscan.io", "category": "Behaviour",
         "url": "https://urlscan.io/domain/{q}",
         "note": "screenshots and request log; the JSON is at /api/osint/urlscan"},
        {"id": "sucuri", "name": "Sucuri SiteCheck", "category": "Behaviour",
         "url": "https://sitecheck.sucuri.net/results/{q}"},
        {"id": "mywot", "name": "MyWOT scorecard", "category": "Behaviour",
         "url": "https://www.mywot.com/scorecard/{q}"},
        {"id": "hypestat", "name": "HypeStat", "category": "Behaviour",
         "url": "https://hypestat.com/info/{q}"},
        {"id": "informer", "name": "Website Informer", "category": "Behaviour",
         "url": "https://website.informer.com/{q}"},
        {"id": "wayback", "name": "Wayback Machine", "category": "Archives",
         "url": "https://web.archive.org/web/*/{q}"},
        {"id": "archive-today", "name": "archive.today", "category": "Archives",
         "url": "https://archive.is/newest/https://{q}"},
        {"id": "arquivo", "name": "Arquivo.pt", "category": "Archives",
         "url": "https://arquivo.pt/wayback/*/{q}"},
        {"id": "loc", "name": "Library of Congress web archive", "category": "Archives",
         "url": "https://webarchive.loc.gov/all/*/{q}"},
        {"id": "hunter", "name": "Hunter.io addresses", "category": "People on the domain",
         "url": "https://hunter.io/search/{q}"},
        {"id": "skymem", "name": "Skymem addresses", "category": "People on the domain",
         "url": "https://www.skymem.info/srch?q={q}"},
        {"id": "intelx", "name": "Intelligence X", "category": "Breach and leak",
         "url": "https://intelx.io/?s={q}"},
    ),

    # ── Ch. 33: IP addresses ───────────────────────────────────────────────
    "ip": (
        {"id": "shodan", "name": "Shodan host", "category": "Services",
         "url": "https://www.shodan.io/host/{q}",
         "note": "the full record; the keyless InternetDB subset is at /api/osint/shodan"},
        {"id": "censys", "name": "Censys host", "category": "Services",
         "url": "https://search.censys.io/hosts/{q}"},
        {"id": "zoomeye", "name": "ZoomEye", "category": "Services",
         "url": "https://www.zoomeye.hk/searchResult?q={q}"},
        {"id": "viewdns-portscan", "name": "ViewDNS port scan", "category": "Services",
         "url": "https://viewdns.info/portscan/?host={q}"},
        {"id": "viewdns-reversedns", "name": "ViewDNS reverse DNS", "category": "Naming",
         "url": "https://viewdns.info/reversedns/?ip={q}"},
        {"id": "viewdns-reverseip", "name": "ViewDNS reverse IP", "category": "Naming",
         "url": "https://viewdns.info/reverseip/?host={q}&t=1"},
        {"id": "dnslytics", "name": "DNSlytics", "category": "Naming",
         "url": "https://search.dnslytics.com/ip/{q}"},
        {"id": "myipms", "name": "MyIP.ms", "category": "Naming",
         "url": "https://myip.ms/view/ip_information/{q}"},
        {"id": "viewdns-iplocation", "name": "ViewDNS IP location", "category": "Attribution",
         "url": "https://viewdns.info/iplocation/?ip={q}"},
        {"id": "iplocation", "name": "IPLocation.net", "category": "Attribution",
         "url": "https://www.iplocation.net/ip-lookup?query={q}"},
        {"id": "thatsthem", "name": "That's Them by IP", "category": "Attribution",
         "url": "https://thatsthem.com/ip/{q}"},
        {"id": "bing-ip", "name": "Bing ip: operator", "category": "Attribution",
         "url": "https://www.bing.com/search?q=ip%3A{q}"},
        {"id": "greynoise", "name": "GreyNoise visualizer", "category": "Reputation",
         "url": "https://viz.greynoise.io/ip/{q}",
         "note": "the timeline view; the verdict is at /api/osint/greynoise"},
        {"id": "abuseipdb", "name": "AbuseIPDB", "category": "Reputation",
         "url": "https://www.abuseipdb.com/check/{q}"},
        {"id": "iknowwhatyoudownload", "name": "Torrent activity", "category": "Reputation",
         "url": "https://iknowwhatyoudownload.com/en/peer/?ip={q}"},
    ),

    # ── Ch. 35: virtual currency (chain-filtered by pivots_for) ────────────
    "wallet": (
        {"id": "blockchair-btc", "name": "Blockchair", "category": "Bitcoin",
         "url": "https://blockchair.com/bitcoin/address/{q}"},
        {"id": "blockchain-com", "name": "Blockchain.com explorer", "category": "Bitcoin",
         "url": "https://www.blockchain.com/explorer/addresses/btc/{q}"},
        {"id": "walletexplorer", "name": "WalletExplorer clustering", "category": "Bitcoin",
         "url": "https://www.walletexplorer.com/address/{q}"},
        {"id": "cloverpool", "name": "CloverPool explorer", "category": "Bitcoin",
         "url": "https://explorer.cloverpool.com/btc/address/{q}"},
        {"id": "mempool", "name": "mempool.space", "category": "Bitcoin",
         "url": "https://mempool.space/address/{q}",
         "note": "the human view; the JSON is at /api/osint/mempool"},
        {"id": "blockstream", "name": "Blockstream explorer", "category": "Bitcoin",
         "url": "https://blockstream.info/address/{q}"},
        {"id": "etherscan", "name": "Etherscan", "category": "Ethereum",
         "url": "https://etherscan.io/address/{q}"},
        {"id": "blockscout", "name": "Blockscout", "category": "Ethereum",
         "url": "https://eth.blockscout.com/address/{q}",
         "note": "the human view; the JSON is at /api/osint/blockscout"},
        {"id": "blockchair-eth", "name": "Blockchair", "category": "Ethereum",
         "url": "https://blockchair.com/ethereum/address/{q}"},
        {"id": "chainabuse", "name": "Chainabuse reports", "category": "Abuse",
         "url": "https://www.chainabuse.com/address/{q}"},
    ),

    # ── Ch. 34: government and business records ────────────────────────────
    "company": (
        {"id": "google", "name": "Google exact phrase", "category": "Search engines",
         "url": "https://www.google.com/search?q=%22{q}%22"},
        {"id": "google-books", "name": "Google Books", "category": "Search engines",
         "url": "https://www.google.com/search?tbm=bks&q=%22{q}%22"},
        {"id": "opencorporates", "name": "OpenCorporates companies", "category": "Registries",
         "url": "https://opencorporates.com/companies?q={q}",
         "note": "the API is key-gated now; the web search is not"},
        {"id": "opencorporates-officers", "name": "OpenCorporates officers",
         "category": "Registries",
         "url": "https://opencorporates.com/officers?q={q}"},
        {"id": "sec-edgar", "name": "SEC EDGAR company search", "category": "Registries",
         "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company={q}&count=40"},
        {"id": "aihit", "name": "aiHitData", "category": "Registries",
         "url": "https://www.aihitdata.com/search/companies?c={q}"},
        {"id": "littlesis", "name": "LittleSis power network", "category": "Power and money",
         "url": "https://littlesis.org/search?q={q}"},
        {"id": "aleph", "name": "OCCRP Aleph", "category": "Power and money",
         "url": "https://aleph.occrp.org/search?q={q}"},
        {"id": "openpayrolls", "name": "OpenPayrolls", "category": "Power and money",
         "url": "https://openpayrolls.com/search/{q}", "fmt": "dash"},
        {"id": "trellis", "name": "Trellis state courts", "category": "Courts and records",
         "url": "https://trellis.law/cases/{q}", "fmt": "dash"},
        {"id": "unicourt", "name": "UniCourt", "category": "Courts and records",
         "url": "https://unicourt.com/search?q={q}"},
        {"id": "muckrock", "name": "MuckRock FOIA", "category": "Courts and records",
         "url": "https://www.muckrock.com/foi/list/?q={q}"},
        {"id": "foia", "name": "FOIA.gov", "category": "Courts and records",
         "url": "https://search.foia.gov/search?affiliate=foia.gov&query={q}"},
    ),

    # ── Ch. 29: images (the target is the URL of an image) ─────────────────
    "image": (
        {"id": "google-lens", "name": "Google Lens", "category": "Reverse image",
         "url": "https://lens.google.com/uploadbyurl?url={q}"},
        {"id": "yandex-images", "name": "Yandex Images", "category": "Reverse image",
         "url": "https://yandex.com/images/search?rpt=imageview&url={q}",
         "note": "the strongest of the four for faces and places"},
        {"id": "bing-visual", "name": "Bing Visual Search", "category": "Reverse image",
         "url": "https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:{q}"},
        {"id": "tineye", "name": "TinEye", "category": "Reverse image",
         "url": "https://www.tineye.com/search/?url={q}"},
        {"id": "baidu", "name": "Baidu image graph", "category": "Reverse image",
         "url": "https://graph.baidu.com/upload?image={q}"},
        {"id": "repostsleuth", "name": "Repost Sleuth · Reddit", "category": "Reverse image",
         "url": "https://www.repostsleuth.com/search?url={q}"},
        {"id": "facecheck", "name": "FaceCheck.ID", "category": "Faces",
         "url": "https://facecheck.id/#url={q}"},
    ),

    # ── Ch. 28 and 30: a url, archived and analysed ────────────────────────
    "url": (
        {"id": "wayback", "name": "Wayback Machine", "category": "Archives",
         "url": "https://web.archive.org/web/*/{q}"},
        {"id": "archive-today", "name": "archive.today", "category": "Archives",
         "url": "https://archive.is/newest/{q}"},
        {"id": "arquivo", "name": "Arquivo.pt", "category": "Archives",
         "url": "https://arquivo.pt/wayback/*/{q}"},
        {"id": "loc", "name": "Library of Congress web archive", "category": "Archives",
         "url": "https://webarchive.loc.gov/all/*/{q}"},
        {"id": "urlscan", "name": "urlscan.io", "category": "Behaviour",
         "url": "https://urlscan.io/search/#{q}"},
        {"id": "virustotal", "name": "VirusTotal", "category": "Behaviour",
         "url": "https://www.virustotal.com/gui/search/{q}"},
    ),

    # ── Ch. 27: online maps (the target is a lat/lon pair) ─────────────────
    # These take {lat} and {lon} rather than {q}: no mapping site wants the
    # pair as one opaque string, and half of them want it in the other order.
    "coordinate": (
        {"id": "google-maps", "name": "Google Maps", "category": "Maps",
         "url": "https://www.google.com/maps/place/{lat},{lon}/@{lat},{lon},18z"},
        {"id": "google-earth", "name": "Google Earth web", "category": "Maps",
         "url": "https://earth.google.com/web/@{lat},{lon},0a,1000d,35y,0h,0t,0r"},
        {"id": "bing-maps", "name": "Bing Maps (bird's eye)", "category": "Maps",
         "url": "https://www.bing.com/maps?cp={lat}~{lon}&lvl=18&style=h"},
        {"id": "yandex-maps", "name": "Yandex Maps", "category": "Maps",
         "url": "https://yandex.com/maps/?ll={lon}%2C{lat}&z=18&l=sat",
         "note": "often the freshest imagery over Russia and central Asia"},
        {"id": "apple-maps", "name": "Apple Maps", "category": "Maps",
         "url": "https://beta.maps.apple.com/?ll={lat},{lon}&z=18&t=k"},
        {"id": "osm", "name": "OpenStreetMap", "category": "Maps",
         "url": "https://www.openstreetmap.org/#map=18/{lat}/{lon}"},
        {"id": "here", "name": "HERE WeGo", "category": "Maps",
         "url": "https://wego.here.com/?map={lat},{lon},18,satellite"},
        {"id": "wikimapia", "name": "Wikimapia", "category": "Maps",
         "url": "https://wikimapia.org/#lang=en&lat={lat}&lon={lon}&z=17&m=b"},
        {"id": "streetview", "name": "Google Street View", "category": "Street level",
         "url": "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lon}"},
        {"id": "mapillary", "name": "Mapillary", "category": "Street level",
         "url": "https://www.mapillary.com/app/?lat={lat}&lng={lon}&z=17"},
        {"id": "kartaview", "name": "KartaView", "category": "Street level",
         "url": "https://kartaview.org/map/@{lat},{lon},17z"},
        {"id": "zoom-earth", "name": "Zoom Earth", "category": "Imagery over time",
         "url": "https://zoom.earth/#view={lat},{lon},18z"},
        {"id": "satellites-pro", "name": "Satellites.pro", "category": "Imagery over time",
         "url": "https://satellites.pro/#{lat},{lon},18"},
        {"id": "eo-browser", "name": "Sentinel Hub EO Browser", "category": "Imagery over time",
         "url": "https://apps.sentinel-hub.com/eo-browser/?lat={lat}&lng={lon}&zoom=13"},
        {"id": "landviewer", "name": "EOS LandViewer", "category": "Imagery over time",
         "url": "https://eos.com/landviewer/?lat={lat}&lng={lon}&z=12"},
        {"id": "suncalc", "name": "SunCalc shadow and sun angle", "category": "Analysis",
         "url": "https://www.suncalc.org/#/{lat},{lon},17/2024.06.21/12:00/1/3",
         "note": "shadow length and bearing, for dating an image from its shadows"},
        {"id": "acrevalue", "name": "AcreValue parcels", "category": "Analysis",
         "url": "https://www.acrevalue.com/map/?lat={lat}&lng={lon}&zoom=15",
         "note": "US parcel boundaries and owners"},
    ),

    # ── Ch. 28: documents ──────────────────────────────────────────────────
    "document": (
        {"id": "google-pdf", "name": "Google · filetype:pdf", "category": "Search engines",
         "url": "https://www.google.com/search?q=%22{q}%22+filetype%3Apdf"},
        {"id": "google-office", "name": "Google · office formats", "category": "Search engines",
         "url": "https://www.google.com/search?q=%22{q}%22+filetype%3Adoc+OR+filetype%3Adocx"
                "+OR+filetype%3Axls+OR+filetype%3Apptx"},
        {"id": "google-books", "name": "Google Books", "category": "Search engines",
         "url": "https://www.google.com/search?tbm=bks&q=%22{q}%22"},
        {"id": "refseek", "name": "RefSeek", "category": "Search engines",
         "url": "https://www.refseek.com/documents?q={q}"},
        {"id": "archive-org", "name": "Internet Archive texts", "category": "Archives",
         "url": "https://archive.org/search?query={q}&sin=TXT"},
        {"id": "annas-archive", "name": "Anna's Archive", "category": "Archives",
         "url": "https://annas-archive.org/search?q={q}"},
        {"id": "pdfdrive", "name": "PDFDrive", "category": "Archives",
         "url": "https://www.pdfdrive.com/search?q={q}"},
        {"id": "us-archives", "name": "US National Archives", "category": "Government",
         "url": "https://search.archives.gov/search?affiliate=national-archives&query={q}"},
        {"id": "govinfo", "name": "GovInfo", "category": "Government",
         "url": "https://www.govinfo.gov/app/search/%7B%22query%22%3A%22{q}%22%7D"},
        {"id": "base", "name": "BASE academic search", "category": "Academic",
         "url": "https://www.base-search.net/Search/Results?lookfor={q}"},
        {"id": "core", "name": "CORE open access", "category": "Academic",
         "url": "https://core.ac.uk/search/?q={q}"},
        {"id": "grayhat-buckets", "name": "Open buckets · GrayHatWarfare",
         "category": "Exposed storage",
         "url": "https://buckets.grayhatwarfare.com/files?keywords={q}"},
    ),

    # ── Ch. 30: one video, by its YouTube id ───────────────────────────────
    "video": (
        {"id": "youtube", "name": "Watch page", "category": "The video",
         "url": "https://www.youtube.com/watch?v={q}"},
        {"id": "thumbnail", "name": "Full-size thumbnail", "category": "The video",
         "url": "https://img.youtube.com/vi/{q}/maxresdefault.jpg",
         "note": "a thumbnail that still serves after the watch page 404s is how "
                 "ch. 30 confirms a deleted video existed"},
        {"id": "polsy", "name": "Country restrictions · Polsy", "category": "Availability",
         "url": "https://polsy.org.uk/stuff/ytrestrict.cgi?ytid={q}",
         "note": "which countries the upload is blocked in, which is itself a lead"},
        {"id": "wayback", "name": "Archived watch page", "category": "Availability",
         "url": "https://web.archive.org/web/*/youtube.com/watch%3Fv%3D{q}"},
        {"id": "filmot", "name": "Subtitle search · Filmot", "category": "Contents",
         "url": "https://filmot.com/video/{q}"},
        {"id": "lens-thumb", "name": "Google Lens on the thumbnail", "category": "Contents",
         "url": "https://lens.google.com/uploadbyurl?url=https%3A%2F%2Fimg.youtube.com"
                "%2Fvi%2F{q}%2Fmaxresdefault.jpg"},
        {"id": "yandex-thumb", "name": "Yandex on the thumbnail", "category": "Contents",
         "url": "https://yandex.com/images/search?rpt=imageview&url=https%3A%2F%2Fimg.youtube.com"
                "%2Fvi%2F{q}%2Fmaxresdefault.jpg"},
    ),
}

# ── rendering ──────────────────────────────────────────────────────────────────

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _digits(target: str) -> str:
    return re.sub(r"\D", "", target)


def _nanp(target: str) -> tuple[str, str, str]:
    """Split a phone into (area, prefix, line) when it is a 10-digit NANP number.

    A non-NANP number (an international one, or a short one) has no dashed form
    the US lookup sites accept, so it renders as bare digits everywhere.
    """
    d = _digits(target)
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    if len(d) != 10:
        return ("", "", "")
    return (d[0:3], d[3:6], d[6:10])


def _render(target: str, kind: str, fmt: str) -> str:
    """The one string this entry wants, url-quoted for a query string."""
    if kind == "phone":
        d = _digits(target)
        area, pre, line = _nanp(target)
        if fmt == "dash" and area:
            return f"{area}-{pre}-{line}"
        if fmt == "dash1" and area:
            return f"1-{area}-{pre}-{line}"
        if fmt == "e164":
            return d if d.startswith("1") else f"1{d}"
        return d
    if kind == "wallet":
        # Canonical wallet ids are "<chain>:<address>"; the explorers want the
        # address alone.
        target = target.split(":", 1)[-1]
    if fmt == "dash":
        return _NON_ALNUM.sub("-", target.strip().lower()).strip("-")
    if fmt == "plus":
        return _NON_ALNUM.sub("+", target.strip().lower()).strip("+")
    return target


# Which placeholders a kind's templates may use. A template outside its kind's
# set would survive into the url as literal braces, so the guard checks it.
PLACEHOLDERS: dict[str, frozenset[str]] = {
    "coordinate": frozenset({"lat", "lon"}),
}
DEFAULT_PLACEHOLDERS: frozenset[str] = frozenset({"q"})


def placeholders_for(kind: str) -> frozenset[str]:
    return PLACEHOLDERS.get(kind, DEFAULT_PLACEHOLDERS)


def _chain_of(wallet: str) -> str:
    return wallet.split(":", 1)[0].lower() if ":" in wallet else ""


def pivots_for(kind: str, target: str) -> list[dict[str, Any]]:
    """The book's manual-pivot links for this selector, grouped by category.

    Returns ``[{"category": str, "links": [{"id", "name", "url", "note"?}]}]``
    in catalog order. An unknown kind gives an empty list rather than raising —
    the caller is a GET route and a kind we have no entries for is a legitimate
    empty answer, not an error.
    """
    entries = PIVOTS.get(kind)
    if not entries or not (target or "").strip():
        return []

    chain = _chain_of(target) if kind == "wallet" else ""
    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for e in entries:
        # A BTC explorer handed an ETH address is a guaranteed 404 — filter by
        # chain rather than shipping half the list dead.
        if chain == "btc" and e["category"] == "Ethereum":
            continue
        if chain == "eth" and e["category"] == "Bitcoin":
            continue
        fmt = e.get("fmt", "raw")
        # The `plus` format's separator is part of the shape the site wants
        # (the book prints `michael+bazzell`), so it must survive quoting. In a
        # path segment a literal + and %2B mean the same thing, but matching the
        # printed form removes a difference nobody can test from this egress —
        # every site in that group WAFs a datacenter address.
        value = quote(_render(target, kind, fmt), safe="+" if fmt == "plus" else "")
        url = e["url"]
        if kind == "coordinate":
            lat, _, lon = target.partition(",")
            url = url.replace("{lat}", quote(lat, safe="-.")).replace(
                "{lon}", quote(lon, safe="-.")
            )
        else:
            url = url.replace("{q}", value)
        link: dict[str, Any] = {
            "id": e["id"],
            "name": e["name"],
            "url": url,
        }
        if e.get("note"):
            link["note"] = e["note"]
        cat = e["category"]
        if cat not in groups:
            groups[cat] = []
            order.append(cat)
        groups[cat].append(link)
    return [{"category": c, "links": groups[c]} for c in order]
