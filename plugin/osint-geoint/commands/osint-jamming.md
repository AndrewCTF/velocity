---
description: Hunt GPS jamming/spoofing and estimate the emitter location
argument-hint: [place | lat,lon | global]
---

Hunt GPS jamming for: **$ARGUMENTS**

Follow the jammer-hunt playbook:

1. `get_situation()` → read `gps_jamming.high` (any high-severity cells worldwide?).
2. `gps_jamming(area or global)` → the worst cell's centre.
3. `focus_area(lat, lon, 300)` → a fresh, un-rate-limited pull of that region.
4. `locate_emitter(lat, lon, 300)` → weighted-centroid estimate + CEP + confidence. State clearly it is a **footprint estimate (~tens of km), not RF direction-finding**.
5. `query_aircraft(lat, lon, gnss_degraded=True, detail='long')` → the affected aircraft, to corroborate the footprint with real tracks.
6. `detect_deception(lat, lon)` → rule out that this is GPS **spoofing** (position injection) rather than jamming.

Report: emitter estimate ±CEP, affected-aircraft count, confidence, and caveats.
