# Reddit posts, October 2026

Five posts, each about 80% content a reader keeps even if they never click the
repo, and 20% Velocity, always last and always disclosed. Voice rules are the
ones in [`launch-2026-10.md`](launch-2026-10.md): first person, short sentences,
say what is rough. These words never appear: Gotham, Palantir, world monitor,
dashboard, "N live feeds", "AI-powered", "situational awareness".

## Before posting any of these

The account history is the biggest risk, not the copy. See the post-mortem in
[`post-datahoarder-2026-07-16.md`](post-datahoarder-2026-07-16.md).

1. **One post every 3 or 4 days, at most.** Ten promo posts in eight days got
   the account spam-filtered in July. Pick the order below and stop there.
2. **Message the mods first** wherever the rules mention self-promotion
   (r/OSINT, r/DataHoarder and r/aviation all do). One paragraph: what it is,
   that you built it, that it's AGPL, whether the post is welcome.
3. **Repo link goes in the first comment**, not the body. Then check the post
   logged out at 30 minutes. If it isn't there, it was filtered: message the
   mods, don't repost.
4. **Re-measure every number marked `[like this]`** on the morning you post
   (commands are in `launch-2026-10.md`). A stale number loses the thread.
5. **Spend the first hour answering comments.** Most of a post's reach comes
   from comment activity in that hour.

Suggested order: r/ClaudeAI, r/selfhosted, r/ADSB, r/mcp, r/OSINT (needs a
mod reply first).

## Why these are built the way they are

Each post uses the same few levers, on purpose:

- **A curiosity gap in the title**, answered properly in the body. The
  title promises something specific and the body delivers it, so the post
  earns the click instead of baiting it.
- **Specific numbers over adjectives.** "9.43 GB/day" is believable in a way
  "lightweight" never is, and people repeat specific numbers in comments.
- **Admitting the flaws first.** Saying where it's weak before anyone else
  does makes the rest believable, and it takes away the top comment's
  ammunition.
- **Something useful up front.** A reader who learned something from the post
  is far more willing to look at the project at the end.
- **Asking for expertise at the end.** "Tell me what you'd cut" gets more
  comments than "check it out", and comments drive ranking.
- **Loss aversion, stated as fact.** Free history windows really did shrink.
  That's the real reason anyone self-hosts this, so it's said plainly, not
  dressed up as urgency.

What none of them do: invent users, fake urgency, post from second accounts,
or hide who wrote it. Every one of those gets a post removed and the account
banned, and on r/OSINT it also kills the project's reputation in its core
audience.

---

## 1. r/selfhosted

**Flair:** the self-promo / AI flair the sub requires that week. **Day:** Wednesday.

**Title options**

- `What it actually costs to record every plane and ship you can see, on your own disk`
- `I recorded every aircraft and ship position for two months. Here's the disk bill.`
- `A 49 GB SQLite WAL file, and other things I learned self-hosting a flight archive`

**Body**

> Free flight trackers keep cutting their history. Flightradar24 wants a
> subscription for anything past [12 hours], MarineTraffic cut its free window
> to 24 hours, and ADS-B Exchange ended its free API. So I started recording
> everything locally, and I couldn't find a straight answer for what that costs.
> Here's mine, measured.
>
> **The raw number.** Flat out, one row per position, plain SQLite: 9.43 GB a
> day, about 3.4 TB a year. 97% of that is aircraft. Roughly 12,600 planes are
> airborne at any moment and they all move fast enough to beat the dedup
> threshold. Ships are 3%: most of the ~57,000 in view are parked and barely
> write rows.
>
> **Why the rows were fat.** 208.8 bytes for what is really six numbers. The
> vessel name was being rewritten on every fix (one ship's name hit disk 48
> times an hour, forever), the ID was a 15-char string stored twice because
> of the index, and "aircraft"/"vessel" was a string on every row. Lesson:
> anything static per object belongs in its own table, not the position row.
>
> **The bug worth checking on your own box.** One day the archive was 71 GB on
> disk for 15 GB of data. The WAL file was 49.6 GB by itself. A WAL can only
> checkpoint past its oldest open reader. My UI polled a coverage query every
> 5 seconds, the query took longer than 5 seconds, so a reader was always open
> and the log could never shrink. Worse, a bigger WAL makes every read slower,
> which holds the reader longer, which grows the WAL faster. The same query
> went from 73 s to 14.8 s once the log was gone.
> `PRAGMA wal_checkpoint(TRUNCATE)` gave back 48.6 GB in 38 seconds. The fix
> was caching the scan and setting `journal_size_limit`. If you run anything
> WAL-mode with a long reader and a constant writer, go look at your `-wal`
> file today.
>
> **What fixed the size for real.** Moving to Postgres + TimescaleDB with
> 6-hour chunks and columnar compression segmented by ID. Migrating 55,352,047
> rows ran at ~120k rows/s, and the compressed table came out 13.46x smaller
> (11.3 GB down to 840 MB). SQLite is still the fallback if you don't want to
> run Postgres. Retention is a byte budget you set, not a pricing tier.
>
> Right now mine holds [132M] positions since August in [27 GB].
>
> **The thing doing the recording** is something I built, called Velocity: a
> docker compose stack (api + web + nginx), no API keys, live aircraft and
> ships on a map with a scrubber to rewind to any moment you recorded. It can
> fold in your own ADS-B receiver's tar1090, and alert you to Discord, a
> webhook or ntfy when something enters an area. Loopback-only by default; I
> reach it over Tailscale.
>
> What's rough: coverage is whatever the volunteer feeders can see, so it's
> thin over open ocean. The 3D globe wants a real GPU on the viewing machine
> (there's a lighter 2D map). And I built it with a lot of help from Claude
> Code; I review every change and it has [3,276] backend tests.
>
> Question for people who've stored time series at this row count: would you
> partition by day, or is Timescale's chunking already doing the job? Repo in
> the first comment.

**First comment:** `Repo (AGPL-3.0): https://github.com/AndrewCTF/velocity. docker compose up and it's on :8080.`

**The 20%:** the "thing doing the recording" paragraph and the repo link.
Everything above it is useful to anyone running SQLite or Timescale.

---

## 2. r/ADSB (or r/aviation, mod message first)

**Title options**

- `How GPS jamming maps are made from airliner broadcasts, and three ways to misread them`
- `The GPS jamming map you keep seeing is built from one number every plane broadcasts`

**Body**

> Every GPS jamming map you've seen in the news (GPSJam is the well-known one)
> is built from a field most people never look at: the accuracy figure a plane
> reports about its own position.
>
> **How it works.** An ADS-B position message carries two quality numbers. NIC
> (Navigation Integrity Category) is how sure the avionics are that the
> position is inside a given radius. NACp (Navigation Accuracy Category for
> position) is the expected accuracy. When GPS is healthy, an airliner reports
> high values. When it's being jammed, the receiver loses its fix or falls back
> to something worse, and those numbers drop. The usual method counts a
> report as degraded when NACp < 8 or NIC < 7, bins every report into a
> hexagon grid, and colours each cell by the share of aircraft that were
> degraded over the period.
>
> Nothing is measuring the jammer. You're inferring it from what the
> airplanes say about themselves. That's clever, and it's also where people go
> wrong.
>
> **Three ways to misread the map:**
>
> 1. **One bad transponder.** Some older or misconfigured avionics always
>    report low integrity. A cell with three aircraft in it, one of them a
>    permanently low reporter, looks 33% jammed. Always check how many aircraft
>    a cell is based on before reading anything into its colour.
> 2. **No data looks like no jamming.** If nobody's feeder can hear a region,
>    the cell is empty, not green. Over open ocean and in places with few
>    volunteer receivers, absence of red means absence of evidence.
> 3. **Jamming vs spoofing.** Jamming drops the quality numbers. Spoofing can
>    keep them high while the reported position is wrong: the aircraft
>    confidently broadcasts that it's somewhere it isn't. Tracks that jump
>    sideways, or circle over an airport they're nowhere near, are the tell,
>    and a pure NIC/NACp map won't flag them.
>
> If you run a feeder, you're part of what makes these maps possible. The
> hexagons over your area are your antenna.
>
> **Disclosure:** I build a self-hosted tracker called Velocity that draws this
> same layer (same NACp/NIC method) next to live aircraft and ships, and keeps
> the history on your own disk so you can look at last week's jamming instead
> of only today's. It can take your own receiver's tar1090 feed. Built with
> help from Claude Code. Repo in the comments if anyone wants it.
>
> What I'd like to know from feeder operators: have you seen a specific
> avionics fit that always reports low NIC? I'd rather filter known offenders
> than let them paint cells red.

**First comment:** `Repo: https://github.com/AndrewCTF/velocity (AGPL, no API keys).`

**The 20%:** the disclosure paragraph. The method and the three misreadings
are the post.

---

## 3. r/OSINT (mod message first: draft in `launch-2026-10.md`)

r/OSINT's rules: tools must be free and open source, list their APIs, posts
must be human-written. **The operator rewrites this in their own words before
posting.** Treat the text below as notes, not copy.

**Title options**

- `Before you cite a flight tracker in a thread: five checks`
- `A dot on a flight map is not evidence. What to check before you screenshot it.`

**Body**

> Flight and ship trackers are some of the most-screenshotted sources in open
> source work, and the most over-trusted. A contact appearing on a map is not
> proof it was ever broadcast. Five checks I now run before citing one:
>
> 1. **How many independent receivers heard it?** Crowd-sourced aggregators
>    accept uploads from anyone. A contact seen by one feeder and no one else
>    is a lead, not a fact.
> 2. **How old is the fix?** Many trackers keep drawing a contact for minutes
>    after its last position, and cached sources often report when _they_
>    fetched the data, not when the plane broadcast it. A stale dot looks
>    exactly like a live one.
> 3. **ADS-B or MLAT?** MLAT positions are computed from arrival times at
>    several receivers. Useful for aircraft that don't broadcast a position,
>    but less precise, and can jump.
> 4. **Do the integrity numbers make sense?** A track with good NIC/NACp that
>    jumps kilometres sideways is a spoofing candidate. Low numbers across a
>    whole area suggest jamming.
> 5. **Can you get the history from somewhere you control?** If the source
>    deletes after 12 or 24 hours, your citation can't be re-checked next
>    week. Save the raw track, not just the screenshot, and hash it.
>
> **Disclosure:** I build Velocity, a free self-hosted tracker (AGPL) that
> shows these checks per contact: which sources reported it, how many agreed,
> how old the fix is. It records position history to your own disk and has an
> evidence locker that SHA-256 hashes every capture with an append-only
> custody log. All data sources are listed in the README. I wrote it with
> heavy help from Claude Code and review every change.
>
> What checks did I miss? Particularly for AIS, where spoofed and swapped
> MMSIs make all of this harder.

**The 20%:** the disclosure paragraph. The checklist works with any tracker.

---

## 4. r/ClaudeAI

**Flair:** Built with Claude (the sub asks you to explain how).

**Title options**

- `Four months of Claude Code on one repo. The file that stopped it undoing my decisions.`
- `Claude Code kept "cleaning up" things I'd fixed on purpose. Here's the fix that worked.`

**Body**

> I've used Claude Code on a single repo for four months. The biggest problem
> wasn't bad code. It was confident cleanups: Claude would see something odd,
> tidy it, and undo a decision I'd made for a reason it couldn't see. Every
> real regression came from that.
>
> What fixed it, in order of impact:
>
> 1. **Every decision gets a guard test.** If I decide "this refresh interval
>    stays at X" or "this feed must work with no API key", a test asserts it.
>    One command (`scripts/verify.sh`) runs them all. When a cleanup undoes an
>    old decision, the build fails and names the decision.
> 2. **A decision log the guards point to.** `docs/decisions.md` holds the why,
>    the date and the post-mortem. CLAUDE.md says: read the entry before
>    changing guarded behaviour. To revoke a decision you change the guard
>    _and_ the file that states it, deliberately.
> 3. **CLAUDE.md per directory.** The root file is short and points to one
>    per area (web, api, ml, infra). They load when Claude works there, so it
>    sees the rules for the code it's touching without a 2,000-line root file.
> 4. **Evidence words.** It can't say "done", "works" or "fixed" without the
>    command and output from that turn, and claims get tagged proven-live,
>    plumbed-unverified or not-built. "Complete" and "global" are banned
>    without a live count. This one change killed most of the overclaiming.
> 5. **A test baseline it may not drop below.** The pass count lives in
>    CLAUDE.md with a date. It's [3,276] now. Never commit below the number
>    you inherited.
>
> One surprise: running tests in parallel by default made results depend on
> core count. Green on a 16-core machine, red in 4-core CI, because of state
> leaking between test files. Serial is now the default.
>
> **The project** is Velocity, a self-hosted flight and ship tracker that keeps
> its own history so you can rewind the map. It also runs as an MCP server, so
> Claude can ask it what's flying somewhere right now instead of guessing from
> training data. The CLAUDE.md is in the repo if you want to steal the
> structure: https://github.com/AndrewCTF/velocity
>
> What's in your CLAUDE.md that made the biggest difference?

**The 20%:** the project paragraph. The five patterns work on any repo.

---

## 5. r/mcp

**Flair:** showcase, with the disclosure.

**Title options**

- `Lessons from building an MCP server for live data: make every answer say how old it is`
- `MCP server for live aircraft and ship positions, and what I learned about tool output design`

**Body**

> Ask an agent "what's flying near X right now" and it either refuses or
> makes something up from training data. I built an MCP server that answers
> from live feeds instead, and most of what I learned was about the shape of
> the tool output, not the data.
>
> **What worked:**
>
> - **Put the age in every answer.** Each contact carries how many seconds old
>   its fix is. Without that, the model presents a 20-minute-old position as
>   "currently". With it, it says "last seen 20 minutes ago" on its own.
> - **Put the source in every answer.** Which feeds reported this contact and
>   how many agreed. The model then hedges correctly when one source is alone
>   in seeing something.
> - **Label automated output as automated.** Anything the server derives
>   rather than observes says so. The model passes the label on instead of
>   upgrading a guess into a fact.
> - **Accept shapes the user actually has.** `focus_area` started as centre +
>   radius. Someone here asked for polygons in July, so it now takes either.
>   Real areas of interest are rarely circles.
>
> **Disclosure:** it's part of Velocity, a self-hosted tracker I build (AGPL,
> no API keys, mostly written with Claude Code). The MCP server runs against
> your own instance.
>
> How are other people handling freshness in tool output? Timestamps, ages, or
> something else?

**First comment:** `Repo: https://github.com/AndrewCTF/velocity`

**The 20%:** the disclosure paragraph. The output-design list is the post.
