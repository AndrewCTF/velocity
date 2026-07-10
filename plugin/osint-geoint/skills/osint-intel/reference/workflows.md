# OSINT GEOINT — worked playbooks

Each playbook is short → drill. Sweep with `detail='short'`; switch to `'long'`
only on the one target you commit to.

## 1. Hunt a GPS jammer

1. `get_situation()` → read `gps_jamming.high` to see if any high-severity cells
   exist worldwide.
2. `gps_jamming()` (global, short) → note the worst cell's centre.
3. `focus_area(lat, lon, 300)` → load it PRIMARY for a fresh, un-rate-limited pull.
4. `locate_emitter(lat, lon, 300)` → weighted-centroid estimate + CEP + confidence.
   State it's a footprint estimate (~tens of km), not RF direction-finding.
5. `query_aircraft(lat, lon, gnss_degraded=True, detail='long')` → the affected
   aircraft — corroborate the footprint with real tracks.
6. `deep_analyze("Is this coordinated jamming, and where is the emitter?", lat, lon)`.

## 2. Find & work dark vessels

1. `intel_brief(lat, lon, radius_nm)` → does a dark-vessel incident already exist?
   Let fusion do the correlation.
2. `query_vessels(lat, lon, dark_only=True, detail='long')` → dark candidates
   (moving, no static identity).
3. For each of interest: `vessel_dossier(mmsi)` → track, AIS gaps, speed profile
   (loiter / transit / loiter-then-dash), which incidents it appears in.
4. `area_baseline(lat, lon)` → is the dark-vessel count actually anomalous
   (e.g. "+5σ") or a normal day here?
5. `detect_deception(lat, lon)` → make sure a "dark vessel" isn't a spoofed or
   duplicate-MMSI artefact before you escalate.

## 3. Stand a watch over an area

1. Establish the area PRIMARY once: `focus_area(lat, lon, radius_nm, label="…")`.
2. Baseline it: `intel_brief(lat, lon, radius_nm, detail='long')` — the full picture.
3. Then poll **`whats_changed(lat, lon, radius_nm)`** on a cadence — it diffs
   against your previous call for that area and returns only NEW / ESCALATED /
   DE-ESCALATED / RESOLVED incidents. Do NOT re-brief every cycle.
4. On an escalation, `incident_history(lat, lon)` shows how it built up over time.

## 4. Build a pattern-of-life dossier

- Aircraft: `aircraft_dossier(ident)` (ICAO24 hex or callsign) → recent track,
  gaps, GNSS integrity, emergency/military flags, live incidents.
- Vessel: `vessel_dossier(mmsi)` → track over the ~1 h retention window, AIS gaps,
  derived speed profile, area covered.
- Pair with `lookup_aircraft(ident)` for a point-in-time integrity/threat read.

## 5. Verify an event against open news

1. `news_analysis()` → debiased world events: verified facts (≥2 independent
   outlets) vs attributed claims vs rhetoric.
2. `fact_check("<specific claim>")` → `{verdict, reasoning, supporting_sources,
   confidence}`. Use before treating any statement as fact.
3. Cross with geospatial: if a claim names a place, `intel_brief(lat, lon)` there
   to see whether the live picture supports it.

## 6. Assess imagery availability for a site

`aoi_imagery(before="YYYY-MM-DD", after="YYYY-MM-DD", lat, lon, radius_km=5)` →
what Maxar VHR (event-gated, ~0.3–0.5 m) and Sentinel (10 m, global) scenes exist
for each date **without downloading**. Read `best_source` to decide which to pull.

## Global sweep, cheaply

To scan the planet without blowing context: `get_situation()` →
`intel_brief()` (global, short) → pick the top 1–2 incidents → `focus_area()` +
`detail='long'` only on those. Everything you discard cost you a few tokens.

## Failure modes to expect

- **Backend cold-start**: the very first global call can take up to ~75 s while
  the snapshot warms; after that every call is instant. Retry once on a timeout.
- **Key-gated layers**: fires (FIRMS) and some imagery need keys. `data_sources()`
  tells you what's on. Report the gap; don't infer the missing layer.
- **Contested feeds**: always `detect_deception()` before trusting tracks in a
  jammed/high-tension area.
