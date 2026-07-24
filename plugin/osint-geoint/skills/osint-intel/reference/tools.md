# OSINT GEOINT — tool reference

46 tools. All geography is optional and accepted two ways: a **centre**
(`lat`, `lon`, `radius_nm`) or an explicit **bbox** (`min_lon`, `min_lat`,
`max_lon`, `max_lat`). Omit both for a **global** view. Most tools take
`detail='short'` (default digest) or `'long'` (full bundle) — see the SKILL.

## Orient & fuse (start here)

| Tool | Use it to… | Key args |
| --- | --- | --- |
| `get_situation()` | Cheapest first call — global counts, worst jamming cells, emergencies, vessel mix. | `detail` |
| `intel_brief(...)` | **Headline.** Ranked, cited cross-domain INCIDENTS with narratives + evidence IDs + follow-ups. | area/bbox, `link_km=50`, `window_hours=6`, `detail` |
| `anomalies(...)` | Fused triage report: emergencies, jamming hotspots, dark vessels, alerts + `threat_level`. | area/bbox, `detail` |
| `focus_area(lat, lon, radius_nm)` | Load a region **PRIMARY** (dedicated fresh fetch) + full bundle in one call. | `label`, `cell_deg=1.0`, `detail` |

## Drill into evidence

| Tool | Use it to… | Key args |
| --- | --- | --- |
| `query_aircraft(...)` | Filtered aircraft: category, squawk, callsign, altitude band, emergency/gnss/on-ground flags. | filters, `limit=50`, `detail` |
| `lookup_aircraft(ident)` | One aircraft by ICAO24 hex (exact) or callsign (substring) + integrity/threat assessment. | `ident` |
| `query_vessels(...)` | AIS vessels classified (cargo/tanker/fishing/passenger/military/…); `dark_only=True` for dark candidates. | area/bbox, `dark_only`, `limit=50`, `detail` |
| `aircraft_density(...)` | Density grid (count, by-category, GNSS-degraded per cell) + peak cell + in-area vessels. | area/bbox, `cell_deg=1.0`, `detail` |
| `gps_jamming(...)` | GPSJam assessment (NACp<8 / NIC<7 binned to 1° cells), ranked by severity + affected sample. | area/bbox, `detail` |

## Adversary & attribution

| Tool | Use it to… | Key args |
| --- | --- | --- |
| `detect_deception(...)` | **"Am I being fed?"** Duplicate-MMSI, teleports, GPS-spoof injection — distinct from jamming. Run before trusting a contested feed. | area, `detail` |
| `locate_emitter(...)` | Estimate a jammer/spoofer LOCATION from the degraded-ADS-B footprint (weighted centroid + CEP + confidence). Not RF DF. | area, `detail` |
| `area_baseline(...)` | "Is this normal?" Current counts z-scored against a rolling baseline; anomalies called out (e.g. "dark vessels +5σ"). | area, `detail` |

## Monitor & history

| Tool | Use it to… | Key args |
| --- | --- | --- |
| `whats_changed(...)` | Standing watch — only NEW/ESCALATED/DE-ESCALATED/RESOLVED since your last check. Poll this instead of re-briefing. | area, `detail` |
| `incident_history(...)` | Per-incident timeline `[time, threat_level, score]` — reveals sequence (jamming → dark vessels → event). | area, `hours=6`, `limit=25`, `detail` |
| `vessel_dossier(mmsi)` | Pattern-of-life for one vessel: track, AIS gaps, speed profile, incidents it appears in. | `mmsi`, `detail` |
| `aircraft_dossier(ident)` | Pattern-of-life for one aircraft: track, gaps, GNSS integrity, emergency/military flags. | `ident`, `detail` |
| `list_focus_areas()` | Which AOIs are loaded PRIMARY (fetch stats; direct vs snapshot fallback). | — |

## Reasoning, news & imagery

| Tool | Use it to… | Key args |
| --- | --- | --- |
| `deep_analyze(question, lat, lon)` | Hand gathered intel to a reasoning model (DeepSeek → Ollama). Heavy analysis off your context; conclusion returns. | `question`, area, `tier='reason'|'fast'` |
| `news_analysis()` | Cross-source debiased world news: verified facts (≥2 outlets) vs attributed claims vs rhetoric, with bias flags. | — |
| `fact_check(claim)` | Adjudicate one claim vs current headlines → `{verdict, reasoning, sources, confidence}`. | `claim` |
| `aoi_imagery(before, after, lat, lon)` | What VHR/Sentinel imagery exists for a place at two dates (no download). `best_source` says which to use. | dates, area, `window_days=30` |
| `data_sources()` | Which feeds are always-on vs key-gated, + configured reasoning backend. Explain coverage gaps with this. | — |

## Quakes, history & standing watches

| Tool | Use it to… | Key args |
| --- | --- | --- |
| `quakes_near(lat, lon, radius_km)` | USGS earthquakes within `radius_km` of a point. All three of `lat`/`lon`/`radius_km` are required together (422 on a partial set). | `range='hour'|'day'|'week'|'month'`, `detail` |
| `track_history(id)` | Historical position track for ONE aircraft/vessel over a time window. `id` is `'aircraft:<icao24>'`/`'vessel:<mmsi>'` or an unambiguous bare id. | `from_ts`, `to_ts`, `detail` |
| `create_watch_rule(label, ...)` | Create a standing watch: an identity pin (`icao24`/`mmsi`/`callsign`, follows that entity globally) OR a complete AOI (`lat`, `lon`, `radius_nm`, default 50 nm). | `kinds`, `min_severity`, `channel='inapp'|'discord'|'webhook'`, `sink_url` |
| `list_watch_rules()` | List your standing watch rules. | `detail` |
| `delete_watch_rule(rule_id)` | Delete a standing watch rule by id. | `rule_id` |

## Reading a `short` digest

When `detail='short'` trims something you'll see: capped arrays, a `<field>_total`
giving the real size, and top-level `truncated: true` + a `hint`. Re-issue the
same call with `detail='long'` to get the untrimmed bundle. If those keys are
absent, the payload was already small — you have all of it.
