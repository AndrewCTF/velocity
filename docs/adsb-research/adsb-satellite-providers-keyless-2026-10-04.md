# Space-based ADS-B providers — is any endpoint free and keyless?

**Date:** 2026-10-04 · **Method:** provider docs, live API contracts (OpenAPI/Swagger), public DNS
resolvers, Wayback CDX. Marketing pages were not trusted for auth claims. **No data endpoints were
called** — docs only.
**Companion docs:** `adsb-aggregators/alt-free-adsb-apis-2026-10-04.md` (terrestrial keyless tier),
`adsb-oceanic-nat-pacific-open-access.md` (Aireon/NAT), `docs/adsb-keyless-ocean-coverage.md`.

---

## TL;DR

**No. There is zero free, keyless, space-based ADS-B data anywhere.** Every operational
space-based ADS-B constellation is a commercial product sold by contract. Two of the three
candidates named in the task brief do not exist any more.

| Named candidate             | Verdict                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ADSBX** (`api.adsbx.com`) | **DEAD.** API host is `NXDOMAIN`; apex domain is a parked GoDaddy lander. The free keyless API no longer exists.                                             |
| **airto.io**                | **DOES NOT EXIST.** `NXDOMAIN` at the zone level. Never was an ADS-B provider — no such service appears anywhere.                                            |
| _(satellite providers)_     | Aireon, Spire, KSAT, ExoAnalytic — all commercial. The only non-commercial satellite ADS-B access (Contrails.org/Spire) is **API-key + organization gated**. |

The premise "satellite is the only viable path to true open-ocean ADS-B" is **physically correct**.
The conclusion that follows is the finding: **that path is unreachable for this project.**

---

## 1. Space-based ADS-B providers — access reality

| Provider                                         | Platform                                                                                    | Public endpoint?                          | Auth                                                                                                   | Free?                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Aireon** (operational since 2019-03-27)        | ADS-B payloads on all **75 Iridium NEXT** sats                                              | **No public API.** Sold to ANSPs/airlines | Commercial contract (resold by FlightAware as AeroVue/Firehose)                                        | **No.** "Flat, affordable **monthly price**", subscription-gated                                         |
| **Spire Aviation**                               | ADS-B on Lemur-2 CubeSats                                                                   | Indirect, via **Contrails.org**           | `x-api-key`, issued by e-mailing `api@contrails.org` **with an organization**; "authorized users" only | Research-grade and effectively free, but **key-gated + relationship-gated**, not self-serve, not keyless |
| **Kongsberg Satellite Services**                 | KSAT                                                                                        | Product page 404s; commercial only        | Sales contact                                                                                          | No                                                                                                       |
| **ExoAnalytic**                                  | Space-based composite ADS-B                                                                 | No public self-serve API                  | —                                                                                                      | No                                                                                                       |
| **LeoLabs**                                      | _Now "Persistent Orbital Intelligence"_ — space-domain awareness, not an ADS-B data product | No                                        | —                                                                                                      | No                                                                                                       |
| ESA PROBA-V (2013), GomSpace/Aalborg, **SATERA** | Experiments / academic                                                                      | Papers and Zenodo datasets only           | —                                                                                                      | N/A — research, not a service                                                                            |

### Direct citation that satellite ADS-B will not be free

FlightAware is Aireon's reseller. Their own FAQ, asked "Will Aireon space-based ADS-B data be
available for free on FlightAware.com?", answers:

> "FlightAware is exploring ways to publicly leverage this data. **Because this is an extremely
> expensive endeavor, our initial focus is on incorporating the data into commercial products to fund
> the project.**"

and on price: _"Unlike satcom services, Aireon space-based ADS-B is provided at a flat, affordable
monthly price"_ … _"With a **subscription** to Aireon space-based ADS-B, global coverage … is
seamlessly fused into FlightAware products."_
— https://www.flightaware.com/commercial/aireon/

That is the vendor's own statement, on their own product page. It settles the question.

### The one satellite-adjacent lead worth remembering

`https://api.contrails.org/v1/adsb/telemetry` — **1 hour of all-global ADS-B as Apache Parquet**
(hourly resolution, up to 30 s to return). Verified from `apidocs.contrails.org`: _"The underlying
ADS-B data is provided by **Spire Aviation**."_ This is genuinely satellite-derived and genuinely
global. It is **not keyless** — `x-api-key` header required, access granted by e-mailing
`api@contrails.org` with subject "Common ADS-B Access" describing your organization.
**Route:** if ocean coverage is ever worth a relationship, this is the cheapest door in — a research
program, not a purchase order. Do not build on it as a self-serve feed.

---

## 2. The two named candidates are both dead ends

### ADSBX — the free keyless API no longer exists

- `api.adsbx.com` → **NXDOMAIN** from two independent public resolvers
  (Cloudflare DoH `Status 3` with SOA for `adsbx.com`; Google DoH `Status 3`). The `adsbx.com` zone
  still exists — `opendata.adsbx.com` is likewise NXDOMAIN, so this is a removed record, not a
  dead zone.
- Apex `adsbx.com` resolves only to GoDaddy parking IPs (`3.33.130.190`, `15.197.148.33`, NS
  `ns59.domaincontrol.com`) and serves a **114-byte** page: `<script>window.onload=…"/lander"</script>`
  — a domain-parking lander. **The domain has lapsed.**
- Wayback has **no snapshots** of `adsbx.com` or `api.adsbx.com` (method validated against
  `github.com`, which returns captures normally).

**Do not put `api.adsbx.com` in any failover list.** Name disambiguation, because "ADSBX" is
commonly conflated with three different things, none of them a free satellite feed:

1. **ADS-B Exchange's feeder software** — `ADSBexchange/adsbx-update` on GitHub (the SD-card image).
   Purely a feeder; contributes data _to_ ADS-B Exchange. Not an API.
2. **ADS-B Exchange's "ADSBx Flight Sim Traffic" RapidAPI** — a _paid_ RapidAPI listing, retired
   **2025-03-01**.
3. **ADSBX (`api.adsbx.com`)** — the old third-party free no-key mirror. This is the one that died.

### airto.io — does not exist

- `airto.io` → **NXDOMAIN at the zone level** (Cloudflare DoH returns the `.io` TLD SOA, no answer
  records). The domain is unregistered/nonexistent.
- No ADS-B service named "airto"/"Airto" appears in any search; results are unrelated (NTRS PDFs,
  OCR noise).
- **Likely a garbled reference.** Nearest real candidates, all of which are _not_ keyless:
  **AirLabs** (`airlabs.io` — key-gated, returns "Application not found" unauthenticated),
  **AvioADSB** (`avioadsb.org`), **AirNav RadarBox** (free page is a login wall).

---

## 3. What _is_ genuinely keyless today — all terrestrial, none with ocean reach

Verified against live API contracts, not READMEs:

| Endpoint                                     | Keyless?                                  | Verified how                                                                                                                                                                                                                        | Ocean reach                               |
| -------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `api.adsb.lol/api/openapi.json` + `/v2/*`    | **Yes — genuinely**                       | Live contract has **`securitySchemes: {}`, no global `security`, and 0 of 18 operations declare security**. ODbL                                                                                                                    | **None** — terrestrial only               |
| `opendata.adsb.fi/api/v3/lat/…/dist/…`       | **Yes**                                   | README: public endpoints open; 1 req/s; **4xx/5xx count toward the limit**; personal non-commercial + must cite                                                                                                                     | **None**                                  |
| `avioadsb.org/v1/point/…`                    | **Yes**, anonymous ~10,000 req/mo         | Docs: `X-API-Key` optional. ⚠️ **`/v1/aircraft` (every live aircraft) is contributors-only** — run a receiver to unlock                                                                                                             | **None**                                  |
| `opensky-network.org/api/states/all`         | **Yes**, anonymous tier — but **metered** | Official REST doc: _"Anonymous users (unauthenticated, bucketed by IP)"_, **400 credits/day**, recent vectors only, 10 s resolution; global bbox = 4 credits → ~100 global calls/day. Higher tiers need OAuth2 `client_credentials` | **None**; no ADS-C in the public REST API |
| `api.airplanes.live/v2/*`                    | **No**                                    | Hand-written 403; human-reviewed key; 500 req/day free                                                                                                                                                                              | n/a                                       |
| `gateway.adsbexchange.com/api/aircraft/v2/*` | **No**                                    | `api-auth: YOUR_API_KEY` header required on every endpoint                                                                                                                                                                          | n/a                                       |

⚠️ **Note the trap in AvioADSB:** the anonymous tier covers point/hex/callsign/squawk lookups, but the
one endpoint an ocean sweep actually needs — _every live aircraft_ — is **contributors-only**. You
must run a receiver to unlock global snapshots. Same shape as adsb.fi's feeder-IP-only
`/v2/snapshot`. Keyless ≠ globally enumerable.

⚠️ **OpenSky is keyless but not unmetered.** The 400-credit anonymous pool is **shared per IP** and
refills daily; if the running app already draws on it, adding it is not "free". Its anonymous tier is
also restricted to the most recent state vectors (no `time` parameter) at 10 s resolution.

---

## 4. Conclusion for the project

1. **Do not pursue a satellite ADS-B provider.** It does not exist at any price point we could
   self-serve. The physics is right, the access is not.
2. **Purge `api.adsbx.com` from every config and failover list** — the domain is a parked lander;
   the endpoint is NXDOMAIN. Same for any note that cites `airto.io`.
3. **If open-ocean aircraft positions are a hard requirement**, the only routes are (a) buy Aireon,
   (b) apply to the Contrails.org/Spire research program, or (c) pivot to **ADS-C** — reports broadcast
   _by the aircraft_ over satellite, which is the mechanism actually used for oceanic procedural
   separation. ADS-C is also not public: ADS-B Exchange publishes a full build spec for C-band dish
   receivers aimed at Inmarsat, but there are <50 such stations worldwide.
4. **For everything else**, the honest ceiling is terrestrial reach: ~250 NM from a receiver. Deep-ocean
   counts stay at single digits on every keyless feed — the zeros are the finding, not a bug to fix.
