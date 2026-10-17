# ADSBHub — Community & Public Endpoint Research

**Research date:** 2026-10-04
**Subject:** ADSBHub (`www.adsbhub.org`) — ADS-B receiver aggregation network

---

## 0. Two premise corrections (important)

1. **`afr321` is NOT ADSBHub.** It is an **Air France flight number** (AF321 / AFR321 —
   AirNav Radar, FlightAware, ADS-B Exchange all index it as a flight). There is no GitHub
   user, repo, or handle `afr321` associated with ADSBHub (GitHub API returns 404; the only
   near-match is an unrelated user `afr3214`). The task handle appears to be a conflation
   with the flight number.
2. **ADSBHub has no `vol4/table.json` or any HTTP/JSON data endpoint** — ever. Verified two ways:
   - Live probing: `/vol4/table.json`, `/vol4/`, `/table.json`, `/data/table.json`,
     `/api/table.json`, `/stations.json`, `/data.php`, `/ajax.php`, `/stats.php`,
     `/data/` — **all HTTP 404**.
   - **Wayback CDX** full-URL index of `adsbhub.org*` contains no `.json`, no `vol*`, and no
     bulk-data path — only `.php` UI pages, CSS/JS assets, and the WordPress `/docs/` blog.
     So this endpoint never existed on this host. The premise likely belongs to a different
     ADS-B project lineage (tar1090/Ultrafeeder-style deployments).

**The real ADSBHub identity is `www.adsbhub.org`** — confirmed via:

- Page copy: _"ADSBHub is a service for real time ADS-B data sharing and exchange between
  plane tracking enthusiasts, plane spotters and radio amateurs."_
- `robots.txt` → `Disallow:` (nothing disallowed — no API crawl hints)
- Footer: `© 2017` on main app, `© 2023` on the `/docs/` WordPress theme.

---

## 1. Community

| Channel               | Where                                                                    | Notes                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Primary community** | `sdr-enthusiasts` GitHub org + Discord                                   | The de-facto home of ADSBHub tooling. Docker image `ghcr.io/sdr-enthusiasts/docker-adsbhub`. Discord invite `discord.gg/sTf9uYF`. |
| **Docs**              | `sdr-enthusiasts.gitbook.io/ads-b/feeder-containers/feeding-adsbhub`     | "Feeding ADSBHub" chapter in the group ADS-B guide.                                                                               |
| **Forum**             | `forums.radioreference.com` thread 427649 ("ADSB Hub", Jun 2021, closed) | Thin, mostly unanswered support traffic — sign of low activity.                                                                   |
| **Site**              | `adsbhub.org/docs/`                                                      | WordPress blog, Kadence theme, Yoast SEO. Effectively empty — RSS `?feed=rss2` returns **0 `<item>`s**.                           |
| **Contact**           | `adsbhub.org/contactus.php`                                              | Only a form (name/email/subject/message). No public address, no staff identity.                                                   |

**Assessment:** ADSBHub is a small, largely **maintainer-absent** hobby project. The only real
signals of life are the `sdr-enthusiasts` Docker image and the `key.php` salt endpoint. The
RadioReference thread went unanswered, the blog has no posts, and the stats pages render
zeroed counters. Community is thin — this is not a tar1090/readsb-scale ecosystem.

---

## 2. Architecture (from official docs + feeder source)

### Inbound (you → ADSBHub) — push

- `data.adsbhub.org:5001` (TCP, client mode). Host resolves to **`94.130.23.233`**.
- Raw Beast hex or SBS/BaseStation (30003); Compressed VRS recommended.
- **IP allowlist required.** Station must be pre-registered in the user's profile
  (up to 4 IPs per account).
- Dynamic-IP handling uses a per-station **"Station dynamic IP update ckey"**.

### Outbound (ADSBHub → you) — aggregated pull

- `data.adsbhub.org:5002` (TCP), SBS/30003 format.
- **IP allowlist required** — quote: _"The TCP port is opened only for hosts (IP
  addresses) configured at your profile page!"_
- Reciprocal model: every user must feed ≥1 station and receives the aggregate of all other users' stations.
- Terms explicitly allow **free publication and commercial use**.

**Both ports confirmed TCP-reachable** (connection-only check, no handshake, no auth attempt
— per research-only constraint). Authorization is enforced at the application layer by
source IP, not by credentials on the wire.

### Auth model quirk (worth flagging)

The dynamic-IP updater in `docker-adsbhub` uses a **challenge-response with a shared rotating
MD5 salt**:

```
salt      = GET https://www.adsbhub.org/key.php            # 32 hex chars, rotates
md5       = md5( ckey + salt )                              # ckey = station secret
GET https://www.adsbhub.org/updateip.php?sessid={md5}{salt[-1]}&myip=…&myip6=…
# server echoes back md5+salt[-1] on success
```

This is a weak construction: the salt is **fetchable keyless by anyone**, and the station
`ckey` is the only real secret. `key.php` is unauthenticated and returns a live 32-char hex
string (observed: `baf1be8383b1a3751ceefb0f536266ab0`).

---

## 3. Keyless public endpoints — VERIFIED LIVE

These are the only publicly reachable, no-auth surfaces found. **None of them carry flight
data** — they are control-plane / metadata only.

| Endpoint                                   | Status           | What it returns                                                                                                                                                     |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://www.adsbhub.org/key.php`          | **200, keyless** | Rotating 32-hex-char MD5 salt (33 bytes w/ newline). Session-salt generator.                                                                                        |
| `https://ip4.adsbhub.org/getmyip.php`      | **200, keyless** | Caller's public IPv4 as bare text. ⚠️ **TLS cert does not match hostname** — requires `-k`; redirects oddly (`ip4.adsbhub.org:80` → `www.adsbhub.org/getmyip.php`). |
| `https://ip6.adsbhub.org/getmyip.php`      | **conn refused** | No listener (port 443).                                                                                                                                             |
| `https://www.adsbhub.org/station.php?id=N` | **200, keyless** | ⚠️ **Main finding.** Per-station public stat page.                                                                                                                  |
| `https://www.adsbhub.org/coverage.php`     | 200              | Coverage map shell (JS-driven).                                                                                                                                     |
| `https://www.adsbhub.org/docs/?feed=rss2`  | 200              | WordPress RSS — returns **0 items**.                                                                                                                                |
| `https://www.adsbhub.org/robots.txt`       | 200              | `User-agent: * / Disallow:` — nothing disallowed.                                                                                                                   |
| `https://www.adsbhub.org/disclaimer.php`   | 200              | Legal text.                                                                                                                                                         |

### Keyless station enumeration (main OSINT-relevant finding)

`station.php?id=N` requires **no session, no key, no referer**. Response titles leak
**station nickname + city + country**, and the body leaks per-station stat counters.

Sampling observed:

```
id=1     → "ADS-B Station IDSB Stats - / United States"
id=100   → "ADS-B Station KingAirPilot Stats - Bradenton, FL / United States"
id=1000  → "ADS-B Station Treviso Stats - Treviso / Italy"
id=2000  → "ADS-B Station Almere Stad Stats - Almere Stad / Netherlands"
id=5000  → "ADS-B Station Hong Kong Stats - Hong Kong / Hong Kong"
id=6000  → "ADS-B Station Casa Stats - Apex, NC / United States"
id=6500  → "ADS-B Station UT-ADS2 Stats - / Japan"
id=7000+ → generic title (no station → default page, HTTP 200 either way)
```

**Scale:** IDs 1–5000 confirmed populated; boundary is between **6500 and 7000**
(6500 valid, 7000 empty) → roughly **6,500 sequential station records**. Note invalid IDs
return **HTTP 200**, not 404, so enumeration must distinguish by title/body.

**Caveat on "zeros":** the stat counters (`totalplanes`, `uniqueplanes`, `totalposition`,
`uniqueposition`) render as hardcoded `0` in the initial HTML and are filled by
**AJAX polling** (`setInterval(StatusView3, …)`, `setInterval(StatusView4, 60000)`).
So the visible zeros are the _pre-fetch_ state — **not** evidence the network is dead.
I did not decode the obfuscated AJAX endpoint (base64 + RC4 string table, 158 entries),
so **I could not confirm live traffic volumes.** Do not report "ADSBHub is dead" on this
evidence.

The page also echoes the **client's own IP** into the page:

```js
var ConnectIP = "<egress-ip>"; // = the requesting IP
```

Used by the client-side connection self-check — confirms no per-user token is involved.

---

## 4. Mirrors

**No ADSBHub mirror or public bulk-data mirror was found.** Specifically:

- No third-party proxy/relay of ADSBHub's aggregate feed.
- No archive.org capture of any data endpoint (CDX index has none).
- The feed is TCP+IP-gated, so it cannot be casually mirrored the way HTTP JSON can.

**Practical takeaway:** ADSBHub is _not_ a usable keyless data source. For genuinely keyless
public ADS-B JSON/aggregates, the well-known options are adsb.fi, adsb.lol, OpenSky, and
ADS-B Exchange — none of which are ADSBHub-operated, and several of which now require
registration keys. If the objective is a keyless endpoint, ADSBHub should be dropped in
favor of those.

---

## 5. Gaps / not verified

- Live AJAX stats endpoint not decoded (obfuscator.io-style base64+RC4; RC4 key derived at
  runtime from a cookie, so static extraction failed). Page JS execution was declined by
  the user, so this stayed unverified.
- Whether any _account-free_ TCP access is possible on :5002 — not tested (out of scope,
  and it would be probing).
- Wayback CDX second query returned a malformed/error page with embedded base64 image blobs;
  the conclusions above rest on the first, clean CDX index plus live 404s.
- Community health judged from thin signals; no active forum presence found to confirm.

---

## 6. Reproduce

```bash
curl -sS https://www.adsbhub.org/key.php                      # keyless salt
curl -sSk https://ip4.adsbhub.org/getmyip.php                 # keyless IP echo (cert mismatch)
curl -sS "https://www.adsbhub.org/station.php?id=1000" | grep -o "<title>[^<]*</title>"
for p in vol4/table.json table.json stations.json data.php; do
  curl -sS -o /dev/null -w "$p %{http_code}\n" "https://www.adsbhub.org/$p"   # all 404
done
curl -sS "https://web.archive.org/cdx/search/cdx?url=adsbhub.org*&output=text&fl=original&collapse=urlkey"
```

Helpers written during this task: `/tmp/osint_search.py` (multi-engine scraper),
`/tmp/dec_rc4.py` (string-table decoder, unused — key not recoverable statically).
