# Geo-assessment — `test_images/` (analyst synthesis over the pipeline output)

Run: `apps/ml/geolocate` pipeline (Stages A–E) on 9 files → 6 unique scenes.
Method: classical forensics + independent Claude-vision attribute extraction → rule-based
geo-prior fusion (`knowledge/cues.yaml`) → candidate retrieval → calibrated report.
Machine output persisted in `docs/geoloc-run-testset/` (geo_assessment.md, geo_prior.json,
result.geojson, vlm_injection_attributes.json).

Pipeline's own calibrated output (Stage E): **Country = Denmark 72%**, **Region = Denmark 61%**
(both `plumbed-unverified`); AOI/Pose 0% (`heuristic`, not resolved — under-canopy). The 72/61%
are the honest recalibration of the rule-fuser's uncalibrated softmax (Denmark 0.97 of prior mass).

## Verdict (calibrated, evidence-tagged)

| Level | Call | Confidence | Basis / tag |
|---|---|---|---|
| Country | **Denmark** | high *given the operator's "near Germany, not Germany" constraint* | rule-fuser #1 (beech-moraine); constraint excludes the image-only alternative (Sweden). `heuristic+constraint` |
| Country (image-only) | Denmark ↔ **southern Sweden** ambiguous | ~medium | falu-red reads most Swedish; independent vision agent's own top guess was S-Sweden. `heuristic` |
| Region | **eastern Denmark / Danish-islands moraine belt** (Zealand·Funen·E-Jutland; Bornholm a granite-fit candidate) | moderate | mossy granite erratics + beech + slopes. `heuristic` |
| Sub-1 km point | **not warranted from pixels** | — | under-canopy; no plate/sign/skyline. Needs reference-image cross-match (Stage C). `not-built` |

## Evidence (what the photos actually show)
- **Architecture:** falu-red (iron-oxide) horizontal-timber barn/cabin, white 6-pane window, round
  globe wall-lamp; a second dark-timber outbuilding with a **red clay-tile roof** + wall meter box.
  Nordic vernacular. (`Pasted image.png`, `(8)`.)
- **Vegetation/geomorphology:** European beech (Fagus sylvatica)–dominated mixed forest + birch +
  hazel + bracken; **moss-covered granite boulders / glacial erratics** recurring on a sloped,
  hummocky floor. Weichselian moraine landscape. (`(2)(3)(4)(7)(5)`.)
- **Husbandry:** free-range heritage hens roosting in trees; small Hereford-cross beef herd on a
  forest-edge paddock (single-strand electric fence); fresh-milled softwood viewing deck/hide.
  Woodland smallholding. (`(2)(3)(4)(5)(8)`.)
- **Vehicle:** **Toyota C-HR** (concealed rear-door handle in C-pillar) → European-market, **≥2016**.
  No number plate visible → no plate-based country lock.
- **Negative evidence (bounds confidence):** no signage, no readable text/language, no road markings,
  no visible horizon/skyline. The strongest cue classes (plate country-code, language, driving side —
  cue weights 5–6) are therefore **all absent**; the call rests on architecture+vegetation+husbandry.

## Why Denmark, and the honest Sweden caveat
Two independent paths reached the southern-Scandinavia beech belt:
1. An **independent** Claude-vision agent (not shown any conclusion) read the raw photos and returned
   the same cues; its *own* region guess led with **southern Sweden (Götaland)**, Denmark/Norway next.
2. The **rule-fuser** aggregated the injected attributes over 6 scenes → **Denmark p≈0.97,
   S-Scandinavia p≈0.03** (uncalibrated softmax — cue weights are relative boosts, not probabilities).
   Denmark wins because beech (Denmark's national tree, +3.0) fires on every forest shot while
   falu-red (more Swedish, +3.0) fires on only two.

The image-only signal is genuinely **Sweden↔Denmark ambiguous**. The tie-breaker is the operator's
given constraint **"near Germany, not in Germany"**: Sweden shares no land border with Germany, so it
is excluded; Denmark (southern Jutland borders Germany; the islands are close) is the consistent fit.
The "looks Swedish (granite erratics) but is Danish + near Germany" reconciliation makes **Bornholm**
(Denmark's granite island in the southern Baltic, ~90 km off Germany/Poland) a notable specific
candidate — but scattered erratics occur throughout eastern-Danish moraine too, so Bornholm is *one*
hypothesis inside the region, not a favored pin.

## Live-network attempt (2026-07-10, network enabled)
Ran the retrieval stages live + targeted OSINT once the network was enabled:
- **Web (concept search):** returns unambiguously **Danish** smallholding/nature culture — Hereford
  extensive nature-grazing (hereford.dk), forest shelterpladser (naturstyrelsen.dk / bookenshelter.dk),
  `skovhus`/`naturgrund`. A *Country Smallholding* feature describes a near-identical self-sufficient
  smallholding on **southern Funen** ("softly undulating Ice-Age hills", little forest, poultry) —
  same *pattern*, different named family; not a confirmed match. Corroborates DK + moraine-island type.
- **OSM/Panoramax:** live-reachable, but co-occurrence ("timber building ∧ forest ∧ pasture") matches
  thousands of rural-DK cells and street-level coverage over private forest tracks is ~absent → cannot
  fingerprint this property.
- **Plate/signage hunt (max-res):** rear plate not legible (car nose-in), zero signage/house-number →
  no hard geodetic cue. Outbuilding = dark-tarred timber + **red clay pantile (vingetegl) roof** +
  wall meter box → reinforces DK/S-Scandinavia.
- **Ceiling (honest):** no content-based reverse-image-search tool is available in this environment;
  that (or a name / restored EXIF) is what a ≤1 km pin requires. Enabling the network did NOT add it.

## To go finer (the method the system implements)
Sub-1 km localisation of these shots needs **reference-image cross-match**, not satellite geometry
(the woodland interiors share ~zero visible geometry with nadir imagery — a physics limit). Concretely:
(a) pull keyless street-level imagery (Panoramax/KartaView) + Esri-Wayback dated VHR over the eastern-DK
prior; (b) match the distinctive signature — falu-red barn + tile-roofed outbuilding + adjacent
forest-edge Hereford paddock + raised timber hide — by eye or CLIP retrieval; (c) if the operator can
supply a reverse-image hit or a place name, confirm. The satellite→3DGS→pose branch (Stage D) would
then refine camera pose on the *open* yard/barn frames only.
