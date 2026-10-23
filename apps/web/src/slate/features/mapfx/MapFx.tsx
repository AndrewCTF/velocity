import { useEffect, useState } from "react";
import * as Cesium from "cesium";
import "./mapfx.css";
import { useSelection } from "../../../state/stores.js";
import { findEntity } from "../../../entity-panel/read.js";
import { destinationPoint, KN_TO_KMH } from "../../../globe/projection.js";
import {
  FAN_DEG,
  FAN_HOURS,
  RING_HOURS,
  RING_STYLE,
  useProjectFx,
  useRingFx,
  type LatLon,
} from "./store.js";

// Map effects drawn as SVG over the Cesium canvas, each world point projected
// through the live camera on every render (so they stay glued to the globe):
//   G17 selection ring (dashed white, the copy's 2.2 px) + red heat glows on
//       the live contacts inside it,
//   G26 reachable-range rings around a projected vessel (copy's eight blue
//       rings, radius = reported speed x hours),
//   G27 the course fan: a teal cone along the reported course to the +6 h
//       point, with the copy's dashed centre line and an end pin.
// Geometry from the copy: gotham/gotham/_build_features_a.py rings(), fans(),
// pin(); ring/glow from hero-object (_kit/highlight.py).

type XY = [number, number];

// The copy's red heat glow (hero-object highlight.py) as one sprite.
const GLOW = ((): HTMLCanvasElement | string => {
  if (typeof document === "undefined") return "";
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return c;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(209,58,70,.52)");
  r.addColorStop(0.58, "rgba(209,58,70,.2)");
  r.addColorStop(0.71, "rgba(209,58,70,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return c;
})();

function circle(c: LatLon, km: number, n = 72): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i <= n; i++)
    out.push(destinationPoint(c.lat, c.lon, (i / n) * 360, km));
  return out;
}

export function MapFx({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element | null {
  const ring = useRingFx((s) => s.ring);
  const proj = useProjectFx((s) => s.p);
  const drawn = useProjectFx((s) => s.drawn);
  const selected = useSelection((s) => s.selectedEntityId);
  // A projection belongs to its vessel: another selection clears it.
  useEffect(() => {
    if (proj && selected !== proj.id) useProjectFx.getState().set(null);
  }, [selected, proj]);
  const [frame, setFrame] = useState<{
    rings: { d: string; i: number }[];
    fan: { cone: string; line: string; pin: XY } | null;
  } | null>(null);

  // G17 ring and its contacts' glows are map entities, not SVG: an overlay
  // re-placed after each frame trailed the globe during a pan. Each glow takes
  // its contact's live position property, so it moves with the icon.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !ring) return;
    const ds = new Cesium.CustomDataSource("__slate_ring");
    const added = viewer.dataSources.add(ds);
    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(
          circle(ring.center, ring.km).flatMap((p) => [p.lon, p.lat]),
        ),
        width: 2.2,
        clampToGround: true,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString("#e4e9ec").withAlpha(0.9),
          dashLength: 10,
        }),
      },
    });
    for (const g of ring.glows) {
      const live = g.id ? findEntity(viewer, g.id) : null;
      ds.entities.add({
        position: live?.position ?? Cesium.Cartesian3.fromDegrees(g.lon, g.lat),
        billboard: {
          image: GLOW,
          width: 2400, // the copy's 1.2 km glow radius
          height: 2400,
          sizeInMeters: true,
          // Depth-tested, so always-on-top labels (the situation counter) stay
          // readable over a dense ring.
        },
      });
    }
    viewer.scene.requestRender();
    return () => {
      void added.then(() => {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      });
    };
  }, [viewer, ring]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !proj) {
      setFrame(null);
      return;
    }
    const scene = viewer.scene;
    const scratch = new Cesium.Cartesian2();
    const P = (p: LatLon): XY | null => {
      const c = Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
      // Behind the globe: hidden.
      if (
        Cesium.Cartesian3.dot(viewer.camera.positionWC, c) <=
        Cesium.Cartesian3.magnitudeSquared(c)
      )
        return null;
      const s = scene.cartesianToCanvasCoordinates(c, scratch);
      return s ? [s.x, s.y] : null;
    };
    const path = (pts: LatLon[], close: boolean): string => {
      const xy = pts.map(P);
      if (xy.some((v) => v === null)) return "";
      return (
        "M" +
        (xy as XY[])
          .map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`)
          .join(" L") +
        (close ? " Z" : "")
      );
    };
    const kmh = proj ? proj.speedKn * KN_TO_KMH : 0;
    const projRings =
      proj && kmh > 0 ? RING_HOURS.map((h) => circle(proj.fix, kmh * h)) : [];
    let fanTop: LatLon[] = [];
    let fanBot: LatLon[] = [];
    let fanLine: LatLon[] = [];
    if (proj && kmh > 0 && proj.cog !== null) {
      const N = 16;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const d = kmh * FAN_HOURS * t;
        const half = FAN_DEG * t ** 1.25;
        fanTop.push(
          destinationPoint(proj.fix.lat, proj.fix.lon, proj.cog - half, d),
        );
        fanBot.push(
          destinationPoint(proj.fix.lat, proj.fix.lon, proj.cog + half, d),
        );
        fanLine.push(destinationPoint(proj.fix.lat, proj.fix.lon, proj.cog, d));
      }
    } else {
      fanTop = fanBot = fanLine = [];
    }
    const update = (): void => {
      if (viewer.isDestroyed()) return;
      setFrame({
        rings: projRings.map((pts, i) => ({ d: path(pts, true), i })),
        fan:
          fanLine.length > 1
            ? {
                cone: path([...fanTop, ...[...fanBot].reverse()], true),
                line: path(fanLine, false),
                pin: P(fanLine[fanLine.length - 1]!) ?? [-99, -99],
              }
            : null,
      });
    };
    update();
    viewer.scene.requestRender();
    return viewer.scene.postRender.addEventListener(update);
  }, [viewer, proj]);

  if (!frame) return null;
  return (
    <div className="sl-mapfx" aria-hidden="true">
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", left: 0, top: 0 }}
      >
        <defs>
          <filter id="sl-fanblur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="16" />
          </filter>
          <linearGradient id="sl-fang" x1="0" x2="1">
            <stop offset="0" stopColor="#27d6b4" stopOpacity=".8" />
            <stop offset="1" stopColor="#1a9a96" stopOpacity=".42" />
          </linearGradient>
        </defs>
        {frame.rings
          .slice(0, drawn)
          .map(({ d, i }) =>
            d ? (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={i < 3 ? "#5b7cc0" : "#8fa8d8"}
                strokeWidth={RING_STYLE[i]?.[0] ?? 1}
                opacity={RING_STYLE[i]?.[1] ?? 0.4}
              />
            ) : null,
          )}
        {frame.fan && frame.fan.cone && drawn >= RING_HOURS.length && (
          <g>
            <path
              d={frame.fan.cone}
              fill="url(#sl-fang)"
              filter="url(#sl-fanblur)"
            />
            <path
              d={frame.fan.line}
              fill="none"
              stroke="#d9fff6"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <g transform={`translate(${frame.fan.pin[0]} ${frame.fan.pin[1]})`}>
              <path
                d="M0 22 C -4 14 -14 9 -14 -3 A14 14 0 1 1 14 -3 C 14 9 4 14 0 22 Z"
                fill="#e5484d"
                stroke="#fff"
                strokeWidth="1.6"
                transform="translate(0 -22)"
              />
              <rect
                x="-1.8"
                y="-34"
                width="3.6"
                height="10"
                rx="1.5"
                fill="#fff"
              />
              <circle cx="0" cy="-19" r="2" fill="#fff" />
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
