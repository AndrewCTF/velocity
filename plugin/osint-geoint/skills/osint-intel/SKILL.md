---
name: osint-intel
description: >-
  Drive the OSINT GEOINT MCP server — live ADS-B aircraft, AIS vessels,
  GPS-jamming (NACp/NIC), Sentinel-1 SAR dark vessels, geocoded events, and a
  cross-domain incident-fusion engine. Use when the user asks about live air or
  maritime traffic, GPS jamming/spoofing, dark/AIS-off vessels, a region's
  threat picture, denial & deception, or wants to stand watch over an area.
when_to_use: >-
  Any live geospatial-intelligence question — "what's flying/sailing near X",
  "is there GPS jamming in the Baltic", "any dark vessels off Y", "give me the
  threat picture for Z", "watch this area and tell me what changes".
---

# OSINT GEOINT — analyst playbook

You have an MCP server (`osint-geoint`) over a live intelligence console: ~13k
aircraft (ADS-B), ~21k vessels (AIS), a GPS-jamming layer, SAR dark-vessel
detections, geocoded events, and a fusion engine that chains co-located signals
into **cited incidents**. Every tool returns distilled JSON, so you can sweep the
planet for a few hundred tokens.

## The one habit that matters: brief first, drill second

Do **not** pull raw layers and correlate them by hand — the fusion engine already
did. The spine of every investigation:

1. **`get_situation()`** — one cheap call to orient (global counts, worst jamming
   cells, emergencies, vessel mix).
2. **`intel_brief()`** — the headline tool. Ranked, cited cross-domain INCIDENTS
   (a convergence of ≥2 domains within a link distance), each with a narrative,
   threat level, evidence IDs, and recommended follow-ups. Omit coords for global;
   pass `lat,lon,radius_nm` or a bbox to scope.
3. **`focus_area(lat, lon, radius_nm)`** — mark the incident's region PRIMARY: a
   dedicated always-fresh fetch that bypasses global rate limits, plus a full
   bundle (aircraft, density, jamming, vessels, anomalies) in one call.
4. **Drill** into the evidence: `query_vessels`, `query_aircraft`, `gps_jamming`,
   `detect_deception`, `locate_emitter`, `vessel_dossier`, `aircraft_dossier`.
5. **`deep_analyze(question, lat, lon)`** — hand the gathered intel to a reasoning
   model; heavy analysis runs off your context, only the conclusion returns.

To **monitor** instead of re-reading: `whats_changed()` returns only what is NEW /
ESCALATED / DE-ESCALATED / RESOLVED since your last check.

## Context budget: `detail='short'` vs `'long'`

Most tools take `detail`:

- **`short`** (default) — a token-frugal digest: headline counts plus the top few
  items of each list, with a companion `<field>_total` telling you the true size
  and a `hint`/`truncated` flag when anything was trimmed. Use it for orientation
  and broad sweeps.
- **`long`** — the full, comprehensive bundle. Switch to it only once you have
  picked one incident/area/entity worth the extra context.

Rule of thumb: sweep in `short`, drill in `long`. Never open with `long` on a
global call — you will burn context on regions you are about to discard.

## Before you trust a contested feed

In a jammed or high-tension area, run **`detect_deception()`** first — it flags
manipulated tracks (duplicate-MMSI vessels, impossible teleports, GPS-spoof
position injection) that are distinct from mere jamming. Trusting a spoofed feed
is worse than having no feed.

## References (load on demand — keep this file cheap)

- **`reference/tools.md`** — every tool, its parameters, what it returns, and when
  to reach for it. Read it when you need a parameter you don't remember.
- **`reference/workflows.md`** — worked playbooks: hunt a GPS jammer, find dark
  vessels, run a standing watch, build a pattern-of-life dossier, fact-check an
  event against the news layer.

## Honesty contract

The data is real and often thin. Cite concrete numbers and IDs. If a layer is
empty or a feed is key-gated (`data_sources()` says which), say so — never invent
vessels, aircraft, or events the tools did not return.
