---
description: Stand a watch over an area — baseline once, then report only what changes
argument-hint: [place | lat,lon]
---

Stand a watch over: **$ARGUMENTS**

1. Resolve `$ARGUMENTS` to `lat`/`lon`.
2. `focus_area(lat, lon, radius_nm, label="…")` once to load the area PRIMARY (dedicated fresh fetch).
3. `intel_brief(lat, lon, detail='long')` for the baseline picture; summarise it.
4. Then poll `whats_changed(lat, lon)` — report **only** what is NEW / ESCALATED / DE-ESCALATED / RESOLVED. Do not re-brief the whole area each cycle.
5. On an escalation, `incident_history(lat, lon)` to show how it built up over time.

If the user wants this to repeat automatically on a cadence, suggest the `/loop` skill wrapping `whats_changed` for this area.
