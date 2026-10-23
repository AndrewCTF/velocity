// The imagery plate behind the video surface: a square mosaic of the app's
// own satellite tiles (/tiles/sat, same origin) around a real position, with
// exact web-mercator maths so every pixel on it has a latitude and longitude.

export const TILE = 256;
export const SPAN = 7; // tiles per side
const EARTH_CIRC = 2 * Math.PI * 6378137;

export interface Plate {
  lat: number;
  lon: number;
  z: number;
  /** Top-left tile of the mosaic. */
  tx0: number;
  ty0: number;
}

const tileX = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat: number, z: number): number => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

export function makePlate(lat: number, lon: number, z = 17): Plate {
  const h = Math.floor(SPAN / 2);
  return {
    lat,
    lon,
    z,
    tx0: Math.floor(tileX(lon, z)) - h,
    ty0: Math.floor(tileY(lat, z)) - h,
  };
}

/** Plate pixel of a position. */
export function toPx(p: Plate, lat: number, lon: number): [number, number] {
  return [(tileX(lon, p.z) - p.tx0) * TILE, (tileY(lat, p.z) - p.ty0) * TILE];
}

/** Position of a plate pixel. */
export function toLL(p: Plate, x: number, y: number): [number, number] {
  const n = 2 ** p.z;
  const lon = ((p.tx0 + x / TILE) / n) * 360 - 180;
  const yy = Math.PI * (1 - (2 * (p.ty0 + y / TILE)) / n);
  const lat = (Math.atan(Math.sinh(yy)) * 180) / Math.PI;
  return [lat, lon];
}

/** Ground metres per plate pixel at the plate centre. */
export function gsd(p: Plate): number {
  return (EARTH_CIRC * Math.cos((p.lat * Math.PI) / 180)) / (TILE * 2 ** p.z);
}

export function tiles(
  p: Plate,
): Array<{ key: string; x: number; y: number; url: string }> {
  const out = [];
  for (let i = 0; i < SPAN; i++)
    for (let j = 0; j < SPAN; j++) {
      const tx = p.tx0 + i;
      const ty = p.ty0 + j;
      out.push({
        key: `${p.z}/${tx}/${ty}`,
        x: i * TILE,
        y: j * TILE,
        url: `/tiles/sat/${p.z}/${tx}/${ty}.jpg`,
      });
    }
  return out;
}

/** [min_lon, min_lat, max_lon, max_lat] of the plate. */
export function bounds(p: Plate): [number, number, number, number] {
  const [n, w] = toLL(p, 0, 0);
  const [s, e] = toLL(p, SPAN * TILE, SPAN * TILE);
  return [w, s, e, n];
}
