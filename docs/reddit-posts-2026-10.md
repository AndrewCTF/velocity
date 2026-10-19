# Reddit posts, October 2026

Five posts, each about 80% content a reader keeps even if they never click the
repo, and 20% Velocity, always last and always disclosed. Voice rules are the
ones in [`launch-2026-10.md`](launch-2026-10.md): first person, short sentences,
say what is rough. These words never appear: Gotham, Palantir, world monitor,
dashboard, "N live feeds", "AI-powered", "situational awareness".

## High-ceiling versions (read this first)

Added 2026-10-19 after the operator's verdict on the long posts: they won't blow
up. That's right. The long posts are niche-sub posts: a good one gets a few
hundred upvotes and some stars. A post that reaches the front of a big sub
needs things they don't have:

- **A picture or a video.** In big subs almost everything that takes off is
  visual. A text essay tops out in a niche sub.
- **A title that makes people feel something.** The long posts' titles explain.
  These use a villain (paywalled history), a before/after, or a surprise, and
  every claim in them is true.
- **The plug in the comments, not the post.** Big subs remove self-promotion,
  but "what software is this?" always gets asked. Answering it honestly, with
  the disclosure, is the 20%.
- **Timing.** A replay of something that is in the news this week beats
  anything here. When an airspace closure or shipping incident hits the news,
  record the replay within 24 to 48 hours and post that instead.
- **An account that isn't filtered.** Nothing blows up if automod removes it.
  Let the account cool first (see the rules below), and check every post
  logged out at 30 minutes.

Never fake the votes, the comments or the "what software is this?" question.

Assets these need, none of which exist yet except the GIF:

- The Heathrow side-by-side (`heathrow-2025-03-21-replay.mp4`, recorded
  2026-10-17 per `launch-2026-10.md`, not in the repo).
- A 30-second, 24-hour time-lapse of Europe from the replay at 3600x, with
  the UI panels hidden.
- A clean density map of the ship archive: dots on a dark basemap, no UI. The
  existing screenshots carry the console chrome and the event labels, which is
  the look the July threads called "AI slop". Don't use them for these.
- `docs/media/tour-replay.gif` (exists) for r/selfhosted.

### A. r/aviation (video)

```
Heathrow the day before the substation fire vs the day of. Every plane over London, replayed at 600x.
```

```
First: Thursday 20 March 2025. Then: Friday 21 March, after the North Hyde substation fire cut Heathrow's power overnight. Same window, same speed. Watch the approach stream west of London just stop.

Replayed from a public ADS-B archive that goes back to January 2024. How it's made is in the comments.
```

Your own first comment:

```
How it's made: community ADS-B sites publish a history file for every half hour, and adsb.lol and adsb.fi have them back to January 2024. I replayed those files in Velocity, a free self-hosted tracker I build (with a lot of help from Claude Code): https://github.com/AndrewCTF/velocity
```

### B. r/interestingasfuck or r/Damnthatsinteresting (video)

Both remove self-promotion. Nothing about the tool goes in the post.

```
24 hours of every plane over Europe, squeezed into 30 seconds
```

When someone asks what it's made with:

```
I made it with a self-hosted tracker I build, called Velocity. It records public ADS-B data and can replay any day: https://github.com/AndrewCTF/velocity
```

### C. r/dataisbeautiful [OC] (image; r/MapPorn later)

The sub requires a comment naming the data source and the tool, which is the
plug. The ship archive has gaps and ends 2026-10-10, so the title says "about
two months" and the comment gives the real range.

```
[OC] About two months of free ship-tracking data. The oceans look empty because every receiver is on shore.
```

Required source comment:

```
Data: AIS positions from free, no-key sources (ShipXplorer, OpenWaters, VesselFinder), recorded August to October 2026, with gaps. Free AIS comes from shore receivers with roughly 20 to 40 nautical miles of range, which is why open water is blank: when I queried six open-ocean boxes directly, both providers returned zero ships. Satellite AIS covers the oceans but is paid.

Tool: recorded by Velocity, a self-hosted tracker I build (https://github.com/AndrewCTF/velocity), rendered with matplotlib.
```

### D. r/selfhosted (GIF)

```
Flightradar24 now charges to see flights older than 12 hours. My home server has kept every flight and ship it's seen since August.
```

```
132 million positions in 27 GB. Drag the slider and the whole map rewinds.

- docker compose up, no API keys, no account
- planes, ships and satellites from public feeds, plus your own ADS-B receiver if you have one
- phone alerts (ntfy, Discord, webhook) when something enters an area you pick
- retention is a disk budget you set, not a subscription

What's rough: ocean coverage is thin because free AIS is shore-based, the 3D globe wants a decent GPU (there's a 2D view), and I built it with a lot of help from Claude Code.

AGPL, link in the first comment. Ask me anything about the storage. One bug grew a 49 GB SQLite WAL file, and the story is in the comments if anyone wants it.
```

### E. r/ClaudeAI (sharper title for post 4, same body)

```
Claude Code kept "tidying up" my code and quietly undoing my decisions. So I made every decision a failing test.
```

---

### F. r/sysadmin (also works in r/selfhosted)

Text post. r/sysadmin removes self-promotion, so the project is only in your
first comment.

```
PSA: go look at your SQLite -wal files. One of mine was 49 GB for 15 GB of data.
```

```
Quick one, because I'd never have guessed this could happen.

My database was 15 GB. The file next to it, the -wal file, was 49.6 GB.

Why: SQLite's write-ahead log can only be folded back into the database past the oldest open reader. I had a status query that ran every 5 seconds and took longer than 5 seconds. So there was always a reader open, the log never got checkpointed, and the writer kept appending.

It snowballs. A bigger WAL makes every read slower, which keeps the reader open longer, which grows the WAL faster. The same query took 73 s with the bloated log and 14.8 s after.

Check yours:

    ls -la *.db-wal

Shrink it (stop the writer first):

    sqlite3 your.db "PRAGMA wal_checkpoint(TRUNCATE);"

That gave me back 48.6 GB in 38 seconds. To stop it coming back: make sure no query runs longer than the interval it's polled at, and set `PRAGMA journal_size_limit`.

Lots of self-hosted apps keep their data in SQLite. If one of them has a constant writer and a slow reader, it can do this to you too.
```

```
For context, this was the position archive in Velocity, a self-hosted flight and ship tracker I build: https://github.com/AndrewCTF/velocity. The archive has moved to TimescaleDB since, but SQLite is still the default for people who don't want Postgres, and that path has the fix.
```

### G. r/LocalLLaMA

Attach a screenshot of an MCP client answering "what's flying near X" with the
source and age visible.

```
I gave my local model live access to planes and ships over MCP. The fix that mattered: make every answer say how old the data is.
```

```
Ask any model "what's flying over London right now" and it either refuses or invents something. So I wrote an MCP server that answers from live aircraft and ship feeds instead.

Three things made the answers trustworthy:

- **Every contact carries its age.** Without it, the model reports a 20-minute-old position as "currently". With it, it says "last seen 20 minutes ago" on its own.
- **Every contact carries its sources.** Which feeds reported it and how many agreed. The model hedges by itself when only one source saw something.
- **Derived output is labelled as derived.** The model passes the label on instead of upgrading a guess into a fact.

The heavy reasoning runs locally. One tool gathers the relevant data and hands it to an Ollama model (the smallest one you have installed, by default), so only the conclusion comes back into the agent's context. If Ollama isn't running, it returns the raw data instead of failing.

It works with any MCP client and needs no API keys. The data comes from a self-hosted tracker I build called Velocity, written with a lot of help from Claude Code. Link in the comments.

Which local models are you finding reliable for long tool-calling chains? That's the part I'd like to tune next.
```

```
Repo (AGPL): https://github.com/AndrewCTF/velocity. The MCP setup and the Ollama settings are in the README.
```

### H. r/selfhosted (discussion)

Discussion posts get the most comments here. Reply to every answer in the
first hour, and add your own second and third examples in the comments.

```
What does your server keep that no company will keep for you?
```

```
Mine is flight and ship history. Flightradar24's free tier now stops at 12 hours, and MarineTraffic's at 24. My server has kept every aircraft and ship position it's seen since August: 132 million of them, in 27 GB.

What's yours? I'm after the stuff where the free tier quietly got smaller or the service disappeared, and you decided to just keep it yourself.
```

```
The flight and ship one is Velocity, which I build. It's AGPL, docker compose up, no API keys: https://github.com/AndrewCTF/velocity
```

### I. r/interestingasfuck (image)

A clean screenshot of the Singapore Strait vessel layer with the panels
hidden. No self-promotion in the post.

```
1,282 ships in the Singapore Strait at a single moment, from free tracking data
```

When someone asks:

```
It's a self-hosted ship and flight tracker I build, called Velocity. It merges the free AIS feeds and keeps the history: https://github.com/AndrewCTF/velocity. And this is only what shore receivers can hear. Out at sea, free tracking sees almost nothing.
```

### J. r/homelab (photo)

Post a real photo of the machine, plus the replay GIF. r/homelab rewards the
hardware story: if you can, add one line at the top of the body saying what
the machine is (CPU, RAM, disk).

```
My homelab records every plane and ship it can get from public feeds. 132 million positions since August, 27 GB.
```

```
What it runs: a docker compose stack (API, web, nginx, TimescaleDB) that pulls live aircraft and ship positions from public feeds with no API keys and writes every one to disk. 27 GB so far. The compression is the reason it's that small: the same data was 11.3 GB in SQLite before it became 840 MB in TimescaleDB.

The payoff is the slider. Drag it and the map rewinds to any moment it recorded. It can also ping your phone (ntfy, Discord or a webhook) when a military aircraft or GPS jamming shows up in an area you pick.

Rough edges: the 3D globe wants a decent GPU on whatever you view it from, and ocean coverage is thin because free ship data comes from shore receivers.

I built it, with a lot of help from Claude Code. Link in the comments.
```

```
Repo (AGPL): https://github.com/AndrewCTF/velocity
```

### K. r/opensource (GIF)

```
I built a flight and ship tracker that keeps its own history, because the free ones keep deleting theirs (AGPL)
```

```
Flightradar24's free tier keeps 12 hours of history, MarineTraffic's keeps 24, and ADS-B Exchange ended its free API. So I built an open one you run yourself.

Velocity records every aircraft and ship position it sees to your own disk, and a slider rewinds the map to any moment. For aircraft it can also replay public archives back to January 2024. No API keys, no account, docker compose up.

Every plane and ship on the map shows which sources reported it and how old the fix is, so a stale dot never pretends to be live.

What's rough: ocean coverage is thin (free ship data comes from shore receivers), the 3D globe wants a decent GPU (there's a 2D view), and it's a single-user tool for now. I wrote it with a lot of help from Claude Code and review every change; there are 3,276 backend tests.

Contributions welcome, especially from people who run their own ADS-B receivers.
```

```
https://github.com/AndrewCTF/velocity
```

---

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
4. **Re-check the numbers on the morning you post.** They were last measured
   2026-10-17: 132M positions, 27 GB, 3,276 backend tests, Flightradar24 free
   history at 12 hours (the README table still says 7 days; check FR24's
   pricing page). Commands are in `launch-2026-10.md`. A stale number loses
   the thread.
5. **Spend the first hour answering comments.** Most of a post's reach comes
   from comment activity in that hour.

Suggested order: r/ClaudeAI, r/selfhosted, r/RTLSDR, r/aviation, r/PostgreSQL,
r/dataengineering, r/mcp, r/maritime, r/ADSB, r/satellites, r/Python,
r/webdev, r/AppSec, r/remotesensing, r/webscraping, then r/OSINT and
r/DataHoarder once their mods have replied. At one post every 3 or 4 days that
is about two months; don't compress it.

r/ADSB and r/homelab were among the subs posted to in July. If you post there
again, leave the longest gap before it.

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

One title per block, pick one.

```
What it actually costs to record every plane and ship you can see, on your own disk
```

```
I recorded every aircraft and ship position for two months. Here's the disk bill.
```

```
A 49 GB SQLite WAL file, and other things I learned self-hosting a flight archive
```

**Body**

```
Free flight trackers keep cutting their history. Flightradar24 wants a subscription for anything past 12 hours, MarineTraffic cut its free window to 24 hours, and ADS-B Exchange ended its free API. So I started recording everything locally, and I couldn't find a straight answer for what that costs. Here's mine, measured.

**The raw number.** Flat out, one row per position, plain SQLite: 9.43 GB a day, about 3.4 TB a year. 97% of that is aircraft. Roughly 12,600 planes are airborne at any moment and they all move fast enough to beat the dedup threshold. Ships are 3%: most of the ~57,000 in view are parked and barely write rows.

**Why the rows were fat.** 208.8 bytes for what is really six numbers. The vessel name was being rewritten on every fix (one ship's name hit disk 48 times an hour, forever), the ID was a 15-char string stored twice because of the index, and "aircraft"/"vessel" was a string on every row. Lesson: anything static per object belongs in its own table, not the position row.

**The bug worth checking on your own box.** One day the archive was 71 GB on disk for 15 GB of data. The WAL file was 49.6 GB by itself. A WAL can only checkpoint past its oldest open reader. My UI polled a coverage query every 5 seconds, the query took longer than 5 seconds, so a reader was always open and the log could never shrink. Worse, a bigger WAL makes every read slower, which holds the reader longer, which grows the WAL faster. The same query went from 73 s to 14.8 s once the log was gone. `PRAGMA wal_checkpoint(TRUNCATE)` gave back 48.6 GB in 38 seconds. The fix was caching the scan and setting `journal_size_limit`. If you run anything WAL-mode with a long reader and a constant writer, go look at your `-wal` file today.

**What fixed the size for real.** Moving to Postgres + TimescaleDB with 6-hour chunks and columnar compression segmented by ID. Migrating 55,352,047 rows ran at ~120k rows/s, and the compressed table came out 13.46x smaller (11.3 GB down to 840 MB). SQLite is still the fallback if you don't want to run Postgres. Retention is a byte budget you set, not a pricing tier.

Right now mine holds 132M positions since August in 27 GB.

**The thing doing the recording** is something I built, called Velocity: a docker compose stack (api + web + nginx), no API keys, live aircraft and ships on a map with a scrubber to rewind to any moment you recorded. It can fold in your own ADS-B receiver's tar1090, and alert you to Discord, a webhook or ntfy when something enters an area. Loopback-only by default; I reach it over Tailscale.

What's rough: coverage is whatever the volunteer feeders can see, so it's thin over open ocean. The 3D globe wants a real GPU on the viewing machine (there's a lighter 2D map). And I built it with a lot of help from Claude Code; I review every change and it has 3,276 backend tests.

Question for people who've stored time series at this row count: would you partition by day, or is Timescale's chunking already doing the job? Repo in the first comment.
```

**First comment**

```
Repo (AGPL-3.0): https://github.com/AndrewCTF/velocity. docker compose up and it's on :8080.
```

**The 20%:** the "thing doing the recording" paragraph and the repo link.
Everything above it is useful to anyone running SQLite or Timescale.

---

## 2. r/ADSB (or r/aviation, mod message first)

**Title options**

One title per block, pick one.

```
How GPS jamming maps are made from airliner broadcasts, and three ways to misread them
```

```
The GPS jamming map you keep seeing is built from one number every plane broadcasts
```

**Body**

```
Every GPS jamming map you've seen in the news (GPSJam is the well-known one) is built from a field most people never look at: the accuracy figure a plane reports about its own position.

**How it works.** An ADS-B position message carries two quality numbers. NIC (Navigation Integrity Category) is how sure the avionics are that the position is inside a given radius. NACp (Navigation Accuracy Category for position) is the expected accuracy. When GPS is healthy, an airliner reports high values. When it's being jammed, the receiver loses its fix or falls back to something worse, and those numbers drop. The usual method counts a report as degraded when NACp < 8 or NIC < 7, bins every report into a hexagon grid, and colours each cell by the share of aircraft that were degraded over the period.

Nothing is measuring the jammer. You're inferring it from what the airplanes say about themselves. That's clever, and it's also where people go wrong.

**Three ways to misread the map:**

1. **One bad transponder.** Some older or misconfigured avionics always report low integrity. A cell with three aircraft in it, one of them a permanently low reporter, looks 33% jammed. Always check how many aircraft a cell is based on before reading anything into its colour.
2. **No data looks like no jamming.** If nobody's feeder can hear a region, the cell is empty, not green. Over open ocean and in places with few volunteer receivers, absence of red means absence of evidence.
3. **Jamming vs spoofing.** Jamming drops the quality numbers. Spoofing can keep them high while the reported position is wrong: the aircraft confidently broadcasts that it's somewhere it isn't. Tracks that jump sideways, or circle over an airport they're nowhere near, are the tell, and a pure NIC/NACp map won't flag them.

If you run a feeder, you're part of what makes these maps possible. The hexagons over your area are your antenna.

**Disclosure:** I build a self-hosted tracker called Velocity that draws this same layer (same NACp/NIC method) next to live aircraft and ships, and keeps the history on your own disk so you can look at last week's jamming instead of only today's. It can take your own receiver's tar1090 feed. Built with help from Claude Code. Repo in the comments if anyone wants it.

What I'd like to know from feeder operators: have you seen a specific avionics fit that always reports low NIC? I'd rather filter known offenders than let them paint cells red.
```

**First comment**

```
Repo: https://github.com/AndrewCTF/velocity (AGPL, no API keys).
```

**The 20%:** the disclosure paragraph. The method and the three misreadings
are the post.

---

## 3. r/OSINT (mod message first: draft in `launch-2026-10.md`)

r/OSINT's rules: tools must be free and open source, list their APIs, posts
must be human-written. **The operator rewrites this in their own words before
posting.** Treat the text below as notes, not copy.

**Title options**

One title per block, pick one.

```
Before you cite a flight tracker in a thread: five checks
```

```
A dot on a flight map is not evidence. What to check before you screenshot it.
```

**Body**

```
Flight and ship trackers are some of the most-screenshotted sources in open source work, and the most over-trusted. A contact appearing on a map is not proof it was ever broadcast. Five checks I now run before citing one:

1. **How many independent receivers heard it?** Crowd-sourced aggregators accept uploads from anyone. A contact seen by one feeder and no one else is a lead, not a fact.
2. **How old is the fix?** Many trackers keep drawing a contact for minutes after its last position, and cached sources often report when _they_ fetched the data, not when the plane broadcast it. A stale dot looks exactly like a live one.
3. **ADS-B or MLAT?** MLAT positions are computed from arrival times at several receivers. Useful for aircraft that don't broadcast a position, but less precise, and can jump.
4. **Do the integrity numbers make sense?** A track with good NIC/NACp that jumps kilometres sideways is a spoofing candidate. Low numbers across a whole area suggest jamming.
5. **Can you get the history from somewhere you control?** If the source deletes after 12 or 24 hours, your citation can't be re-checked next week. Save the raw track, not just the screenshot, and hash it.

**Disclosure:** I build Velocity, a free self-hosted tracker (AGPL) that shows these checks per contact: which sources reported it, how many agreed, how old the fix is. It records position history to your own disk and has an evidence locker that SHA-256 hashes every capture with an append-only custody log. All data sources are listed in the README. I wrote it with heavy help from Claude Code and review every change.

What checks did I miss? Particularly for AIS, where spoofed and swapped MMSIs make all of this harder.
```

**The 20%:** the disclosure paragraph. The checklist works with any tracker.

---

## 4. r/ClaudeAI

**Flair:** Built with Claude (the sub asks you to explain how).

**Title options**

One title per block, pick one.

```
Four months of Claude Code on one repo. The file that stopped it undoing my decisions.
```

```
Claude Code kept "cleaning up" things I'd fixed on purpose. Here's the fix that worked.
```

**Body**

```
I've used Claude Code on a single repo for four months. The biggest problem wasn't bad code. It was confident cleanups: Claude would see something odd, tidy it, and undo a decision I'd made for a reason it couldn't see. Every real regression came from that.

What fixed it, in order of impact:

1. **Every decision gets a guard test.** If I decide "this refresh interval stays at X" or "this feed must work with no API key", a test asserts it. One command (`scripts/verify.sh`) runs them all. When a cleanup undoes an old decision, the build fails and names the decision.
2. **A decision log the guards point to.** `docs/decisions.md` holds the why, the date and the post-mortem. CLAUDE.md says: read the entry before changing guarded behaviour. To revoke a decision you change the guard _and_ the file that states it, deliberately.
3. **CLAUDE.md per directory.** The root file is short and points to one per area (web, api, ml, infra). They load when Claude works there, so it sees the rules for the code it's touching without a 2,000-line root file.
4. **Evidence words.** It can't say "done", "works" or "fixed" without the command and output from that turn, and claims get tagged proven-live, plumbed-unverified or not-built. "Complete" and "global" are banned without a live count. This one change killed most of the overclaiming.
5. **A test baseline it may not drop below.** The pass count lives in CLAUDE.md with a date. It's 3,276 now. Never commit below the number you inherited.

One surprise: running tests in parallel by default made results depend on core count. Green on a 16-core machine, red in 4-core CI, because of state leaking between test files. Serial is now the default.

**The project** is Velocity, a self-hosted flight and ship tracker that keeps its own history so you can rewind the map. It also runs as an MCP server, so Claude can ask it what's flying somewhere right now instead of guessing from training data. The CLAUDE.md is in the repo if you want to steal the structure: https://github.com/AndrewCTF/velocity

What's in your CLAUDE.md that made the biggest difference?
```

**The 20%:** the project paragraph. The five patterns work on any repo.

---

## 5. r/mcp

**Flair:** showcase, with the disclosure.

**Title options**

One title per block, pick one.

```
Lessons from building an MCP server for live data: make every answer say how old it is
```

```
MCP server for live aircraft and ship positions, and what I learned about tool output design
```

**Body**

```
Ask an agent "what's flying near X right now" and it either refuses or makes something up from training data. I built an MCP server that answers from live feeds instead, and most of what I learned was about the shape of the tool output, not the data.

**What worked:**

- **Put the age in every answer.** Each contact carries how many seconds old its fix is. Without that, the model presents a 20-minute-old position as "currently". With it, it says "last seen 20 minutes ago" on its own.
- **Put the source in every answer.** Which feeds reported this contact and how many agreed. The model then hedges correctly when one source is alone in seeing something.
- **Label automated output as automated.** Anything the server derives rather than observes says so. The model passes the label on instead of upgrading a guess into a fact.
- **Accept shapes the user actually has.** `focus_area` started as centre + radius. Someone here asked for polygons in July, so it now takes either. Real areas of interest are rarely circles.

**Disclosure:** it's part of Velocity, a self-hosted tracker I build (AGPL, no API keys, mostly written with Claude Code). The MCP server runs against your own instance.

How are other people handling freshness in tool output? Timestamps, ages, or something else?
```

**First comment**

```
Repo: https://github.com/AndrewCTF/velocity
```

**The 20%:** the disclosure paragraph. The output-design list is the post.

---

## 6. r/aviation

Message the mods first; the sub is strict about self-promotion. Attach the Heathrow replay video (`heathrow-2025-03-21-replay.mp4`, see `launch-2026-10.md`) as the post's media. Re-record it from the merged build before posting.

**Title options**

One title per block, pick one.

```
Heathrow, 20 March vs 21 March 2025, replayed from a free public ADS-B archive
```

```
You can replay any day of air traffic since January 2024 for free. Here's Heathrow the day the substation burned.
```

**Body**

```
On the night of 20 March 2025 a fire at the North Hyde substation cut power to Heathrow, and the airport stayed shut for most of the 21st. The video is London on the 20th, then the 21st, both replayed at 600x. The approach traffic west of London is there on the first day and gone on the second.

The part I think more people should know: **you can do this for almost any day since January 2024, for free.**

Most community ADS-B sites run readsb, and readsb writes a history file every half hour. Several aggregators publish those files openly under `globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf`, where NN is the half-hour of the day (00 is 00:00 UTC, 47 is 23:30 UTC). Each file is a stream of time-slice markers followed by every aircraft position, callsign and squawk in that slice.

How far back it goes, from a coverage check I ran in September:

- **adsb.fi** had all 990 days since 1 January 2024.
- **adsb.lol** had 689 of the 990, but with 10-second slices instead of 30, so where it has a day the tracks are smoother.

tar1090, the map most of these sites use, can replay these same files, so some of them let you scrub back right on their own map.

Two caveats. These are volunteer-run servers: my 990-request coverage sweep got me blocked by one of them, so fetch only what you need and cache it. And there is no equivalent for ships. If you want vessel history, someone has to have recorded it.

**Disclosure:** that last point is why I built Velocity, a free self-hosted tracker. It replays these public aircraft files on a 3D globe (that's what the video is) and records its own aircraft and ship archive to your disk. Built with a lot of help from Claude Code. Repo in the comments.

What day would you want to see replayed? I'll do a few in the comments. Not crashes, though.
```

**First comment**

```
Repo (AGPL, no API keys): https://github.com/AndrewCTF/velocity
```

**The 20%:** the disclosure paragraph. How to find and replay the public history files works without Velocity.

---

## 7. r/DataHoarder

Mod approval first: the sub's rules require it for anything self-promotional, and the July post was filtered without it (`post-datahoarder-2026-07-16.md`).

**Title options**

One title per block, pick one.

```
Every aircraft position since January 2024 is sitting on public servers in half-hour files. Here's the format, and how to fetch it without getting banned.
```

```
Free, public, minute-by-minute air traffic history back to 2024. Nobody seems to be mirroring it.
```

**Body**

```
Flight trackers sell history back to you. Flightradar24's free tier stops at 12 hours. But a large chunk of the raw data is already public, and I haven't found anyone mirroring it.

**Where it is.** Community aggregators that run readsb publish its half-hour history files at `globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf` (NN = 2 x hour + 1 if past :30, zero-padded, UTC). In a September check, adsb.fi had every one of the 990 days since 1 January 2024. adsb.lol had 689 of them, but at 10-second resolution instead of 30.

**The format.** A file is a flat array of 16-byte little-endian records, `<iiihh` in Python struct terms: three 32-bit ints and two 16-bit shorts. Most records are positions: ICAO hex, latitude x 1e6, longitude x 1e6, altitude, ground speed. A record whose first int is the magic value `0x0E7F7C9D` starts a new time slice and carries the timestamp; its altitude field holds the slice interval in milliseconds. Callsign and squawk records sit inside the slices too. One adsb.lol file I decoded (2024-06-01 12:00 UTC) held 180 slices and 3,953 aircraft tracks over Europe.

**Fetch it politely, or lose it.** These are volunteer-run. A 990-request sweep at 8 concurrent requests got my address blocked by adsb.fi's Cloudflare. To check which days exist, probe one file per day (I use 12:00 UTC), not all 48. Send a normal browser user agent; some hosts refuse anything else. Cache what you fetch, gzipped, and never fetch the same file twice.

**What isn't out there: ships.** There is no public equivalent for AIS. If you want vessel history, you have to record it yourself, live. That's the genuinely hoardable gap.

**Disclosure:** I build Velocity, a self-hosted tracker that does both. It proxies and caches these aircraft files under a size cap you set (least recently used goes first) and replays them on a globe. It also records its own live aircraft and ship archive. Mine holds 132M positions since August in 27 GB of TimescaleDB. Built with heavy help from Claude Code. Repo in the first comment.

Is anyone already mirroring globe_history? I'd rather point people at a mirror than at volunteers' servers.
```

**First comment**

```
Repo (AGPL-3.0): https://github.com/AndrewCTF/velocity
```

**The 20%:** the disclosure paragraph. The format and the fetching rules stand on their own.

---

## 8. r/RTLSDR

The highest-fit audience in the distribution kit: these readers run feeders. The script in the body was tested against a fake feed on 2026-10-19 (military and 7700 contacts inside the radius alerted; a normal squawk and a military contact outside it didn't). Reddit shows the indented lines as a code block.

**Title options**

One title per block, pick one.

```
Get a phone alert when a military or emergency aircraft flies near you, from your own feeder, in 30 lines
```

```
Your readsb already knows when a military plane is overhead. 30 lines to make it tell your phone.
```

**Body**

```
If you run readsb with the tar1090 database, your `aircraft.json` already flags military aircraft. `dbFlags` bit 1 means military. Add the emergency squawks (7500, 7600, 7700) and a distance check, and you have alerts with no account and no API.

This polls your feeder every 10 seconds and pushes to ntfy (free, there's a phone app, no sign-up). Each aircraft alerts at most once an hour.

    import json, math, time, urllib.request

    HOME = (51.47, -0.45)        # your lat, lon
    RADIUS_KM = 30
    TOPIC = "https://ntfy.sh/pick-a-long-random-topic"
    URL = "http://localhost/tar1090/data/aircraft.json"
    seen = {}

    def km(a, b):
        la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
        h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
        return 12742 * math.asin(math.sqrt(h))

    while True:
        for ac in json.load(urllib.request.urlopen(URL))["aircraft"]:
            if "lat" not in ac:
                continue
            mil = ac.get("dbFlags", 0) & 1
            sq = ac.get("squawk")
            emergency = sq in ("7500", "7600", "7700")
            if not (mil or emergency) or km(HOME, (ac["lat"], ac["lon"])) > RADIUS_KM:
                continue
            if time.time() - seen.get(ac["hex"], 0) < 3600:
                continue
            seen[ac["hex"]] = time.time()
            what = "military" if mil else "squawk " + sq
            msg = f'{ac.get("flight", "?").strip()} ({ac["hex"]}) {what}, {km(HOME, (ac["lat"], ac["lon"])):.0f} km away'
            urllib.request.urlopen(urllib.request.Request(TOPIC, data=msg.encode()))
        time.sleep(10)

Things to know:

- **No `dbFlags`?** readsb only adds it when it's run with the aircraft database. Check one entry in your `aircraft.json`.
- **ntfy topics are public by name.** Use a long random topic, or self-host ntfy.
- **Military aircraft often don't send a position.** They show up as Mode S only, with no lat/lon, so this will miss them. MLAT catches some if you're in a dense area.
- **7600 and 7700 are rare, and a real 7500 is extremely rare; most are mistyped.** Treat the alert as "go look", not news.

**Disclosure:** I build Velocity, a self-hosted tracker that does a bigger version of this: you pick an area (centre and radius) and what to watch for (military aircraft or ships, GPS jamming, dark vessels, loitering, quakes, fires) and it pushes to ntfy, Discord or a webhook. It can read your tar1090 feed alongside the public ones and keeps the history, so you can rewind to the moment of the alert. Built with help from Claude Code. Repo in the first comment.

What else would you filter on? I've thought about a list of interesting hexes, but I'd like to hear what feeders actually watch for.
```

**First comment**

```
Repo (AGPL, no API keys): https://github.com/AndrewCTF/velocity. Point ADSB_FEED_URLS at your tar1090 and it folds your receiver in.
```

**The 20%:** the disclosure paragraph. The script runs on any readsb feeder with nothing else installed.

---

## 9. r/PostgreSQL

**Title options**

One title per block, pick one.

```
Moved 55M time-series rows from SQLite to TimescaleDB: 13.46x smaller and a 73-second query became instant. Numbers and mistakes.
```

```
SQLite to TimescaleDB for 55 million GPS positions: what the migration actually measured
```

**Body**

```
I keep an archive of aircraft and ship positions: one row per fix, append only, roughly 10,000 to 13,000 aircraft and tens of thousands of ships feeding it. It started as SQLite. Here's what moving it to Postgres + TimescaleDB measured.

**The migration.** 55,352,047 rows (9 August to 13 September), copied with asyncpg COPY at about 120k rows/s, landing in 12 chunks. The script resumes from the target's `max(t)`, so a crash halfway costs nothing.

**The size.** The SQLite file was 11,300,810,752 bytes. The compressed hypertable is 839,786,496. That's 13.46x smaller overall and 11.29x from columnar compression alone.

**The setup that got there:**

- 6-hour chunks.
- `compress_segmentby` on the object ID. Positions for the same aircraft sit together, so lat/lon/time compress as nearly smooth series. That's where the columnar win comes from.
- A continuous aggregate (`positions_hourly`) for the "what do I have, and when" coverage question. On SQLite that question was a full scan: 73 seconds over 78M rows. Now it reads the aggregate.
- Retention drops whole chunks, so nothing on this path ever runs VACUUM.

**Mistakes I'd skip next time:**

- The SQLite row was 208.8 bytes for six numbers, because the ship's name was rewritten into every row. Static per-object data belongs in its own table.
- That 73-second coverage scan, polled every 5 seconds by the UI, kept a reader permanently open and grew SQLite's WAL to 49.6 GB. On any MVCC or WAL system, a slow query run more often than it takes to finish will eventually bite.

SQLite is still the fallback for people who don't want to run Postgres, so both paths implement the same reads.

**Disclosure:** this is the archive inside Velocity, a self-hosted aircraft and ship tracker I build (AGPL). Built with a lot of help from Claude Code. Repo in the first comment if you want to read `history_pg.py`.

Question for people running Timescale at higher volume: is segmenting by a high-cardinality ID (tens of thousands of distinct values per chunk) going to hurt me later, or is that what it's designed for?
```

**First comment**

```
The schema and the migration script are in https://github.com/AndrewCTF/velocity (apps/api/app/history_pg.py, scripts/history_migrate_sqlite_to_pg.py).
```

**The 20%:** the disclosure paragraph. The numbers and the setup apply to any append-only time series.

---

## 10. r/dataengineering

**Title options**

One title per block, pick one.

```
Last-write-wins silently corrupted our merged feed. Freshest-observation-wins fixed it.
```

```
Merging live feeds: the cache that kept reporting stale data as fresh
```

**Body**

```
I merge live position data from several upstream sources: aircraft and ships, each reported by more than one feed. The merge looked simple. It turned out to be the source of almost every "the map is lying" bug I had. Three lessons that apply to any multi-source merge.

**1. Last-write-wins is a correctness bug, not a rounding error.** My store did `latest[id] = obs` for whatever arrived last. If a slow source delivered a 3-minute-old fix after a fast source delivered a 5-second-old one, the old fix won. Worse, it carried an optimistic timestamp, so retention thought it was fresh and kept it. The fix: merge by **observation time** (when the thing was actually seen), and only accept a write if it is strictly newer than what you hold.

**2. A cache must report the age of the data, not the age of the response.** One upstream reported each position's age relative to when *it* served the request. Cache that response and the ages freeze: a position "2 seconds old" stays 2 seconds old forever. Compute `observed_at = served_at - age` once, at fetch time, and store that. Never compare raw ages across tiers that cache differently.

**3. Refuse data instead of passing it through.** A feeder that hangs will often keep answering its health check with 200 and the last thing it had. Now a source whose newest data is older than 180 seconds is refused, not merged. Going silent lets stale positions age out. Passing them through pins them on the map.

A bonus physics check that caught a whole class of bad merges: if a fast-moving aircraft's new fix is *behind* it along its own heading, drop it. Something older arrived late.

**Disclosure:** this is the merge inside Velocity, a self-hosted aircraft and ship tracker I build (AGPL). Every contact now shows which sources reported it and how old the fix is. Written with a lot of help from Claude Code. Repo in the first comment.

How do you handle sources that report relative times? I'd like to know if there's a cleaner pattern than converting at the edge.
```

**First comment**

```
Repo: https://github.com/AndrewCTF/velocity. The merge rules and their tests are in apps/api/CLAUDE.md.
```

**The 20%:** the disclosure paragraph. The three rules work for any multi-source merge.

---

## 11. r/maritime (or r/shipping)

**Title options**

One title per block, pick one.

```
I queried two free ship-tracking feeds over six patches of open ocean. Every one came back with zero ships.
```

```
Free AIS has a blind spot the size of the Pacific. Measured.
```

**Body**

```
Free ship-tracking maps make the ocean look covered. I wanted to know how much of that is real, so I queried the free, no-key AIS sources directly over boxes of open ocean and over chokepoints.

**Open ocean, 10 x 10 degree boxes with no coast in them:**

- mid-Pacific: 0
- South Atlantic: 0
- Indian Ocean: 0
- North Pacific: 0
- Southern Ocean: 0
- Coral Sea: 0

Two independent providers, same result.

**Chokepoints, same store:** Singapore Strait 1,282, Strait of Hormuz 373, Gibraltar 267, Malacca 54, Bab-el-Mandeb 0 (no free feed reaches that box at all).

Why: free AIS comes from shore receivers run by volunteers, and VHF from a coastal antenna typically reaches 20 to 40 nautical miles. Satellite AIS is what covers mid-ocean, and every vendor I checked keeps it behind a paid token. One provider shows some satellite positions on its public map, but they have no MMSI, name or age, so you can see that *a* ship is there, not which one or when.

What that means in practice: an empty ocean on a free map tells you nothing. A ship that "went dark" mid-Atlantic may just have left receiver range. And the Red Sea gap is worth knowing about, given what's been happening there.

The free option for open ocean is radar, not AIS. Sentinel-1 SAR imagery is downloadable with no account (a public catalogue plus anonymous S3 reads). It shows hulls, not identities, and only when a satellite passes over, but it does see ships with their transponders off.

**Disclosure:** I build Velocity, a self-hosted tracker that merges these free AIS feeds (deduped by MMSI), records the history to your disk, and draws an AIS coverage layer so empty water reads as "no data" rather than "no ships". It has a dark-vessel layer built on Sentinel-1. Built with heavy help from Claude Code. Repo in the first comment.

People who work at sea: how often do you see your own ship missing from these maps, and where?
```

**First comment**

```
Repo (AGPL, no API keys): https://github.com/AndrewCTF/velocity. The coverage measurements are in docs/ais/ais-vessel-pipeline.md.
```

**The 20%:** the disclosure paragraph. The coverage numbers and what they mean hold for any free tracker.

---

## 12. r/satellites (or r/SatelliteTracking)

**Title options**

One title per block, pick one.

```
CelesTrak isn't banning you. That 403 means "you already have this."
```

```
Tracking satellites in the browser: the 403 that wasn't a ban, and why I draw 4,000 of 16,000
```

**Body**

```
If you pull TLEs from CelesTrak in anything you build, this will save you a confusing afternoon.

**The 403 that isn't a block.** CelesTrak publishes GP data every 2 hours. If you request the same GROUP again from the same IP inside that window, it answers **403** with a body like: "GP data has not updated since your last successful download of GROUP=active at <time>. Data is updated once every 2 hours." It's a conditional GET dressed as a 403. Browser user agent or not, same answer.

I treated it as an outage. My cache lived in memory, so every restart of my backend re-requested, got the 403, and showed an empty sky until the window passed. The fix: keep the last good download on disk, and when the 403 body says "has not updated", serve the disk copy as if it were a 304. Any other 403 is still a real error.

**Pick the format your propagator wants.** If your SGP4 library parses TLE lines (satellite.js's `twoline2satrec` does), ask for `FORMAT=tle`. The JSON/OMM output doesn't include the TLE line strings, and my satellite layer quietly showed zero objects until I noticed.

**16,000 is too many for a main thread.** The `active` group is around 16,000 objects and 6.5 MB. Propagating all of them every frame in the browser will stutter. What worked for me:

- Cap what you draw. I draw 4,000 on a desktop at high quality and 1,000 on phones. Nobody can read 16,000 dots on a globe anyway.
- Don't propagate per frame. Sample each orbit ahead in time and let the renderer interpolate.
- Spread the sampling across frames with a time budget (about 5 ms a frame for me), so re-sampling never lands as one big hitch.

**Disclosure:** this is the satellite layer in Velocity, a self-hosted tracker I build that puts satellites, aircraft and ships on one globe and keeps their history on your own disk. Built with a lot of help from Claude Code. Repo in the first comment.

If you've built SGP4 propagation for the browser, did you move it to a Web Worker? I've held off because the frame budget was enough at 4,000, but I'd like to hear where that stops being true.
```

**First comment**

```
Repo (AGPL, no API keys): https://github.com/AndrewCTF/velocity. The CelesTrak handling is in apps/api/app/routes/space.py.
```

**The 20%:** the disclosure paragraph. The 403 behaviour and the rendering advice apply to anyone using CelesTrak.

---

## 13. r/webscraping

Read the subreddit's self-promotion rule first. This post is about reading responses correctly and backing off, not about getting around blocks. Keep it that way in the comments too.

**Title options**

One title per block, pick one.

```
Six HTTP responses that lie to your scraper (and what each one actually meant)
```

```
A 403 that means 'not modified', a 200 that means 'slow down', and other things I learned polling public data
```

**Body**

```
I poll a dozen public data sources every few seconds. Most of my bugs weren't parsing bugs. They were me believing the status code. Six that fooled me:

**1. 200 OK, text/plain body = you're throttled.** One API answers rate limits with a 200 and a plain-text message instead of a 429. Parse it as JSON and you get an exception at best, an empty list at worst. Now any non-JSON body from a JSON endpoint is an error, not "no data".

**2. 200 OK, 4-byte body = also throttled.** Another source returns a valid but tiny binary response when you ask too often. It parses fine, into zero rows. I now raise on bodies below a sane minimum instead of reporting an empty map.

**3. 403 = "you already have this".** CelesTrak returns 403 when you re-request data that hasn't changed in its 2-hour window, with a body that says exactly that. Read the body before you decide you're blocked. Treat it as a 304 and serve your saved copy.

**4. 403 for everyone, including a real browser.** Some paths are blocked by a WAF rule no matter who asks. Headers, proxies and real Chrome all get the same 403. Don't fight it. Load the page in a browser and look at what request the page itself makes. That's the endpoint meant for you.

**5. 451 = we don't serve non-browser clients.** One host answers 451 to anything that doesn't look like a browser. That's a policy statement, not an outage.

**6. 403 with an email address in the body = a person.** That's not a bot wall. That's someone asking you to stop or to get in touch. I moved that host to last resort, added a setting to switch it off entirely, and wrote to them.

And one that was my fault: **httpx doesn't follow redirects by default.** A source moved from http to https, answered 301 with an empty body, and my health check scored it as up. A whole layer went to zero and nothing complained. Either follow redirects or treat a 3xx as a failure, explicitly.

The general rule I ended up with: a response is healthy only if it has the shape you expect. Status code alone tells you almost nothing.

**Disclosure:** these all came from building Velocity, a self-hosted tracker for public aircraft, ship and satellite data. Each source's health and data age is shown in the app instead of hidden. Built with a lot of help from Claude Code. Repo in the first comment.

What's the strangest "success" response you've hit?
```

**First comment**

```
Repo: https://github.com/AndrewCTF/velocity
```

**The 20%:** the disclosure paragraph. The six responses are useful to anyone polling public endpoints.

---

## 14. r/Python

The snippet in the body was run on 2026-10-19 against a deliberate 0.6 s `time.sleep` inside a coroutine and named the right function and line. Reddit shows the indented lines as a code block.

**Title options**

One title per block, pick one.

```
py-spy couldn't attach, so I made my asyncio app tell me which line blocks the event loop. 25 lines.
```

```
Find the exact line stalling your asyncio event loop, from inside the process
```

**Body**

```
My FastAPI app had lag nobody could explain. A 2 ms route was taking over 100 ms almost half the time, and up to 4 seconds under load. The usual answer is py-spy, but on my box ptrace is refused, so nothing outside the process can look at its stack.

So I made the process watch itself. The idea: a coroutine updates a heartbeat every 50 ms. A plain thread checks the heartbeat. If it's late, the event loop is stuck, and the thread reads the loop thread's current stack with `sys._current_frames()` and counts which line it's stuck on.

    import asyncio, sys, threading, time
    from collections import Counter

    stalls = Counter()
    _keep = set()

    def _watch(loop_thread, beat):
        while True:
            time.sleep(0.05)
            if time.monotonic() - beat[0] > 0.1:
                f = sys._current_frames().get(loop_thread)
                if f:
                    stalls[f"{f.f_code.co_filename}:{f.f_lineno} {f.f_code.co_name}"] += 1

    async def _heartbeat(beat):
        while True:
            beat[0] = time.monotonic()
            await asyncio.sleep(0.05)

    async def start_stall_watch():
        beat = [time.monotonic()]
        _keep.add(asyncio.create_task(_heartbeat(beat)))
        threading.Thread(target=_watch, args=(threading.get_ident(), beat), daemon=True).start()

Call `await start_stall_watch()` at startup and print `stalls.most_common(10)` from a debug route. Each count is roughly 50 ms the loop spent stuck on that line.

Two upgrades that made it much more useful:

- **Walk up to your own code.** The innermost frame is often inside a library (`json`, `gzip`, `ssl`). Walk `f.f_back` until the filename is in your project and record that too, so you see *your* line that called the slow thing.
- **Measure CPU time as well as wall time.** On Linux, `time.pthread_getcpuclockid(thread_id)` gives the loop thread's own CPU clock. If CPU time is close to wall time, the loop was computing (move that work to a thread or process). If it's far below, the loop was waiting: a blocking call, or another thread holding the GIL.

One I'd hit before in the same app: serializing and gzipping a ~13,000-item payload on every poll. Building it once per cycle and serving the bytes made latency flat. That's exactly the kind of line this points straight at.

**Disclosure:** this is from Velocity, a self-hosted aircraft and ship tracker I build. The full version reports per-line wall and CPU time at a status endpoint. Written with a lot of help from Claude Code. Repo in the first comment.

Is there a cleaner way to do this that I've missed? `sys._current_frames()` being underscore-private makes me a little nervous.
```

**First comment**

```
Full version with CPU time and the walk up to app frames: https://github.com/AndrewCTF/velocity (apps/api/app/routes/status.py).
```

**The 20%:** the disclosure paragraph. The snippet works in any asyncio app.

---

## 15. r/AppSec (or r/websecurity)

**Title options**

One title per block, pick one.

```
Letting users paste a webhook URL is an SSRF hole. The checks I needed, including the ones that surprised me.
```

```
User-supplied webhook URLs: why 'block private IPs' isn't enough
```

**Body**

```
My app lets users paste a webhook URL for alerts (Discord, ntfy, any webhook). That's a server making requests to a URL an outsider chose, which is textbook SSRF. "Block private IPs" sounded like the whole fix. It wasn't.

**What a working check needed:**

1. **Resolve the hostname and check every address.** Checking the string `localhost` catches nothing. `my-site.example` can resolve to 127.0.0.1.
2. **Unwrap IPv4 hidden in IPv6.** `::ffff:127.0.0.1` (IPv4-mapped), 6to4 (`2002::/16`) and Teredo addresses all carry an IPv4 inside. Older CPython versions don't apply `is_private` or `is_loopback` to the embedded address of a mapped literal, so you have to pull it out yourself (`ipv4_mapped`, `sixtofour`, `teredo` on `IPv6Address`) and check that.
3. **Block CGNAT explicitly.** `100.64.0.0/10` is not covered by `is_private`. If you run on Tailscale or behind a carrier NAT, that range is your internal network.
4. **Check link-local, reserved, multicast and unspecified too.** 169.254.169.254 is the cloud metadata service on most providers, and the classic SSRF target.
5. **Check again at delivery, not just when the URL is saved.** DNS can change between the two. A name that resolved to a public IP at signup can point at 127.0.0.1 next week.
6. **Re-check every redirect hop.** If your HTTP client follows redirects, a public URL can 302 to an internal one. Either turn redirects off for these requests or validate each hop.
7. **Treat the URL as a secret.** A Discord webhook URL *is* the credential. Log the host when you refuse, never the full URL.

**The gap I couldn't close cheaply: DNS rebinding over https.** For plain http I resolve once, check the IP, then connect to that exact IP with the original Host header, so there's no second lookup to poison. For https the hostname has to stay in the URL for certificate validation, so the client resolves again. I've accepted that window because metadata endpoints are http-only, but I'd like a better answer.

And one product decision: alert webhooks are public-internet only, with an explicit allow-list for the operator's own LAN hosts. If someone wants alerts sent to Home Assistant on their LAN, they opt in by name.

**Disclosure:** this is the guard in Velocity, a self-hosted aircraft and ship tracker I build (AGPL), where alert rules can post to Discord, ntfy or a webhook. Written with a lot of help from Claude Code. Repo in the first comment, the classifier is in `apps/api/app/netguard.py`.

How do you close the https rebinding gap in practice? A custom resolver in the transport, or something else?
```

**First comment**

```
Repo: https://github.com/AndrewCTF/velocity. The classifier is apps/api/app/netguard.py and the http pinning is in apps/api/app/workflows/control.py.
```

**The 20%:** the disclosure paragraph. The checklist applies to any app that accepts user URLs.

---

## 16. r/webdev

**Title options**

One title per block, pick one.

```
Showing 13,000 moving objects that update every second in a browser: the bottleneck was never rendering
```

```
One line of decimation code made half my map icons churn every second. 112% ID churn, measured.
```

**Body**

```
I built a web map that shows every tracked aircraft, around 13,000 of them, with positions polled every second. I assumed drawing would be the hard part. It was the cheapest part. Three things that actually mattered.

**1. Thin data by a hash of the ID, never by position in the list.** When a view had too many objects, I kept every Nth item. But the server's list order and count changed on every refresh, so every poll picked a *different* subset. Between two polls one second apart, the set of visible IDs churned by 112%. Icons kept appearing and disappearing, and none lived long enough to animate smoothly. The fix was to choose the subset by a hash of each object's ID. The same aircraft stay visible poll after poll, and motion interpolation works again.

**2. The cost is updating your object store, not drawing it.** The time went into upserting and re-clustering thousands of entities per poll. Rendering them was cheap. So the server now sends only what's inside the current viewport, and the browser never holds the full set unless you're looking at the whole world.

**3. Build the response once, serve the same bytes to everyone.** The server used to filter, serialize and gzip ~13,000 features on every request. Response times alternated short, long, short, long, depending on what else the event loop was doing. Now it builds one gzipped blob per refresh cycle and serves those bytes as-is, with an ETag. A poll inside the same cycle gets a 304. Latency went flat.

Bonus, for anything computed client-side: I propagate satellite orbits in the browser, and doing it all at once caused visible hitches. Spreading the work across animation frames with a fixed budget (about 5 ms a frame) removed them without needing a Web Worker.

**Disclosure:** this is Velocity, a self-hosted aircraft, ship and satellite tracker I build (CesiumJS front end, FastAPI back end). It records history so you can rewind the map. Built with a lot of help from Claude Code. Repo in the first comment.

If you've done live maps at this scale: did you end up on WebSockets, or is a 1-second poll with ETags fine? Mine does both and I'm not sure the socket earns its keep.
```

**First comment**

```
Repo: https://github.com/AndrewCTF/velocity
```

**The 20%:** the disclosure paragraph. The three lessons apply to any live map or list.

---

## 17. r/remotesensing

**Title options**

One title per block, pick one.

```
What satellite imagery can you get with no account and no API key at all? I measured it.
```

```
Keyless imagery: sub-metre optical from Esri Wayback, and full Sentinel-1 scenes from anonymous S3
```

**Body**

```
I needed imagery a server could fetch without any account, key or metered quota. Most "free" options fail that test: Copernicus Data Space, Earth Engine, EarthExplorer and every commercial broker need a login. Here's what passed, measured from live requests.

**Sub-metre optical: Esri Wayback.** It serves the dated releases of World Imagery as XYZ tiles. 196 releases from 2014-02-20 to 2026-08-05, roughly every four weeks. Measured resolution 0.13 to 0.27 m per pixel. I checked six cities with no special event coverage (Nairobi, Lhasa, Reykjavik, Ulaanbaatar, Perth, Manaus) and all returned tiles at zoom 19. Nairobi resolves individual cars.

Two caveats that matter:

- **A release date is not an acquisition date.** It's a mosaic of best-available imagery, so a 2026 release can serve 2024 photos. The metadata layer has a per-tile source date, but for my Nairobi probes it came back empty. Treat the release date as an upper bound.
- **Licensing.** World Imagery is licensed for use in Esri and ArcGIS apps. Occasional research use is one thing. Building a product on bulk tile fetches is not.

**Best quality, wrong coverage: Maxar Open Data.** Genuinely 0.3 m RGB, with un-JPEG'd source bands. But it's event-scoped: 55 disaster events, and none of the six cities above has any footprint. Excellent for before/after on a specific event, useless as a global layer. I spent too long building toward it before I checked.

**Radar for the open ocean: Sentinel-1.** Element 84's Earth Search STAC catalogue is public, and the `sentinel-s1-l1c` S3 bucket serves pixels anonymously. I fetched a full VV GRD scene (25,998 x 19,529) with no credentials. The trap: those raw measurement TIFFs are in pixel space with no CRS. You have to georeference them from the scene's `annotation/iw-*.xml` ground-range metadata. From there a plain CFAR detector is the standard way to pull out ship-sized bright targets, AIS or not.

**Disclosure:** I build Velocity, a self-hosted tracker that uses Wayback for close-ups of a location (always showing the source date) and Sentinel-1 for a dark-vessel layer over open water. Built with a lot of help from Claude Code. Repo in the first comment.

What did I miss? Specifically anything sub-metre and keyless that isn't a mosaic.
```

**First comment**

```
Repo (AGPL): https://github.com/AndrewCTF/velocity. The full measurement write-up is docs/free-keyless-vhr-imagery-measured.md.
```

**The 20%:** the disclosure paragraph. The source-by-source findings stand on their own.
