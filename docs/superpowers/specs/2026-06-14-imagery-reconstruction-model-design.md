# Spec 4 — Imagery reconstruction model (LiDAR + SAR + weather → optical)

- Date: 2026-06-14
- Status: draft (awaiting review)
- Depends on: Spec A (imagery foundation supplies training data + serving path).
- Class: **research-grade ML.** Real model training. Single-workstation budget.

## 1. Problem

Optical satellite flyovers are infrequent (Sentinel-2 ~5 day) and cloud-blocked. Between/under clouds we have other observations: SAR (Sentinel-1 C-band, NISAR L-band — all-weather), LiDAR/DEM (where available), and weather state. Goal: a model that **synthesizes a plausible, cloud-/gap-free optical image for a target time** from those inputs + recent optical context, so the map shows a "best estimate current" surface between true flyovers — clearly labelled as synthesized, with per-pixel provenance/age.

This is image-to-image translation + temporal infilling conditioned on heterogeneous sensors. It does NOT claim to invent unobserved events; it interpolates/translates from concurrent observations.

## 2. Hardware budget (fixed)

- CPU Ryzen 9 9950X3D (16C/32T), 128 GB RAM, GPU **RTX 5090 (32 GB GDDR7, Blackwell, bf16/fp8)**.
- Single GPU. So: **patch-based training**, **fine-tune pretrained backbones** (not train a giant model from scratch), gradient checkpointing, bf16/fp8 mixed precision, batch sized to ≤32 GB. 128 GB RAM allows large CPU-side tiling/caching of the dataset.

## 3. Data — dataset construction

No off-the-shelf paired dataset fits exactly; we build one from open sources (all from Spec A providers).

Per AOI + timestamp, assemble co-registered tiles:
- **Target (label):** clear Sentinel-2 optical (low cloud %, from S2 cloud mask).
- **Inputs:** temporally-nearest Sentinel-1 SAR (VV/VH), NISAR L-band where available, DEM/LiDAR (Copernicus DEM 30 m; high-res LiDAR where open, e.g. national tiles), weather (ERA5 / GOES-derived cloud, temperature, precip), and the most recent prior clear optical ("context frame").
- **Pairs:** (inputs at t) → (clear optical at t). Cloudy targets become *masked* training (inpaint the cloudy region from SAR + context).

Pipeline `apps/ml/reconstruction/dataset/`:
- STAC search (CDSE/openEO + ERA5) → download → reproject to common grid (UTM, 10 m) → cloud mask → tile to 256/512 px → store as sharded WebDataset/`.npy` on local NVMe. Target: a few hundred AOIs × multi-date → 10⁵–10⁶ tiles (manageable on 128 GB RAM streaming, single-GPU epochs).

## 4. Architecture

- **Backbone:** conditional latent diffusion (fine-tune a pretrained Stable-Diffusion-class UNet/VAE) OR a deterministic ConvNeXt/U-Net + perceptual+adversarial loss. Recommend **conditional latent diffusion** for texture realism, fine-tuned (LoRA/ControlNet-style conditioning) to fit 32 GB.
- **Conditioning encoder:** multi-modal fusion — SAR + DEM + weather + context frame encoded (small ResNet/ViT per modality) → cross-attention / ControlNet hint into the diffusion UNet.
- **Provenance head:** output also carries a confidence/age map (how far the synthesis extrapolated from real observations).
- Train at 256², infer tiled with overlap-blend for larger scenes.

## 5. Training

- Stage 1: fit VAE/encoders on the corpus (or reuse pretrained VAE frozen).
- Stage 2: fine-tune diffusion + conditioning (LoRA + ControlNet) with bf16, grad-checkpointing, batch 4–16 @256², grad-accum to taste. Expect days–weeks wall-clock on one 5090.
- Losses: diffusion denoising + LPIPS + L1 + (optional) adversarial; mask-aware for cloud inpainting.
- Logging: Weights&Biases or local TensorBoard.

## 6. Serving / integration

- Export to ONNX/TensorRT; inference service `apps/ml/reconstruction/serve.py` (FastAPI sidecar) → `POST /api/imagery/reconstruct {aoi, date}` returns a synthesized tile set + confidence map.
- Frontend: a "Synthesized (model)" imagery layer, **visibly badged** + confidence overlay; never presented as a real observation.

## 7. Testing method

- Unit: dataset pipeline — co-registration aligns a known fixture pair to sub-pixel; cloud mask fixture yields expected masked ratio; tiler round-trips shapes.
- Unit: model forward pass on a dummy batch produces correct output shape + a confidence map in [0,1]; LoRA/ControlNet wiring loads.
- Training smoke test: overfit a single batch → loss → ~0 (proves the loss/optimizer path).
- Held-out eval set (AOIs/dates never trained): **PSNR, SSIM, LPIPS** vs the true clear optical; SAR-only-input subset reported separately.
- Downstream-task eval: run Spec A damage/dark-vessel on synthesized vs real imagery — agreement rate (the synthesis must not fabricate structures that flip detections).
- Cloud-inpaint eval: mask a clear region, reconstruct, measure error inside the mask only.

## 8. Verification — "done when"

- [ ] Dataset pipeline produces ≥10⁵ co-registered (inputs→clear-optical) tiles, reproducibly, from a documented AOI/date list.
- [ ] Single-batch overfit reaches near-zero loss (path correctness).
- [ ] On held-out AOIs the model beats two baselines (a) most-recent-clear-optical carry-forward and (b) SAR-colorization, on LPIPS and SSIM, by a stated margin.
- [ ] Cloud-inpaint error inside masked regions is below a stated threshold and visibly plausible.
- [ ] Downstream detections (damage/dark-vessel) on synthesized imagery agree with real-imagery detections ≥ a stated rate; disagreements are within low-confidence regions.
- [ ] Served as a badged layer with a per-pixel confidence/age overlay; clearly never labelled as a real observation.

## 9. Risks

- Single-GPU ceiling: keep the model fine-tuned, not from-scratch; 256² patches.
- Hallucination is the core danger → the confidence/age map + downstream-agreement gate are mandatory acceptance criteria, not nice-to-haves.
- Data co-registration is the silent killer; budget most engineering time on the dataset pipeline + QA.
- Honest framing: this is a multi-week-to-month effort even at this scope.

## 10. Phasing

1. Dataset pipeline + QA (largest chunk).
2. Deterministic U-Net baseline (fast to train) → establishes metrics + serving path.
3. Diffusion fine-tune for realism.
4. Confidence map + downstream-agreement gate.
5. TensorRT serve + badged frontend layer.
