// View state of the watch workspace and the two live feeds it reads: the
// board items' positions (from the globe's own entities, the same lookup the
// board uses) and the asset candidates for the selected item.

import { useEffect, useState } from "react";
import * as Cesium from "cesium";
import { create } from "zustand";
import {
  useTargetBoard,
  type TargetEntry,
} from "../../../state/targetBoard.js";
import { boardLookup } from "../../pages/TargetBoard.js";
import { aircraftNear, satellitesOver, type Asset } from "./recommend.js";

export type Mode = "targets" | "rec" | "create" | "taskings";
export type Section =
  | "Overview"
  | "Details"
  | "Location"
  | "Intelligence"
  | "Collection plan"
  | "Tasking"
  | "Approvals"
  | "Assessment"
  | "Watch system"
  | "Comments"
  | "Activity"
  | "Requests"
  | "Re-collects";

interface Ui {
  mode: Mode;
  target: string | null;
  objOpen: boolean;
  section: Section;
  metrics: boolean;
  collapsed: boolean;
  strip: boolean;
  overlays: boolean;
  draftAsset: string | null;
  activeTask: string | null;
  toast: string | null;
  ganttAll: boolean;
  set: (p: Partial<Omit<Ui, "set">>) => void;
}

export const useWs = create<Ui>((set) => ({
  mode: "targets",
  target: null,
  objOpen: false,
  section: "Tasking",
  metrics: false,
  collapsed: false,
  strip: true,
  overlays: true,
  draftAsset: null,
  activeTask: null,
  toast: null,
  ganttAll: false,
  set: (p) => set(p),
}));

export interface Fix {
  lat: number;
  lon: number;
  name: string;
  layer: string | null;
}

/** Live position of every board entry, re-read every 2 s from the globe. */
export function useFixes(
  viewer: Cesium.Viewer | null | undefined,
): Map<string, Fix> {
  const entries = useTargetBoard((s) => s.entries);
  const [fixes, setFixes] = useState<Map<string, Fix>>(new Map());
  useEffect(() => {
    const read = (): void => {
      const m = new Map<string, Fix>();
      for (const e of entries) {
        const hit = boardLookup(viewer, e.entityId);
        const cart = hit?.ent.position?.getValue(
          viewer?.clock.currentTime ?? Cesium.JulianDate.now(),
        );
        if (!hit || !cart) continue;
        const g = Cesium.Cartographic.fromCartesian(cart);
        m.set(e.entityId, {
          lat: Cesium.Math.toDegrees(g.latitude),
          lon: Cesium.Math.toDegrees(g.longitude),
          name: hit.ent.name || e.label || e.entityId,
          layer: hit.layer,
        });
      }
      setFixes(m);
    };
    read();
    const t = setInterval(read, 2000);
    return () => clearInterval(t);
  }, [entries, viewer]);
  return fixes;
}

export function titleOf(e: TargetEntry, fix: Fix | undefined): string {
  const c = e.entityId.indexOf(":");
  return (
    fix?.name || e.label || (c >= 0 ? e.entityId.slice(c + 1) : e.entityId)
  );
}

export function kindOf(e: TargetEntry): string {
  const k = e.kind ?? e.entityId.split(":")[0] ?? "object";
  return k.charAt(0).toUpperCase() + k.slice(1);
}

interface Recs {
  key: string | null;
  air: Asset[];
  sat: Asset[];
  airAt: number;
  airErr: string | null;
  satErr: string | null;
  airBusy: boolean;
  satBusy: boolean;
}

export const useRecsStore = create<Recs>(() => ({
  key: null,
  air: [],
  sat: [],
  airAt: 0,
  airErr: null,
  satErr: null,
  airBusy: false,
  satBusy: false,
}));

/** Pull asset candidates for the item at `fix`: ADS-B every 15 s while
 *  `active`, satellites once per item. */
export function useRecs(
  targetId: string | null,
  fix: Fix | undefined,
  active: boolean,
): Recs & { refresh: () => void } {
  const recs = useRecsStore();
  const [tick, setTick] = useState(0);
  const lat = fix?.lat;
  const lon = fix?.lon;
  const has = lat !== undefined && lon !== undefined;

  useEffect(() => {
    if (!active || !targetId || !has) return;
    let live = true;
    const pull = (): void => {
      useRecsStore.setState({ airBusy: true });
      aircraftNear(lat, lon)
        .then((air) => {
          if (live)
            useRecsStore.setState({
              air,
              airAt: Date.now(),
              airErr: null,
              airBusy: false,
            });
        })
        .catch((e: unknown) => {
          if (live)
            useRecsStore.setState({
              airErr:
                e instanceof Error && e.message.startsWith("ADS-B")
                  ? e.message
                  : "ADS-B unreachable",
              airBusy: false,
            });
        });
    };
    pull();
    const t = setInterval(pull, 15000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // Position moves every poll; re-pull on item change or a manual refresh only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, targetId, has, tick]);

  useEffect(() => {
    if (!active || !targetId || !has) return;
    if (useRecsStore.getState().key === targetId) return;
    useRecsStore.setState({
      key: targetId,
      sat: [],
      satBusy: true,
      satErr: null,
    });
    satellitesOver(lat, lon)
      .then((sat) => {
        if (useRecsStore.getState().key === targetId)
          useRecsStore.setState({ sat, satBusy: false });
      })
      .catch((e: unknown) => {
        if (useRecsStore.getState().key === targetId)
          useRecsStore.setState({
            satErr:
              e instanceof Error && e.message.startsWith("Satellite")
                ? e.message
                : "Satellite elements unreachable",
            satBusy: false,
          });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, targetId, has]);

  return { ...recs, refresh: () => setTick((n) => n + 1) };
}

/** Wall clock that re-renders every second. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
