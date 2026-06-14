# Spec 5 — Skyfall-GS 3D urban reconstruction (incl. destruction)

> **SUPERSEDED (2026-06-14):** merged into
> `2026-06-14-fusion-skyfall-3d-design.md` (Spec 5★), which unifies this with the
> multi-sensor fusion/colorization work per operator direction. Kept for history.

- Date: 2026-06-14
- Status: superseded
- Depends on: Spec A (multi-view/multi-date satellite imagery supply + Cesium serving path).
- Upstream method: **Skyfall-GS**, "Synthesizing Immersive 3D Urban Scenes from Satellite Imagery", arXiv 2510.15869, project https://skyfall-gs.jayinnn.dev/ .
- Class: **research-grade, GPU.** Single workstation.

## 1. Goal

Reconstruct navigable, photoreal 3D urban scenes ("top-to-low": top-down satellite → walkable ground-level view) for an AOI, and serve them into the Cesium globe. Extend beyond the paper to **reconstruct destruction / battle damage** (collapsed/partial buildings, rubble) — the paper's training distribution is intact cities (e.g. NYC), which differs from war-damaged structure, so domain adaptation is required.

## 2. Hardware budget (fixed)

- Ryzen 9 9950X3D, 128 GB RAM, **RTX 5090 32 GB (Blackwell)**.
- Skyfall-GS is largely **per-scene optimization** (3DGS fits one AOI at a time on a single GPU) plus a **diffusion T2I refinement** step. Both fit a 5090: 3DGS per-scene is VRAM-modest; diffusion fine-tune via **LoRA** fits 32 GB. No cluster needed for per-scene reconstruction; dataset-scale diffusion fine-tune is the only heavy part and is LoRA-scoped.

## 3. Method (per Skyfall-GS)

Two stages:
1. **Reconstruction stage** — multi-view, multi-date satellite imagery → 3D Gaussian Splatting with **illumination-adaptive appearance modeling** + regularizers for sparse/multi-date input. Produces base geometry + appearance.
2. **Synthesis stage** — **Iterative Dataset Update (IDU)** with a **Text-to-Image diffusion** model + curriculum refinement: progressively render novel (lower/oblique) views, refine them with the diffusion prior, fold back in → fills geometry gaps + adds photoreal ground-level texture without street-level training data.

Reference/compare: **SkySplat** (arXiv 2508.09479, generalizable 3DGS from multi-temporal sparse satellite).

## 4. Inputs / dataset

- **Per-scene inputs (from Spec A):** multi-view / multi-date high-res optical for the AOI. Best results need sub-meter VHR (Maxar/Airbus archive) or the sharpest available (Sentinel-2 10 m is coarse for buildings — note as a quality floor; VHR is a paid add-on, flagged optional).
- **Camera/geometry:** RPC → local ENU conversion (standard satellite photogrammetry); Copernicus DEM as geometry prior.
- **Diffusion prior dataset (for the IDU T2I model):**
  - Base: the paper's pretrained T2I prior (intact urban).
  - **Destruction adaptation set (new):** curate post-strike VHR + ground/oblique imagery of damaged buildings (open OSINT: news/agency imagery, UNOSAT damage sites, Gaza/Ukraine documented strikes) → caption (collapsed roof, pancaked floors, facade loss, rubble, crater) → **LoRA fine-tune** the T2I prior so IDU can synthesize *damaged* structure instead of hallucinating intact buildings.

## 5. Pipeline / integration

- `apps/ml/skyfall/` :
  - `prepare.py` — fetch AOI multi-view imagery, RPC→ENU, COLMAP-free init (paper's approach) / DEM prior.
  - `reconstruct.py` — 3DGS optimization (illumination-adaptive) per scene.
  - `refine.py` — IDU loop with the (destruction-LoRA) T2I diffusion model.
  - `export.py` — splats → Cesium-servable: 3D Tiles (mesh bake) and/or a 3DGS viewer (`.splat`/`.ksplat`) layer.
- Serving: `GET /api/scenes/{aoi}` → tileset/splat URL. Frontend: Cesium `Cesium3DTileset` or a Gaussian-splat renderer layer; AOI picker; "ground view" free-flight camera.
- Cross-link: a damage AOI from Spec A can launch its Skyfall-GS 3D scene.

## 6. Testing method

- Unit: RPC→ENU conversion against a known geodetic fixture (sub-pixel reprojection error).
- Unit: export produces a valid 3D Tiles `tileset.json` / splat file that the Cesium loader accepts (headless load, no throw).
- Reconstruction smoke: a small public multi-view AOI runs end-to-end → produces a splat with > N Gaussians and renders a novel view.
- Quantitative (held-out views): **PSNR / SSIM / LPIPS** on rendered novel views vs withheld real views; geometry vs DEM (elevation MAE). Compare against paper-reported and a vanilla-3DGS baseline.
- **Destruction eval:** a held-out set of *damaged* AOIs (documented strikes) — reconstruct, then have human/VLM raters score whether damage is preserved (collapsed vs falsely-intact). Metric: % scenes where destruction is correctly represented, base prior vs destruction-LoRA. The LoRA must beat base by a stated margin.
- Regression: novel-view quality on intact AOIs must not degrade after destruction-LoRA (no catastrophic forgetting).

## 7. Verification — "done when"

- [ ] One intact AOI reconstructs to a navigable 3D scene served in Cesium with free-flight ground view; novel-view LPIPS/SSIM within a stated band of paper results.
- [ ] One **damaged** AOI reconstructs with the destruction correctly represented (rater/VLM ≥ stated %), and the destruction-LoRA beats the base prior on the destruction eval.
- [ ] Intact-AOI quality does not regress after adding the destruction-LoRA.
- [ ] Full per-scene pipeline (prepare→reconstruct→refine→export) runs on the RTX 5090 within a documented wall-clock + VRAM budget.
- [ ] Export loads in Cesium with no console errors; AOI launchable from a Spec A damage result.

## 8. Risks

- **Imagery resolution:** Sentinel-2 10 m is too coarse for crisp buildings; quality scales with VHR. Flag VHR as the real enabler; ship S2 as a low-fidelity proof.
- **Destruction domain gap (called out by user):** the paper's prior assumes intact cities → without the destruction-LoRA, IDU will "repair" damaged buildings. The LoRA + destruction eval gate are core, not optional.
- **Reproducing the paper:** upstream code maturity unknown; budget time to re-implement or adapt from the project release. Pin a commit; record exact deps (CUDA/torch/gsplat versions for Blackwell/5090).
- **Per-scene cost:** reconstruction is per-AOI, not global — scope to a curated AOI list, not the whole planet.

## 9. Phasing

1. Repro Skyfall-GS on one public intact AOI (RTX 5090 env: CUDA/torch for Blackwell, gsplat).
2. Cesium export + serve (3D Tiles and/or splat layer).
3. Curate destruction adaptation dataset + LoRA fine-tune the IDU T2I prior.
4. Destruction eval + intact-regression gate.
5. AOI catalog + cross-link from Spec A damage results.
