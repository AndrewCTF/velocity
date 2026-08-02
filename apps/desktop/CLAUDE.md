# apps/desktop — Tauri shell

Repo-wide rules: `/CLAUDE.md`. Decision history: `docs/decisions.md`.

- `src-tauri/.taurignore` is load-bearing, not clutter. The running app writes
  its history store and tile cache under `src-tauri/data/`, inside the crate dir
  that `tauri dev` watches — every write triggered a full app restart, an
  infinite rebuild loop. Never remove `data/`, `*.db*`, or `tilecache/` from it,
  and add an entry for any new runtime-data path you introduce under the crate.
- `sidecar/yolo_sidecar.py` runs in the CUDA env that backs `/api/recon`
  (`.mamba-cuda/compute_120`) or a sibling env with `ultralytics` + `torch(+cu)`
  — NOT `apps/api/.venv`. Device selection covers NVIDIA and AMD through the
  same `cuda:0` code path (ROCm reports through HIP), so do not add a
  vendor branch.
