// Pure layout for the native Reports pages: the slide stage scale, the
// incident link graph and the lineage pipeline, each as plain coordinates the
// pages draw into an SVG whose viewBox scales to its pane.
import { lineageLayoutEu, type Incident, type Lineage } from "./data.js";

export type XY = [number, number];
export type Box = [number, number, number, number];

/** Scale that fits a W x H slide inside a w x h pane (0 until the pane is measured). */
export function stageScale(w: number, h: number, W: number, H: number): number {
  return w > 0 && h > 0 ? Math.min(w / W, h / H) : 0;
}

/** Bounding viewBox [x, y, w, h] of the points, padded on every side. */
export function boxOf(pts: XY[], pad: number, minW = 200, minH = 120): Box {
  if (!pts.length) return [0, 0, minW, minH];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - x0;
  const h = Math.max(...ys) + pad - y0;
  // a small graph is centred in a minimum box, so it does not blow up to fill the pane
  return [x0 - Math.max(0, minW - w) / 2, y0 - Math.max(0, minH - h) / 2, Math.max(minW, w), Math.max(minH, h)];
}

/** Hub of each detector domain; an unknown domain sits at the default. */
const HUB: Record<string, XY> = {
  "dark-vessel": [250, 230],
  military: [720, 190],
  "ais-gap": [250, 520],
  "gps-jamming": [720, 500],
  "air-emergency": [485, 360],
  event: [485, 60],
};
export const hubOf = (d: string): XY => HUB[d] ?? [485, 640];

export interface GraphLayout {
  /** incident index (into the input) to its position */
  pos: Map<number, XY>;
  box: Box;
}

/** Incidents ring around the mean of their domains' hubs, ordered by first domain. */
export function graphLayout(inc: Incident[], doms: string[]): GraphLayout {
  const order = [...inc.keys()].sort((a, b) => {
    const da = inc[a]!.domains[0]!;
    const db = inc[b]!.domains[0]!;
    return da < db ? -1 : da > db ? 1 : a - b;
  });
  const pos = new Map<number, XY>();
  order.forEach((i, rank) => {
    const a = (rank / inc.length) * 2 * Math.PI + 0.4;
    const r = (38 + ((rank * 37) % 7) * 13) * 1.3;
    const ds = inc[i]!.domains;
    const cx = ds.reduce((t, d) => t + hubOf(d)[0], 0) / ds.length;
    const cy = ds.reduce((t, d) => t + hubOf(d)[1], 0) / ds.length;
    pos.set(i, [cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r]);
  });
  return { pos, box: boxOf([...pos.values(), ...doms.map(hubOf)], 48, 400, 300) };
}

export const NODE_W = 150;
export const NODE_H = 30;

export interface LineageLayout {
  pos: Map<string, XY>; // node id to its left edge and vertical centre
  box: Box;
}
export function lineageLayout(lin: Lineage): LineageLayout {
  const pos = lineageLayoutEu(lin);
  const pts: XY[] = [];
  for (const [x, y] of pos.values()) pts.push([x, y - NODE_H / 2], [x + NODE_W, y + NODE_H / 2]);
  return { pos, box: boxOf(pts, 32, 1400, 800) };
}

/** Share of the span a time falls at, clamped to 0..1. */
export const along = (t: number, t0: number, span: number): number => Math.min(1, Math.max(0, (t - t0) / span));
