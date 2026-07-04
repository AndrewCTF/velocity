# Real SAR + satellite vessel detection — phased spec

## Context

Operator wants REAL dark-vessel and military-vessel detection from SAR + satellite
imagery, not the current metadata-gap heuristics. Diagnosis this session found: the
"dark-vessel" AIS tag actually means "missing static name/type" (`incidents.py:368`),
military tagging depends on AIS ship-type that keyless feeds carry only in N. Europe,
and the real SAR detector (`sar_vessels.py:116 detect_targets`, robust CFAR + land
suppression + water-context gate) exists but is on-demand-only and can't confirm "dark"
without AIS at the chokepoint.

**Honest capability ceiling (verified reasoning, not effort-limited):** keyless imagery
is Sentinel-1 SAR + Sentinel-2 optical at **10 m/px**. At 10 m you can detect a vessel
and estimate its length/heading, but you **cannot reliably classify warship vs merchant**
— a frigate is ~12 px. Reliable military *classification* needs sub-meter VHR (keyless =
Maxar Open Data, event-gated) + a trained model. So detection + dark-correlation are fully
real; military *class ID* is honestly bounded (size heuristic now; trained models later).

**Feasibility gates verified this turn:** CDSE OAuth `_token()` returns a live 1593-char
token (imagery fetch works); `detect_targets` is a real CFAR detector; `_ais_match`
correlation exists.

Decisions: **all three phases**, **scheduled auto-sweep**.

## Phase 1 — Real SAR detection + estimation + AIS-correlated dark flag + scheduled sweep (BUILD NOW)

The achievable real core. Everything here works on keyless Sentinel-1 today.

### 1a. Per-vessel estimation (extend `sar_vessels.py detect_targets`)
Today each detection = `{row, col, area_px, peak}`. Add, from the component's pixel set:
- **length_m / width_m / heading_deg** — principal-axis analysis: covariance of the blob's
  (row,col) pixels → eigenvectors give orientation (heading, 0–180° ambiguous — SAR can't
  see direction of travel) and major/minor extent; multiply px extent by the **ground
  pixel size** (derive from bbox span ÷ image dims via existing `_pixel_lonlat`; ~10 m).
- **rcs_proxy** — `peak / sqrt(area_px)` (relative radar cross-section; steel warships and
  loaded tankers are bright — a weak discriminator, surfaced as a number, not a verdict).
- Keep it a pure function → unit-testable on a synthetic array (assert a rotated rectangle
  yields the right length + heading within tolerance).

### 1b. AIS correlation → honest dark flag (extend `detect_dark_vessels` / `_ais_match`)
Per detection: match against ALL available AIS (whatever the store has for the AOI + time).
- matched → `status: "ais-matched"` (+ the mmsi).
- unmatched AND AIS coverage present in AOI → `status: "dark-candidate"` (a real
  non-broadcasting contact — this is the genuine article).
- unmatched AND no AIS coverage → `status: "unverified"` (honest; can't call it dark).
- Military *hint* (not classification): `length_m ≥ ~90` AND `status != ais-matched` →
  `mil_hint: true` with `confidence: "low"` and a `basis` string ("large unlit SAR contact
  — size-only heuristic, NOT a classified warship"). Never asserts "military".

### 1c. Scheduled auto-sweep (new `sar_sweep` background module)
- Background loop mirroring `intel/watch.py` (`_TASK`/`start`/`stop`/`_run_forever`),
  registered in `main.py` lifespan `if background:` + `finally`.
- Sweeps the curated chokepoint AOIs (`sar_vessels.AOIS`) on a cadence tied to Sentinel-1
  revisit (~12 h); cheap poll that skips an AOI when CDSE reports no newer scene than last
  run (store last-scene id per AOI). `OSINT_DISABLE_BACKGROUND` gates it off for tests.
- Store detections as persistent map entities so they show without an operator run — reuse
  the captures-store pattern (`CustomDataSource` + upsert-by-id) OR mint SAR contacts into
  the ontology. Feed the watch-officer: a `dark-candidate` detection is exactly the
  `dark-vessel` domain that already triggers `cue.run` → brief.

### 1d. Routes + frontend
- `GET /api/intel/sar/sweep` — latest sweep results (all AOIs, cached).
- Extend the existing dark-vessel SAR layer/card to render the richer fields (length,
  heading, status, mil_hint) with honest labels. Relabel the old AIS "dark-vessel
  candidate" → "incomplete AIS identity" so it stops overpromising (`analytics.py`,
  `incidents.py` basis already honest).

### Verification (Phase 1)
- pytest: `detect_targets` estimation on a synthetic rotated-rectangle array (length +
  heading within tolerance); AIS-correlation status logic (matched / dark / unverified /
  mil_hint) on fixtures; sweep dedup (no re-store when scene id unchanged). From repo root.
- Live: probe one real AOI (e.g. `hormuz`) end-to-end — fetch S1 GRD via CDSE, run
  detect_targets, show N detections with length/heading; confirm token + fetch on real data
  (CDSE token already proven live this turn). Screenshot the rendered contacts.
- `pnpm -r typecheck` green; backend suite stays green.

## Phase 2 — Trained SAR ship classifier (LATER)
Fine-tune a CNN on public SAR-ship datasets (OpenSARShip / FUSAR-Ship) on the local RTX
5090 → class estimate from the SAR chip. Real ML; accuracy uncertain at 10 m; warship-vs-
merchant remains hard. Own spec + dataset sourcing + training harness. Runs via the CUDA
sidecar env (`~/.venv` torch, per memory `cuda-yolo-sidecar-env`).

## Phase 3 — VHR optical CNN where available (LATER)
When Maxar Open Data VHR (<1 m) covers an AOI, run a ship-detection/classification CNN on
optical chips → real silhouette-based class ID. Opportunistic (VHR is event-gated). Reuses
the on-demand imagery path (`imagery/ondemand.py`) + the YOLO sidecar, but needs a
ship/warship-tuned model, not generic COCO.

## Honest scope note
Phase 1 delivers real detection of non-broadcasting vessels (incl. dark) + honest size-based
military hints at the chokepoints, on keyless Sentinel-1, running on a schedule. Reliable
military *classification* arrives only with Phase 2/3 and is bounded by sensor resolution +
model accuracy — it will be tiered by confidence, never asserted.
