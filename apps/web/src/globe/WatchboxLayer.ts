import * as Cesium from 'cesium';
import type { Alert } from '@osint/shared';
import { useWatchboxes, type Watchbox } from '../watchbox/watchboxStore.js';
import { useAlerts } from '../state/stores.js';
import { haversineKm } from './draw.js';

// Renders watchbox AOIs (amber rings) and runs a client-side enter/exit/loiter
// evaluator every 2 s against live aircraft/vessel/sim entities, pushing a real
// Alert into useAlerts (so triggers show in the Alerts rail + ticker).

const AOI = Cesium.Color.fromCssColorString('#f5a524');
const DWELL_MS = 45_000; // continuous-inside time before a loiter fires
const KINDS = ['aircraft:', 'ais:', 'vessel:', 'sim:'];

export function installWatchboxes(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__watchbox');
  void viewer.dataSources.add(ds);

  const inside = new Map<string, Set<string>>(); // wbId → entity ids currently inside
  const since = new Map<string, Map<string, number>>(); // wbId → entityId → first-inside ms
  const loiterFired = new Map<string, Set<string>>();
  const baselined = new Set<string>();

  const addAoi = (w: Watchbox): void => {
    ds.entities.add({
      id: `wb:${w.id}`,
      position: Cesium.Cartesian3.fromDegrees(w.center.lon, w.center.lat),
      ellipse: {
        semiMajorAxis: w.radiusKm * 1000,
        semiMinorAxis: w.radiusKm * 1000,
        material: AOI.withAlpha(0.06),
        outline: true,
        outlineColor: AOI,
        outlineWidth: 2,
        height: 0,
      },
      label: {
        text: `⊙ ${w.label} · ${w.rule.toUpperCase()}`,
        font: '600 10px "IBM Plex Mono", monospace',
        fillColor: AOI,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.75),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        pixelOffset: new Cesium.Cartesian2(0, -8),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  };

  const rebuild = (): void => {
    if (viewer.isDestroyed()) return;
    ds.entities.removeAll();
    for (const w of useWatchboxes.getState().watchboxes) addAoi(w);
    viewer.scene.requestRender();
  };

  const fire = (
    rule: string,
    w: Watchbox,
    entId: string,
    label: string,
    lon: number,
    lat: number,
    t: number,
  ): void => {
    const a: Alert = {
      id: `watchbox:${w.id}:${entId}:${rule}:${t}`,
      ruleId: `watchbox_${rule}`,
      severity: rule === 'loiter' ? 'high' : 'medium',
      t,
      geom: { type: 'Point', coordinates: [lon, lat] },
      confidence: 1,
      message: `${label} ${rule.toUpperCase()} ${w.label}`,
      contributingObservations: entId ? [entId] : [],
    };
    useAlerts.getState().push(a);
  };

  const entityLatLon = (e: Cesium.Entity): { lat: number; lon: number } | null => {
    const p = e.position?.getValue(viewer.clock.currentTime);
    if (!p) return null;
    const c = Cesium.Cartographic.fromCartesian(p);
    return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
  };

  const evaluate = (): void => {
    const wbs = useWatchboxes.getState().watchboxes;
    if (wbs.length === 0) return;
    const now = Date.now();
    // Gather candidate entities once per tick.
    const ents: Array<{ id: string; label: string; lat: number; lon: number }> = [];
    const seen = new Set<string>(); // dedup ids that appear in >1 data source (union feeds)
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const d = viewer.dataSources.get(i);
      if (d.name.startsWith('__')) continue;
      for (const e of d.entities.values) {
        const id = String(e.id);
        if (!KINDS.some((k) => id.startsWith(k))) continue;
        if (seen.has(id)) continue;
        const ll = entityLatLon(e);
        if (!ll) continue;
        seen.add(id);
        const lbl =
          e.label?.text?.getValue?.(viewer.clock.currentTime) ?? (e.name || id);
        ents.push({ id, label: String(lbl), lat: ll.lat, lon: ll.lon });
      }
    }
    for (const w of wbs) {
      const cur = new Set<string>();
      const sinceW = since.get(w.id) ?? new Map<string, number>();
      since.set(w.id, sinceW);
      const firedW = loiterFired.get(w.id) ?? new Set<string>();
      loiterFired.set(w.id, firedW);
      const prev = inside.get(w.id) ?? new Set<string>();
      const isBaselined = baselined.has(w.id);
      for (const en of ents) {
        if (haversineKm(w.center, en) > w.radiusKm) continue;
        cur.add(en.id);
        if (!sinceW.has(en.id)) sinceW.set(en.id, now);
        if (!isBaselined) continue;
        const fresh = !prev.has(en.id);
        if (fresh && w.rule === 'enter') fire('enter', w, en.id, en.label, en.lon, en.lat, now);
        if (
          w.rule === 'loiter' &&
          !firedW.has(en.id) &&
          now - (sinceW.get(en.id) ?? now) >= DWELL_MS
        ) {
          fire('loiter', w, en.id, en.label, en.lon, en.lat, now);
          firedW.add(en.id);
        }
      }
      for (const id of prev) {
        if (!cur.has(id)) {
          sinceW.delete(id);
          firedW.delete(id);
          if (isBaselined && w.rule === 'exit') fire('exit', w, id, id, w.center.lon, w.center.lat, now);
        }
      }
      inside.set(w.id, cur);
      if (!isBaselined) {
        baselined.add(w.id);
        // Immediate feedback: announce how many contacts are inside at arm time.
        fire('armed', w, '', `${cur.size} contacts`, w.center.lon, w.center.lat, now);
      }
    }
  };

  rebuild();
  const unsub = useWatchboxes.subscribe(rebuild);
  const timer = window.setInterval(evaluate, 2000);

  return () => {
    unsub();
    window.clearInterval(timer);
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
