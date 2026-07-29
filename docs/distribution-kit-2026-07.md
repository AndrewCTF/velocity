# Distribution kit — 2026-07-26

Everything needed to pitch Velocity without rewriting the pitch each time:
the standing copy, the channel list with a status column, and the measurement
loop. Strategy and channel ranking live in the plan this came from; this file
is the executable half.

Operator constraints, fixed 2026-07-26: goal is **stars / visibility**, there
is **no public demo instance** (video is the only "try it" surface), and the
name stays **velocity**.

## 1. Baseline (measured 2026-07-26, re-measure before claiming movement)

| Metric | Value |
|---|---|
| Stars | 39 |
| Views / uniques, 14 d | 511 / 254 |
| Clones / uniques, 14 d | 1,068 / 234 |
| Referrers, 14 d | reddit 42 uniques, HN 21, github 14 |
| First Show HN (2026-07-11) | 4 points, 2 comments |
| External backlinks | none outside the repo itself |
| Directory listings | none |

```bash
gh repo view --json stargazerCount -q .stargazerCount
gh api repos/:owner/:repo/traffic/views
gh api repos/:owner/:repo/traffic/clones
gh api repos/:owner/:repo/traffic/popular/referrers
```

A channel that produces no referrer row within 72 h of going live did not
fire. Record that outcome instead of counting the submission as a win.

## 2. Standing copy

Numbers below were true on 2026-07-26 (site counters, `verify.sh` baseline).
Re-check before pasting: aircraft and vessel counts drift with time of day.

**One-liner (25 words)**

> Velocity is a self-hosted OSINT console: live aircraft, ships, satellites
> and hazards on one 3D globe, with position history you own and can replay.

**Short (50 words)**

> Velocity fuses live aircraft, ships, satellites, earthquakes and conflict
> events onto one 3D globe, self-hosted, with no API keys for core feeds. The
> part hosted trackers cannot match: it archives position history to your own
> disk and lets you scrub back to any past moment. AGPL-3.0.

**Long (100 words)**

> Flightradar24 gives you 7 days of history on the free tier, MarineTraffic
> cut its free window to 24 hours, ADS-B Exchange discontinued its free API.
> Velocity is the self-hosted answer: a FastAPI backend and a Cesium globe
> that fuse aircraft (OpenSky plus the airplanes.live grid), keyless AIS,
> CelesTrak satellites propagated with real SGP4 in the browser, earthquakes,
> wildfires, GPS jamming inferred from ADS-B integrity degradation, and
> conflict events. It records every position to a local SQLite archive with a
> size cap you choose, and a scrubber rewinds to any moment you kept. Evidence
> exports carry SHA-256 custody logs. One compose file, AGPL-3.0.

**Numbers worth citing** (source: live site counters + `scripts/verify.sh`)

- 21,186 aircraft and 55,086 vessels in one measured peak snapshot; typical
  day is around 13,000 and 33,000.
- ~16,000 orbital objects propagated client-side with real SGP4.
- 7,183 military bases, 46 MCP tools, 1,972 backend tests passing.
- Archive: 8.7M positions in a 1.8 GB SQLite file at a 2 GB cap.

**Positioning discipline** (non-negotiable, inherited from the campaign plan)

- Lead with self-hosted + keyless + history you own. Never with the feed
  count: that was the 2026-07-11 Show HN headline and it scored 4 points.
- Never "AI-powered". The AI features are optional, labelled as automated
  output, and run against local inference.
- Always carry the caveats: community-feeder coverage is dense over Europe
  and the US and thin over open ocean, AIS is strongest in Northern Europe,
  it is a single-analyst tool, the 3D globe wants a real GPU.
- Disclose authorship everywhere. Every list, forum and newsletter treats an
  undisclosed maintainer submission as spam.

**Assets**

- **Walkthrough video: `website/assets/tour.mp4`** (1 min 51 s, 7.2 MB, one
  continuous take against live feeds, captured 2026-07-26). Public at
  `https://projectvelocity.org/assets/tour.mp4`. This is the asset every pitch
  below links; it is the substitute for the demo instance.
- Replay GIF from the tour: `docs/media/tour-replay.gif` (1.2 MB, 13 s) for
  places that will not embed video. Older, longer hero GIF:
  `docs/media/hero-replay.gif` (7.7 MB).
- Stills: `docs/media/hero-main.jpeg`, `hero-europe-density.png`,
  `hero-selected-track.png`, `hero-satellites.jpeg`.
- Press kit page: `website/press.html`, public at
  `https://projectvelocity.org/press`.

## 3. Permanent listings (file all of them; they never decay)

Status column is the record. Do not re-litigate what was filed.

| Channel | How | Status |
|---|---|---|
| awesome-selfhosted | PR, category "Maps & GPS"; read CONTRIBUTING first (license, docs, active maintenance, no self-promo language) | not filed |
| awesome-osint | PR | not filed |
| awesome-geospatial | PR | not filed |
| awesome-cesium | PR | not filed |
| OSINT Framework | submission form / PR | not filed |
| Bellingcat toolkit | their submission form; lead with the evidence locker and custody chain, not the globe | not filed |
| selfh.st apps directory | submission form | not filed |
| LibHunt | claim/submit the project | not filed |
| OpenAlternative | submit as an alternative to Flightradar24 | not filed |
| alternativeto.net | three entries: alternative to Flightradar24, MarineTraffic, ADS-B Exchange | not filed |
| GitHub Discussions | enable in repo settings; gives readers a landing spot that is not an issue | off |

Listing rules that get submissions rejected if ignored: awesome-* lists want
a one-line neutral description with no marketing adjectives, a real license,
and evidence of maintenance. Nitpicks arrive fast; comply the same day.

## 4. Tip lines (best fit for a video-only pitch)

They publish about projects and need a video, not a demo.

| Channel | Angle | Status |
|---|---|---|
| Hackaday tip line | SDR / ADS-B / 3D globe is their beat; one paragraph plus the mp4 | not sent |
| RTL-SDR.com | their readers physically run ADS-B feeders; highest audience fit anywhere in this kit | not sent |
| Lobste.rs | invite-only; ask a maintainer or via HN. Small, but often pulls a second HN look | no invite |

## 5. Newsletters and creators

One personalized email each. Two sentences of what it is, the video, the
press-kit link, the install one-liner, an offer to help with setup. One nudge
after two weeks, then stop.

| Target | Kind | Status |
|---|---|---|
| selfh.st / Self-Host Weekly | newsletter | not sent |
| Sector035, "Week in OSINT" | newsletter | not sent |
| Console.dev | newsletter | not sent |
| Changelog News | newsletter | not sent |
| TLDR | newsletter (long shot) | not sent |
| DB Tech | YouTube | not sent |
| Techno Tim | YouTube | not sent |
| Jim's Garage | YouTube | not sent |
| Christian Lempa | YouTube | not sent |
| Hardware Haven | YouTube | not sent |
| Awesome Open Source | YouTube | not sent |
| NetworkChuck | YouTube (long shot; "track the planes over your house from your homelab") | not sent |

**Template**

> Subject: Self-hosted flight and ship tracker that keeps its own history
>
> Hi <name>,
>
> I built Velocity, a self-hosted OSINT console: live aircraft, ships and
> satellites on one 3D globe, no API keys for the core feeds, and it archives
> position history to your own disk so you can rewind to any past moment.
> Flightradar24 gives you 7 days free and MarineTraffic 24 hours; this one is
> bounded by your disk instead.
>
> 90-second walkthrough: <video link>
> Press kit (video, stills, blurbs): https://projectvelocity.org/press
> Repo, AGPL-3.0: https://github.com/AndrewCTF/velocity
> Install: `docker compose up`
>
> Happy to help if you want to run it, and happy to answer anything about how
> the feeds or the archive work. Either way, thanks for reading.
>
> <name>, maintainer

## 6. The drip

- **Fediverse and Bluesky**, tags `#OSINT` `#geospatial` `#selfhosted`. No
  gatekeeper, video-native, and the OSINT crowd is there. This is where the
  case studies go.
- **Case study cadence, 1-2 per month.** Event happens, then within 48 h a
  60-90 s replay clip plus 300 words of what the archive shows. Nobody
  without a local archive can produce this content; it is the only durable
  differentiator. 90% information, 10% project.
- **Communities as a member, not an advertiser**: self-hosted and homelab
  Discords, SDR and ADS-B communities (tar1090, airplanes.live), OSINT
  Curious, Trace Labs.
- **Monthly release ritual.** One headline feature, real release notes.
  GitHub's release-follower feed and "recently updated" surfaces do quiet
  work for free.

## 7. Deliberately not doing

- **Product Hunt.** Dev and self-hosted infrastructure underperform there
  relative to prep cost, and a mediocre day is public.
- **More small-subreddit posts.** Operator instruction 2026-07-26, and the
  account u/Prestigious_Act3077 is spam-heuristic-hot from ~10 promo posts in
  8 days. r/selfhosted and r/OSINT were never posted to and remain the
  largest reddit-shaped levers, but they are out of scope by instruction.
- **A public demo instance.** Declined 2026-07-26: cost, abuse surface, and
  redistribution is not what the community feeders signed up for. Every
  channel above is working around its absence, which is why the video is the
  gate on all of them.
