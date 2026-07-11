// Keyless "any city on Earth -> real Gaussian splat" for City 3D.
//
// There is no free, keyless, whole-world splat STREAM (Google/Apple 3D is keyed
// mesh, not splats — see docs/gaussian-splat-free-sources.md). The keyless path
// that DOES cover the whole world is on-demand GENERATION: stitch a satellite
// chip from the backend's keyless /tiles/sat proxy (EOX Sentinel-2 + Esri World
// Imagery, no API key) around any lat/lon, then run it through the existing
// feed-forward recon engine (POST /api/recon/jobs mode=mapany -> MapAnything
// Apache model -> INRIA .ply). Proven 2026-07-11: one Manhattan chip -> 267,318
// real Gaussians, keyless. Reuses the recon pipeline wholesale (no new backend).
//
// Single-view feed-forward yields a 2.5D relief splat (true multi-view stereo
// would need per-city imagery that isn't keyless/global) — real Gaussians, honest
// about the geometry.
import { apiFetch, backendUrl } from '../transport/http.js';

// --- Web-Mercator (XYZ) tile math ---------------------------------------------
function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

// Pick a zoom so a grid×grid block of 256 px tiles spans ~2·radiusKm, clamped to
// the keyless stack's useful range (z13 coarse city → z18 sub-metre Esri).
function zoomForRadius(lat: number, radiusKm: number, grid: number): number {
  const spanM = Math.max(0.2, 2 * radiusKm) * 1000;
  const mPerTileZ0 = 156543.03 * Math.cos((lat * Math.PI) / 180) * 256;
  const z = Math.round(Math.log2((grid * mPerTileZ0) / spanM));
  return Math.max(13, Math.min(18, z));
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`tile load failed: ${src}`));
    im.src = src;
  });
}

// Stitch a keyless satellite chip around (lat,lon) into a JPEG blob. Tiles come
// through the same-origin /tiles/sat proxy (Vite-proxied in dev), so the canvas
// stays untainted and toBlob() works. Missing tiles are left black rather than
// failing the whole chip.
export async function stitchSatChip(
  lat: number,
  lon: number,
  radiusKm: number,
  grid = 4,
): Promise<Blob> {
  const z = zoomForRadius(lat, radiusKm, grid);
  const xc = lonToTileX(lon, z);
  const yc = latToTileY(lat, z);
  const half = Math.floor(grid / 2);
  const canvas = document.createElement('canvas');
  canvas.width = 256 * grid;
  canvas.height = 256 * grid;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas context');
  const draws: Promise<void>[] = [];
  for (let dy = 0; dy < grid; dy++) {
    for (let dx = 0; dx < grid; dx++) {
      const url = backendUrl(`/tiles/sat/${z}/${xc - half + dx}/${yc - half + dy}.jpg`);
      draws.push(
        loadImg(url)
          .then((im) => {
            ctx.drawImage(im, dx * 256, dy * 256);
          })
          .catch(() => {
            /* missing tile → leave black; the rest of the chip is still usable */
          }),
      );
    }
  }
  await Promise.all(draws);
  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob((b) => res(b), 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('canvas encode failed');
  return blob;
}

// Kick off a keyless "city → Gaussian splat" job: stitch the chip and POST it to
// the existing feed-forward recon pipeline. Returns the job id; the caller polls
// /api/recon/jobs (as CityApp already does) and opens the result in SplatView.
export async function splatCityFromSat(
  lat: number,
  lon: number,
  radiusKm: number,
): Promise<string> {
  const chip = await stitchSatChip(lat, lon, radiusKm);
  const fd = new FormData();
  fd.append('files', chip, `city_${lat.toFixed(3)}_${lon.toFixed(3)}.jpg`);
  fd.append('mode', 'mapany'); // single-image feed-forward (MapAnything)
  const res = await apiFetch('/api/recon/jobs', { method: 'POST', body: fd });
  if (res.status === 503) {
    throw new Error('This server has no recon GPU lab — run locally to generate splats.');
  }
  if (!res.ok) throw new Error(`recon job failed: ${res.status}`);
  const body = (await res.json()) as { job_id?: string };
  if (!body.job_id) throw new Error('no job_id in response');
  return body.job_id;
}
