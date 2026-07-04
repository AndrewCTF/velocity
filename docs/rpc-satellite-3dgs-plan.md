# RPC satellite → real 3D Gaussian Splat (MVS3DM path)

Goal: replace the "hills" (MapAnything on RPC-less ortho tiles) with true building-3D
from multi-view satellite that ships an RPC camera model. Reuses the existing gsplat
train/export/viewer; only the SfM step is new.

## Why this works where `source=eusi` didn't
- EUSI exportImage = rendered PNG, **no camera model** → geometry must be guessed → flat.
- MVS3DM = 50 WV-3 PAN views/AOI + **RPC** (rational polynomial camera) per view → real
  multi-view geometry. Keyless S3, MIT licence. Verified on disk: `apps/ml/fusion/.sat_data/mvs3dm/`.

## Data (proven-live)
- `s3://spacenet-dataset/Hosted-Datasets/MVS_dataset/Challenge_Data_and_Software/cropimagedata/`
- 8 AOIs (`MasterProvisional1..3`, `MasterSequestered1..3`, `Explorer`, `SequesteredPark`).
- Each AOI: ~50 × `*.tif` (2001² 8-bit PAN, 1 km radius crop) + `rpc_*.txt` sidecar.
- RPC `.txt` = 96 csv values: `LINE_OFF,SAMP_OFF,LAT_OFF,LONG_OFF,HEIGHT_OFF,LINE_SCALE,
  SAMP_SCALE,LAT_SCALE,LONG_SCALE,HEIGHT_SCALE, LINE_NUM[20],LINE_DEN[20],SAMP_NUM[20],
  SAMP_DEN[20], MIN_LONG,MIN_LAT,MAX_LONG,MAX_LAT, sampleOFFSET, lineOFFSET`.
- RPC gives **full-NITF** (line,sample); chip pixel = `(samp-sampleOFFSET, line-lineOFFSET)`.

## Pipeline (mirrors pi3_sfm → train_gs → pt_to_ply)
1. **rpc_sfm.py** (NEW): RPC `.txt` + chips → COLMAP `sparse/0/{cameras,images,points3D}.bin`.
   - Shared local **ENU** world frame at the AOI-centre ground point (RPC-inverse of chip centre).
   - Per view: sample a 3D grid (AOI footprint × ±150 m height), project via RPC → chip px,
     fit a perspective matrix `P` (normalized DLT), RQ-decompose → `K,R,t` (world2cam).
   - Init points: ENU grid at mean ground height, coloured from the most-nadir chip.
   - Downsample chips (2001→~900) for training; scale `K` to match.
2. **recon.py**: `_pipeline` gains `sfm="pi3"|"rpc"`; `register_sat_job(dataset,...)` copies
   local `.sat_data` chips+rpc into a job dir and runs `sfm="rpc"`. Route `POST /api/recon/sat`.
3. **train_gs.py / pt_to_ply.py / viewer**: unchanged.

## Risks / measure-before-claim
- RPC≠exact perspective over a 150 m height band → DLT reprojection error. **Gate: median < ~1 px.**
  If high: shrink height band or go per-AOI affine. (measured in rpc_sfm self/real check)
- Far camera (~600 km, focal ~1e6 px) → gsplat numerics. Mitigation if it diverges: uniform
  scene scale (geometry-preserving). Try without first.
- gsplat run cost: test on a **subset** (~8–12 views) before the full 50.

## Part 3 (separate bug): `eusi.py` dead endpoint
- `apps.euspaceimaging.com/atom/api/tara/.../search/ogc` → `ROUTE_NOT_FOUND` (verified).
  Keyless EUSI TARA is gone (backend now AWS-Cognito). Fix = degrade `source=eusi` with a
  clear 502 pointing at `source=mvs3dm`; leave code path for other egress.

## Done = a `result.ply` from MasterProvisional1 whose Z-relief ≫ the MapAnything "hills"
(measure z-spread / xy-extent; report the number, no "global/complete" claims).
