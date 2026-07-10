---
description: Cross-domain intelligence brief for an area (or global) from the live OSINT feeds
argument-hint: [place | lat,lon | global]
---

Produce an intelligence brief for: **$ARGUMENTS**

1. If `$ARGUMENTS` names a place, resolve it to `lat`/`lon` (use your knowledge or a quick search). If it is empty or `global`, brief globally.
2. `get_situation()` to orient (global counts, worst jamming, emergencies).
3. `intel_brief(...)` scoped to the area (or global), `detail='short'` first — it returns ranked, cited INCIDENTS, not raw layers.
4. Summarise the top incidents: threat level, domains, one-line narrative, evidence IDs.
5. Offer to `focus_area()` + drill (`detail='long'`) into the single highest-threat incident.

Keep it tight: verdict → top incidents with numbers/IDs → the one recommended next query. Never invent signals the tools did not return.
