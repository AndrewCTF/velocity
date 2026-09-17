# r/osinttools — third attempt, drafted 2026-09-16

Supersedes `post-osinttools-2026-07-17.md` (never posted). Same inversion as
before: capability first, measured numbers, flaws volunteered, no brand-envy
line, automation labeled, no em dashes. Written against what the sub actually
rewarded in the last 30 days: "[OC] conflict map" (30 pts), "building OMEN,
would love feedback" (18 pts), and the spidering thread's top comment ("most
people are not gonna wanna put their api keys on a random website", 45 pts /
31 comments). Feedback-seeking, self-hosted, keyless is the sub's current mood.

Numbers measured 2026-09-16 from `data/history.db` (55,352,047 rows, 11.3 GB,
first fix 2026-08-09, last 2026-09-13, stack was down at draft time). Re-run
the count right before posting and paste whatever is true. Do not put a live
aircraft/vessel count in the post unless the stack is up and you measured it.

Account heat: u/Prestigious_Act3077 carried ~10 promo posts in July and a
silent r/DataHoarder filter. Check the mod conversation resolved and that the
account has been quiet for a week. Weekday 14:00-16:00 UTC, Showcase flair,
answer every comment for the first hour. Do not mention God's Eye View; the
campaign doc's GEV claims (key required) are stale as of Sept and the wave is
three weeks old.

Paywall claims: ADS-B Exchange free API gone is verified (RapidAPI pricing page,
$10/mo only, 2026-09-16 search). FR24 7 days and MarineTraffic 24h are carried
from the README and were NOT re-verified this session; the only search hit was
our own repo. Spot-check both before posting.

Reddit renders single newlines as one paragraph in markdown mode; paste the
body in the rich text editor, or add blank lines if you use markdown mode.

---

**Title:**

I've been recording every ADS-B and AIS position I can see for 5 weeks (55M fixes) so I can rewind the map. Open source, self hosted, no API keys. What sources would you actually want in it?

---

**Body (one line per paragraph, paste as is):**

Posted here a couple months back with a dumb title comparing this to Palantir and got told off, fairly. Same project, different pitch, because the pitch was the problem not the tool.
The thing I actually wanted was a map I could rewind. FR24 gives you 7 days, MarineTraffic went to 24h, ADS-B Exchange killed the free API, and every time something kicks off the position history you need is either paywalled or already gone. So the tool just records the whole picture to your own disk and lets you scrub back.
Real numbers off my box: 55 million positions since Aug 9, 11 GB of plain sqlite. Pick a window (1h to 7d), click the density strip, the globe rewinds and the tracks re-fly. Keep it as long as you have disk for.
Every contact shows which sources reported it, how many agreed, and how old the fix actually is, because anyone can upload anything to a crowdsourced aggregator and a dot on a map is not proof it was ever broadcast.
Someone in the spidering thread here said most people are not gonna put their API keys on a random website and that's basically the design constraint. Planes, ships, quakes, sats, basemap all run with zero keys. docker compose up and it's live.
For case work there's an evidence locker: url snapshots, uploads and feed freezes get sha256'd into an append only custody log, and a case exports to a self contained html or pptx with the source on every claim. GeoJSON, CSV and KML out so QGIS or Google Earth stays in the loop.
Coverage is community feeders, so it's thick over Europe and the US and thin over open ocean and conflict zones, which is exactly where you need it most. AIS is best in northern Europe. It's a single analyst tool, not a team server. The 3D globe wants a real GPU. There's optional AI summary stuff, it's labeled as automated output and everything works with it off.
What I'd like from this sub: which sources am I missing that you'd actually use (keyless preferred), and does the evidence export hold up against how you document a case.
Repo https://github.com/AndrewCTF/velocity (AGPL), site https://projectvelocity.org
