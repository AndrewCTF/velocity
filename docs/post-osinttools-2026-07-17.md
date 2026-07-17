# r/osinttools retry — drafted 2026-07-17

Second attempt at r/osinttools. The first (2026-07-06, "I built Palantir
Gotham.", 26 points / 13 comments) led with a comparison the reader had to
reject and with fusion+AI; top comments were "AI slop dashboard" and "you
definitely didn't build Gotham". Same inversion as the DataHoarder draft:
capability the reader already wants, measured numbers, flaws volunteered, no
brand-envy claim, automation labeled, no em dashes in the post body.

TIMING WARNING (do not skip): the account has ~10 promo posts in 8 days and
the r/DataHoarder submission was filtered on sight. Posting again from the
same account before the DataHoarder mod conversation resolves risks the same
silent removal here, and r/osinttools already knows this project from the
Gotham post. Wait for the mod reply, or at minimum several quiet days, before
this goes up. When it does: weekday 14:00-16:00 UTC, Showcase flair, answer
comments for the first hour.

---

**Title:**

Free trackers keep shrinking their history: FR24 gives 7 days, MarineTraffic cut free history to 24h, ADS-B Exchange killed the free API. So I record the picture myself: 9M+ positions in 2 days on my own disk, rewind any window, hash-chained exports. Open source, no API keys.

---

**Body:**

A while back I posted here comparing this project to a certain commercial
intelligence platform. That framing was wrong and the thread told me so.
This is the same project, months later, described by what it actually does.

The problem it solves for me: investigation timelines depend on position
history, and every free source of it is shrinking. Flightradar24 free is 7
days. MarineTraffic went from 72h free to 24h. ADS-B Exchange removed its
free API tier. The live picture is never the paywall; the past is. If your
case needs "where was this vessel last Tuesday", you either pay monthly or
you already recorded it.

So the tool records it. Numbers from the box it is running on right now, not
projections:

```
live picture     ~11,500 aircraft, ~28,500 vessels (MMSI-deduped)
recording        9.1M positions in the last 2 days, 1.8 GB, plain SQLite
replay           scrub any recorded window, tracks re-fly on the globe
cost to run      one docker compose up, no API keys for any core feed
```

What an OSINT workflow actually gets:

- **Owned history.** Position archive on your disk, retention is a size cap
  you set. Scrub back to any recorded moment and watch the picture as it was.
- **Chain of custody.** An evidence locker: URL snapshots, uploads and feed
  freezes get SHA-256 hashes and an append-only custody log; cases export to
  self-contained HTML/PPTX where every claim carries its source.
- **One picture.** Aircraft, vessels, satellites, quakes, wildfires, GPS
  jamming, conflict events, naval warnings on one globe, with dossiers per
  entity (registration, operator, track).
- **Export.** GeoJSON/CSV/KML out, so QGIS or your own tooling stays in the
  loop.

The parts I want feedback on from this sub: which sources are missing that
you would actually use (keyless preferred), and whether the evidence export
format holds up against how you document cases.

Honest limits, so nobody finds them the hard way: coverage is community
feeders, so it is dense over Europe/US and thin over open ocean and conflict
zones exactly when you want it most. AIS is strongest in Northern Europe.
It is a single-analyst tool, not a team server. The 3D globe wants a real
GPU. There are AI summarization features; they are optional, clearly
labeled as automated output, and the tool works with them off.

Repo: https://github.com/AndrewCTF/velocity (AGPL). Live demo:
https://projectvelocity.org
