# What actually worked in the last 30 days — Reddit, HN, YouTube, X, GitHub

Compiled 2026-07-29. Window: 2026-06-29 → 2026-07-29, with four older-but-decisive
items (marked `[>30d]`) kept because they are the highest-engagement artifacts in the
category and every 30-day item reacts to them.

Companion documents:
- `docs/palantir-reference-2026-07.md` — what the incumbent ships, panel by panel.
- `docs/plan-50-2026-07-29.md` — the 50 changes this evidence produced.

Method and honest coverage limits are in §7. Read §7 before quoting any number here.

---

## 1. The finding that should change the roadmap

**The "fusion globe dashboard" is not a product category any more. It is a template.**

Searching X for open-source OSINT dashboards launched in the last 30 days returns a
queue of near-identical projects, and one tagline repeated verbatim across at least
four separate GitHub repositories:

> "Open Source Global Intelligence Platform - Real-Time OSINT Dashboard - **A Palantir
> Alternative**"

That exact string is the repo description of `enzg/osiris-live`, `RigelFive/OSIRIS`,
`WilliamTaack/osiris-Palintir`, and `simplifaisoul/osiris`. The last one appends
"We Get 0.5% on Volume Traded" followed by a pump.fun token contract address
(`2nZNHm3Lr9umG3DVrzYwHgktwkuKuJRXqqRqs3ewpump`).

The phrase "a Palantir alternative" has been fully absorbed as a crypto-pump template.
Shipping another one does not put this repo in a competitive category; it puts it in a
category a reader now pattern-matches to a scam. This is the hardest possible evidence
for the operator's constraint — do not build another Gotham clone — and it is not an
aesthetic judgement, it is a positioning fact.

Hacker News reached the same verdict in a single line. On the 312-point Shadowbroker
thread, the top-voted reply is:

> "I've seen so many of these in the last week alone. **I need a realtime OSINT
> dashboard for OSINT dashboards.**" — u/laborcontract
> <https://news.ycombinator.com/item?id=47300102>

and immediately below it:

> "Reminds me of all the Covid data trackers in mid 2020" — u/skinnymuch

That is a category-collapse diagnosis from the audience we would be launching to.

### 1.1 What every competitor is missing, in one table

| Project | Evidence | Stateless? | History/replay | Provenance | Queue/alerts | Agent API |
|---|---|---|---|---|---|---|
| **OSIRIS** (+4 forks) | X, GH | **Yes** — "entirely stateless, pulls data on demand" | none | none | none | none |
| **Shadowbroker** | HN 312pts | Yes — 60 s GeoJSON push | none | none | none | none |
| **WorldMonitor** | GH, X | Yes | none | none | AI threat classify | none |
| **IRONSIGHT** | X 2026-07-19 | Yes | none | none | none | none |
| **KNWLDGBox** | X 2026-07-21 | Yes | none | none | none | none |
| **GlobalThreatMap** | X | Yes | none | none | none | none |
| **SitDeck** | HN 47267923 | Yes | none | none | none | none |
| **IranWarLive** | HN 47200316 | Yes | none | none | none | none |
| **This repo** | — | No — `history.db` | **owned, unlimited** | partial | rules exist | MCP, 34 tools |

Every single competitor is a **stateless viewer of other people's live APIs**. Not one
of them owns the past, scores the trustworthiness of a contact, works a queue, or can be
driven by an agent. Those four columns are the entire defensible surface, and this repo
already has the substrate for all four.

**The strategic instruction that falls out:** stop competing on layer count. Fifteen
competitors have 15-65 layers. Compete on the four columns nobody else has.

---

## 2. What the audience actually upvotes (ranked by measured engagement)

Ranked by real engagement, not by how impressive the project is. The ordering is the
lesson.

| # | Item | Source | Date | Engagement |
|---|---|---|---|---|
| 1 | [Somebody used spoofed ADSB signals to raster the meme of JD Vance](https://news.ycombinator.com/item?id=46802067) | HN | 2026-01-28 `[>30d]` | **549 pts, 150 cmt** |
| 2 | [Show HN: Is Hormuz open yet?](https://news.ycombinator.com/item?id=47696562) | HN | 2026-04-08 `[>30d]` | **484 pts, 209 cmt** |
| 3 | [How to track dark ships using OSINT (with demos)](https://youtu.be/niL4JPfcD3g) | YouTube (David Bombal) | 2026-04-19 `[>30d]` | **332,802 views** |
| 4 | [Show HN: real-time OSINT dashboard, 15 live global feeds (Shadowbroker)](https://news.ycombinator.com/item?id=47300102) | HN | 2026-03-08 `[>30d]` | **312 pts, 123 cmt** |
| 5 | [Small aircraft crashes into house near Ganderkesee Airfield](https://www.reddit.com/r/flightradar24/comments/1v678na/) | r/flightradar24 | 2026-07-25 | **703 pts, 36 cmt** |
| 6 | [Top 7 OSINT tools REVEALED for 2026](https://youtu.be/WHOgdsEiyew) | YouTube (David Bombal) | 2026-02-15 | 397,386 views |
| 7 | [Oshkosh Feeders are Live](https://www.reddit.com/r/ADSB/comments/1uxl3i7/) | r/ADSB | 2026-07-15 | **179 pts, 18 cmt** |
| 8 | [OSINT professionals: watch out for this recruitment approach](https://www.reddit.com/r/OSINT/comments/1v4917w/) | r/OSINT | 2026-07-23 | **168 pts, 19 cmt** |
| 9 | [What's the most interesting OSINT job you've ever had?](https://www.reddit.com/r/OSINT/comments/1v0vdak/) | r/OSINT | 2026-07-19 | **167 pts, 47 cmt** |
| 10 | [User Scanner v1.4.1 — free 2-in-1 OSINT tool](https://www.reddit.com/r/Hacking_Tutorials/comments/1uw7f6d/) | r/Hacking_Tutorials | 2026-07-14 | **139 pts, 15 cmt** |
| 11 | [OSINT Toolkit Every Investigator Needs in 2026](https://youtu.be/iMD4R1LeqNg) | YouTube (Shield Spectrum) | 2026-04-02 | 73,444 views |
| 12 | [Where to practice crypto OSINT skills without real-world consequences?](https://www.reddit.com/r/OSINT/comments/1v70zud/) | r/OSINT | 2026-07-26 | 59 pts, 6 cmt |
| 13 | [Show HN: OSINT tool that finds exposed files on domains](https://news.ycombinator.com/item?id=48797656) | HN | 2026-07-05 | 58 pts, 26 cmt |
| 14 | [Show HN: Red Grid Link — P2P team tracking over Bluetooth, no servers](https://news.ycombinator.com/item?id=47461529) | HN | 2026-03-20 `[>30d]` | 54 pts, 36 cmt |
| 15 | [Show HN: Customizable OSINT dashboard to monitor the situation](https://news.ycombinator.com/item?id=46591589) | HN | 2026-01-12 `[>30d]` | 50 pts, 23 cmt |
| 16 | [ADV-S Flight Radar is officially live!!!](https://www.reddit.com/r/ADSB/comments/1v5evbi/) | r/ADSB | 2026-07-24 | 40 pts, 7 cmt |
| 17 | [Built a GUI for usual OSINT tools plus added some extra](https://www.reddit.com/r/osinttools/comments/1v7qbp7/) | r/osinttools | 2026-07-27 | 15 pts, 4 cmt |
| 18 | [Espectrosint vs maltego?](https://www.reddit.com/r/OSINT/comments/1v4t369/) | r/OSINT | 2026-07-23 | 4 pts, 3 cmt |
| 19 | **[Multi-source live geospatial fusion on a Cesium globe (this repo)](https://www.reddit.com/r/geospatial/comments/1uqppm7/)** | r/geospatial | 2026-07-08 | **2 pts, 0 cmt** |

**Read rows 1, 2, 5, 7 and 19 together.** Row 19 is our own post. "Multi-source live
geospatial fusion on a Cesium globe, with GeoJSON/CSV/KML export for QGIS" scored **2
points and zero comments**. In the same window, a plane crash thread got 703 and a post
about *Noctua fans in a receiver enclosure* got 179.

The audience does not upvote capability descriptions. It upvotes **an event**, **a
decisive answer**, or **a build they can copy**. "Multi-source fusion" is a description
of plumbing.

---

## 3. Show HN: Is Hormuz open yet? — the highest-value case study

484 points, 209 comments, for a site that answers **one question with one word**, built
in a few hours, on a data source with a **four-day lag**, by an author who says so in
the first paragraph.

The author's own post (<https://news.ycombinator.com/item?id=47696562>):

> "Turns out live ship tracking APIs are expensive so I manually just copied the json
> from marinetraffic... To actually know if the port is open without live ship tracking
> I found portwatch.imf.org which was perfect, except **it has 4 day lag!**"

The top comment is not praise, it is an interrogation of the method:

> "Very cool, thanks for sharing! **What's the threshold function?** Do you have
> graduating `No --> Partially --> Mostly --> Open`? Also **what's the update cadence?**"
> — u/fraywing

and the author answers with the actual rule:

> "So if it's under **25% of the prior year's crossing** it goes to NO, otherwise it's
> counted as open. The update cadence kinda sucks because I didn't spring for the $200 a
> month live ship tracking data" — u/anonfunction

**Three transferable rules, all of which we currently fail:**

1. **A decisive answer beats a capability.** One question, one word, one URL you can
   send to a colleague. We render 64 layers and answer nothing.
2. **The threshold function is the product.** The first thing a technical audience asks
   is "what is the rule, and when does it change its mind". Our dashboard has no stated
   rule for anything.
3. **Publishing your data lag builds trust rather than destroying it.** He led with
   "4 day lag" and got 484 points. We have `seen_pos_s` on every contact and show it
   nowhere prominent.

A fourth, commercially relevant: **live AIS is a real moat.** Four vendors either failed
or wanted enterprise contracts for this author (AISStream down, DataDocked out of credits
on one request, VesselFinder and MarineTraffic both enterprise-contact-form). This repo
already runs a keyless ~32k-MMSI AIS union. That is genuinely hard to get and we treat it
as a bullet point.

---

## 4. Trust and provenance: the top-scoring story in the whole category

549 points — the highest-engagement item found in any source — is about **someone drawing
a meme on a live flight-tracking map by uploading fake ADS-B**
(<https://news.ycombinator.com/item?id=46802067>).

The technically-correct top replies:

> "ADSB sites aren't any sort of official thing. **You can send whatever data you want to
> them. Just because it's there doesn't mean it ever went over the air** as an ADSB
> broadcast." — u/HNisCIS

> "I believe this was 'spoofed' only in the sense that a particular provider/online
> platform accepted data via an API that was abused to draw this on that platform only.
> Searching around it seems it was **not found if you looked on other platforms**"
> — u/pear01

> "Detecting falsified data is a separate matter." — u/fc417fc802

The audience for this product **already knows the feed is poisonable** and knows the
detection method is *cross-platform corroboration*. Every competitor renders a contact as
a plain icon with no indication of how many independent sources saw it, when, or whether
the report is self-consistent.

This also lands directly on one of the operator's three named defects. "OpenSky has so
many dead planes" is not a cosmetic bug; it is the visible symptom of having no freshness
or corroboration model on the contact itself.

Corroborating, from r/OSINT in-window: **[Monitoring the Shadow Fleet](https://www.reddit.com/r/OSINT/comments/1uttsjm/)**
(2026-07-11) and **[Using advanced techniques to determine if a ship is laden — Open
Source Centre](https://www.reddit.com/r/OSINT/comments/1uzljmr/)** (2026-07-17). The
serious maritime OSINT conversation in this window is entirely about **vessels that lie**
— AIS gaps, spoofed positions, draught inference. Bombal's 332,802-view video is called
"How to track **dark** ships".

Dark contacts are the topic. A map that only draws what the feed asserts is answering a
question nobody in this community is asking.

---

## 5. What kills these projects on contact with users

The Shadowbroker thread is the most useful failure log available, because 312 points
brought real installs. Sorted by how many comments each failure generated:

**5.1 It did not run.** The single largest comment cluster.

> "There's no data when I tried it on a windows 11 PC. It seemed to install all deps
> front end is served but dossier says intel unavailable. **No planes etc. No helpful
> output in the command window.**" — u/rustyhancock
> "Same on a Mac" — u/spzb
> "Yeah this doesn't work on Mac either. **This is just broken and nonfunctioning.**" — u/DetroitThrow

The author's own diagnosis is the actionable part:

> "If the map is blank, it usually means the backend is missing the .env file... so it's
> **silently failing** to fetch the streams... I'm going to push an update later today to
> show a prominent **'Backend Disconnected / Missing API Keys'** warning on the UI so it
> doesn't just look dead." — u/vancecookcobxin

**A blank map that is silently a config error reads as a broken product.** We have 64
layers, most keyless, some not. We have no per-layer "why is this empty" answer.

**5.2 Documentation that contradicts the code.**

> "On the topic of API Keys, for Opensky it's `OPENSKY_CLIENT_ID` and
> `OPENSKY_CLIENT_SECRET`, the readme has `OPENSKY_USERNAME` and `OPENSKY_PASSWORD`"
> — u/AH4oFVbPT4f8
> "The perils of vibe coding." — u/porridgeraisin

This is independently confirmed: **OpenSky retired basic username/password auth in March
2026** in favour of OAuth2 client-credentials, tokens expiring ~30 min, on a daily credit
budget (~8,000/day for feeders). Directly relevant to our OpenSky staleness.

**5.3 Leaked secrets.**

> "You leaked `./frontend/.env.local` & `./backend/.env` inside `ShadowBroker_v0.1.zip`
> in the first commit." — u/vavkamil
> "the real OSINT is always in the comments" — u/DetroitThrow

**5.4 The credibility attack.** A former US Navy Maritime Domain Awareness engineer:

> "My very first real software job was working on ground processing algorithms for the US
> Navy's Maritime Domain Awareness system, which is the 'real' version of something like
> this... Bush announced in like 2004 and we didn't go into full operational capability
> until 2015. Thousands of developers... **I wish these weekend warriors would work on a
> project like that someday, to see what capabilities truly take.**" — u/nonameiguess

The only answer that survives this is *honest scope*: state coverage, state lag, state
what you cannot see. Claiming completeness against someone who built the real thing is
unwinnable.

**5.5 LLM-slop detection is now a first-pass filter.**

> "please at least clean up the markdown diagram — claude has a real hard time aligning
> the borders in ascii art" — u/btbuildem
> "**dont give these OSINT quality signals away** ... that's one of the indicators that
> allow you on first scan to id (potentially) low quality content. Ie: fully llm gen; the
> author doesnt look over the docs or doesnt care for 'details'." — u/mentalgear
> "Whole thing feels very vibe coded. Even OP's post here." — u/Escapade5160

For an OSINT audience specifically, sloppy artifacts are read as *evidence of unreliable
sourcing*. Misaligned ASCII in a README is treated as a provenance signal.

**5.6 Hosting.**

> "Can this be run on a public server (I use dreamhost) with a web interface for others
> to see? Or is this strictly something that gets run on a local computer?" — u/hettygreen

**5.7 Rendering advice, from someone who does this.**

> "Optimizing some of that geojson into realtime tiles is a really fun and engaging
> project. Have you seen these? protomaps/PMTiles, maplibre/martin" — u/afatparakeet

and the author's own correct pushback — that tile-cache invalidation defeats live movers,
so tiles are for **static/slow layers** while live entities stay raw. Followed by:

> "Yeah less ideal for the realtime data but could be useful for **lightening the load of
> certain more static layers**." — u/afatparakeet

This is exactly the Palantir Auto/Tile/Object split in `docs/palantir-reference-2026-07.md`
§2, arrived at independently by two strangers on HN. It is also the direct answer to the
operator's "takes some time to load in data after I zoom out or move".

---

## 6. In-window Reddit signal, by community

Collected 2026-07-29 via Reddit RSS (91 posts across 16 subreddits after date filtering;
Reddit's JSON API returned 403/429 to this host, see §7).

**r/OSINT — what practitioners are actually asking, July 2026**

| Date | Thread | Why it matters here |
|---|---|---|
| 2026-07-03 | [Is OSINT automation actually doable?](https://www.reddit.com/r/OSINT/comments/1ujpjxq/) | The core demand: automate the boring parts |
| 2026-07-08 | [How U.S. Satellite Imagery Restrictions Are Changing How We Report on Iran](https://www.reddit.com/r/OSINT/comments/1uqqz3f/) | Coverage honesty is a live topic |
| 2026-07-11 | [Monitoring the Shadow Fleet](https://www.reddit.com/r/OSINT/comments/1uttsjm/) | Dark vessels |
| 2026-07-13 | [How useful is the platform Blind?](https://www.reddit.com/r/OSINT/comments/1uvrp5m/) | Tool-evaluation genre |
| 2026-07-17 | [Determining if a ship is laden — Open Source Centre](https://www.reddit.com/r/OSINT/comments/1uzljmr/) | Inference from observables |
| **2026-07-19** | **[Anyone have experience with OpenSky Network API or ADS-B Exchange API — what is the polling request limit?](https://www.reddit.com/r/OSINT/comments/1v1bgqm/)** | **Our exact upstream problem, asked by a stranger, in window** |
| 2026-07-20 | [How to effectively monitor/scrape specific Facebook Groups for time-sensitive posts in 2026?](https://www.reddit.com/r/OSINT/comments/1v25xkw/) | Standing monitoring, not ad-hoc search |
| 2026-07-25 | [Is it possible to view all comments made by a TikTok account?](https://www.reddit.com/r/OSINT/comments/1v6mxsx/) | Pivot-from-entity |
| 2026-07-26 | [Where to practice crypto OSINT skills without real-world consequences?](https://www.reddit.com/r/OSINT/comments/1v70zud/) | 59 pts — demand for a **sandbox/replay** |

**r/geospatial — in-window, most relevant to the globe**

| Date | Thread |
|---|---|
| 2026-06-28 | [Real-time global events mapped (PC & Mobile) on interactive 3D/2.5D map from 30+ feeds](https://www.reddit.com/r/geospatial/comments/1uneu8w/) — another competitor |
| 2026-07-08 | [Multi-source live geospatial fusion on a Cesium globe (**ours, 2 pts**)](https://www.reddit.com/r/geospatial/comments/1uqppm7/) |
| 2026-07-11 | [maplibre-label-callout: labels with connector lines](https://www.reddit.com/r/geospatial/comments/1usmzp6/) — label collision is a shared pain |
| 2026-07-14 | [MapCheck 1.1: loads large, high quality PDF maps **on-device**, offline imports](https://www.reddit.com/r/geospatial/comments/1uwbz1p/) |
| 2026-07-15 | [I added automatic AI segmentation to my QGIS plugin. **Draw a zone, type what to find, get clean vector polygons**](https://www.reddit.com/r/geospatial/comments/1ux9j4v/) |
| 2026-07-28 | [Cesium DevCon 2026 session recordings are all free on YouTube now](https://www.reddit.com/r/geospatial/comments/1v8kx2n/) |

The QGIS-plugin post is the single most transferable interaction pattern found:
**draw a zone → type what you want in natural language → get a structured result.** We
have the box-draw tool, the LLM path, and the entity store. We have never connected them
in that order.

**r/ADSB — what this community rewards**

179 points for POE-powered Noctua fans in a receiver enclosure; 40 points for a new
handheld radar. Zero posts in-window about fusion dashboards. This community rewards
**hardware you can build and feed data from** — and it is the community that would
supply provenance (independent receivers) if we ever asked.

---

## 7. Coverage, method, and what this research did NOT establish

Stated plainly, because §5.4 says honest scope is the only defence that survives.

**Sources that ran:** Reddit (RSS + shreddit via the last30days engine, 22 scored
threads + 91 RSS posts), Hacker News (Algolia API, full comment trees for 4 threads,
~120 stories scanned), YouTube (yt-dlp search + 3 full auto-transcripts), GitHub
(engine + web), Digg (68 clusters), web search (12 queries).

**Sources that did NOT run properly — do not read absence as silence:**

- **X/Twitter: no API access.** The engine reported `Missing: X/Twitter`. X requires
  either browser-cookie extraction or a paid key, and reading the operator's browser
  cookies while they were asleep was not a consent decision to make unasked. **All X
  evidence in this document came from web search over `site:x.com`, which returns post
  text and URLs but usually not like/repost counts.** X items are therefore cited with
  date and URL but *without* engagement figures. That is a real gap: X is where OSINT
  practitioners actually live (@sentdefender, @MATA_osint, @zarGEOINT, @DefenceGeek).
  Fix: log into x.com in Firefox, or set `XAI_API_KEY`, then re-run.
- **Reddit JSON API: 403/429 from this host.** Vote counts here come from the engine's
  arctic-shift backfill and from RSS-derived listings; some in-window r/OSINT and
  r/geospatial threads are cited with date and URL but no score.
- **Jobs source: DNS failure** (`Temporary failure in name resolution`).
- **arXiv, Techmeme, Polymarket: 0 in-window items.** For Polymarket and Techmeme this
  is a genuine no-results; the category is not traded or covered by tech press.
- **YouTube in-window is thin.** The category's big videos (332K, 397K views) are 3-5
  months old. Marked `[>30d]`.

**What this research does not claim.** It does not claim the competitor list is
exhaustive — new dashboards are appearing weekly and that is the point of §1. It does not
claim measured performance numbers for any competitor; OSIRIS's "60fps with thousands of
entities" is *their* claim from their README, not a measurement. It does not establish
what paying users want, because no paying-user evidence exists in these sources.

**Reproduce this:**

```bash
SKILL_DIR="$HOME/.claude/plugins/cache/last30days-skill/last30days/3.18.4/skills/last30days"
LAST30DAYS_NATIVE_SEARCH=1 python3.14 "$SKILL_DIR/scripts/last30days.py" "OSINT tools" \
  --emit=compact --save-dir="$HOME/Documents/Last30Days" --plan plan-a.json \
  --subreddits=OSINT,osint,GIS,selfhosted,netsec,geospatial,privacy --dedicated-subreddits=OSINT
```

Raw artifacts: `~/Documents/Last30Days/osint-tools-raw-osint.md`,
`~/Documents/Last30Days/live-aircraft-and-vessel-tracking-dashboards-raw-tracking.md`.

---

## 8. The five conclusions that produced the plan

1. **Own the past.** Every competitor is stateless. `history.db` + replay is the only
   asset none of them can copy without rebuilding their architecture. Make replay the
   headline, not a tab. (Evidence: §1.1; r/OSINT 2026-07-26 sandbox demand.)
2. **Score the contact, don't just draw it.** The top story in the category (549 pts) is
   about fake data on a live map, and the audience already knows the detection method is
   cross-source corroboration. Provenance/freshness on every entity is differentiating
   *and* it fixes "OpenSky dead planes". (Evidence: §4.)
3. **Answer a question, don't render a capability.** 484 points for one word; 2 points
   for "multi-source live geospatial fusion". Ship named, shareable, threshold-backed
   answers. (Evidence: §2, §3.)
4. **Load what's in view.** Both the HN rendering thread and Palantir's own docs
   independently reach "tile the static layers, stream the live ones". This is the fix
   for the operator's zoom/pan latency complaint. (Evidence: §5.7 + palantir-reference §2.)
5. **Never fail silently.** The largest failure cluster on a 312-point launch was a blank
   map that was actually a config error. Every empty layer must state why it is empty.
   (Evidence: §5.1.)

**And the anti-clone rule the whole plan is measured against:** if a change would also
appear on OSIRIS, Shadowbroker, WorldMonitor, IRONSIGHT, or a Gotham panel inventory, it
is not a differentiator — it is table stakes, and it only earns a slot if it is on the
critical path to one of the five conclusions above.
