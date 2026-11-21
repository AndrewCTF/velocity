// Pure view maths of the native Foundry map pages: the zoom that keeps a page's
// reference extent as its pane grows, timeline fractions, and the scale bar.

export const clampZ = (z: number, lo = 0, hi = 16): number =>
  Math.min(hi, Math.max(lo, z));

/** Web-mercator zoom for a pane `w` px wide: `base` at `ref` px, +1 per doubling.
 *  `world` pages never go below the zoom whose world exactly fills the pane
 *  (the basemap would wrap while countries and tracks are drawn once). */
export function zoomFor(
  base: number,
  ref: number,
  w: number,
  dz = 0,
  world = false,
): number {
  if (w <= 0) return clampZ(base + dz);
  let z = base + Math.log2(w / ref);
  if (world) z = Math.max(z, Math.log2(w / 256));
  return clampZ(z + dz);
}

/** Position of t in [t0, t1] as 0..1 (0 when the span is empty). */
export const frac = (t: number, t0: number, t1: number): number =>
  t1 > t0 ? clampZ((t - t0) / (t1 - t0), 0, 1) : 0;

/** Multiples of `step` strictly inside (t0, t1). */
export function ticks(t0: number, t1: number, step: number): number[] {
  const out: number[] = [];
  for (let t = (Math.floor(t0 / step) + 1) * step; t < t1; t += step)
    out.push(t);
  return out;
}

const NICE = [5, 10, 20, 50, 100, 200, 500, 1000];
/** The nautical-mile scale bar nearest 80 px at `kmPx` km per pixel. */
export function scaleNm(kmPx: number): { nm: number; px: number } {
  const nm = NICE.reduce((b, v) =>
    Math.abs((v * 1.852) / kmPx - 80) < Math.abs((b * 1.852) / kmPx - 80)
      ? v
      : b,
  );
  return { nm, px: (nm * 1.852) / kmPx };
}
