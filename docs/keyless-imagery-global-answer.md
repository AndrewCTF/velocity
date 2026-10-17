# Round 6 — the global answer, with freshness finally measured

You asked twice for global + new data. Here is the verified answer, including a
correction to something I told you earlier and the measurement that settles the
freshness question.

## Esri Wayback is the global source. Measured, not asserted.

- **196 dated world releases**, 2014-02-20 → **2026-08-05**.
- Keyless, no quota, no token. browser UA is all that's needed.
- Verified live at Nairobi, Gaza City, Port-au-Prince, Raleigh, Perth and 6 more.

### It genuinely carries new imagery

Same tile, six releases, fraction of pixels differing by >25 levels:

| Place | 14→17 | 17→19 | 19→21 | 21→23 | 23→26 |
|---|---|---|---|---|---|
| Raleigh NC | 0.0% | 53.8% | 57.5% | 65.4% | 77.2% |
| Nairobi KE | n/a | 38.1% | 56.4% | 62.4% | 65.9% |
| Port-au-Prince HT | n/a | 23.8% | 29.1% | 77.1% | 28.8% |
| Perth AU | n/a | 43.2% | 65.9% | 61.2% | 78.6% |
| Manhattan NY | 0.0% | 83.2% | 0.0% | 72.3% | 54.5% |
| Dubai UAE | n/a | n/a | 47.8% | 36.9% | 63.4% |

**The 0.0% cells are not stale data** — I checked the bytes. Manhattan 2014 vs 2017
and 2019 vs 2021 are **byte-identical files** (`byte-identical=True`, `maxdiff=0`,
same 14249 / 22162 bytes). Esri reuses the identical tile when the underlying
source hasn't been re-flown. Where the file differs, the imagery is genuinely new.

So: 24–83% of pixels change per cycle in fast-moving places. That's a real archive,
not a repackaged basemap.

### Correction: SRC_DATE is NOT obtainable — I was wrong to suggest it was

Earlier I said per-tile `SRC_DATE` could be queried from Esri's metadata layer and
that a release date is "an upper bound on freshness". The second half holds, but I
implied the first was reliable. It isn't.

The metadata service has **14 resolution tiers** (1.9cm → 150m). I queried them
properly, one at a time:

- The `/identify` response key is `results`, not `value` — my round-1 script read
  the wrong key, which is why it returned nothing.
- With the right key, the server **ignores the `layers=` parameter entirely**. Every
  request returns the same **150 m "TerraColor NextGen"** polygon with
  `SRC_DATE: "Null"` — including for Manhattan at z19, which is certainly 30 cm
  pavement imagery.

So the endpoint does not expose per-tile acquisition dates. **Treat the Wayback
release date as a mosaic rebuild date, nothing more.** The pixel-difference method
above is the only freshness signal that actually works.

### Coverage caveat, measured

Gaza City returns a tile on **2026 releases only** — `null` on 2014, 2018, 2022 and
2024. Mariupol returns `null` on every release tested. Esri's archive is a global
*mosaic*, and some places simply weren't in early releases.

Practical consequence: **do not assume historical coverage exists for a given AOI.**
Probe the specific release before building a time series. That's the failure mode
that produces an empty diff and a false "no change detected" conclusion.

---

## The state/municipal providers remain the sharpest, but they are not global

Confirmed this session, all keyless, all verified by returning real pixels:

- **DC GIS** — **0.08 m (3 inch)**, flown 2025-03-27, 4-band. Best in the whole
  investigation. Verified: the US Capitol with individual cars resolvable by
  colour (`satscrape/qa5/dc_ortho_3inch.jpg`).
- **NC OneMap** — 0.152 m (6 inch), statewide, 4-year cycle, 2024–2027 with NIR.
- **Brampton ON** — ~40 discrete orthophotos, **2004→2023**, spring and fall.
- **Maine / Kansas / North Dakota / Iowa** — 90+ further services.
- **111 keyless orthoimagery services** discoverable through the keyless ArcGIS
  Online item-search API (`satscrape/probe_state_ortho.py`).

These beat Esri on sharpness by 2–3x. They cover one state or city each. There is
no version of this that is both.

---

## Answering the original requirement directly

| Requirement | Best available | Gap |
|---|---|---|
| Whole globe | **Esri Wayback** (0.134–0.269 m) | only option that is global |
| New data | Wayback, refreshed ~4-weekly | ✅ verified changing |
| ≥50 cm/px | Wayback clears it 2–4x | ✅ |
| No key / no quota | ✅ | — |
| Globe + sub-metre + fresh + keyless | **does not exist** | — |

That last row is the finding. Five rounds, ~1,000 AWS registry entries, 6,862 ArcGIS
Online items, ~30 national geoportals, and 15 Firecrawl searches: every provider at
0.08–0.2 m is a US state or municipality. Outside the US, orthoimagery at that
resolution exists (NL, DK, CH, UK, NZ all publish it) but is registration-gated.
US state and local government publishes openly under open-records law; most other
countries' equivalents are sold.

If the requirement stays "global + sub-metre + no credentials", Esri Wayback is the
answer and the gap is ~2x in resolution. Getting past that means either accepting a
US-only scope, or a commercial licence — there is no third option hiding in a forum.