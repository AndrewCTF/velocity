import { useState } from "react";
import * as Cesium from "cesium";
import { apiFetch } from "../transport/http.js";
import { useSituations } from "./situationStore.js";
import { useDetected } from "./detectedStore.js";
import { useSelection } from "../state/stores.js";
import { flyToPosition } from "../globe/camera.js";
import { useAppView } from "../state/appView.js";
import { sensorOf } from "../registry/sensorSats.js";
import { passesOverAoi, type Pass } from "../sim/tasking.js";
import {
  SectionLabel,
  Btn,
  Badge,
  KV,
  KVRow,
  MicroLabel,
} from "../shell/instruments.js";

// "Detected in view": the densest cluster of hulls at anchor inside the camera
// view (GET /api/situations/detect), the next Sentinel-1 pass over it, and a button to
// persist it as a Situation. Promoted from the Gotham situation copy
// (gotham/gotham/_situation_data.py). Nothing here is saved until the analyst
// opens it; the footprint highlight is globe/DetectedLayer.ts, fed by detectedStore.

export interface DetectMember {
  id: string;
  mmsi: number | null;
  name: string | null;
  shipType: number | string | null;
  t: number | null;
  sanctioned: boolean;
}

export interface Detection {
  ok: true;
  lon: number;
  lat: number;
  r_km: number;
  n: number;
  sanctioned: number;
  members: DetectMember[];
  sanctions_lists: string[];
  sanctions_failed: string[];
}

interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  TLE_LINE1?: string;
  TLE_LINE2?: string;
}

// SAR images off-nadir, so a pass is useful only well above the horizon.
const SAR_MIN_ELEV_DEG = 30;
const SAR_WINDOW_MS = 48 * 3600 * 1000;

/** Earliest Sentinel-1 pass over (lat, lon). */
export function nextSarPass(
  items: OmmRecord[],
  lat: number,
  lon: number,
  nowMs: number,
): Pass | null {
  let best: Pass | null = null;
  for (const it of items) {
    if (!it.TLE_LINE1 || !it.TLE_LINE2) continue;
    const name = (it.OBJECT_NAME ?? "").trim();
    const norad = Number(it.NORAD_CAT_ID);
    // Sentinel-1 only: the one SAR source this console can pull (CDSE
    // S1_GRD_VV), and 3 hulls keeps the SGP4 sweep cheap on the main thread.
    if (
      sensorOf(name, isFinite(norad) ? norad : undefined)?.operator !==
      "ESA Copernicus"
    )
      continue;
    const p = passesOverAoi(
      it.TLE_LINE1,
      it.TLE_LINE2,
      { lat, lon },
      { startMs: nowMs, endMs: nowMs + SAR_WINDOW_MS },
      30,
      SAR_MIN_ELEV_DEG,
      name,
    )[0];
    if (p && (!best || p.startMs < best.startMs)) best = p;
  }
  return best;
}

function viewBbox(viewer: Cesium.Viewer): string | null {
  const r = viewer.camera.computeViewRectangle();
  if (!r) return null;
  const d = Cesium.Math.toDegrees;
  const w = d(r.west);
  const e = d(r.east);
  // A view across the antimeridian: shortcut, scan the whole longitude band.
  return w < e
    ? [w, d(r.south), e, d(r.north)].map((v) => v.toFixed(4)).join(",")
    : [-180, d(r.south), 180, d(r.north)].map((v) => v.toFixed(4)).join(",");
}

const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ") + "Z";

export function DetectedSituation({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element {
  const det = useDetected((s) => s.det);
  const sar = useDetected((s) => s.sar);
  const put = useDetected((s) => s.set);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scan = async (): Promise<void> => {
    if (!viewer) return;
    const bbox = viewBbox(viewer);
    if (!bbox) {
      setMsg("Tilt the camera down so the view covers the globe, then scan.");
      return;
    }
    setBusy(true);
    setMsg(null);
    put({ det: null, sar: null });
    try {
      const r = await apiFetch(
        `/api/situations/detect?bbox=${encodeURIComponent(bbox)}`,
      );
      if (!r.ok) {
        setMsg(`Detection unavailable (HTTP ${r.status})`);
        return;
      }
      const j = (await r.json()) as Detection | { ok: false; reason: string };
      if (!j.ok) {
        setMsg(j.reason);
        return;
      }
      put({ det: j });
      const g = await apiFetch("/api/space/gp?group=active&limit=20000");
      if (!g.ok) {
        put({ sar: "err" });
        return;
      }
      const items = ((await g.json()) as { items?: OmmRecord[] }).items ?? [];
      put({ sar: nextSarPass(items, j.lat, j.lon, Date.now()) ?? "none" });
    } catch {
      setMsg("Detection unavailable (network error)");
    } finally {
      setBusy(false);
    }
  };

  const openAsSituation = async (): Promise<void> => {
    if (!det) return;
    const st = useSituations.getState();
    const id = await st.create({
      name: `Anchorage · ${det.lat.toFixed(2)}, ${det.lon.toFixed(2)}`,
      severity: det.sanctioned > 0 ? "high" : "med",
      centroid: { lat: det.lat, lon: det.lon },
      radius_km: det.r_km,
      summary: `${det.n} vessels at anchor within ${det.r_km} km. ${det.sanctioned} matched a sanctions list on IMO or MMSI.`,
    });
    // Link the identifier-backed hits first, then the rest, capped.
    const order = [...det.members].sort(
      (a, b) => Number(b.sanctioned) - Number(a.sanctioned),
    );
    for (const m of order.slice(0, 50)) await st.linkChild(id, m.id);
    useSelection.getState().select(id);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionLabel title="Detected in view" className="flex-1" />
        <Btn
          size="sm"
          tone="accent"
          disabled={!viewer || busy}
          onClick={() => void scan()}
        >
          {busy ? "scanning…" : "Scan map view"}
        </Btn>
      </div>
      {msg && <p className="text-[11px] text-txt-3">{msg}</p>}
      {det && (
        <div className="rounded-sm border border-line bg-bg-2 p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <Badge tone={det.sanctioned > 0 ? "alert" : "accent"}>
              {det.sanctioned > 0 ? "sanctions hit" : "anchorage"}
            </Badge>
            <span className="text-[12px] text-txt-0 flex-1">
              {det.n} vessels at anchor
            </span>
          </div>
          <KV>
            <KVRow
              k="Centre"
              v={`${det.lat.toFixed(3)}, ${det.lon.toFixed(3)}`}
            />
            <KVRow k="Radius" v={`${det.r_km} km`} />
            <KVRow
              k="Sanctions"
              v={`${det.sanctioned} of ${det.n}`}
              warn={det.sanctioned > 0}
              title={`Joined on IMO or MMSI against ${det.sanctions_lists.join(", ") || "no list"}${det.sanctions_failed.length ? `. Not loaded: ${det.sanctions_failed.join(", ")}` : ""}`}
            />
            <KVRow
              k="Next Sentinel-1 pass"
              v={
                sar === null
                  ? "…"
                  : sar === "err"
                    ? "Catalogue unavailable"
                    : sar === "none"
                      ? "None in 48 h"
                      : `${sar.satName ?? "SAR"} · ${utc(sar.startMs)}`
              }
              title={`Earliest Sentinel-1 A/C/D pass at ${SAR_MIN_ELEV_DEG}° elevation or more, SGP4 on the CelesTrak TLE.`}
            />
          </KV>
          <ul className="max-h-40 overflow-auto space-y-0.5">
            {[...det.members]
              .sort((a, b) => Number(b.sanctioned) - Number(a.sanctioned))
              .map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => useSelection.getState().select(m.id)}
                    className="w-full flex items-center gap-2 text-left px-1 py-0.5 rounded-sm hover:bg-hover"
                  >
                    <span
                      className={`text-[11px] truncate flex-1 ${m.sanctioned ? "text-alert-fg" : "text-txt-1"}`}
                    >
                      {m.name?.trim() || "—"}
                    </span>
                    <span className="mono text-[11px] text-txt-3">
                      {m.mmsi ?? "—"}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          <div className="flex gap-2">
            <Btn
              size="sm"
              onClick={() => {
                // Case files cover the globe; flying is only visible on the map.
                useAppView.getState().setApp("map");
                if (viewer)
                  flyToPosition(viewer, det.lon, det.lat, 120_000, 1.0);
              }}
            >
              Fly to
            </Btn>
            <Btn size="sm" tone="accent" onClick={() => void openAsSituation()}>
              Open as situation
            </Btn>
          </div>
          <MicroLabel>stationary together now · no claim about why</MicroLabel>
        </div>
      )}
    </div>
  );
}
