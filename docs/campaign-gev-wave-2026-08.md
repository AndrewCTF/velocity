# Campaign: the God's Eye View wave (drafted 2026-08-30)

A launch happened in our category and we are not in the conversation.
`bilawalsidhu/gods-eye-view` went MIT-public around 2026-08-24 and is at
**12,772 stars / 59 open issues** (GitHub API, 2026-08-30). Velocity is at **81
stars**. This document is how we ride that wave instead of arguing with it.

The window is decaying. A wave-riding post is welcome in week one or two and
looks like scavenging in week five. Fire this week.

## The position (read this before writing anything)

**Never punch at GEV.** At 81 vs 12,772 stars, adversarial framing reads as sour
grapes and invites exactly the head-to-head we lose. GEV's globe is beautiful,
its onboarding is charming, and it has 150x our distribution.

The wedge is not quality, it is **category**. GEV's own README draws the line
for us, twice:

> "An evolving open-source client for exploration and learning — a fast,
> hackable foundation, **not a hardened production service**." (README, Status)

> `GOOGLE_MAPS_API_KEY` … "**That one key is the whole entry fee.**"
> (README, Quick start / Keys & Costs)

Those are honest, correct statements about what GEV is for. They are also the
segmentation. GEV is the demo that made a hundred thousand people want a fusion
globe. Velocity is the console you leave running afterwards.

And the globe itself is already commodity: firmatic.nl published "we tested it
and built our own version for €0" within days, and `noaRoblesLevy/GodsEye`
shipped the same shape independently. Nobody wins the globe. The archive, the
provenance and the custody log are the parts nobody cloned in a weekend.

**One-line message:**

> God's Eye View is the best way to *see* the planet right now. Velocity is what
> you run when you need to prove what you saw, six weeks later.

## Claims, with receipts

Every row below was verified this session. Do not add a row without a receipt —
one wrong claim about a 12.7k-star project ends the campaign's credibility.

| Claim | Receipt |
| --- | --- |
| GEV requires a metered Google Maps key | GEV README line 72 (`set GOOGLE_MAPS_API_KEY`), line 290 (marked 🔴 required, metered) |
| Velocity needs no key for any core feed | `README.md:110-127`, `docker-compose.yml` (`.env` marked `required: false`) |
| GEV self-describes as not production-hardened | GEV README line 346 |
| GEV keeps ~24 h of per-target trace, not an archive | GEV README line 212 ("silently backfills ~24 h of real trace history"); launch replay at line 220 is labelled `RECONSTRUCTED ESTIMATE` |
| Velocity records position history you keep | `README.md:121-127` (`ARCHIVE_MODE=1`, named Docker volume, replay scrubber) |
| Velocity scores what it shows | `/api/status/provenance`, per-contact source count + fix age (`README.md:20-28`) |
| Velocity has chain-of-custody evidence export | SHA-256 evidence locker + append-only custody log → self-contained HTML/PPTX case report (`README.md:37-44`, `README.md:264-266`) |
| Both refuse person-tracking | GEV README line 342; Velocity fuses public broadcasts only |

**Do not claim** that GEV has "no replay" — it has per-target backfill and a
scrubbable reconstructed launch replay. The true distinction is *ephemeral
per-target backfill* versus *a persistent archive on your disk*. Say it that way
or not at all.

**Do not weaponise GEV's ~25 open security issues** (SSRF, unauthenticated
quota-spend, key exposure). They are the honest consequence of the status line
it already publishes, and 26 of the 59 open issues were filed in one batch by a
single outside contributor (`jsawyerdev`) rather than reported as breakage by
users (`gh api .../issues --jq '.[].user.login'`, 2026-08-30). Pointing at them
reads as an attack. If asked directly about hardening, answer about
Velocity only: `docker-compose.prod.yml`, auth on by default off-loopback, 2587
passing tests.

## Demand mining: their issue tracker is our copy

These are prospective users describing our product in their own words, in a
thread we did not have to start. **Mine the language. Do not post in their
issues** — showing up in a competitor's tracker to pitch is the one move that
turns goodwill into a grudge.

| What GEV users are asking for | Issues | Velocity today |
| --- | --- | --- |
| Docker / one-click deploy for non-developers | #43, #48 | `docker compose up` — api + web + nginx (`README.md:110`) |
| npm install / `.env` / API-key setup pain | #86, #76, #74, #69, #90 | Boots keyless, nothing to configure |
| An option to not use Google's 3D tiles | #64, #59 | 8-way keyless basemap picker (`README.md:635`), no Google dependency |
| Google 3D tiles blocked in the EEA | #71 (7 comments) | No Google account involved at all |
| Live weather / satellite imagery overlay | #85 | Partial — fires and hazards, no radar. Don't claim radar. |
| Local RTL-SDR / dump1090 receiver tap | #57 | Not built. Honest roadmap answer. |
| TAK / ATAK Cursor-on-Target | #7 | Not built. Real gap; the highest-value one on this list. |

The first four rows are the campaign. "It runs with one command and no Google
account" answers five separate open issues, and it is already true.

## Channel fire order

Existing drafts are good and were never fired — the July problem was a missing
news hook, and the wave is that hook. **Retool, do not rewrite.**

| # | Channel | Asset | State |
| --- | --- | --- | --- |
| 1 | **Show HN** | `docs/post-hn-2026-07.md` | **Retooled 2026-08-30.** Wave paragraph opens the first comment; a prepared "how is this different from GEV" answer is now #2 in the answer list. Title unchanged — history/replay already leads. |
| 2 | **r/OSINT** | `docs/post-osint-2026-07.md` | **Retooled 2026-08-30.** Wave paragraph opens the body; a GEV-framed title option added. Evidence-trail section already carried the weight. |
| 3 | **r/selfhosted** | `docs/post-selfhosted-2026-07.md` | **Retooled 2026-08-30.** No-Google-key paragraph added above the cost table, plus a GEV title option. |
| 4 | **X** | this doc | Drafted below. Fire from the user's account. |
| 5 | **README** | `README.md:61` table | Drafted below, **deliberately not applied** — a positioning call, not a mechanical edit. |

Everything from `docs/star-campaign-2026-07.md` still applies: never ask for
upvotes, re-measure the live counts with the one-liner in the HN draft before
posting, and mind the account heat on u/Prestigious_Act3077 (mod pre-ack or a
3-4 day cooldown before r/OSINT and r/selfhosted).

**Blocker:** the repo's `pushed_at` is 2026-08-20 and this work is on a local
branch. Push master before any of this fires — traffic landing on a two-week-old
tree is a wasted wave.

### Dated schedule

Today is **Sunday 2026-08-30**. The Reddit account needs a 3-4 day cooldown
(`docs/post-selfhosted-2026-07.md`, account-heat caveat), which sets the floor
for the two Reddit dates. HN carries none of that heat and wants Tue/Wed/Thu
08:00-10:00 ET.

| When | Action | Gate before firing |
| --- | --- | --- |
| **Sun 2026-08-30** | Push master. Boot the stack and re-measure the live counts (one-liner in `docs/post-hn-2026-07.md`). | Nothing fires until master is pushed. |
| **Sun 2026-08-30 or Mon 08-31** | X post (draft below). No account heat here, and X is where the wave actually is. | Repo pushed. |
| **Mon 2026-08-31** | DM the r/selfhosted and r/OSINT mods, one honest paragraph each. Zero promo posts from the Reddit account today. | — |
| **Tue 2026-09-01, 08:00-10:00 ET** | Show HN, `https://projectvelocity.org`. Repo link in the first comment. Stay in the thread all day. | Numbers re-measured that morning; GEV README lines re-checked. |
| **Wed 2026-09-02, 09:00-11:00 ET** | r/selfhosted (the #1 planned channel, never fired). | Account cold 3 days; mod pre-ack or accept filter risk. Check logged-out at +30 min. |
| **Thu 2026-09-03, 09:00-11:00 ET** | r/OSINT. | Same visibility check. |
| **Fri 2026-09-04 - Sun 09-06** | Hold. No posting. Answer threads only. | — |
| **Tue 2026-09-08** | Measure against the baseline below. Decide whether r/osinttools and r/DataHoarder get a second run. | — |

If a post is filtered, message the mods — never repost. If Show HN stalls under
20 points, mail `hn@ycombinator.com` for the second-chance pool and say the angle
changed since the 2026-07-11 attempt (4 points).

### Baseline, measured 2026-08-30

Measured today via the GitHub API, so the delta is checkable rather than felt:

| Metric | 2026-08-30 |
| --- | --- |
| `AndrewCTF/velocity` stars | **81** |
| `AndrewCTF/velocity` forks | 12 |
| `bilawalsidhu/gods-eye-view` stars | **12,772** |
| `bilawalsidhu/gods-eye-view` open issues (excl. PRs) | 59 |

Re-run on 2026-09-08:

```bash
for r in AndrewCTF/velocity bilawalsidhu/gods-eye-view; do
  echo -n "$r "; gh api "repos/$r" --jq '"\(.stargazers_count) stars, \(.forks_count) forks"'
done
```

What counts as the wave having worked: a Show HN that clears 20 points (the July
attempt got 4), and a star count in three figures. Stars are the lagging
indicator; the leading one is whether anyone in a thread says "I bounced off the
Google key" unprompted — that sentence means the positioning landed.

### The wave paragraph (drop into HN first comment and r/OSINT body)

> If you came from God's Eye View, this is the other half of that idea. GEV is
> the best-looking public-data globe out there and it got a lot of people
> interested in this category in one week. It's also explicit that it's a
> foundation for exploration rather than a service you leave running, and the
> photorealistic planet needs a metered Google Maps key. This is the
> leave-it-running half: no key for any core feed, one `docker compose up`, and
> it records the picture to your own disk so you can scrub back to last Tuesday.
> Every contact carries which sources reported it and how old the fix actually
> is, and captures come out with a SHA-256 custody log. Different job, same
> excitement.

### X post

Quote-post or reply on the GEV thread. Generous, factual, no comparison table.

> God's Eye View is the best public-data globe anyone has shipped, and the
> Google 3D tiles are doing real work.
>
> I've been building the boring half for a while: keyless feeds, one compose
> file, and it records position history to your own disk so you can rewind to
> last Tuesday — and captures come out with a SHA-256 custody log.
>
> Different job. AGPL, self-hosted: github.com/AndrewCTF/velocity

Do not tag Sidhu into a comparison. If he engages, be useful and stay factual.

### README comparison row (draft only — not applied)

The existing table at `README.md:61` runs four columns: *History you can replay ·
Self-hosted · Account / API key · Who owns the archive*. A GEV row merges into it
without inventing axes:

| | History you can replay | Self-hosted | Account / API key | Who owns the archive |
|---|---|---|---|---|
| God's Eye View | ~24 h per-target backfill, nothing stored | Yes | Google Maps (metered) | Nothing is kept |

Left unapplied deliberately: the README is public-facing and this branch carries
other work. Adding a competitor row is a positioning call, not a mechanical edit
— your call whether it goes in at all. If it does, keep the table's tone: the
column headings already make the argument, so the cells stay flat.

## What would make this fail

- **Punching down-ward-up.** Any post that reads as "actually, ours is better"
  gets buried and earns a reputation that outlives the wave.
- **A claim that turns out to be wrong.** Re-check the two GEV README lines the
  day you post; that repo changes fast.
- **Firing at a stale repo.** See the push blocker above.
- **Leading with AI features.** Same as July: HN and r/selfhosted read it as
  SaaS-in-disguise.
