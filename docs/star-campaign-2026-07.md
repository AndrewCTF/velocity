# Star campaign — 5,000 GitHub stars (2026-07-12)

Operator target: **5,000 stars.** This plan is the distribution half of
`docs/roadmap-users-2026-07.md` (W2), expanded into an executable playbook:
the math, the assets, the channel sequence with dates, the copy, the
measurement loop, and the anti-patterns that would get the project banned or
laughed at. Positioning discipline is inherited and non-negotiable: lead with
**self-hosted + keyless + unlimited replay you own**; never "AI-powered";
label automation; caveat the feeds; human voice everywhere.

---

## 1. The honest math of 5,000 stars

5,000 stars puts a repo in roughly the top 0.5% of GitHub. It is reachable
for a self-hosted tool with a strong demo — Uptime Kuma, Dawarich,
ArchiveBox, SpiderFoot (~13k) all cleared it — but not from one launch post.
The realistic decomposition:

| Source | Stars (realistic range) | When |
|---|---|---|
| Show HN, front page (top-10 for hours) | 800–2,500 | launch week |
| Show HN, modest (page 2, 30–80 points) | 100–400 | launch week |
| r/selfhosted strong post (500+ upvotes) | 150–500 | launch week |
| r/OSINT + r/ADSB + r/homelab variants | 50–200 | weeks 1–3 |
| GitHub Trending (daily/weekly) — triggered by launch velocity | ×1.5–2 multiplier on the wave | launch week, if >~150 stars/day |
| awesome-selfhosted + awesome-OSINT + directory drip | 10–40/week, compounding | from week 3, indefinitely |
| Newsletters (Self-Host Weekly, Week in OSINT, Console.dev) | 50–300 each | weeks 2–6 |
| One YouTube review from a self-hosted channel | 100–600 | weeks 3–8 |
| Timely case-study posts (replay of a real event) | 50–400 each | ongoing |
| Second Show HN at a major release (new headline feature) | 300–1,200 | month 3–5 |
| Baseline drip once >1k stars (search, similar-repo, trending residue) | 100–300/month | ongoing |

**Median path: ~1,000–1,800 stars in month 1, 5,000 around month 4–7.**
A first-launch flop (sub-200 total) triggers the roadmap's 30-day gate:
stop building, fix positioning, relaunch. Do not spend the gate window
adding features. Anything promising 5k in "2 weeks" involves fraud (§9).

Two structural facts to exploit:
1. **Velocity's demo is intrinsically viral-shaped.** A dark 3D globe with
   20k live aircraft that *rewinds time* GIFs better than 95% of self-hosted
   tools (a dashboard can't do this). The GIF is the campaign.
2. **The audiences already exist and already hate the paywalls** (FR24 7-day
   history, MarineTraffic 72h→24h cut, ADS-B Exchange API kill). The pitch
   isn't "new tool", it's "the thing you're angry about, solved, on your box."

## 2. Pre-launch: make the repo convert (week 0, gate for everything else)

A launch post is a firehose pointed at the README for ~6 hours. Visitors
star or bounce in ~20 seconds. Everything here is about that 20 seconds.

**2.1 The funnel target.** Post → repo visit converts at 5–15%. A front-page
HN day is 30–80k views → 5–15k repo visits → 500–1,500 stars *if the README
lands*. Halving README quality halves the campaign. This is the highest-ROI
work in the whole plan.

**2.2 README surgery** (current README is feature-complete but depth-first;
launch needs conversion-first):
- **Above the fold:** one hero GIF (≤10 MB, 15–25 s loop): globe spins →
  zoom to a hotspot → click an aircraft → dossier opens → **scrub the
  timeline backwards, tracks rewind**. The rewind IS the differentiator —
  it must be in the first screenful. Record at 1440p, encode with gifski
  (or an `<video>`-in-README mp4, which GitHub now renders — smaller and
  sharper than GIF).
- Three sentences, verbatim discipline from the roadmap's value statement:
  self-hosted situation console; live aircraft/ships/satellites/hazards on
  one 3D globe; unlimited local history you can rewind — no account, no API
  key, no vendor able to paywall your archive.
- `git clone … && docker compose up` → `http://localhost:8080` as the third
  block. Nothing before it but the GIF and the pitch.
- **Comparison table** (converts skeptics; keep it factual, cite dates):
  history depth / self-hosted / API keys / replay — Velocity vs FR24 vs
  MarineTraffic vs ADS-B Exchange vs World Monitor. Every cell verifiable.
- **Honest-caveats block** (this audience stars honesty): community feeds =
  dense over EU/US, patchy open ocean; Cesium wants a GPU; VPS datacenter
  IPs get blocked by some ADS-B mirrors (link the FAQ entry); satellite
  imagery layers need free keys.
- Badges: CI green, license, latest release, Docker. No star-count badge
  yet (looks needy under 1k), add at ~2k.
- Move the current deep feature tour below the fold; it's good retention
  content, wrong first impression.

**2.3 Repo furniture** (GitHub's own distribution surfaces):
- **Name check (decide once, before launch):** repo is
  `osint-geospatial-console`, product says "Velocity". Pick the memorable
  one, make the other a tagline. A rename after launch burns inbound links.
  ("Velocity" has collisions in dev tooling; verify searchability — if
  keeping it, always pair as "Velocity — self-hosted OSINT console".)
- Social preview image (Settings → set the hero frame; this is what every
  Slack/Discord/Twitter unfurl shows).
- Topics: `self-hosted`, `osint`, `adsb`, `ais`, `flight-tracking`,
  `ship-tracking`, `cesium`, `geoint`, `situational-awareness`, `docker`.
  These feed GitHub topic pages and Explore.
- `LICENSE` prominent; `CONTRIBUTING.md` (build, verify.sh, PR
  expectations); issue templates (bug / feed-problem / feature); enable
  Discussions (Q&A category for setup help — keeps issues clean).
- Seed **8–12 `good-first-issue`s** (real, small: a panel polish, a doc
  gap, a new keyless connector from the skip-list). Contributors are
  super-stargazers: each PR author brings watchers.
- Community space: one Discord server (or Matrix bridge), three channels
  max (#setup-help, #showcase, #dev). Link in README. Empty is fine; it
  fills during launch week.
- Tag a release: `v1.0.0` if the stranger-boot test passes cleanly, else
  `v0.10.0` — with real release notes. HN respects honest versioning.

**2.4 The stranger-boot gate** (from the state-of-project audit — this is
the launch precondition, not a parallel task):
- Clean VM, fresh clone, `docker compose up`, no `.env`: globe shows
  aircraft within ~60 s. Fix what breaks.
- The VPS/datacenter-egress case: boot on a cheap VPS, observe what a
  cloud-hosting user sees. Ship the **empty-globe diagnostic** (feed-status
  panel already exists — make the failure mode self-explanatory: "0
  aircraft: this host's IP is blocked by community ADS-B mirrors; see
  FAQ") so the worst first-contact outcome is an explained limitation, not
  "it's fake".
- Decide the archive default: measure GB/day at full firehose, then either
  ship archive-mode-on with a disk budget, or keep 48 h and make the README
  say exactly that ("unlimited *if you turn the dial*"). The pitch and the
  boot must match — this community diffs claims against behavior for sport.

**2.5 Asset kit** (produce once, reuse everywhere):
- Hero GIF/mp4 (above) + 3 short GIFs: (a) replay scrub, (b) click→dossier
  →evidence capture, (c) dark-vessel/AIS-gap detection view.
- 90-second silent screen-capture video with captions (YouTube unlisted —
  for embedding in posts and sending to reviewers).
- 6–8 stills at 1440p (the `docs/media/` set is already strong).
- A one-paragraph project boilerplate + the comparison table as an image
  (for newsletters that don't render markdown).
- Press-kit page in the repo: `docs/press-kit.md` linking all of it.

## 3. Launch week (week 1) — sequence and mechanics

Post drafts already exist in `docs/launch-posts-draft.md` (r/selfhosted,
r/OSINT, +more) and follow the right voice. Mechanics:

**Day −7 to −1:** join the communities you'll post in (r/selfhosted,
r/OSINT, Trace Labs Discord, OSINT Curious, a couple of self-hosted
Discords) and *participate normally* — answer two or three questions,
comment on other tools. Drive-by self-promo from a fresh account is the #1
cause of removed posts on r/selfhosted. Check each subreddit's self-promo
rules the week of posting (r/selfhosted requires clear author-disclosure
and interaction; some subs have "Show-off Saturday"-style windows).

**Day 1 (Tuesday) — r/selfhosted.** Post the existing draft (title leads
with the paywall pain, not the product name — correct). 9–11 am US Eastern.
Author-disclose in the first line. Then **live in the comments for 8–10
hours**: setup help, honest limitation answers, "good idea, filed as
issue #N" (and actually file them — visible responsiveness converts
lurkers). Do not link-drop the repo more than the post itself does.

**Day 2 — r/OSINT** with its own draft (the "owning your history" angle —
different thesis, not a crosspost). Same presence rules.

**Day 3 or 4 (Wed/Thu) — Show HN.** 8–10 am ET (max weekday traffic window).
- Title: `Show HN: Self-hosted flight/ship tracker with unlimited history
  and replay` — concrete, no adjectives, no "AI", under 80 chars. Two
  fallback titles pre-written (different angle: the paywall story; the
  "one Docker box" story).
- URL = the GitHub repo. First comment (yours, immediately): the personal
  story — why built, what's hard (feed politeness, Cesium perf, keeping
  13k aircraft at 60 fps), honest caveats, what feedback you want. HN
  rewards builders who talk engineering, punishes marketing voice.
- Stay in the thread all day. Prepared answers (write these before
  posting) for the predictable questions:
  1. *Feed ToS/legality* — community feeds, polite pull cadences, no
     redistribution, that's why no public demo instance.
  2. *"How is this different from FR24 / World Monitor / ADS-B Exchange?"*
     — the comparison table, especially history + self-host + keyless.
  3. *"Why is my globe empty?"* (VPS egress) — the FAQ link.
  4. *OPSEC/misuse concerns* — serious answer: it fuses already-public
     broadcasts; watch-lists stay on the user's hardware, which is the
     privacy-preserving direction.
  5. *The AI features* — labeled, optional, local-only inference; never
     auto-asserted as fact (assertion/provenance schema).
  6. *Cesium perf on old hardware* — the low-end banner + quality presets.
- **Do not** ask anyone to upvote, ever (HN voting-ring detection is real
  and permanent). If the post dies (<20 points): one relaunch is
  acceptable ~2 weeks later with a different title/angle; also email
  hn@ycombinator.com — mods occasionally re-up good Show HNs via the
  second-chance pool.

**Day 5–7:** Trace Labs Discord #tools, OSINT Curious community, one or two
self-hosted Discords — shared as a member ("I posted this on HN this week,
r/selfhosted thread here, feedback welcome"), not as an announcement blast.
Mastodon (infosec.exchange) + Bluesky thread with the replay GIF; tag
#selfhosted #OSINT #ADSB. Watch GitHub Trending — if the repo appears,
screenshot it (asset for later posts) and expect a second wave.

**All week:** respond to every issue within hours. Label the good ones
`launch-feedback`. Ship two or three tiny fixes *during* the week and say
so in the threads ("fixed in v1.0.1") — visible momentum is the strongest
star-converter there is.

## 4. Weeks 2–4 — directories, newsletters, reviewers

**Directories** (slow, permanent, compounding — file all of them):
- **awesome-selfhosted** PR (read their contributing rules: needs license,
  active maintenance, docs; put it under "Maps & GPS" or closest category).
  Expect nitpicks; comply fast.
- **awesome-osint** PR, **awesome-geospatial**, an ADS-B/awesome-aviation
  list, awesome-docker-compose examples if applicable.
- **selfh.st** app directory submission; **alternativeto.net** entries as
  alternative to Flightradar24, MarineTraffic, ADS-B Exchange (these pages
  rank on exactly the searches disappointed users make); **LibHunt**;
  **Awesome-Selfhosted's** sibling lists as discovered.
- **Bellingcat toolkit** submission (their GitHub/form) — the evidence
  locker + provenance story is precisely their bar. Expect weeks of lag;
  file early.

**Newsletters** (one personalized paragraph + press kit link each):
- **Self-Host Weekly / selfh.st** (submission form; high conversion for
  this exact audience).
- **Sector035 "Week in OSINT"** — pitch as a tool note; the replay-of-a-
  real-event angle lands better than a feature list.
- **Console.dev** (they curate dev tools; the pitch is the engineering).
- **The OSINT Newsletter**, **OSINT Combine**-adjacent letters as found.
- tldr.tech / Changelog News are long shots; submit anyway (5 minutes).

**Reviewers** (self-hosted YouTube is the highest-variance channel: one
video can be 500 stars):
- Shortlist: DB Tech, Awesome Open Source, Techno Tim, Jim's Garage,
  Christian Lempa, Hardware Haven, NetworkChuck (long shot; the "track
  planes from your homelab" angle is his shape).
- One personalized email each: what it is in two sentences, the hero mp4,
  the compose one-liner, an offer to help with setup. No follow-up spam;
  one polite nudge after two weeks. Expect 1–2 conversions from 7 pitches.

**Product Hunt: deliberately skipped** for launch. Dev/self-hosted
infrastructure underperforms there relative to prep cost, and a mediocre PH
day is public. Revisit only if a major release needs a second wave and the
HN/Reddit channels are exhausted.

## 5. Weeks 2–8+ — the content engine (what carries you from ~1.5k to 5k)

One launch ≠ 5k. The compounding loop is **timely case studies using
replay on real events** — content nobody without a local archive can make:
- Template: event happens (airspace closure, naval incident, GPS-jamming
  spike, mystery drone wave) → within 24–48 h publish a 60–90 s replay GIF
  + a 300-word "what the archive shows" write-up → post to the relevant
  subreddit (r/OSINT, r/ADSB, r/CredibleDefense-adjacent where allowed),
  Mastodon, Bluesky. Each carries one quiet repo link. 90% info, 10% ad.
- Cadence: 1–2/month minimum; opportunistic when news breaks. These double
  as the demand research for W6 (which detector do people ask about?).
- **Monthly release ritual:** one headline feature per month (aligned with
  the product roadmap: archive profile → alert sinks → dark-fleet
  explainability), real release notes, posted to r/selfhosted's monthly
  "what's new" thread and the Discord. GitHub's release-follower feed and
  the "recently updated" surfaces do quiet work.
- **SEO floor:** a `docs/`-based GitHub Pages site with three pages —
  "self-hosted Flightradar24 alternative", "self-hosted ship tracker",
  "flight history without a subscription". These are typed into Google
  verbatim by the target user; alternativeto + a Pages site owns them
  within a couple of months.
- **The second Show HN** (month 3–5): tied to the biggest release (e.g.
  "30 days of world history in 40 GB, scrub any hour" once archive mode is
  proven, or the dark-fleet explainability release). New headline = new
  post, legitimately. This is typically another 300–1,200 stars.

## 6. Community ops (stars follow believers)

- **Issue SLA:** <24 h first response for months 1–2. Nothing converts a
  visitor like an issue tracker full of fast, kind, technical answers.
- Merge the first external PRs fast and generously; credit contributors in
  release notes by handle. Each contributor is a permanent evangelist.
- Pin a **public roadmap issue** (the 90-day plan, trimmed); check items
  off visibly. "They ship what they say" is the retention story.
- Convert launch feedback into named releases within days where cheap
  ("v1.0.2 — the r/selfhosted feedback release").
- Add a star-history chart to the README at ~2k (social proof; needy
  before that).

## 7. Measurement (weekly, 20 minutes, in a pinned issue or docs/)

Track weekly: stars (+delta), GitHub traffic (uniques, referrers), clones,
open/closed issues, Discord members, newsletter/directory placements live.
Funnel sanity: referrer views → uniques → stars should hold ≥5%; if a big
referrer converts <2%, the README (not the channel) is the problem.

Milestones against the median path:
- Week 1: ≥400 (front-page HN) or ≥150 (modest launch). **<100 total by
  day 30 = the roadmap's gate fires: freeze features, rework positioning,
  relaunch. Do not pass the gate by adding channels.**
- Month 2: 1,500–2,000 (drip + first case studies + a reviewer video).
- Month 3–5: 2,500–4,000 (second Show HN wave + directory compounding).
- **5,000: month ~4 (everything hits) to month ~9 (grind path).** Both are
  wins; only the flop-and-ignore-the-gate path loses.

## 8. Division of labor

Agent-executable: README surgery, comparison table, FAQ, press kit,
CONTRIBUTING/templates/labels, good-first-issue seeding, directory PRs,
newsletter/reviewer pitch drafts, case-study write-ups + GIF pipeline
(screenshot-panel.mjs exists), release notes, weekly metrics digest.
Operator-only: posting under their own accounts (HN/Reddit norms require
the human author, and voting/posting by proxy is ban territory), Discord
presence, final say on name/version, sending outreach email from a real
address, being "the builder" in threads — the single most credibility-
bearing asset in the whole plan.

## 9. Do-not list (each of these has ended a launch)

- **No paid/exchanged/botted stars, ever** — GitHub purges them and the
  graph shape (cliff + foreign burst) is publicly visible; HN threads
  screenshot it. 5k fraudulent stars is worth less than 500 real ones.
- No upvote solicitation, vote rings, or alt accounts on HN/Reddit.
- No public live demo instance (feed ToS, OPSEC, DDoS — settled in the
  roadmap). The GIF is the demo.
- Never "AI-powered" in a title; never unlabeled AI output in a
  screenshot (the PRISM-dashboard backlash is the cautionary tale).
- No "Palantir alternative / killer" framing — it's cringe to the OSINT
  crowd, invites exactly the wrong scrutiny, and undersells the actual
  differentiator (ownership, not vibes).
- No coverage overclaims: every count in public copy must be a measured
  number with a date (repo rule anyway; doubly so in marketing).
- Don't argue with hostile comments; answer the technical substance once,
  concede real limitations, move on. Threads reward the calm builder.

## 10. Launch-week runbook (condensed)

| Day | Action |
|---|---|
| T−7…−1 | Community participation; stranger-boot gate passes; README surgery done; assets recorded; release tagged |
| Tue | r/selfhosted post (existing draft), all-day presence; file feedback issues |
| Wed | r/OSINT post (its draft); fix + ship one small feedback item |
| Wed/Thu | Show HN 8–10 am ET; first comment = builder story; all-day presence |
| Fri | Discords + Mastodon/Bluesky thread; v1.0.1 with launch-week fixes |
| Sat/Sun | r/ADSB / r/homelab variants if energy; weekly metrics entry #1 |
| Week 2+ | §4 directories/newsletters/reviewers; §5 content engine starts |

The single sentence to keep on the monitor while doing all of it: **does
this turn what we already see into something a stranger can run, trust,
and keep?** Stars are the echo of "yes".
