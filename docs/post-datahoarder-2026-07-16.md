# r/DataHoarder post — 2026-07-16

## Outcome (2026-07-17): removed/filtered before anyone saw it

Posted 2026-07-16; audited the morning after, logged out (what the public
sees):

- Not findable in r/DataHoarder search — neither a title-phrase query nor
  exact strings from the body ("FR24", "9.4 GB", "98,001,172", past week).
- **Not present on the account's public submitted page** — newest visible
  submission is the r/OSINTExperts post from 4 days prior. A live post always
  appears on the author's public profile; a mod/automod-removed one stays
  visible only to the logged-in author. This is the conclusive signal.
- Repo traffic 2026-07-16: 17 views / 8 uniques / +1 star. No launch signal
  at all, so approximately nobody ever saw the repo link.

So the post did not fail on content — it was never in the feed. The content
never got its test.

Likely causes, in order:

1. **Account posting pattern.** The account submitted ~10 promotional posts
   for the same project in 8 days (r/osinttools, r/QGIS, r/gis, r/ClaudeAI,
   r/mcp, r/dataisbeautiful, r/Python, r/homelab, r/ADSB, r/OSINTExperts).
   That is precisely what Reddit's sitewide spam heuristics and subreddit
   automod karma/history rules key on.
2. **No mod pre-approval.** r/DataHoarder's rules require prior mod approval
   for advertisement/promo posts. A long branded-project title from an
   account with the above history is an easy automod match.
3. The repo-link-in-first-comment trick protects against link-domain filters,
   not against the post itself being removed.

Repost path (do these in order, no shortcuts):

1. From the logged-in account, open the post and check its state. "Removed by
   moderators" label confirms the diagnosis; if it looks normal to you with
   zero votes/comments after 24 h, it was silently filtered — same conclusion.
2. Message the r/DataHoarder mods (old.reddit.com/message/compose/?to=/r/DataHoarder):
   link this draft, disclose it is your own project, ask whether it is
   acceptable and under what flair. The draft's content (measured storage
   numbers, the WAL bug, asking for schema critique) is exactly on-topic for
   the sub; the account history is the problem, and mods can whitelist a post
   they have pre-read.
3. Until it is approved: stop posting the project anywhere else. Every
   additional promo post lowers the account's standing with every automod.
4. If approved, post at 14:00-16:00 UTC on a weekday (US morning), and spend
   the first hour answering comments only.

---


Replaces the r/osinttools attempt (2026-07-06, "I built Palantir Gotham", 23K
views, 26 upvotes, top comments "AI slop dashboard" / "you definitely didn't
build Gotham"). That post led with fusion and AI, never mentioned owned history,
and made a claim the reader had to reject. Everything below is the inverse:
measured numbers first, the moat as the hook, the known flaws volunteered, no
feature list, no AI paragraph, no em dashes.

Repo link goes in the FIRST COMMENT, not the body.

---

**Title:**

Measured: recording every aircraft and ship on Earth costs 9.4 GB/day. 98,001,172 positions in 48 hours, on my own disk, rewind any window. FR24 gives free users 7 days of history, MarineTraffic cut its free window to 24h, ADS-B Exchange killed its free API tier. The past is the only part they charge for.

---

**Body:**

The most hoardable dataset on the planet is where everything is, minute by minute. Every company collecting it either deletes it or rents it back to you. Flightradar24 keeps 7 days for free users. MarineTraffic cut its free window from 72h to 24h. ADS-B Exchange removed its free API tier. The live map is never the paywall. Your past is.

So I have been recording it locally instead. Two days ago I let it run flat out and measured what that actually costs, because I could not find a straight answer anywhere and "a few GB/day" is not an answer.

Everything below is from the box it is running on right now, not an estimate.

**What 48 hours of the whole world costs**

```
rows          98,001,172
file size     19.06 GB
span          48.5 h
bytes/row     208.8
rows/day      48,495,780
GB/day        9.43        ->  ~3.4 TB/year
```

Split:

```
aircraft   94,896,595 rows  (96.8%)  ~9.13 GB/day
vessel      3,104,577 rows  ( 3.2%)  ~0.30 GB/day
```

Aircraft are 97% of the cost. That surprised me until I looked: roughly 12,600 aircraft airborne at any moment each moving fast enough to clear the dedup threshold constantly, versus vessels that mostly sit still. About 57,000 vessels are in the live picture but 32,000 of them are parked and barely produce rows.

**The storage layout, and where it is bad**

Plain SQLite, one row per position, WAL, append only. It is a file. You can back it up, move it, and query it with the sqlite3 binary. Nothing phones home. Retention is a disk budget you set, not a pricing tier, and you can set it to never prune.

Now the part I want torn apart, because 208.8 bytes for what is really six numbers is fat and I know it:

```sql
positions(kind TEXT, id TEXT, t REAL, lon REAL, lat REAL, track REAL, extra TEXT)
INDEX (id, t)
INDEX (t)
```

A real row:

```
('vessel', 'vessel:255805884', 1784033740.045, 18.888277, 60.575748, 320.0, '{"name": "ELBSUMMER"}')
```

Three things are obviously wrong and I would rather say them than have you find them:

- `extra` averages 75 chars and it is mostly the vessel's **name**, rewritten on every single fix. ELBSUMMER's name is on disk about 48 times an hour, forever. It is static per vessel and has no business in a position row.
- `id` is a 15 char TEXT, stored in the table and again in the (id, t) index. It should be an integer key into a vessels table.
- `kind` is the string 'aircraft' or 'vessel' on every row. That is a bit.

The 208.8 figure includes both indexes. My back of the envelope says normalising the id, dropping the name out of the row and enum-ing kind gets this under 60 bytes/row, so call it 2.7 GB/day instead of 9.4. I have not done it yet. If you have done this shape of thing at this row count I would genuinely like to hear what you would do, especially about whether the (id, t) index is worth its weight or whether I should be partitioning by day.

**A storage bug that ate 48 GB, since this sub will appreciate it**

Yesterday the archive was 71 GB on disk for 15 GB of data. The write ahead log was 49.63 GB on its own.

The cause is nastier than it looks. A WAL can only checkpoint past its oldest live reader. The UI polled a coverage query every 5 seconds, and that query scanned the whole archive and took longer than the gap between polls, so a read transaction was open permanently and the log could never be written back while the recorder kept appending.

Then it compounds. Every page read has to search the WAL index for the newest version of that page, so a bigger log makes the scan slower, which holds the reader open longer, which grows the log faster. Same query: 73 seconds against the bloated log, 14.8 seconds once it was gone. The slow query was a symptom, not the cause.

Stopping the writer and running `PRAGMA wal_checkpoint(TRUNCATE)` took 37.7 seconds and gave back 48.6 GB. The database grew by 1.04 GB, so 98% of that log was redundant page versions nothing could ever reclaim. Fixed by caching the scan and setting `journal_size_limit`. WAL sits at 0 now.

If you run anything WAL-mode with a long reader and a constant writer, go look at your -wal file. I did not know a 49 GB WAL was a thing that could happen to me.

**Honest caveats**

Coverage is only as good as the public community feeders, so it is dense over land and populated coastline and sparse over open ocean. This is not a global truth dataset, it is what volunteers with antennas can see. The globe wants a GPU on the client. And this is a tool I run, not a dataset dump. I am not offering you my archive, I am offering you the recorder.

**What I actually want from this sub**

Storage tuning. The row layout above is the honest weak point and 9.4 GB/day is higher than it needs to be by roughly 3x. Tell me what you would cut. Repo and the compose file in the first comment.
