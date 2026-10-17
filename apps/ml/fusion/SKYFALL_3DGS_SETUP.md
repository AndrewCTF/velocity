# Satellite 3DGS (real-colored 3D) — reproducible build on RTX 5090 (Blackwell sm_120)

Engine: **EOGS** (Earth Observation Gaussian Splatting, CVPR 2025,
https://github.com/mezzelfo/EOGS). Chosen over Skyfall-GS because EOGS **bakes the
real optical color into the splats** (verified: per-Gaussian RGB via `RGB2SH`),
whereas Skyfall-GS Stage 2 diffusion-hallucinates close-up texture. Color here is
_observed_, not generated.

The EOGS clone, datasets, CUDA env, and outputs are gitignored; THIS file is the
reproducible recipe.

## 1. CUDA 12.8 toolchain for Blackwell (no sudo)

The pip `nvidia-cuda-nvcc-cu12` wheel ships only `ptxas` (no nvcc front-end), and
system gcc-15 + glibc-2.41 both break CUDA 12.8. Solution = micromamba toolchain:

```bash
# micromamba (user-space)
python - <<'PY'
import urllib.request,os,stat
d=os.path.expanduser("~/.local/bin/micromamba")
urllib.request.urlretrieve("https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-linux-64",d)
os.chmod(d,0o755)
PY
export MAMBA_ROOT_PREFIX=$PWD/.mamba-root
micromamba create -y -p ./.mamba-cuda -c nvidia -c conda-forge \
  cuda-nvcc=12.8 cuda-cudart-dev=12.8 cuda-cccl=12.8 cuda-nvrtc-dev=12.8 cuda-driver-dev=12.8
# gcc-13 + ISOLATED sysroot (system gcc-15/glibc-2.41 hard-fail CUDA 12.8 math headers)
micromamba install -y -p ./.mamba-cuda -c conda-forge gxx_linux-64=13 gcc_linux-64=13 sysroot_linux-64=2.28
# image dev libs for the `iio` python dep
micromamba install -y -p ./.mamba-cuda -c conda-forge libjpeg-turbo libtiff libpng zlib
```

## 2. Build env (used for compiling the 3DGS CUDA submodules)

```bash
CH=$PWD/.mamba-cuda
export CUDA_HOME=$CH PATH=$CH/bin:$PATH
export CC=$CH/bin/x86_64-conda-linux-gnu-gcc CXX=$CH/bin/x86_64-conda-linux-gnu-g++
export NVCC_PREPEND_FLAGS="-ccbin $CXX" TORCH_CUDA_ARCH_LIST=12.0 FORCE_CUDA=1 MAX_JOBS=8
export C_INCLUDE_PATH=$CH/include CPATH=$CH/include LIBRARY_PATH=$CH/lib LD_LIBRARY_PATH=$CH/lib
```

torch 2.11.0+cu128 already exposes sm_120; only the compiler was missing.

## 3. EOGS + CUDA submodules

```bash
git clone --recursive --depth 1 https://github.com/mezzelfo/EOGS.git
uv pip install --python ../.venv/bin/python -r EOGS/requirements.txt   # iio needs the conda image libs (step 1)
# PATCH (one line): diff-gaussian-rasterization uses std::uintptr_t/uint32_t without <cstdint>.
#   add `#include <cstdint>` + `#include <cstddef>` to
#   EOGS/src/gaussiansplatting/submodules/diff-gaussian-rasterization/cuda_rasterizer/rasterizer_impl.h
uv pip install --python ../.venv/bin/python --no-build-isolation \
  EOGS/src/gaussiansplatting/submodules/simple-knn \
  EOGS/src/gaussiansplatting/submodules/diff-gaussian-rasterization
```

### rpcm / srtm4 (data prep only)

`rpcm` hard-imports `srtm4`, whose C/GeoTIFF `make` fails on glibc-15. EOGS's
RPC->affine prep does NOT use SRTM elevation, so:

```bash
uv pip install --python ../.venv/bin/python --no-deps rpcm geojson
# write a stub .venv/.../site-packages/srtm4.py whose srtm4() raises (never called by to_affine)
```

## 4. Data (DFC2019 / SpaceNet — free)

```bash
# EOGS release bundle (~1GB): JAX_004/068/214/260 + IARPA_001..003, with RPCs + truth DSM
python -c "import urllib.request;urllib.request.urlretrieve('https://github.com/mezzelfo/EOGS/releases/download/dataset_v01/data.zip','data.zip')"
unzip -q data.zip -d EOGS/      # extracts images/ rpcs/ truth/ to EOGS root
cd EOGS && mv images rpcs truth data/        # EOGS expects them under data/
python scripts/dataset_creation/to_affine.py --scene_name JAX_068   # RPC -> local affine camera
```

## 5. Train + render (real-colored 3D)

```bash
cd EOGS/src/gaussiansplatting
LD_LIBRARY_PATH=$CH/lib python train.py \
  -s ../../data/affine_models/JAX_068 --images ../../data/images/JAX_068 \
  --eval -m ../../output/JAX_068 --sh_degree 0 --iterations 5000
python render.py -m ../../output/JAX_068
```

~130 it/s on a 5090 → ~40 s for 5000 iters. Output: per-Gaussian-colored splats +
rendered novel views + a DSM under `output/JAX_068/test_opNone/ours_5000/`.

## 6. Status / next

- DONE: toolchain, EOGS build, JAX_068 real-colored 3D.
- NEXT: more scenes; then the research add-on — fuse SAR (geometry/cloud-gap) while
  color stays from real optical (novel/unproven — see fusion spec §7).
