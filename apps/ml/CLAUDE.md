# apps/ml — three environments, pick the right one

Repo-wide rules: `/CLAUDE.md`. Stage-by-stage plan and hardware notes:
`fusion/README.md`. Decision history: `docs/decisions.md`.

The one thing that costs time here is running a module in the wrong venv. There
are three, they are not interchangeable, and the failure mode is an import error
that reads like a missing dependency:

- `apps/api/.venv` — the API venv. Runs the geolocate tests
  (`apps/api/.venv/bin/pytest apps/ml/geolocate -q`, from the repo ROOT), the
  rasterio/DEM I/O, and `geolocate.retrieval.osm`. It has NO CLIP backend.
- `~/.venv` — the CUDA sidecar venv (transformers CLIP + sklearn + torch).
  Required by `geolocate/retrieval/crossview.py`; `apps/api/.venv` cannot run it.
- `apps/ml/fusion/.venv` — Python 3.12 via `uv`, torch/diffusers/gsplat on
  `cu128`. System Python is 3.14 and has no torch wheels, so never install into
  it. Blackwell (sm_120) needs CUDA 12.8+ wheels and torch ≥ 2.8.

`geolocate/pose/dsm_fallback.py` is deliberately numpy-only so it runs in either
venv — keep it that way when editing it.

Stage E (3DGS) needs multi-view imagery with RPC cameras for crisp buildings.
Free Sentinel is ortho near-nadir and yields a 2.5D terrain drape, not sharp 3D
buildings — do not report a Sentinel-only reconstruction as a building model.

Lightweight Stage A ingest and alignment QA live in `apps/api/app/fusion/` and
are reused from here, not duplicated.
