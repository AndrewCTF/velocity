// Map: the app's own /tiles/sat imagery at the copy's scale (3754.7 px per
// degree of longitude at the default camera, which is about 28 km tall), with
// the live AIS markers for the box pull. Markers are the selected track's last
// fix and the searched place. The map fills its pane and is drawn in CSS pixels.
import { useLayoutEffect, useRef, useState } from "react";
import { Btn, Ic, Sat, Ship } from "./kit.js";
import { TRK, title } from "./data.js";
import { mosaic, project } from "./plate.js";
import { vesselStyle } from "../../../globe/adapters/styles.js";
import type { Ctx } from "./model.js";

const PX_PER_DEG = 3754.656311727277;

/** Zoom steps, tile level and the screen pixels one tile pixel covers. */
export function camera(zoom: number): { ppd: number; z: number; tk: number } {
  const ppd = PX_PER_DEG * 2 ** zoom;
  const z = Math.min(18, Math.max(3, Math.ceil(Math.log2((ppd * 360) / 256))));
  return { ppd, z, tk: ppd / ((256 * 2 ** z) / 360) };
}

export function Gaia({ c }: { c: Ctx }): JSX.Element {
  const [zoom, setZoom] = useState(0); // camera steps from the default height
  const [hide, setHide] = useState<string[]>([]);
  const pane = useRef<HTMLDivElement>(null);
  const [sz, setSz] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const fit = (): void => setSz({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sel = c.sel,
    place = c.place;
  const selT = sel ? TRK(sel.mmsi) : "No track";
  const hams = place ? title(place.name).replace("Lpg", "LPG") : "No place";
  const { ppd, z, tk } = camera(zoom);
  // centre: midway between the fix and the place
  const pts = [
    sel ? [sel.v.lon, sel.v.lat] : null,
    place ? [place.lon, place.lat] : null,
  ].filter((p): p is number[] => !!p);
  const cLon = pts.length
    ? pts.reduce((a, p) => a + p[0]!, 0) / pts.length
    : 55.48;
  const cLat = pts.length
    ? pts.reduce((a, p) => a + p[1]!, 0) / pts.length
    : 25.48;
  const at = (lon: number, lat: number): [number, number] => {
    const [x, y] = project(cLon, cLat, z, lon, lat);
    return [x * tk, y * tk];
  };
  const inView = ([x, y]: [number, number], m = 4): boolean =>
    Math.abs(x) <= sz.w / 2 - m && Math.abs(y) <= sz.h / 2 - m;
  const pxkm =
    ppd /
    (111.32 * Math.cos((((place ?? sel?.v)?.lat ?? 25.48) * Math.PI) / 180));
  const KM =
    [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]
      .filter((k) => k * pxkm <= 200)
      .pop() ?? 0.1;
  const nOver = 2 - hide.length;
  const rows: [string, string][] = [
    ["fix", "Last reported position"],
    ["place", hams],
  ];
  const marks: [number[] | null, string, string, () => void][] = [
    [
      place && !hide.includes("place") ? [place.lon, place.lat] : null,
      "map-marker",
      `${hams}: the Browser`,
      () => c.go("browser"),
    ],
    [
      sel && !hide.includes("fix") ? [sel.v.lon, sel.v.lat] : null,
      "ship",
      `${selT}: the custom object view`,
      () => c.go("cov"),
    ],
  ];
  return (
    <div className="px-pg pxm">
      <aside className="px-pane l pxm-side" aria-label="Map layers">
        <div className="px-ph">
          <Ic n="layers" />
          <h2>Map layers</h2>
        </div>
        <div className="pxm-pad">
          <Btn
            label="Find: the Browser"
            icon="filter"
            onClick={() => c.go("browser")}
            className="pxm-wide"
          >
            Find...
          </Btn>
        </div>
        <div className="px-sect">
          <Ic n="layers" s={12} /> {selT}
        </div>
        <ul>
          {rows.map(([key, tx]) => {
            const on = !hide.includes(key);
            return (
              <li key={key}>
                <button
                  type="button"
                  className="px-row"
                  aria-label={`${on ? "Hide" : "Show"} ${tx}`}
                  title={`${on ? "Hide" : "Show"} ${tx}`}
                  aria-pressed={on}
                  onClick={() =>
                    setHide(on ? [...hide, key] : hide.filter((k) => k !== key))
                  }
                >
                  <Ic n={on ? "tick-circle" : "circle"} />
                  {tx}
                </button>
              </li>
            );
          })}
        </ul>
        <span className="px-gap" />
        <div className="pxm-base">
          <span className="px-thumb">
            <Sat
              lon={place?.lon ?? cLon}
              lat={place?.lat ?? cLat}
              z={13}
              w={64}
              h={64}
            />
          </span>
          <b>Esri World Imagery</b>
          <span className="px-mu">
            {nOver} overlay{nOver === 1 ? "" : "s"}
          </span>
        </div>
        <div className="pxm-status">
          <b>{c.boxRes?.ok === false ? "Offline" : "Online"}</b>
          <span className="px-mu">
            {nOver} interactive element{nOver === 1 ? "" : "s"}
          </span>
        </div>
      </aside>
      <div className="pxm-map" ref={pane}>
        {sz.w > 0 ? (
          <svg
            className="px-sat"
            viewBox={`${-sz.w / 2} ${-sz.h / 2} ${sz.w} ${sz.h}`}
            role="img"
            aria-label="Satellite map with live AIS markers"
          >
            <rect
              x={-sz.w / 2}
              y={-sz.h / 2}
              width={sz.w}
              height={sz.h}
              fill="#0a1220"
            />
            {mosaic(cLon, cLat, z, sz.w / tk, sz.h / tk).map((t) => (
              <image
                key={t.key}
                href={t.url}
                x={t.x * tk}
                y={t.y * tk}
                width={256 * tk + 0.5}
                height={256 * tk + 0.5}
              />
            ))}
            {c.box.map((v) => {
              const p = at(v.lon, v.lat);
              if (!inView(p)) return null;
              const st = vesselStyle(v as unknown as Record<string, unknown>);
              const s = 18 * st.scale;
              return (
                <image
                  key={v.mmsi}
                  href={st.imageUri}
                  x={p[0] - s / 2}
                  y={p[1] - s / 2}
                  width={s}
                  height={s}
                  transform={`rotate(${(st.rotationRad * 180) / Math.PI} ${p[0]} ${p[1]})`}
                />
              );
            })}
          </svg>
        ) : null}
        {sz.w > 0
          ? marks.map(([p, ic, label, fn]) => {
              if (!p) return null;
              const [x, y] = at(p[0]!, p[1]!);
              if (!inView([x, y], 12)) return null;
              return (
                <button
                  key={label}
                  type="button"
                  className="pxm-mk"
                  style={{ left: sz.w / 2 + x, top: sz.h / 2 + y }}
                  aria-label={label}
                  title={label}
                  onClick={fn}
                >
                  {ic === "ship" ? <Ship s={14} /> : <Ic n={ic} s={14} />}
                </button>
              );
            })
          : null}
        <div className="pxm-tools">
          <Btn
            label="Find objects and locations: the Browser"
            icon="search"
            onClick={() => c.go("browser")}
          >
            Find objects and locations
          </Btn>
        </div>
        <div className="pxm-zoom">
          <Btn
            sq
            label="Zoom in"
            icon="plus"
            onClick={
              Math.abs(zoom + 1) <= 4 ? () => setZoom(zoom + 1) : undefined
            }
            why="At the zoom limit"
          />
          <Btn
            sq
            label="Zoom out"
            icon="minus"
            onClick={
              Math.abs(zoom - 1) <= 4 ? () => setZoom(zoom - 1) : undefined
            }
            why="At the zoom limit"
          />
          <Btn
            sq
            label="Reset the camera"
            icon="zoom-to-fit"
            onClick={zoom ? () => setZoom(0) : undefined}
            why="The camera is at its default height"
          />
        </div>
        <div className="pxm-scale" aria-label={`Scale ${KM} km`}>
          <span>{KM} km</span>
          <i style={{ width: KM * pxkm }} />
        </div>
      </div>
    </div>
  );
}
