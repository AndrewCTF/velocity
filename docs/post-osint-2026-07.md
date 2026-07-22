# r/OSINT — drafted 2026-07-17

Campaign plan rates r/OSINT the #2 planned channel (day 2), never fired. This
community is sharp and allergic to "tools" that are actually SaaS funnels or
that overpromise. Lead with what it fuses and what the evidence trail looks
like, not with the globe eye-candy.

## Account-heat caveat (read before posting)

Same as the r/selfhosted draft: u/Prestigious_Act3077 is spam-heuristic-hot and
one recent post was shadow-filtered. r/osinttools already took a post from this
account on 2026-07-17 that survived the filter, so the account isn't fully
burned — but r/OSINT (the big one) is stricter. Message the mods first with an
honest one-paragraph description and that you're the author, or let the account
cool 3-4 days. Post Tue/Wed/Thu 9-11am ET, check it's visible logged-out 30 min
in, and if it's filtered, message mods rather than reposting.

## TITLE (pick one)

- Self-hosted, keyless OSINT console: fuse ADS-B, AIS, satellites and conflict
  events on one globe, with an evidence trail you own
- I built a keyless situation console that records the world so you can replay it
- Free trackers keep cutting their history — so I self-host the whole picture

## BODY

Most live trackers are fine until you need the past. FR24 gives you 7 days of
history, MarineTraffic cut its free window to 24 hours, ADS-B Exchange killed its
free API. This records the picture on your own hardware and keeps it until your
disk cap says stop, so "where was this contact last Tuesday" is a scrub of a
timeline, not a subscription.

What it fuses onto one Cesium globe, all keyless: aircraft (OpenSky +
airplanes.live), vessels (AIS, MMSI-deduped across ShipXplorer and the
Norway/Baltic regional feeds), satellites (CelesTrak TLEs, client-side SGP4),
earthquakes, wildfires, GPS jamming inferred from ADS-B NACp/NIC degradation,
and conflict events. `docker compose up`, no API key for any core feed.

The analyst-workflow parts, since this is r/OSINT and not r/selfhosted:

- **Entity resolution + dossiers.** Click an aircraft or vessel, get a fused
  dossier (registry enrichment, track history, pattern-of-life) instead of a raw
  blob.
- **Evidence trail you own.** Captures go into an evidence locker with a SHA-256
  chain-of-custody log; cases export as self-contained HTML/PPTX. It's built so
  you can hand someone a package and they can check it didn't change.
- **Everything stays on your box.** Watch-lists and queries live on your
  hardware, not a vendor's. It fuses already-public broadcasts; it doesn't
  deanonymize anyone — the privacy-preserving direction, not the other one.
- **AI summaries are optional, labeled, and local.** They run against local
  inference if you point them at a local model, they're never auto-asserted as
  fact, and provenance lives in an append-only assertion log. Off by default.

**Honest caveats:** coverage is community feeders — dense over Europe/US, thin
over open ocean and (frustratingly) conflict zones. AIS is strongest in Northern
Europe. Single-analyst tool, not a team server. The 3D globe wants a real GPU;
the 2D map doesn't. AGPL.

Repo: https://github.com/AndrewCTF/velocity

Feedback I'd actually use: which keyless sources you'd run that I'm missing, and
whether the evidence export holds up against how you document a finding.

## RE-MEASURE before posting

Same one-liner as the HN draft (`docs/post-hn-2026-07.md`, "RUN THIS RIGHT
BEFORE POSTING") — paste in the true live counts with the stack up.

## DO NOT

- Ask for upvotes or stars.
- Overclaim the AI or the "intelligence" framing — this community will test it.
- Imply it does deanonymization or anything targeting private individuals; it
  fuses public broadcasts and that distinction is the whole OPSEC answer.
- Post from the hot account without mod pre-ack or a cooldown.
