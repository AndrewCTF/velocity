// Satellite plate maths for the workspace's map views: web-mercator world
// pixels, the metres one pixel covers, and the /tiles/sat tiles that fill a
// w x h window centred on a position. Positions come back as offsets from the
// centre, which is the origin of the SVG viewBox the views draw in.
export const TILE = 256;
const M_PER_PX_Z0 = 156543.03392; // equator, 256 px tiles

export function worldPx(lon: number, lat: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n];
}

/** Offset in plate pixels of (lon, lat) from the plate centre. */
export function project(cLon: number, cLat: number, z: number, lon: number, lat: number): [number, number] {
  const [cx, cy] = worldPx(cLon, cLat, z);
  const [x, y] = worldPx(lon, lat, z);
  return [x - cx, y - cy];
}

export const metresPerPx = (lat: number, z: number): number =>
  (M_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

export interface PlateTile {
  key: string;
  x: number;
  y: number;
  url: string;
}

/** The tiles covering the window, positioned from the centre. */
export function mosaic(cLon: number, cLat: number, z: number, w: number, h: number): PlateTile[] {
  const [cx, cy] = worldPx(cLon, cLat, z);
  const n = 2 ** z;
  const out: PlateTile[] = [];
  for (let tx = Math.floor((cx - w / 2) / TILE); tx <= Math.floor((cx + w / 2) / TILE); tx++)
    for (let ty = Math.floor((cy - h / 2) / TILE); ty <= Math.floor((cy + h / 2) / TILE); ty++) {
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
      out.push({ key: `${z}/${tx}/${ty}`, x: tx * TILE - cx, y: ty * TILE - cy, url: `/tiles/sat/${z}/${tx}/${ty}.jpg` });
    }
  return out;
}
