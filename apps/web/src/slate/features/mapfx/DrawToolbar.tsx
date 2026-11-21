import { useEffect, useState } from "react";
import * as Cesium from "cesium";
import { BpIcon } from "../../../shell/BpIcon.js";
import { getDrawController } from "../../../globe/draw.js";
import { useMapTools } from "../../../globe/mapTools.js";
import "./drawToolbar.css";

// DrawToolbar: D67 "Compact toolbar with the icon-only draw-tool group
// (polygon, lasso, rectangle, circle, line, point)". Icon-only strip that
// mounts beside MainToolbar when the Draw tool is active; each icon arms the
// matching DrawController op. Reachable: Data tab → Draw in MainToolbar.

type ToolId = "polygon" | "lasso" | "rect" | "circle" | "line" | "point";

const TOOLS: ReadonlyArray<{
  id: ToolId;
  icon: string;
  label: string;
  hint: string;
}> = [
  { id: "polygon", icon: "polygon-filter", label: "Polygon", hint: "Click vertices, right-click to close the ring" },
  { id: "lasso", icon: "draw", label: "Lasso", hint: "Freehand polygon (polyline, right-click to close)" },
  { id: "rect", icon: "square", label: "Rectangle", hint: "Click one corner, move, click the opposite corner" },
  { id: "circle", icon: "circle", label: "Circle", hint: "Click the centre, move to size, click to commit" },
  { id: "line", icon: "more", label: "Line", hint: "Click points for a polyline, right-click to finish" },
  { id: "point", icon: "map-marker", label: "Point", hint: "Click the map to place a point" },
];

export function DrawToolbar({
  viewer,
  active,
}: {
  viewer: Cesium.Viewer | null;
  active?: ToolId | null;
}): React.JSX.Element {
  const [current, setCurrent] = useState<ToolId | null>(active ?? "polygon");

  useEffect(() => {
    if (active) setCurrent(active);
  }, [active]);

  const activate = (id: ToolId): void => {
    setCurrent(id);
    const draw = getDrawController();
    if (!draw) return;
    // Clear the previous op; the copy keeps one tool armed at a time.
    draw.cancel();
    if (id === "polygon") {
      draw.drawPolygon((ring) => {
        if (ring.length > 2) useMapTools.getState().setArea({ north: 0, south: 0, east: 0, west: 0, areaKm2: 0, center: ring[0] as { lat: number; lon: number }, radiusKm: 0 });
      });
    } else if (id === "lasso") {
      draw.drawPolyline((verts) => {
        if (verts.length > 1) {
          useMapTools.getState().setMeasure({ distanceKm: 0, points: verts.length, live: false });
        }
      });
    } else if (id === "rect") {
      draw.drawRect((a, b) => {
        useMapTools.getState().setArea({ north: Math.max(a.lat, b.lat), south: Math.min(a.lat, b.lat), east: Math.max(a.lon, b.lon), west: Math.min(a.lon, b.lon), areaKm2: 0, center: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }, radiusKm: 0 });
      });
    } else if (id === "circle") {
      draw.drawCircle((center, radiusKm) => {
        useMapTools.getState().setArea({ north: center.lat, south: center.lat, east: center.lon, west: center.lon, areaKm2: 0, center, radiusKm });
      });
    } else if (id === "line") {
      draw.drawPolyline((verts) => {
        useMapTools.getState().setMeasure({ distanceKm: 0, points: verts.length, live: false });
      });
    } else {
      draw.placePoint((p) => {
        useMapTools.getState().setMeasure({ distanceKm: 0, points: 1, live: false });
        void p;
      });
    }
    void viewer;
  };

  return (
    <div
      className="mv-draw-toolbar"
      role="toolbar"
      aria-label="Draw tools"
      data-testid="d67-toolbar"
    >
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`mvdt-btn${current === t.id ? " is-active" : ""}`}
          aria-pressed={current === t.id}
          aria-label={t.label}
          title={`${t.label} · ${t.hint}`}
          onClick={() => activate(t.id)}
        >
          <BpIcon name={t.icon} size={17} />
        </button>
      ))}
    </div>
  );
}
