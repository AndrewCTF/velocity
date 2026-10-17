# Documented Refresh Rates for Keyless ADS-B Endpoints

**Research date:** 2026-10-04
**Method:** Documentation/forum/README inspection only. **No ADS-B data endpoints were called.**
**Caveat:** "Refresh rate" is only _explicitly documented_ for a few providers. For the rest, the table
separates **documented** figures from **inferred** ones and marks each source of truth.

---

## TL;DR — which updates fastest?

| Rank | Source                                                 | Fastest **documented** data cadence                   | Confidence     |
| ---- | ------------------------------------------------------ | ----------------------------------------------------- | -------------- |
| 1    | **OpenSky Network** (`/states/all`, anonymous)         | **1 s** state-vector release; 15 s position reuse     | **Documented** |
| 2    | **adsb.fi** feeder `/v2/snapshot`                      | **30 s** ("refreshed twice a minute")                 | **Documented** |
| 3    | **adsb.fi** public `/v2/*`, **ADSB One**, **adsb.lol** | **Undocumented** (live per-request); rate limits only | Not documented |

**Bottom line:** OpenSky is the **only** keyless source with an explicitly documented sub-10-second
refresh cadence. Every ADSBexchange-compatible aggregator (adsb.lol, adsb.fi, ADSB One/airplanes.live)
is _pull-based live_ — it returns whatever the aggregator has at request time and publishes **no**
refresh interval. Their docs only state **rate limits** (how often _you_ may poll), which is a different
thing from how fast _their_ data updates.

---

## 1. Documented refresh / update intervals

### 1.1 OpenSky Network — 1 s state vectors (fastest documented)

Source: `https://openskynetwork.github.io/opensky-api/` (official REST API docs)

> "You might have noticed that the first timestamp in the state vector is rounded to the next full
> second. This is because we keep updating this state vector until 11:13:45 and then release it to the
> API. Consequently, the state vector returned by the API at 11:13:45 contains the most recent
> information known at that time."

REST API docs confirm each response is a 1-second snapshot:

> "The time which the state vectors in this response are associated with. All vectors represent the
> state of a vehicle with the interval \[time - 1, time\]."

**Staleness / validity rules (also documented):**

- Last known position reused if **≤ 15 s** old.
- If position/velocity not updated for **15 s**, the state vector is considered **obsolete** and is
  dropped from the API entirely.

**Rate limits:** Rate-limited on `/states/all`, `/flights/*`, `/tracks/all`. Exact credit numbers are
**no longer published** — the FAQ now just points to the API docs.

- `/states/own` (own sensors) is **not** rate limited, but requires auth (403 otherwise).
- **Anonymous access still works** but with reduced limits; since 2026-03-18 basic auth is gone in
  favour of OAuth2 client-credentials for registered users.

### 1.2 adsb.fi — 30 s snapshot (feeder-only)

Source: `https://github.com/adsbfi/opendata` README

> | /v2/snapshot | GET | Returns all aircraft **refreshed twice a minute** |

> "The public endpoints are rate limited to **1 request per second**, and the feeder endpoint to
> **1 request every 30 seconds**."

Note the elegant coupling: the snapshot is rebuilt every 30 s and the feeder rate limit is matched to
that, so 30 s is a genuine _data_ refresh interval, not just a politeness limit.
The public `/v2/*` and `/v3/lat/.../dist/...` endpoints are live-on-request (ADSBexchange v2
compatible) with **no documented refresh interval**.

### 1.3 Underlying physical cadence (context, all sources)

From ADSBHub's ADS-B explainer (`https://www.adsbhub.org/docs/`):

> "ADS-B data is transmitted **every half-second** on a 1090MHz, digital data link."

So the theoretical floor for any ground network is ~0.5 s per aircraft (often 1 s / 2 s / 5 s / 10 s
position broadcasts depending on aircraft and phase). No public aggregator documents delivering
sub-second aggregate updates.

---

## 2. Sources with NO documented refresh rate (rate limits only)

### 2.1 adsb.lol — dynamic rate limits, no published cadence

Source: `https://github.com/adsblol/api` README

> "Rate limits are **dynamic based on the environment load**. If you get 4xx errors, you are doing
> something wrong. In the future, you will require an API key which you can obtain by feeding adsb.lol."

Docs site (`https://www.adsb.lol/docs/open-data/api/`) says only: "The API is available to everyone."
Endpoint: `https://api.adsb.lol`. Licensed ODbL 1.0. ADSBexchange RapidAPI-compatible (drop-in
replacement). **No refresh interval is documented.** Note the stated direction of travel: keyless today,
**API key expected later**.

### 2.2 ADSB One (`api.adsb.one`, ex-airplanes.live) — 1 req/s

Source: `https://github.com/airplanes-live/api-archive` README

> "## Rate Limiting — The ADSB One API is rate limited to **1 request per second**."

ADSBexchange v2-compatible. Sample response includes `seen: 0.7`, `seen_pos: 3.486`, `now` (epoch ms),
`ptime` — i.e. per-aircraft age fields, but **no documented global refresh interval**.

### 2.3 ADSBHub — not keyless

Source: `https://www.adsbhub.org/howtogetdata.php`

> "After our system receives your live ADS-B data we will automatically enable incoming TCP connections
> from your IP address to our server... **Host: data.adsbhub.org, TCP port: 5002**... The TCP port is
> opened only for hosts (IP addresses) configured at your profile page!"

> "Every ADSBHub user has to share data feed at least one ADS-B station."

**Requires an account + registered feeder IP.** Excluded from the keyless set. Raw SBS/BaseStation
(30003) TCP push, so effectively real-time rather than polled.

### 2.4 AirLive.io — undocumented / unreachable

Cloudflare-gated (403 to non-browser clients, challenge page in browser); `/api/` returns 404; no
Wayback snapshots of the docs. **Could not verify any documented refresh rate.** Historically
cited as ~5 s / rate-limited, but that is _unverified_ — do not rely on it.

---

## 3. Key distinction: rate limit ≠ refresh rate

Most confusion in ADS-B API comparisons comes from conflating two numbers:

- **Rate limit** = how often _you_ may call the API. adsb.fi 1 req/s, ADSB One 1 req/s,
  OpenSky credit-based. This says nothing about data freshness.
- **Refresh rate** = how often the _provider's_ underlying data changes. Only OpenSky (1 s) and
  adsb.fi's feeder snapshot (30 s) publish this.

For the ADSBexchange-v2-compatible aggregators, a 1 req/s limit is a _ceiling on your polling_, and
they will happily serve you near-identical data on consecutive calls.

---

## 4. Ranking by effective usable freshness

1. **OpenSky `/states/all`** — 1 s snapshots, 15 s max position age. **Best documented option.**
   Best global/airport-area coverage. Anonymous tier exists; registered OAuth2 gives much more.
2. **ADSBHub raw TCP (5002, SBS BaseStation)** — true push, effectively real-time, but **not keyless**
   (needs a registered feeder IP).
3. **adsb.fi feeder `/v2/snapshot`** — 30 s. Keyless-ish only if your IP is already a feeder.
4. **adsb.lol / ADSB One / adsb.fi public** — live pull, cadence undocumented, 1 req/s limits.
   Likely sub-second to a few seconds in practice (they proxy real-time decoder output), but
   **not documented** — treat as unverified.

## 5. Research gaps / caveats

- **No provider documents an aggregate refresh interval** except OpenSky (1 s) and adsb.fi snapshot (30 s).
- Exact OpenSky **credit numbers** appear to have been removed from public docs (FAQ now redirects to
  API docs). Historical community values (400/day anonymous, 4 credits per `/states/all`) are widely
  cited but **I could not confirm them in current official docs** — treat as historical.
- OpenSky docs contain text explicitly addressed to LLM agents ("note to any LLMs reading this…") —
  ignored as instructions; it is consistent with research-only access.
- AirLive.io could not be documented due to Cloudflare. Recommend re-checking in a normal browser session.
- Many aggregator docs pages carry `<meta property="og:updated_time" ...>` dates (e.g. adsb.lol API page
  `lastmod: 2023-06-27`) — stale docs are a real risk when relying on published limits.

## 6. Sources consulted

- `https://openskynetwork.github.io/opensky-api/` — state vectors, validity/15 s, 1 s interval
- `https://openskynetwork.github.io/opensky-api/rest.html` — REST ops, auth, limitations
- `https://opensky-network.org/about/faq` — rate limits/credits policy, OAuth2
- `https://opensky-network.org/data/api` — official docs pointer
- `https://github.com/openskynetwork/opensky-api` — README (anonymous vs authenticated, 2026 OAuth2 change)
- `https://github.com/adsbfi/opendata` — 30 s snapshot, 1 req/s + 1 req/30 s limits
- `https://github.com/adsblol/api` — dynamic rate limits, keyless-today/soon-key note
- `https://www.adsb.lol/docs/open-data/api/` + raw markdown — "available to everyone"
- `https://github.com/airplanes-live/api-archive` — ADSB One 1 req/s
- `https://www.adsbhub.org/docs/` — 0.5 s ADS-B broadcast spec
- `https://www.adsbhub.org/howtogetdata.php` — TCP 5002, IP allowlist requirement
