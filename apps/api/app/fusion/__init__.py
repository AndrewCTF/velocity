"""Multi-sensor fusion → colorization → 3D pipeline (Spec 5★).

This package holds the LIGHTWEIGHT stages (Stage A ingest + co-registration QA)
that need only numpy/PIL/httpx and reuse the existing CDSE adapter, so they run
in the API venv and are covered by the normal pytest suite.

The GPU-heavy stages (cross-modal colorizer, multi-image SR, 3DGS reconstruction,
diffusion IDU) live in a separate `apps/ml/fusion/` env with torch/gsplat/diffusers
— added when those stages are built.
"""
