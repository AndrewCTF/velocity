import { useEffect, useState } from "react";
import * as Cesium from "cesium";
import "./dossier.css";
import { edition, useDossier, type Story } from "./data.js";

// Document pins (features-a copy G21: orange ring with a page glyph). One pin
// per country the news edition tags, at the country's Natural Earth label
// point, opening that country's lead story as a dossier. Country-level only:
// the edition carries ISO3 tags, not coordinates.

interface Pin {
  iso3: string;
  story: Story;
  n: number;
  c: Cesium.Cartesian3;
}
const MAX_PINS = 8;

export function DocPins({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element | null {
  const [pins, setPins] = useState<Pin[]>([]);
  const [xy, setXy] = useState<
    { iso3: string; x: number; y: number; story: Story; n: number }[]
  >([]);
  const open = useDossier((s) => s.story);

  useEffect(() => {
    let live = true;
    void Promise.all([edition(), import("../places/countryLabels.json")]).then(
      ([stories, mod]) => {
        if (!live || typeof stories === "string") return;
        const at = new Map<string, Cesium.Cartesian3>();
        for (const [, , flat, iso] of mod.default as unknown as [
          string,
          number,
          number[],
          string,
        ][])
          if (iso && flat.length >= 2)
            at.set(
              iso,
              Cesium.Cartesian3.fromDegrees(flat[0]! / 8, flat[1]! / 8),
            );
        const by = new Map<string, Story[]>();
        for (const s of stories)
          for (const iso of s.countries ?? []) {
            if (!at.has(iso)) continue;
            if (!by.has(iso)) by.set(iso, []);
            by.get(iso)!.push(s);
          }
        setPins(
          [...by.entries()].map(([iso3, l]) => ({
            iso3,
            story: l[0]!,
            n: l.length,
            c: at.get(iso3)!,
          })),
        );
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !pins.length) return;
    const scratch = new Cesium.Cartesian2();
    let last = "";
    const update = (): void => {
      if (viewer.isDestroyed()) return;
      const cam = viewer.camera.positionWC;
      // The open part of the map, as the place labels use it.
      const cr = viewer.scene.canvas.getBoundingClientRect();
      const rect = (q: string): DOMRect | undefined =>
        document.querySelector(q)?.getBoundingClientRect();
      const sit = rect(".slate-shell .sit");
      const obj = rect(".slate-shell .obj") ?? rect(".slate-shell .sl-dossier");
      const dock = rect(".slate-shell .csl2-dock");
      const x0 = (sit ? sit.right - cr.left : 0) + 24;
      const w = Math.min(cr.width, obj ? obj.left - cr.left : cr.width) - 24;
      const h = Math.min(cr.height, dock ? dock.top - cr.top : cr.height) - 64;
      const out: typeof xy = [];
      for (const p of pins) {
        if (out.length >= MAX_PINS) break;
        if (
          Cesium.Cartesian3.dot(cam, p.c) <=
          Cesium.Cartesian3.magnitudeSquared(p.c)
        )
          continue;
        const s = viewer.scene.cartesianToCanvasCoordinates(p.c, scratch);
        if (!s || s.x < x0 || s.y < 0 || s.x > w || s.y > h) continue;
        out.push({
          iso3: p.iso3,
          x: Math.round(s.x),
          y: Math.round(s.y),
          story: p.story,
          n: p.n,
        });
      }
      const key = out.map((o) => `${o.iso3}${o.x},${o.y}`).join("|");
      if (key === last) return;
      last = key;
      setXy(out);
    };
    update();
    return viewer.scene.postRender.addEventListener(update);
  }, [viewer, pins]);

  if (!xy.length) return null;
  return (
    <div className="sl-docpins">
      {xy.map((p) => (
        <button
          key={p.iso3}
          type="button"
          className={`sl-docpin${open?.id === p.story.id ? " on" : ""}`}
          style={{ left: p.x - 22, top: p.y + 18 }}
          title={`${p.story.title}${p.n > 1 ? ` (+${p.n - 1} more stories tagged ${p.iso3})` : ""}`}
          aria-label={`Open dossier: ${p.story.title}`}
          onClick={() => useDossier.getState().open(p.story)}
        >
          <svg width="23" height="33" viewBox="0 0 46 66" aria-hidden="true">
            <path
              d="M5 3 H29 L41 15 V63 H5 Z"
              fill="#f4f6f7"
              stroke="#2a3338"
              strokeWidth="1.5"
            />
            <path
              d="M29 3 V15 H41"
              fill="#cfd6da"
              stroke="#2a3338"
              strokeWidth="1.5"
            />
            <path
              d="M11 24 H35 M11 31 H35 M11 38 H35 M11 45 H35 M11 52 H27"
              stroke="#4a555b"
              strokeWidth="2.2"
            />
          </svg>
        </button>
      ))}
    </div>
  );
}
