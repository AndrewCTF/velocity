# Launch posts — draft (human voice, 90% info / 10% ad)

Positioning discipline (from docs/roadmap-users-2026-07.md):
lead with self-hosted + keyless + unlimited replay you own; never "AI-powered";
label automation honestly; caveat the keyless feeds. Audience spots hype fast.

---

## 1. r/selfhosted

**Title:** I got tired of flight/ship trackers paywalling history, so I self-hosted the whole thing — one Docker box, no API keys

I run a little home-lab habit of watching planes and ships over conflict zones,
and the same wall kept showing up: Flightradar24 gives you 7 days of history
free, MarineTraffic quietly cut its free window from 72h to 24h last year, and
ADS-B Exchange killed its free API tier. The live view is great right up until
you want to ask "what was over here *yesterday*" — and then it's a paywall or
it's just gone.

So I built a self-hosted situation console that fuses live aircraft, ships,
satellites and hazards (quakes, fires) onto one 3D globe, and — this is the part
I actually care about — records everything locally so you can scrub back in time.
Your archive lives on your disk. No vendor can shrink the window, filter it, or
sell the company out from under you.

Some notes for anyone who wants to poke at it:

- **Keyless by default.** ADS-B comes from the community grid (airplanes.live /
  adsb.lol), AIS from public sources, quakes from USGS, satellites from CelesTrak.
  You can run the core with zero accounts and zero API keys. A few extras (NASA
  FIRMS fire data, satellite imagery) want a free key but degrade gracefully
  without one.
- **History is the whole point.** Positions get written to a local SQLite/WAL
  store with retention you configure by disk budget, not by someone's pricing
  tier. Rewind the globe, replay a window, watch a track build up.
- **It's a real box, so be honest about cost.** At full firehose it's ~13k
  aircraft + tens of thousands of vessels; storage adds up over weeks. You size
  the retention to whatever disk you're willing to give it.
- **Runs on one machine.** FastAPI backend + a React/Cesium frontend + a couple
  of scraper sidecars. Watch-lists and queries never leave your hardware.

Caveats I'd want to know as a reader: the keyless feeds are community/public
sources, so coverage is best where feeders are dense (Europe/US great, open
ocean patchy). It's a heavy frontend — Cesium wants a GPU to feel smooth. And
it's early; I'm mostly looking for people to break it and tell me what's missing.

Not trying to replace your Grafana or your Frigate — this is a different itch
(geospatial OSINT + a time machine). If that's your kind of thing, happy to
share the compose file and answer setup questions in the comments.

---

## 2. r/OSINT

**Title:** The most under-appreciated OSINT capability isn't a new source — it's owning your own history

A pattern I keep hitting doing geospatial OSINT: the analysis you actually want
is temporal. "This vessel went dark here — when, and what was nearby?" "This
aircraft's pattern over three weeks." "Rewind to the hour of the incident."
Almost every live tracker is built to show you *now* and monetizes the past.
FR24 gates history, RadarBox charges for a year of it, ADSB-X removed its free
API, MarineTraffic trimmed its free window. The moment your question has a
timestamp, you're renting.

So I've been building a self-hosted console around the opposite assumption: the
live feed is table stakes, and the *archive you own* is the product. It fuses
aircraft + ships + satellites + hazards on one globe, records positions locally,
and lets you scrub back through whatever window your disk holds.

Things that matter to this crowd specifically:

- **Provenance over vibes.** Everything the tool derives is stored as
  assertions with a source and a timestamp, in an append-only local table.
  Anything automated is labeled automated. I deliberately did *not* build a
  "the AI thinks this is suspicious" black box — after watching the practitioner
  backlash against unlabeled AI "insights," that felt like a liability, not a
  feature. If a detector flags something, you can see why.
- **Evidence you can export.** There's a chain-of-custody-style evidence locker
  so a finding carries its sourcing when it leaves the tool — built with
  journalists/legal use in mind.
- **A real investigation layer.** Local ontology (entities, relationships,
  dossiers), detectors for things like AIS gaps / loitering, all on your box.
- **Keyless.** No account to start. The ADS-B/AIS/quake/satellite spine works
  with no API keys.

Honest limits: coverage follows the public/community feeders, so it's strongest
over land in dense-feeder regions and thin over open ocean; dark-vessel
detection is a helper, not a verdict — treat it as a lead, corroborate with
imagery. And I'm one person; the depth is real but the polish is uneven.

I'm posting mostly to sanity-check the premise with people who do this seriously:
is "unlimited local history you own" the thing, or am I over-indexing on it?
Would genuinely like the pushback. Can share the repo/compose if there's interest.

---

## 3. X / Twitter (thread)

1/
Flightradar24: 7 days of history free.
MarineTraffic: cut its free window 72h → 24h.
ADS-B Exchange: killed its free API tier.

The live map is never the paywall. Your *past* is. So I self-hosted a tracker
that records everything locally and lets you rewind. 🧵

2/
It fuses live aircraft ✈️ ships 🚢 satellites 🛰️ and hazards 🔥 onto one 3D
globe — the fused "conflict globe" is a commodity now, plenty of those exist.

The part nobody self-hostable offers: unlimited local history. Scrub back to any
hour your disk can hold. You own the archive.

3/
Keyless by default. ADS-B from the community grid, AIS from public sources,
quakes from USGS, sats from CelesTrak. No account, no API key to boot the core.

Watch-lists and queries never leave your machine. No vendor can filter, shrink,
or rug-pull the data.

4/
Design choice I'll defend: no unlabeled "AI thinks this is sus" box. Everything
derived is stored as a sourced, timestamped assertion; anything automated is
labeled automated. This audience (rightly) distrusts magic. Provenance > vibes.

5/
Honest caveats, because you'd find them anyway:
– coverage follows public feeders (great over land, patchy mid-ocean)
– Cesium globe wants a GPU
– storage grows with retention — you size it to your disk
– it's early and rough

6/
Runs on one box: FastAPI + React/Cesium + a couple sidecars, `docker compose up`.

Not trying to out-feature the cloud trackers. Competing on the one axis they
structurally can't: local-first, private, and replayable — the open world,
recorded, that you actually own.

Repo + setup in replies if you want to break it. 👇

---

## 4. Hacker News — Show HN

**Title:** Show HN: A self-hosted live world tracker that records unlimited local history

I built a self-hosted situation console: live aircraft, ships, satellites and
hazards fused on one 3D globe, recording every position to a local store so you
can rewind and replay any window your disk holds.

The fused live globe itself isn't novel — there are several open-source ones and
at least one polished commercial product (World Monitor). What I couldn't find
anywhere was the thing I actually wanted: **unlimited history that I own.** Every
commercial tracker paywalls the past — FR24 at 7 days, RadarBox at a paid year,
ADS-B Exchange removed its free API, MarineTraffic cut its free window in 2025.
A cloud vendor structurally can't give away unlimited history; a self-hosted
tool can, because it's your disk.

How it's built:
- FastAPI backend, React + CesiumJS frontend, a couple of scraper sidecars.
- Keyless core: airplanes.live/adsb.lol for ADS-B, public AIS, USGS quakes,
  CelesTrak for satellites (client-side SGP4 propagation). Optional free keys
  for NASA FIRMS and satellite imagery; degrades gracefully without them.
- Positions written to SQLite/WAL with retention sized by a disk budget you set.
- An investigation layer on top: a local ontology with sourced, append-only
  assertions (provenance is first-class), detectors, dossiers, evidence export.

Two opinions baked in that I'd be happy to argue about:
1. No unlabeled AI "insights." Anything automated is labeled automated and
   carries its source. The target audience treats black-box "this looks
   suspicious" output as a liability, and I agree.
2. The archive is the product, not the live view. The live view is table stakes.

Honest limitations: coverage tracks the public/community feeders, so it's strong
over dense-feeder regions (Europe, US) and thin over open ocean; the Cesium
frontend needs a GPU to feel good; storage grows with retention; and it's the
work of essentially one person, so depth is uneven and there are rough edges.
There's no public demo instance on purpose — feed-redistribution ToS and the
OPSEC/DDoS surface aren't worth it — so it's video/GIF + self-host for now.

I'd love feedback on one question in particular: is "own your history" the right
hill, or is the live fusion enough for most people? Repo and a docker-compose in
the comments.

---

## 5. Mastodon / short-form (fediverse, low-key)

Self-hosted OSINT thing I've been building: live planes/ships/sats/hazards on
one 3D globe, but it records everything locally so you can rewind time.

The pitch is boring on purpose — every cloud tracker paywalls history (FR24 = 7
days, ADSB-X killed its free API). Self-hosting means the archive is yours, sized
to your disk, no API key to start.

Keyless core, provenance-first (no black-box "AI says sus"), runs in one compose
file. Early and rough. Coverage follows public feeders so it's patchy over open
ocean — being upfront about that.

Boosts welcome if you know someone who'd want to break it. 🌍

---

## 6. r/DataHoarder  (written in the format of the pinned "Gaza archive" post — numbers-forward title, preservation framing, NOT an ad)

**Title:** Self-hosting the timeline of the physical world: ~13,000 aircraft + ~50,000 ships tracked live, every position written to local disk, rewind/replay any window, keyless (no API key, no account), append-only SQLite/WAL you own, GB/day you control | Built it because every flight & ship tracker paywalls or deletes its own history — this keeps it.

The single most hoardable dataset on Earth is *where everything is, minute by
minute* — and every company collecting it throws it away or paywalls it.
Flightradar24 keeps 7 days of history for free users. MarineTraffic cut its free
window from 72h to 24h in 2025. ADS-B Exchange removed its free API tier in
March 2025. RadarBox charges for a year of it. The live world scrolls past and
the past is deleted or rented back to you.

So I've been building a self-hosted recorder that captures it locally, forever
(or until your disk says stop), and lets you scrub back through it. Sharing it
here because this is the one sub that gets *why* that matters.

What it captures, continuously, to your machine:

- **Aircraft:** the community ADS-B grid (airplanes.live / adsb.lol) — on the
  order of ~13,000 aircraft airborne worldwide at any moment.
- **Ships:** public AIS sources, roughly ~50,000 distinct vessels (MMSI-deduped
  union of the keyless feeds).
- **Satellites:** CelesTrak TLEs, propagated with real SGP4 orbital mechanics.
- **Hazards:** USGS earthquakes, NASA FIRMS fire hotspots (optional free key).

The storage/archival specifics — the part that matters here:

- **Append-only local SQLite + WAL.** Every position is a row. Nothing phones
  home; the archive is a file you can back up, move, and grep like any other.
- **Retention = a disk budget YOU set**, not a pricing tier. Set the ceiling to
  `0` and it never prunes — hoard indefinitely.
- **Rewind/replay:** a timeline scrubber replays any window still on disk — watch
  a track rebuild, an AIS gap open, an incident hour play back.
- **Keyless core:** no account, no API key to start recording. Runs on one box
  via `docker compose up`.
- **Byte math (honest estimate, measurements pending):** at full firehose it's
  on the order of a few GB/day depending on dedup/retention settings. I'll post
  real measured numbers rather than guesses — but the point is *you* choose the
  fidelity/size tradeoff, not a vendor.

Caveats, up front so nobody feels sold to: coverage is only as good as the public
community feeders — dense over land and populated coasts, sparse over open ocean;
it's compute-heavier than a text scrape (the Cesium globe wants a GPU on the
client); and the exact GB/day figures are still being nailed down. This is a tool
I built, not a finished dataset dump — flagging that plainly because rule 6, and
because you'd (rightly) call it out otherwise. If "own the recorded timeline of
everything that moves" is your kind of hoard, I'd love storage-tuning ideas and
someone to sanity-check my byte math. Repo + compose file in the comments.

---

## 7. r/ADSB

**Title:** Built a keyless self-hosted globe that overlays the community ADS-B grid with ships/sats and records it all for replay

Most of us here already feed and already stare at tar1090/dump1090. This is a
layer on top of that world, not a replacement for it, so I'll keep it technical.

It pulls the community aggregators (airplanes.live, adsb.lol) for global breadth
plus grid overlays, dedups, and renders category icons on a Cesium globe with
proper track/heading rotation — then fuses ships (public AIS), satellites
(CelesTrak, client-side SGP4) and hazards on the same view. Keyless: no account,
no API key for the core feeds.

The reason I built it, and the r/ADSB-relevant bit:

- **It records.** Every position goes to a local store so you can rewind the
  globe and replay a window — an aircraft's pattern over hours/days, not just the
  live sweep. Retention sized by your disk, not a tier.
- **Honest about the upstream rules.** adsb.lol 451s non-browser UAs;
  airplanes.live throttles with HTTP 200 + text/plain (I reject non-JSON bodies);
  CelesTrak 403s on bursts (cached 2h). The scraper respects all of that with a
  burst semaphore so it's a polite consumer, not a hammer.
- World payload is a pre-rendered gzipped blob served on a 1s poll + WS push, so
  the globe stays live without pounding the aggregators per-client.

Not competing with tar1090 — different job (multi-domain fusion + local replay).
Genuinely want feedback from people who know these feeds cold: am I being a good
citizen to the aggregators, and is local replay something you'd use? Compose file
+ repo in comments.

---

## 8. r/homelab

**Title:** Weekend-ish homelab project: a live world-tracking globe that records its own history, one compose file, keyless

Filing this under "things to run on the box that's already on." It's a
self-hosted situation console — live aircraft, ships, satellites and hazards
fused on a 3D globe — that records every position locally so you can rewind and
replay. Think of it as a Frigate-for-the-outdoors: instead of NVR footage, it's
the recorded movement of the physical world, on your hardware.

Deployment shape:

- `docker compose up` brings the FastAPI backend, the React/Cesium frontend, and
  a couple of scraper sidecars up together.
- Keyless core — community ADS-B, public AIS, USGS quakes, CelesTrak sats — so no
  secrets management just to boot it. Optional free keys (NASA FIRMS fire data,
  imagery) if you want them.
- Stateful bit is a local SQLite/WAL positions store; back it up like any volume.
  Retention sized to whatever disk you allocate.
- Resource honesty: the backend is fine on modest hardware, but the Cesium
  frontend wants a GPU on the *client* to be smooth, and storage grows with
  retention. Not a Pi-zero job at full firehose.

It's early and there are rough edges — mostly posting to find homelabbers who'll
run it, tell me the deploy friction, and file issues about their setup. Compose
file in comments; happy to help anyone get it booting.

---

## 9. r/Python

**Title:** Show and Tell: a keyless, self-hosted OSINT globe (FastAPI + Cesium) that records the live world for replay

Sharing a project that's grown into a decent-sized Python codebase and might be
interesting to poke at architecturally.

It's a self-hosted console that fuses live aircraft/ships/satellites/hazards on a
3D globe and records every position locally so you can rewind time. The Python
side is where most of the interesting problems live:

- **FastAPI backend** serving a pre-rendered, gzipped world snapshot on a 1s poll
  + WebSocket push, with a sticky-snapshot pattern so N clients don't multiply
  upstream load.
- **Polite scraping** of rate-limited community feeds: burst semaphore, per-host
  UA rules, rejecting throttle responses that come back as HTTP 200 + text/plain,
  IPv4-pinned httpx clients. Lots of "the upstream lies to you" defensive code.
- **Satellites** via client-side SGP4 propagation (real orbital mechanics, not
  faked motion) fed from CelesTrak TLEs.
- **A local ontology** in SQLite: append-only assertions with provenance,
  detectors, dossiers — the investigation layer.
- ~1700 pytest tests gating a set of hard invariants (the feed quirks above are
  each pinned by a guard test, because every one of them regressed at least once).

Keyless by default; runs on one box via docker compose. It's opinionated
(provenance-first, no black-box AI output) and still rough in places. Mostly
looking for Python folks to critique the scraping/snapshot architecture and the
test strategy. Repo in comments.

---

## 10. r/gis / r/geospatial

**Title:** A self-hosted CesiumJS globe that fuses live ADS-B/AIS/satellite/hazard feeds and records them for temporal replay

Geospatial-flavored share. It's a self-hosted situation console built on CesiumJS
that pulls multiple real-time feeds onto one 3D globe and — the part I think is
under-served in this space — persists the positions locally so you can scrub
backward through time.

Feed/geo specifics for this crowd:

- Live layers: community ADS-B (aircraft), public AIS (vessels), CelesTrak
  satellites propagated client-side via SGP4, USGS earthquakes, NASA FIRMS fire
  hotspots (optional free key), plus basemaps from Carto.
- Rendering: category SVG icons with correct bearing rotation (track for
  aircraft, COG/heading for vessels), selection polylines, world-view decimation
  by stable hashing so the entity set doesn't churn on zoom.
- **Temporal:** every position is written to a local store; a timeline scrubber
  replays any window your disk retains. Most live map tools are stateless — this
  one keeps its own history.
- Keyless core, self-hosted, one compose file. Data stays on your machine.

Honest limits: coverage is bounded by public/community feeders (dense over
land, thin over open ocean), and Cesium wants a GPU. Looking for GIS folks to
critique the rendering/decimation approach and tell me what temporal-geo
workflows you'd want. Repo in comments.

---

## 11. r/geopolitics & r/CredibleDefense — NOTE, don't hard-sell

These subs ban/heavily moderate self-promotion and low-effort links. Do **not**
drop an ad. Two legitimate routes:
- Post genuinely useful *analysis* that happens to use the tool (e.g., an
  annotated replay of a real air/maritime event), with the tool mentioned only as
  methodology in a comment if asked. Value first, link maybe.
- Answer existing "how do I track X" questions with a real, sourced how-to and
  mention the self-hosted option as one of several, alongside FR24/ADSB-X/etc.
Anything that reads as marketing will (correctly) get removed. Skip these until
you have a concrete, shareable analysis artifact.
