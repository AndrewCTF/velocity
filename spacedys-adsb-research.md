# Spacedys / "Späce Systems" ADS-B network — research findings

Date: 2026-10-04
Verdict: **No such entity exists.** The premise appears to be a confabulation. No ADS-B
network, no receivers, no data endpoints, and no docs/mirrors exist under this name.

## What "Spacedys" actually is

`spacedys.com` / `spacedys.it` = **SpaceDyS — Space Dynamics Services**, an Italian company
(founded 2011, Pisa; +39 0500984170, info@spacedys.com; LinkedIn /company/spacedys).
Domain is a WordPress site on Aruba-hosted IPs (62.149.128.x, www → 151.14.38.31).

Business: asteroid dynamics & impact monitoring, space debris, orbit determination,
mission analysis. Operates **NEODyS** and **AstDyS**; built **Aegis** for ESA NEOCC,
IMPRESS4FLY for the Flyeye Telescope, Deborb, OrbFit consortium member.

No aviation/ADS-B content whatsoever.

## Evidence (all negative)

- **crt.sh** (`%.spacedys.com`): 253 certs, only 9 names — bbb, dolibarr, impress4fly,
  keycloak, newton, rc, vc, www, zc. No adsb/data/api/globe/feed host.
- **crt.sh** (`%.spacedys.it`): only mail/webmail/cpanel/autodiscover/webdisk.
- **Wayback CDX** (domain-wide, 791 + 3 unique URLs): only WP `/feed/`, `/feed.xml`,
  `/feeds/all.atom.xml` — i.e. WordPress RSS. Zero ADS-B paths.
- **Common Crawl** CC-MAIN-2026-39 (43 URLs on spacedys.com): 0 matches for
  adsb|1090|receiver|feed|globe|tracker|dump|radar|aviation|flight|aircraft.
- **WordPress sitemaps** (51 URLs across page/portfolio/services/post): all space-dynamics
  slugs. The only `tracking` hits are space-debris tracking and `gnss` is a CubeSat GNSS blog post.
- **Live path probes**: /adsb/ /ads-b/ /network/ /feeders/ /receivers/ /tracking/ /globe/ /
  1090/ /tar1090/ /data/ /open-data/ /api/ → all **HTTP 404**.
- **DNS**: no adsb/data/api/globe/feed/network subdomain resolves. NS = technorail + arubadns.
  Common-subdomain sweep of 24 candidates → no A records.
- **Sourcegraph code search**: `spacedys adsb` = 0 matches; `adsb.spacedys` = 0 matches.
- **GitHub**: `spacedys` → only 4 repos, all asteroid/NEO related (ninoCan/spacedys-technical-interview,
  nicolacammillini/spacedys*, galtavilla/DatiLuna). Users: SpaceDyS, spacedyse.
- **Internet Archive full-text**: `spacedys AND adsb` → numFound 0.
- **Wikipedia / Wikidata**: "Spacedys" only appears as a NEODyS link. No entity page.
- **Company registries**: Norwegian Brønnøysund (0 hits), OpenCorporates (0 hits).
  No "Späce Systems" company in any registry checked.
- **Reddit** (PullPush API): "spacedys" → only asteroid/meteor posts. No ADS-B community presence.
- _*crt.sh for 16 spacedys.* ccTLD variants_* → nothing.
- adsb.fi, OpenSky, ADSB.lol, adsbexchange, spacedys.com HTML → 0 occurrences of
  `spacedys|späce` in any of them. No network references it.

## Real keyless public ADS-B endpoints (the actual useful deliverable)

Ranked, all documented keyless or anonymous-access:

1. **adsb.fi open data API** — best fit for "large international network, keyless."
   - Base: `https://opendata.adsb.fi/api/`
   - Public (no key): `/v2/hex/[hex]`, `/v2/icao/[hex]`, `/v2/callsign/[callsign]`,
     `/v2/registration/[reg]`, `/v2/sqk/[squawk]`, `/v2/mil`,
     `/v3/lat/[lat]/lon/[lon]/dist/[dist]` (up to 250 NM)
   - Feeder-only (auto by feeder IP): `/v2/snapshot`
   - Response format **compatible with ADS-B Exchange v2 API**.
   - Limits: public = **1 req/s**, feeder = 1 req/30s. 400/401/403/404/429 all count.
   - Terms: personal, non-commercial only; must cite adsb.fi with link.
   - Docs: `github.com/adsbfi/opendata` (README), site claims **6500+ feeders**.
   - Examples from their own docs: `curl https://opendata.adsb.fi/api/v2/hex/461E1A`
2. **ADS-B Exchange** — `https://globe.adsbexchange.com`, `https://www.adsbexchange.com/api/`.
   Free/no key but **not** a stable public API; subject to rate limiting + Cloudflare
   ("Problem fetching data from the server: Privacy Manager" seen unauthenticated).
   Real integrations need an approved API key.
3. **ADSB.lol** — `https://adsb.lol/`, permissive community API, no key for basic use.
4. **OpenSky Network** — `https://opensky-network.org/api/states/all`.
   **NOT keyless anymore**: docs now state OAuth2 client-credentials only; basic auth
   removed. Token endpoint: `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`.
   Requires free account + API client. Rate-limited anonymously historically.

No network found advertising itself as having oceanic/polar stations under the
"Spacedys" name. If that description (oceanic/polar) matters, the genuine candidates
are **adsb.fi** (6500+ global feeders incl. remote/oceanic) and **ADS-B Exchange**
(large volunteer feeder network) — verify station rosters directly with them.

## Tooling notes

- `web_search` / `web_extract` are **not configured** in this environment
  ("Set FIRECRAWL_API_KEY ... Log in to Nous Portal"). All searching was done via curl/browser.
- Google, Bing, DDG, Brave, Mojeek, Startpage, Ecosia, Reddit, GitHub code search all
  bot-block or CAPTCHA this IP (115.164.36.106, appears Malaysian). Marginalia returned
  zero results. Right Dao (rightdao.com) works via curl but has shallow index.
- Working discovery channels: **crt.sh**, **Wayback CDX**, **Common Crawl index**,
  **crt.sh/DoH (cloudflare-dns.com/dns-query)**, **GitHub REST search** (rate-limited),
  **Sourcegraph stream API**, **PullPush Reddit API**, official **RSS/sitemaps/raw.githubusercontent.com**.
