# apps/ml/fusion — multi-sensor fusion → colorization → 3D (Spec 5★)

GPU-heavy stages of the fusion pipeline. Separate env from the API (torch /
diffusers / gsplat) — the lightweight Stage A ingest + alignment QA lives in
`apps/api/app/fusion/` and is reused here.

## Hardware (target)
RTX 5090 (32 GB, Blackwell sm_120), Ryzen 9 9950X3D, 128 GB RAM. Driver 595.x.
Blackwell needs CUDA 12.8+ wheels (`cu128`) and torch ≥ 2.8.

## Env setup
System Python is 3.14 (no torch wheels). Use a 3.12 venv via `uv`:

```bash
cd apps/ml/fusion
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python \
  torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv/bin/python \
  diffusers transformers accelerate peft safetensors \
  numpy pillow rasterio scikit-image kornia einops opencv-python-headless
# gsplat (Stage E 3DGS) is built later — needs the CUDA toolkit (nvcc) for sm_120.
```

Verify: `.venv/bin/python -c "import torch;print(torch.cuda.get_device_name(0))"`

## Stages (Spec 5★)
- **A. ingest + co-register** — DONE, in `apps/api/app/fusion/ingest.py` (lightweight).
- **C. cross-modal colorizer** — reference-conditioned diffusion (SAR/pan/thermal →
  color, referenced to the AOI's own optical). Fine-tune a pretrained latent
  diffusion + ControlNet hint + reference branch. **Runs on free Sentinel + 5090;
  no multi-view / VHR needed.** This is the novel core.
- **D. super-res + fuse** — multi-image SR (DeepSent/WorldStrat lineage).
- **E. 3DGS reconstruct** — EOGS/ShadowGS/SA-GS + Skyfall IDU. **Needs multi-view
  imagery with RPC cameras for crisp buildings → VHR (Maxar/WorldView) or the
  DFC2019 benchmark. Free Sentinel (ortho near-nadir) yields 2.5D terrain drape,
  not sharp 3D buildings.**
- **F. diffusion IDU refine + destruction LoRA** — ground-level fidelity + damage.
- **G. export** — 3D Tiles / .splat → Cesium.

## Honest constraints (read before claiming results)
- Single GPU ⇒ stages run **sequentially**; no large parallel sweeps.
- Free 10 m Sentinel ⇒ every artifact is a **proof**, not VHR fidelity.
- Stage E crisp-3D is gated on multi-view data (above). Stages C/D do not have that
  gap and are the near-term deliverables.
- No "best / SOTA / high-fidelity" claim without a passed acceptance gate (Spec §8).

## Datasets (download targets)
SEN12MS (SAR/optical pairs), SOMA-1M (SAR-optical alignment), WorldStrat (S2↔SPOT
SR), DFC2019 (multi-view WorldView-3 for Stage E validation), xBD/BRIGHT (destruction).
