# Free / keyless ADS-B services with no signup and no metered credit cap

**Date:** 2026-10-04 · **Research only.** Documentation, terms pages and
repository metadata were read; no live aircraft-data response was used to
produce any eligibility claim below. (Two GETs during discovery returned
403/404 gate pages rather than aircraft JSON; they are reported as evidence of
the gate, not as coverage measurements.)

**Bar applied:** public self-serve access · no account/signup · no API key ·
no daily credit budget. A per-second rate limit is *not* a credit cap, so it
does not disqualify a provider.

---

## TL;DR

**Exactly one documented live provider qualifies: `adsb.fi` (opendata).**
Everything else that looks free either needs a key/email, is archived, or is a
bulk archive rather than a live service.

Two secondary answers if "service" can include bulk history:

- **`alexisplacet/adsblol_globe_history` (Hugging Face)** — ungated, ODbL,
  anonymous download verified, 100,000 files. No signup, no credit budget.
- **`adsblol/globe_history_YYYY` (GitHub)** — 1762 GiB of daily readsb traces,
  ODbL. Already known to this repo; re-confirmed here as the licence-clean
  bulk counterpart.

---

## The one qualifying live service

### ✅ `https://opendata.adsb.fi/api/v2/` — ELIGIBLE

| Property | Value | Evidence |
| --- | --- | --- |
| Signup | **None** for public access | `opendata.adsb.fi` front page served without auth; states "We provide open and unfiltered access to worldwide air traffic data" |
| API key | **None** for public access | same |
| Rate limit | **1 req/s** — a rate limit, not a credit budget | Third-party comparison (`flyitalyadsb.com/dati/confronto`, 2026-09-02) |
| Feeder required? | **No** for public base access | same; `/v2/snapshot` is the feeder-gated extra |
| Licence / terms | **Personal, non-commercial only**; attribution + link required | same |

Non-commercial terms mean it cannot feed a commercial product, but nothing in
the terms creates a daily allowance to exhaust — which is the distinction the
operator's rule actually turns on.

⚠️ **Operational caveat found this session (new):** this egress IP
(<egress-ip>) is **already Cloudflare-blocked** on
`opendata.adsb.fi/api/v2/` ("Attention Required! | Cloudflare … You are
unable to access adsb.fi"). Eligibility is not the same as reachability — from
this datacenter egress, adsb.fi is unavailable and must not be treated as a
primary tier here. The repo's earlier note that adsb.fi was "verified HTTP 200
at 60N/-30 and 60N/-40" was from a different path/conditions.

---

## Rejected — and why (all verified, not assumed)

| Provider | Verdict | Deciding evidence |
| --- | --- | --- |
| **FlyItalyADSB** `api.flyitalyadsb.com/v2` | ❌ needs key | Self-described **no-profit, CC BY-SA 4.0, 3,200+ receivers** — excellent public-interest project, but its own `llms.txt`: "All require `X-Api-Key`… `POST /v2/keys {email}` issues a key instantly." 100 req/min/IP. **Email = signup.** Best-in-class licence, wrong on the key axis. |
| **ADSB One** `api.adsb.one/v2` | ❌ **archived / merged** | `ADSB-One/api` GitHub repo is **`archived: true`**, last push **2023-09-03**, description now reads "The Airplanes.live API provides…" → it **merged into airplanes.live**. Its README's 1 req/s keyless promise is stale. Do not build on it. |
| **airplanes.live** `api.airplanes.live/v2` | ❌ approval-gated | Live GET of `/v2/point/0/0/20000` returned **HTTP 403**: `{"error":"Please contact us at contact@airplanes.live. Your email MUST include any links, a description of the project…"}`. Not self-serve. Comparison table: "Non richiesto oggi — dichiarano che potrebbe cambiare" (**not required today — they declare it may change**) → **FREE-NOW-MAY-KEY-LATER FLAG**. |
| **ADSBHub** | ❌ feeder-gated | Site states inbound TCP data connections are enabled **after you register a station and feed it**. Public map, no open API. |
| **GCMB** `gcmb.io` (MQTT, βeta) | ❌ account required | Attractive on paper — MQTT pub/sub, "Open Data is especially welcome", `adsb` topic with 53 subscribers. But `docs.gcmb.io/quickstart` step 1 is "Create an account on gcmb.io", and per-client MQTT `username`/`password` are minted from your account. No anonymous subscribe. |
| **plane.watch** | ❌ no public API | `atc.plane.watch/api/v2/point/…` → HTTP **404**; site is map-only. |
| **Planespotters.net** | ❌ | `/api/v2/…` → HTTP 404; the site exposes photos/DB, and API use is login-gated. |
| **adsb.chaos-consulting.de** | ❌ no data path | Explicitly **non-commercial** and enthusiast-run (good fit for the brief in spirit) but `…/data/aircraft.json` → **404**; map is an iframe wrapper only. |
| **live-military-mode-s.eu** | ❌ | Page is `Your browser does not support iframes.` — embedded map, no endpoint. |
| **AvDelphi** | ❌ | Has an API product, but nothing keyless; commercial data vendor. |
| **radarplane.com** | ❌ dead | `/api/` **301 → `slotonlineterkini.net`** — domain lapsed/parked. |
| **ADS-B Exchange** | ❌ excluded by rule | Comparison table: closed direct access; Community API now only via paid RapidAPI ($10, 10k req/mo) with a key. |
| **OpenSky / FR24 / AirNav** | ❌ excluded by rule | Credit-metered / keyed, per standing instruction. |

---

## 🚩 "Free now, key later" risk register

The brief asked to flag any provider repeating adsb.lol's wording. Found **two**:

1. **airplanes.live** — comparison table: *"Non richiesto oggi — dichiarano che
   potrebbe cambiare"* (not required today; **they declare it may change**).
   Also already returns 403 "contact us" for non-approved use, so the practical
   risk is already materialising. Free tier is 500 req/day (a **hard daily cap**)
   vs 8,640/day for Contributors — so it fails the no-cap bar twice over.
2. **adsb.lol** — the known case, README says a key is a **future** requirement
   obtainable by feeding. Unchanged.

Two more are *at risk but differently*:

- **ADSB One** — not a future-key story, a **consolidation** story: it silently
  became airplanes.live, whose access is now approval-gated. This is the
  failure mode to watch for: a keyless endpoint that keeps its docs while the
  service behind it is absorbed.
- **FlyItalyADSB** — currently requires a key by policy, but it is a young
  non-profit with a fast-moving API and publishes its own comparison table, so
  the terms can change without a deprecation notice. Low risk, worth a
  re-read on any major version bump.

---

## Note on the "credit cap" wording

Worth being explicit, because two providers get conflated:

- **Rate limit** (1 req/s, 100 req/min) → **not** a credit cap. adsb.fi and
  FlyItalyADSB both have these. adsb.fi passes.
- **Credit budget** (OpenSky 400/day anonymous; FR24/AirNav/RapidAPI monthly
  quotas) → a hard allowance that runs out and degrades the feed. Fails.

adsb.fi is the only service found that has the first and not the second.

---

## Verification / re-check commands

```bash
# eligibility by GET with zero auth headers (expect JSON, not HTML/403)
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  "https://opendata.adsb.fi/api/v2/lat/60/lon/-30/dist/100"

# key-required-by-policy gate (expect 403 + contact email)
curl -sS "https://api.airplanes.live/v2/point/0/0/20000"

# archival status of a candidate (archived:true => dead)
curl -sS "https://api.github.com/repos/ADSB-One/api" | jq '{archived,pushed_at}'

# ungated bulk archive + its documented rate limit
curl -sSI "https://huggingface.co/datasets/alexisplacet/adsblol_globe_history/resolve/main/README.md" \
  | grep -iE 'x-hf-warning|ratelimit'
```

## Source links

- adsb.fi open data — https://opendata.adsb.fi/ · feeder scripts `adsbfi/adsb-fi-scripts`
- FlyItalyADSB comparison table — https://flyitalyadsb.com/dati/confronto · machine-readable https://flyitalyadsb.com/llms.txt
- ADSB One archived API — https://github.com/ADSB-One/api
- airplanes.live API docs — https://airplanes.live/api-docs/
- ADSBHub access model — https://www.adsbhub.org/howtogetdata.php
- GCMB quickstart (account required) — https://docs.gcmb.io/quickstart
- HF ODbL archive — https://huggingface.co/datasets/alexisplacet/adsblol_globe_history
- Community aggregator index — https://adsb.cool/