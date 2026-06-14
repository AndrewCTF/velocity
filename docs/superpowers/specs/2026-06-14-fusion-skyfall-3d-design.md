# Spec 5★ — Multi-sensor fusion → colorization → Skyfall-GS high-fidelity 3D

- Date: 2026-06-14
- Status: draft (research-level; awaiting review + a compute decision)
- **Supersedes + merges** `2026-06-14-imagery-reconstruction-model-design.md` (old Spec 4)
  and `2026-06-14-skyfall-gs-3d-design.md` (old Spec 5).
- Depends on: Spec A (imagery foundation supplies the co-registered multi-sensor stack + serving path).
- Enables: Phase 4 damage reconstruction (consumes this pipeline's 3D output).
- Class: **research-grade.** Single-workstation (RTX 5090) + honest cloud fallback.

## 0. Honesty contract

Per the operator's instruction: this spec states where the approach is novel and
where it is unproven; it gives concrete VRAM/time numbers and says plainly what a
single RTX 5090 can and cannot do. No claim of SOTA or "best in market" is made
without a benchmark to back it — those are acceptance gates below, not assertions.

## 1. Goal

Fuse **all** available satellite sensors over an AOI into one harmonized,
colorized, super-resolved multi-view image stack, then reconstruct a **very
high-fidelity, navigable 3D model** of the place. Two genuinely hard sub-problems,
solved together:

1. **Cross-modal colorization / translation** — turn non-color acquisitions
   (Sentinel-1/NISAR SAR, panchromatic, thermal) into color, using *co-registered
   color (optical) acquisitions of the same place* as the color reference, so
   every pass — including cloudy-day SAR and night thermal — contributes a usable
   colored view.
2. **Sensor-fused 3D reconstruction** — feed that dense, harmonized multi-view
   stack into a Gaussian-Splatting + diffusion pipeline (Skyfall-GS lineage) to
   produce a photoreal, free-flight 3D scene, including damaged/destroyed
   structure (the destruction-aware prior that Phase 4 needs).

## 2. Why this is novel (and where prior art stops)

Satellite 3DGS today is **optical-only and single-sensor**: EOGS/EOGS++ (panchromatic),
Sat-NeRF/EO-NeRF, ShadowGS (shadow-aware), SA-GS (season-aware), SkySplat
(feed-forward multi-temporal), Skyfall-GS (3DGS + diffusion refinement). SAR→optical
translation is studied **in 2-D only** (CM-Diffusion color-memory, color-supervised
diffusion, Conditional Brownian-Bridge for VHR, Schrödinger-bridge unpaired).

The new contribution = **the join**: a *sensor-fused radiance field* whose
appearance is supervised by a harmonized stack in which SAR/pan/thermal passes are
colorized by **reference-based cross-modal transfer from the AOI's own optical
dates**, not hallucinated from a generic prior. This (a) multiplies the usable
multi-view supervision (all-weather, day+night) → denser geometry, and (b) keeps
color physically anchored to real optical observations of that exact place. No
published method fuses colorized multi-sensor passes into a single high-fidelity
satellite radiance field. That is the research bet — and the risk (Section 7).

## 3. Pipeline

```
A. Ingest + co-register     all sensors over AOI (Spec A providers) -> common grid + RPC/ENU cameras
B. Harmonize per-sensor     speckle filter (SAR), pan-sharpen, atmospheric/illumination normalize
C. Cross-modal colorize     SAR/pan/thermal -> color, REFERENCED to co-registered optical dates
D. Super-resolve + fuse     multi-image SR; assemble the dense multi-view colorized stack
E. 3DGS reconstruct         RPC cameras, shadow/season/transient aware (EOGS/ShadowGS/SA-GS lineage)
F. Diffusion IDU refine     Skyfall-GS iterative dataset update + destruction-aware LoRA -> ground fidelity
G. Export                   3D Tiles / .splat -> Cesium (Spec A serving path), with provenance/confidence
```

### Stage detail
- **A. Ingest/co-register** (`apps/ml/fusion/ingest/`): pull S2 (10 m optical), S1
  (C-SAR), NISAR (L-SAR), Landsat, S3, geostationary, Copernicus DEM (+ open LiDAR
  where available). RPC→local ENU (Sat-NeRF/EOGS convention). Sub-pixel co-registration
  is the make-or-break step (Section 7).
- **B. Harmonize**: SAR despeckle (e.g. non-local means / learned), terrain-flattening
  (γ0), pansharpen pan→multispectral, BRDF/illumination + atmospheric normalization,
  cloud/shadow masking (carry masks downstream).
- **C. Cross-modal colorize** — the core model. Reference-conditioned diffusion:
  input = (SAR/pan/thermal tile + co-registered optical reference tile(s) from
  nearby dates) → output = colorized optical-domain tile. Builds on CM-Diffusion /
  color-supervised diffusion / Brownian-Bridge, **extended with a real reference
  branch** (the AOI's own optical), not just a learned color prior — this is what
  kills the "color shift / hallucinated color" failure mode the 2-D literature
  reports under small batches.
- **D. Super-resolve + fuse** (DeepSent / WorldStrat / combined SISR+MISR lineage,
  radiometric-consistency losses): multi-image SR to lift effective resolution;
  assemble the per-date colorized stack as 3DGS supervision views.
- **E. 3DGS reconstruct** (EOGS/EOGS++ base; ShadowGS shadow modeling; SA-GS
  season/illumination-adaptive appearance; multi-date transient handling): per-scene
  optimization → base geometry + appearance.
- **F. Diffusion IDU refine** (Skyfall-GS): iterative dataset update with a T2I
  diffusion prior to synthesize oblique/ground views and fill geometry; **destruction
  LoRA** fine-tuned on post-strike VHR so damaged structure is preserved, not
  "repaired" (feeds Phase 4).
- **G. Export**: 3D Tiles + Gaussian-splat layer into Cesium; per-Gaussian
  provenance (which sensors/dates contributed) + confidence.

## 4. Models, datasets, training

| Component | Approach | From scratch? |
|---|---|---|
| Cross-modal colorizer (C) | reference-conditioned latent diffusion + ControlNet (SAR/pan hint) | fine-tune pretrained SD/SDXL/FLUX VAE+UNet; new reference + hint branches trained |
| Multi-image SR (D) | transformer/CNN MISR w/ radiometric loss | small model, trainable from scratch |
| 3DGS reconstruct (E) | per-scene optimization (no global training) | n/a (optimization, not training) |
| IDU diffusion prior (F) | Skyfall-GS T2I + **destruction LoRA** | LoRA fine-tune only |

**Datasets:** SEN12MS (180k SAR/optical/landcover triplets), SOMA-1M (SAR-optical
multi-res alignment), WorldStrat (S2↔SPOT VHR), DFC tracks, Copernicus DEM/open
LiDAR for geometry GT; xBD / BRIGHT / DisasterM3 for the destruction LoRA. All
co-registered to the common grid by Stage A.

## 5. Compute — honest verdict for one RTX 5090 (32 GB, Blackwell), 9950X3D, 128 GB

Grounded in measured numbers (3DGS: 24 GB for 30k iters, 0.1–0.5 M Gaussians ≈10 GB,
2–4 M dense ≈17 GB; SDXL LoRA train ≈20 GB; ControlNet stacks fit in 32 GB).

| Workload | Fits one 5090? | Est. cost | Notes |
|---|---|---|---|
| Stage E per-scene 3DGS (one AOI) | **Yes** | minutes–~1 h/scene | EOGS-class; 32 GB comfortable to dense |
| Stage F IDU + destruction **LoRA** fine-tune | **Yes** | hours–days | LoRA/ControlNet ≈20–24 GB |
| Stage D MISR training | **Yes** | days | patch-based, small model |
| Stage C colorizer **fine-tune** (LoRA/ControlNet on pretrained) | **Yes** | days–~2 wk | the practical path |
| Stage C colorizer **from scratch** (foundation-scale) | **No** | — | needs multi-GPU weeks |
| "Train as parallel as possible / use all compute" | **No on 1 GPU** | — | one GPU = serial phases + batch-1 data parallel |

**Plain statement:** a single RTX 5090 is **sufficient** for the per-scene
reconstruction + the *fine-tune* regime (pretrained backbones + LoRA/ControlNet +
small from-scratch heads), run **sequentially**. It is **not sufficient** for
(a) training the cross-modal colorizer from scratch at foundation scale, or
(b) genuine large-scale parallel training ("use as much compute as possible").
Those need multi-GPU cloud — realistically **4–8× H100/A100 for days–weeks** for a
from-scratch colorizer; the 5090 then does per-scene optimization, LoRA fine-tunes,
and all inference locally.

**Decision needed from you (Section 9):** fine-tune-on-5090 (self-contained, weeks,
no cloud bill) **or** from-scratch foundation colorizer (cloud, strongest result,
real cost). I recommend starting fine-tune-on-5090, measuring against the gates,
and only renting cloud if the gates demand it — but I will not claim the 5090 path
reaches "best in market" until a benchmark says so.

## 6. Repo shape

`apps/ml/fusion/` — `ingest/`, `harmonize/`, `colorize/` (Stage C model + train),
`sr/` (Stage D), `recon/` (Stage E 3DGS), `refine/` (Stage F IDU+LoRA), `export/`,
`serve.py` (inference sidecar → `/api/scenes/{aoi}`). Kept out of the FastAPI app's
import path (heavy deps: torch, gsplat, diffusers) — separate service + env.

## 7. Risks / where it can fail (named, not hidden)

- **Co-registration** is the silent killer: optical vs SAR mis-registration of a few
  metres destroys both colorization and 3DGS. Most engineering time goes here.
- **Hallucinated color**: even reference-conditioned, the colorizer can invent color
  in newly-changed areas. Mitigation: confidence map + downstream agreement gate; in
  damaged areas, prefer geometry/SAR truth over invented optical.
- **Resolution ceiling**: free Sentinel is 10 m — buildings are coarse. True "very
  high fidelity" needs VHR (Maxar/Airbus, paid). Flag VHR as the real fidelity lever;
  ship a 10 m proof first and *say it's a proof*.
- **Single-GPU**: serial phases; no large parallel sweeps. Reproducing 5 papers'
  pipelines on Blackwell (CUDA/torch/gsplat compat) is itself weeks of integration.
- **Destruction domain gap**: paper priors assume intact cities; the destruction LoRA
  must beat the base prior on a held-out damaged set or it "repairs" rubble.

## 8. Testing / verification — "done when" (acceptance gates)

- **Co-registration:** RPC→ENU reproj error < 1 px on a geodetic fixture; optical↔SAR
  alignment median < 1.5 px on a checkerboard of GCPs.
- **Colorization (Stage C):** on a held-out set, colorized-from-SAR vs real optical —
  report **PSNR / SSIM / LPIPS** and a color-shift metric; beat (a) generic SAR-colorizer
  and (b) nearest-optical-carry-forward by a stated margin. No fabricated structures
  (downstream detector agreement ≥ stated rate).
- **Super-res (Stage D):** PSNR/SSIM vs WorldStrat VHR GT beats bicubic + a SISR baseline.
- **3D (Stage E/F):** novel-view PSNR/SSIM/LPIPS on withheld dates within a stated band
  of EOGS/Skyfall-reported; geometry elevation MAE vs DEM/LiDAR below a stated threshold.
- **Destruction:** on documented damaged AOIs, raters/VLM score destruction correctly
  preserved ≥ stated %, LoRA beats base prior, and intact-AOI quality does not regress.
- **End-to-end:** one AOI runs ingest→export on the 5090 within a documented wall-clock
  + VRAM budget; loads in Cesium with no console errors.
- Every quantitative claim ("best", "high fidelity") is backed by one of these gates
  on a named held-out set, or it is not made.

## 9. Locked decisions (operator, 2026-06-14)

1. **Compute:** RTX 5090 local **fine-tune path first** (pretrained backbones +
   LoRA/ControlNet + per-scene 3DGS, sequential). No cloud spend now. Cloud
   (from-scratch colorizer) is revisited only if §8 gates fail — and only after I
   report the gap with numbers; "best in market" is never asserted without a passed
   benchmark.
2. **Imagery:** free **10 m Sentinel** now, every artifact **explicitly labeled a
   proof**. VHR deferred (revisit only if fidelity gates demand + operator approves spend).
3. **AOI order:** **intact Gulf city first** (validate raw fidelity + colorization),
   **then a damaged AOI** (exercise destruction LoRA + Phase 4 hand-off).

## 10. Phasing

1. Stage A ingest + co-registration + QA (largest, riskiest; gate on reproj error).
2. Stage C colorizer (fine-tune) + Stage D SR — 2-D gates first.
3. Stage E 3DGS (reproduce EOGS/Skyfall on one intact AOI) + Cesium export.
4. Stage F IDU + destruction LoRA + destruction gate.
5. Scale to AOI catalog; revisit cloud/VHR only if gates demand.
