// Gaia map (gotham-014-068, D41-D48): sec_gaia() of _build_gotham_b.py. The
// builder's Esri World Imagery render becomes a mosaic of the app's own
// /tiles/sat tiles at the render's scale (3754.7 px per degree of longitude,
// its geo fit); the vessel glyphs on it are the app's live AIS markers for the
// box pull. Markers are the selected track's last fix and the searched place.
import { useState } from "react";
import { A, Hit, I, IS, T, Tc, frag, type N } from "./kit.js";
import { TRK, title } from "./data.js";
import { vesselStyle } from "../../../globe/adapters/styles.js";
import type { Ctx } from "./model.js";

const PX_PER_DEG = 3754.656311727277; // pb-gaia-clean.geo.json cx[0]
const MX0 = 231, MY0 = 3, MAPW = 922, MAPH = 588;
const wx = (lon: number, z: number): number => ((lon + 180) / 360) * 256 * 2 ** z;
const wy = (lat: number, z: number): number => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z;
};

export function Gaia({ c }: { c: Ctx }): JSX.Element {
  const W = 1153, H = 591;
  const [zoom, setZoom] = useState(0); // camera steps from the copy's 28 km height
  const [hide, setHide] = useState<string[]>([]);
  const sel = c.sel, place = c.place;
  const SELT = sel ? TRK(sel.mmsi) : "No track";
  const HAMS = place ? title(place.name).replace("Lpg", "LPG") : "No place";
  const ppd = PX_PER_DEG * 2 ** zoom;
  const z = Math.min(18, Math.max(3, Math.ceil(Math.log2((ppd * 360) / 256))));
  const tk = ppd / ((256 * 2 ** z) / 360); // figure px per tile px
  // centre: midway between the fix and the place (the builder's GCX, GCY)
  const pts = [sel ? [sel.v.lon, sel.v.lat] : null, place ? [place.lon, place.lat] : null].filter((p): p is number[] => !!p);
  const cxw = pts.length ? pts.reduce((a, p) => a + wx(p[0]!, z), 0) / pts.length : wx(55.48, z);
  const cyw = pts.length ? pts.reduce((a, p) => a + wy(p[1]!, z), 0) / pts.length : wy(25.48, z);
  const fig = (lon: number, lat: number): [number, number] => [MX0 + MAPW / 2 + (wx(lon, z) - cxw) * tk, MY0 + MAPH / 2 + (wy(lat, z) - cyw) * tk];
  const tiles: N[] = [];
  const tx0 = Math.floor((cxw - MAPW / 2 / tk) / 256), tx1 = Math.floor((cxw + MAPW / 2 / tk) / 256);
  const ty0 = Math.floor((cyw - MAPH / 2 / tk) / 256), ty1 = Math.floor((cyw + MAPH / 2 / tk) / 256);
  for (let tx = tx0; tx <= tx1; tx++)
    for (let ty = ty0; ty <= ty1; ty++)
      tiles.push(<img key={`${z}/${tx}/${ty}`} src={`/tiles/sat/${z}/${tx}/${ty}.jpg`} alt="" draggable={false}
        style={{ position: "absolute", left: MAPW / 2 + (tx * 256 - cxw) * tk, top: MAPH / 2 + (ty * 256 - cyw) * tk, width: 256 * tk + 0.5, height: 256 * tk + 0.5 }} />);
  const o: N[] = [A(0, 0, W, H, "background:#fefefe")];
  o.push(A(MX0, MY0, MAPW, MAPH, "background:#0a1220;overflow:hidden", tiles));
  // the live AIS markers on the base (the render's own vessel glyphs)
  for (const v of c.box) {
    const [x, y] = fig(v.lon, v.lat);
    if (x < MX0 + 4 || x > MX0 + MAPW - 4 || y < MY0 + 4 || y > MY0 + MAPH - 4) continue;
    const st = vesselStyle(v as unknown as Record<string, unknown>);
    const s = 18 * st.scale;
    o.push(<img src={st.imageUri} alt="" style={{ left: x - s / 2, top: y - s / 2, width: s, height: s, transform: `rotate(${st.rotationRad}rad)` }} />);
  }
  o.push(A(0, 0, W, 3, "background:#0a9860"));
  // left panel (D41)
  o.push(A(0, 3, 231, 588, "background:#fefefe"), A(0, 3, 231, 31, "background:#363e48"));
  o.push(A(0, 3, 77, 31, "background:#2c333c"), I("layers", 19, 19, 12, "#6aa6e8"), T(27, 19, "Map layers", "#f1f4f5", 9.6), A(8, 31, 62, 2, "background:#2d72d2"));
  o.push(I("database", 99, 19, 11, "#c3ccd2"), T(109, 19, "Data sources", "#c3ccd2", 9.6), I("wrench", 189, 19, 11, "#c3ccd2"), T(198, 19, "Tools", "#c3ccd2", 9.6));
  o.push(Hit(88, 6, 90, 26, "Data sources: the Browser", () => c.go("browser")), Hit(180, 6, 48, 26, "Tools: the graph document", () => c.go("menubar")));
  o.push(I("filter", 14, 49, 12, "#394450"), T(26, 49, "Find...", "#7a8592", 9.8), Hit(6, 40, 220, 18, "Find: the Browser", () => c.go("browser")));
  o.push(A(0, 61, 231, 1, "background:#e4e7eb"));
  o.push(I("caret-down", 10, 73, 9, "#394450"), A(19, 66, 14, 14, "background:#ece6fe;border-radius:2px"), I("layers", 26, 73, 9, "#7b61c9"), T(37, 73, SELT, "#1c2127", 9.8, 400, "font-weight:600"));
  const rows: [number, string, string][] = [[93, "Last reported position", "fix"], [113, HAMS, "place"]];
  for (const [y, tx, key] of rows) {
    const on = !hide.includes(key);
    o.push(A(30, y - 6, 12, 12, "border:1.5px solid #2d72d2;border-radius:6px"), on ? A(34, y - 2, 4, 4, "background:#2d72d2;border-radius:2px") : null, T(47, y, tx, "#1c2127", 9.8));
    o.push(Hit(26, y - 9, 196, 18, `${on ? "Hide" : "Show"} ${tx}`, () => setHide(on ? [...hide, key] : hide.filter((k) => k !== key))));
  }
  o.push(A(231, 135, 13, 31, "background:#fefefe;border:1px solid #cfd4da;border-radius:0 3px 3px 0"), I("chevron-left", 238, 151, 9, "#394450"));
  o.push(Hit(231, 135, 13, 31, "Collapse: the Object Explorer", () => c.go("explorer")));
  // basemap footer (D42) and status strip (D43)
  const [tx, ty] = place ? [wx(place.lon, z), wy(place.lat, z)] : [cxw, cyw];
  const th = `background:url(/tiles/sat/${z}/${Math.floor(tx / 256)}/${Math.floor(ty / 256)}.jpg) ${(-((tx % 256) - 11)).toFixed(1)}px ${(-((ty % 256) - 7)).toFixed(1)}px/256px 256px;border-radius:2px`;
  const nOver = 2 - hide.length;
  o.push(A(0, 541, 231, 28, "background:#eeeef2"), A(6, 548, 22, 14, th), T(35, 555, "Esri World Imagery", "#1c2127", 9.6, 400, "font-weight:600"), T(150, 555, `${nOver} overlay${nOver === 1 ? "" : "s"}`, "#7a8592", 9));
  o.push(A(0, 569, 231, 22, "background:#363c44"), T(10, 580, c.boxRes?.ok === false ? "Offline" : "Online", "#f1f4f5", 9.4, 400, "font-weight:600"), T(41, 580, "View", "#6aa6e8", 9.4), T(108, 580, `${nOver} interactive element${nOver === 1 ? "" : "s"}`, "#8f99a8", 8), I("refresh", 200, 580, 11, "#3fb27f"), I("lightning", 220, 580, 11, "#aab4bc"));
  o.push(Hit(38, 572, 26, 16, "View: the Object Explorer", () => c.go("explorer")), Hit(192, 572, 16, 16, "Refresh", undefined, "The box pull refreshes every minute"), Hit(212, 572, 16, 16, "Lightning", undefined, "No quick actions on this map"));
  // floating draw toolbar (D44) and find (D45)
  const sh = "box-shadow:0 1px 4px rgba(0,0,0,.35)";
  o.push(A(235, 8, 222, 40, `background:#fefefe;border-radius:3px;${sh}`), T(241, 17, SELT, "#7a8592", 8.4), I("caret-down", 290, 17, 7, "#7a8592"), T(245, 35, "Symbol", "#1c2127", 9.6), I("caret-down", 281, 36, 7, "#394450"));
  for (const xc of [304, 328, 353, 377, 402, 426]) o.push(Hit(xc - 10, 25, 20, 20, "Draw", undefined, "Drawing lives on the console's map toolbar"));
  ([[304, "record"], [328, "more"], [353, "polygon-filter"], [377, "widget"], [402, "new-object"], [426, "widget-header"]] as const).forEach(([xc, ic]) => o.push(I(ic, xc, 35, 12, "#394450")));
  o.push(A(441, 12, 1, 32, "background:#e4e7eb"), I("chevron-left", 449, 27, 9, "#394450"));
  o.push(A(235, 52, 222, 19, `background:#fefefe;border-radius:3px;${sh}`), I("search", 243, 61, 11, "#394450"), T(255, 61, "Find objects and locations on the map", "#394450", 9.2), I("chevron-left", 448, 61, 9, "#394450"));
  o.push(Hit(235, 52, 222, 19, "Find objects and locations: the Browser", () => c.go("browser")));
  // markers (D46)
  const mk: [number[] | null, string, string, () => void][] = [
    [place && !hide.includes("place") ? [place.lon, place.lat] : null, "map-marker", `${HAMS}: the Browser`, () => c.go("browser")],
    [sel && !hide.includes("fix") ? [sel.v.lon, sel.v.lat] : null, "ship", `${SELT}: the custom object view`, () => c.go("cov")],
  ];
  for (const [p, ic, label, fn] of mk) {
    if (!p) continue;
    const [x, y] = fig(p[0]!, p[1]!);
    o.push(A(x - 11, y - 11, 22, 22, "background:#fff;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.5)"), ic === "ship" ? IS("ship", x, y, 14, "#2d72d2") : I(ic, x, y, 13, "#2d72d2"), Hit(x - 11, y - 11, 22, 22, label, fn));
  }
  // left tool column, compass, scale (D47)
  o.push(A(235, 485, 19, 78, "background:#fefefe;border-radius:2px;box-shadow:0 1px 3px rgba(0,0,0,.4)"));
  for (const [yc, ic, col] of [[495, "th", "#394450"], [517, "eraser", "#394450"], [538, "send-to-map", "#394450"], [563, "locate", "#b3bac3"]] as const) o.push(I(ic, 245, yc, 11, col));
  o.push(Hit(235, 485, 19, 20, "Grid: the Object Explorer", () => c.go("explorer")), Hit(235, 507, 19, 20, "Erase", undefined, "Nothing is drawn on this map"),
    Hit(235, 528, 19, 20, "Reset the camera", zoom ? () => setZoom(0) : undefined, "The camera is at its default height"), Hit(235, 553, 19, 20, "Locate", undefined, "The browser's own position is not used"));
  o.push(A(263, 540, 28, 28, "background:#fefefe;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.4)"), Tc(277, 545, "N", "#d33", 6.5, 12, "font-weight:700"), A(276, 548, 2, 14, "background:#555"));
  const pxkm = ppd / (111.32 * Math.cos((((place ?? sel?.v)?.lat ?? 25.48) * Math.PI) / 180));
  const KM = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].filter((k) => k * pxkm <= 200).pop() ?? 0.1;
  const BAR = KM * pxkm;
  o.push(T(237, 581, `${KM}km`, "#f1f4f5", 8.6, 400, "text-shadow:0 0 3px #000"), A(254, 580, BAR, 2, "background:#f1f4f5;box-shadow:0 0 2px #000"), A(254, 576, 2, 7, "background:#f1f4f5"), A(254 + BAR, 576, 2, 7, "background:#f1f4f5"));
  // right controls (D48)
  for (const [yc, ic, label, fn] of [[18, "notifications", "Notifications: the inbox", () => c.go("inbox")], [62, "pulse", "Activity: chat", () => c.go("chat")]] as const)
    o.push(A(1126, yc - 11, 22, 22, "background:#fefefe;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,.4)"), I(ic, 1137, yc, 12, "#394450"), Hit(1126, yc - 11, 22, 22, label, fn));
  o.push(A(1126, 30, 22, 22, "background:#a7aeb8;opacity:.6;border-radius:3px"));
  o.push(A(1128, 452, 21, 44, "background:#fefefe;border-radius:3px"), I("camera", 1139, 462, 11, "#394450"), I("th-list", 1139, 484, 11, "#394450"));
  o.push(Hit(1128, 452, 21, 22, "Camera: the video", () => c.go("video")), Hit(1128, 474, 21, 22, "List: the Object Explorer", () => c.go("explorer")));
  for (const [yc, ic, dz] of [[520, "plus", 1], [541, "minus", -1]] as const)
    o.push(A(1128, yc - 11, 21, 22, "background:#fefefe;border-radius:3px"), I(ic, 1139, yc, 12, "#394450"), Hit(1128, yc - 11, 21, 22, dz > 0 ? "Zoom in" : "Zoom out", Math.abs(zoom + dz) <= 4 ? () => setZoom(zoom + dz) : undefined, "At the zoom limit"));
  o.push(A(1040, 565, 110, 23, "background:#fefefe;border-radius:3px"));
  const br: [number, string, string, (() => void) | undefined, string][] = [
    [1051, "airplane", "Aircraft", undefined, "Aircraft are on the console's globe"], [1073, "th", "Grid: the Object Explorer", () => c.go("explorer"), ""],
    [1095, "time", "Timeline", () => c.go("timeline"), ""], [1117, "zoom-to-fit", "Zoom to fit", zoom ? () => setZoom(0) : undefined, "The camera is at its default height"], [1140, "antenna", "Feeds: the graph document", () => c.go("menubar"), ""],
  ];
  for (const [xc, ic, label, fn, why] of br) o.push(I(ic, xc, 577, 12, "#394450"), Hit(xc - 10, 567, 20, 20, label, fn, why));
  return frag(o);
}
