# r/selfhosted — drafted 2026-07-17

Campaign plan (`docs/star-campaign-2026-07.md`) rates r/selfhosted the #1 planned
channel (day 1) and it has never fired. This community punishes marketing voice
and rewards "here is the thing I run at home, here is what it costs me." Lead
with the self-hosting story, not the feature list.

## Account-heat caveat (read before posting)

The Reddit account (u/Prestigious_Act3077) is spam-heuristic-hot — ~10 promo
posts in 8 days, and the 2026-07-16 r/DataHoarder post was shadow-filtered
before anyone saw it (post-mortem: `docs/post-datahoarder-2026-07-16.md`).
Before posting here:

1. Message the r/selfhosted mods first, one honest paragraph: what it is, that
   it's AGPL and self-hostable, that you built it, asking if a Show-and-Tell
   post is welcome. Mod pre-ack beats the filter.
2. Or let the account cool ~3-4 days with zero promo posts, then post on a
   fresh well-rested day. A filtered post here is a wasted #1 channel.
3. Post Tue/Wed 9-11am ET. Check it's visible logged-out 30 min in
   (r/selfhosted/new). If absent, it was filtered — message mods, don't repost.

## TITLE (pick one)

- I got tired of flight/ship trackers deleting their history, so I self-host one
- Self-hosted flight + ship + satellite tracker: one compose file, no API keys,
  keeps history until your disk fills
- Own your tracking history: a keyless situation console you run at home

## BODY

The pitch for self-hosting this is history. Flightradar24's free tier gives you
7 days. MarineTraffic cut its free window from 72 to 24 hours. ADS-B Exchange
killed its free API tier. Every "where was this vessel last Tuesday" was a
subscription. A box in my house doesn't have that problem — it records the world
and keeps it until my disk cap says stop.

It's a FastAPI backend and a Cesium globe that fuse aircraft (OpenSky +
airplanes.live community grid), vessels (keyless AIS, MMSI-deduped), satellites
(CelesTrak TLEs, client-side SGP4), earthquakes, wildfires, and conflict events
onto one globe with a replay scrubber. `docker compose up` brings up api + web +
nginx on :8080. No API key for any core feed.

**What it costs to run** (the part this sub actually cares about):

- Backend: Python 3.12, ~1 GB RAM, outbound HTTPS only. Runs fine on a small VPS
  or an old NUC.
- Frontend: the 3D globe wants a real GPU on the *viewing* machine, but the
  2D-dark map runs on integrated graphics. The server doesn't render anything.
- Storage: one SQLite file, retention is a byte cap you set. Mine's capped at
  2 GB and currently holds 8.7M archived positions; set it to 50 GB and it keeps
  months. `docker compose down` doesn't lose your data — it's a named volume.
- No database service, no Redis, no message queue. State is in-process + SQLite.
  The whole dependency list is Docker + the compose plugin.

**Honest caveats:** coverage is community feeders, so it's dense over Europe/US
and thin over open ocean. It's a single-analyst tool, not a multi-user team
server (no per-user accounts yet). There are optional AI summary features; they
run against local inference if you point them at a local model, and they're off
by default. AGPL, because self-hosting is the whole point and I don't want a
hosted fork closing it.

Repo (compose file, screenshots, hardware table): https://github.com/AndrewCTF/velocity

Genuinely useful feedback: which keyless sources you'd actually run that I'm
missing, and whether the resource footprint holds on your hardware.

## RE-MEASURE the numbers before posting

The "8.7M positions / 2 GB" and any live counts drift. With the stack up on :8000,
run the one-liner in `docs/post-hn-2026-07.md` ("RUN THIS RIGHT BEFORE POSTING")
and paste in the true values.

## DO NOT

- Ask for upvotes or stars, ever.
- Reply defensively to the first "isn't this just FR24?" — answer it plainly
  (history you own, self-hosted, keyless) and move on.
- Lead with the AI features. This sub reads that as SaaS-in-disguise.
- Post from the hot account without mod pre-ack or a cooldown first.
