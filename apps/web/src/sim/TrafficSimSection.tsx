// Traffic-sim section: picks the nearest public cam to a point, runs the desktop
// CUDA sidecar on its snapshot in a poll loop, and seeds TrafficController with
// the detected vehicle count (animated vehicles on the globe). Desktop-only —
// the website shows a caveat. Shared by the Ground Recon panel (point = AOI) and
// the Traffic sim right-rail tab (point = map centre).
import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { Widget, KV, KVRow, MicroLabel, Caveat, Btn } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';
import { detectImage, detectStatus, isDesktop } from '../transport/desktop.js';
import { TrafficController, type CamInfo } from './TrafficController.js';
import type { DetectStatus } from '../ground/types.js';
import type { LatLon } from '../globe/center.js';
import { useCaptures } from '../state/captures.js';

export function TrafficSimSection({
  viewer,
  center,
}: {
  viewer: Cesium.Viewer | null;
  center: LatLon | null;
}): JSX.Element {
  const [cam, setCam] = useState<CamInfo | null>(null);
  const [simCount, setSimCount] = useState<number | null>(null);
  const [status, setStatus] = useState<DetectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tcRef = useRef<TrafficController | null>(null);
  const loopRef = useRef<number | null>(null);
  const capUnsubRef = useRef<(() => void) | null>(null);
  const desktop = isDesktop();
  // Real-data mode: drive the sim from the captures store (real detected car
  // counts at real cam locations) instead of one live cam. Works on the website
  // too — captures already carry their detections.
  const [realData, setRealData] = useState(false);
  const [jamInfo, setJamInfo] = useState<{ roads: number; jams: number } | null>(null);
  // Select the STABLE array ref (a filtering selector returns a new array each
  // render → useSyncExternalStore infinite-loop). Filter in render (cheap).
  const allCaptures = useCaptures((s) => s.captures);
  const camCaptures = allCaptures.filter((c) => c.source === 'cam');

  // Find the nearest cam to the point whenever it changes.
  useEffect(() => {
    setCam(null);
    setSimCount(null);
    if (!center) return;
    let cancelled = false;
    apiFetch('/api/cams')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`cams ${r.status}`))))
      .then((fc: { features?: Array<Record<string, unknown>> }) => {
        if (cancelled) return;
        let best: CamInfo | null = null;
        let bestD = Infinity;
        for (const f of fc.features ?? []) {
          const p = (f.properties ?? {}) as Record<string, unknown>;
          const coords = (f.geometry as { coordinates?: [number, number, number] } | undefined)?.coordinates;
          if (!coords || !p.cam_id) continue;
          const lat = coords[1];
          const lon = coords[0];
          const d = Math.hypot(lat - center.lat, lon - center.lon);
          if (d < bestD) {
            bestD = d;
            best = { cam_id: String(p.cam_id), name: String(p.name ?? p.cam_id), lat, lon };
          }
        }
        if (best && bestD < 1.0) setCam(best); // within ~1° (~111 km) of the point
      })
      .catch(() => {
        /* cams unavailable — section just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [center]);

  useEffect(() => {
    if (desktop) void detectStatus().then(setStatus);
  }, [desktop]);

  // Tear down the controller + poll loop on unmount.
  useEffect(() => {
    return () => {
      if (loopRef.current) window.clearInterval(loopRef.current);
      capUnsubRef.current?.();
      tcRef.current?.dispose();
      tcRef.current = null;
    };
  }, []);

  const runOnce = async (c: CamInfo): Promise<void> => {
    const tc = tcRef.current;
    if (!tc) return;
    try {
      const r = await apiFetch(`/api/cams/${encodeURIComponent(c.cam_id)}/snapshot`);
      if (!r.ok) throw new Error(`snap ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const dets = await detectImage(bytes);
      const res = await tc.seed(c, dets ?? []);
      setSimCount(res.count);
      setMsg(res.road ? null : 'no road geometry — using fallback line');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'sim failed');
    }
  };

  const onSimulate = async (): Promise<void> => {
    if (!viewer || !cam || busy) return;
    setBusy(true);
    if (!tcRef.current) tcRef.current = new TrafficController(viewer);
    await runOnce(cam);
    // Re-detect + re-seed every 10 s so the count tracks the live feed.
    if (loopRef.current) window.clearInterval(loopRef.current);
    loopRef.current = window.setInterval(() => {
      void runOnce(cam);
    }, 10_000);
    setBusy(false);
  };

  // Real-data mode: seed the sim from all cam captures + jam prediction, and
  // re-seed whenever a new capture is pinned (live detections auto-pin).
  const seedReal = async (): Promise<void> => {
    const tc = tcRef.current;
    if (!tc) return;
    const caps = useCaptures.getState().captures.filter((c) => c.source === 'cam');
    const res = await tc.seedFromCaptures(caps);
    setSimCount(res.count);
    setJamInfo({ roads: res.roads, jams: res.jams });
    setMsg(res.count === 0 ? 'no cam captures with vehicles yet — detect on some cams first' : null);
  };

  const onSimulateReal = async (): Promise<void> => {
    if (!viewer || busy) return;
    setBusy(true);
    if (!tcRef.current) tcRef.current = new TrafficController(viewer);
    if (loopRef.current) {
      window.clearInterval(loopRef.current);
      loopRef.current = null;
    }
    await seedReal();
    capUnsubRef.current?.();
    capUnsubRef.current = useCaptures.subscribe(() => void seedReal());
    setBusy(false);
  };

  const onStop = (): void => {
    if (loopRef.current) {
      window.clearInterval(loopRef.current);
      loopRef.current = null;
    }
    capUnsubRef.current?.();
    capUnsubRef.current = null;
    tcRef.current?.stop();
    setSimCount(null);
    setJamInfo(null);
  };

  const modeToggle = (
    <div className="flex gap-1 mb-2" role="radiogroup" aria-label="Traffic source">
      {(
        [
          ['live', 'Live cam'],
          ['real', 'Real data'],
        ] as const
      ).map(([mid, label]) => {
        const on = (mid === 'real') === realData;
        return (
          <button
            key={mid}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              onStop();
              setRealData(mid === 'real');
            }}
            className={`flex-1 mono text-[10px] px-2 py-1 rounded-sm border transition-colors ${
              on
                ? 'border-accent-line text-accent bg-accent-dim'
                : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  if (realData) {
    return (
      <Widget
        title="Traffic sim · real data"
        count={simCount != null ? `${simCount} veh` : `${camCaptures.length} caps`}
      >
        {modeToggle}
        <KV>
          <KVRow k="Captures" v={`${camCaptures.length} cam`} />
          <KVRow k="Sim" v={simCount != null ? `${simCount} vehicles` : 'idle'} />
          {jamInfo && <KVRow k="Roads" v={`${jamInfo.roads} · ${jamInfo.jams} jam`} />}
        </KV>
        {msg && <span className="mono text-[10px] text-alert">{msg}</span>}
        <div className="mt-2 flex gap-1.5">
          <Btn
            size="sm"
            tone="accent"
            onClick={() => void onSimulateReal()}
            disabled={busy || !viewer || camCaptures.length === 0}
          >
            {busy ? 'starting…' : '▶ simulate'}
          </Btn>
          <Btn size="sm" onClick={onStop} disabled={simCount == null}>
            stop
          </Btn>
        </div>
        <MicroLabel>
          real car-counts from pinned cam captures → vehicles on OSM roads + traffic-jam prediction
        </MicroLabel>
      </Widget>
    );
  }

  return (
    <Widget title="Traffic sim" count={simCount != null ? `${simCount} veh` : status ? status.device : '—'}>
      {modeToggle}
      {!desktop ? (
        <>
          <Caveat level="DESKTOP-ONLY" tone="warn" />
          <MicroLabel>live cam → CUDA detect runs in the desktop app; use Real data mode here</MicroLabel>
        </>
      ) : (
        <>
          {cam ? (
            <KV>
              <KVRow k="Cam" v={cam.name} />
              <KVRow k="Detect" v={status ? `${status.device}${status.ready ? '' : ' (warming)'}` : '—'} />
              <KVRow k="Sim" v={simCount != null ? `${simCount} vehicles` : 'idle'} />
            </KV>
          ) : (
            <MicroLabel>{center ? 'no public cam near this point' : 'set a location'}</MicroLabel>
          )}
          {msg && <span className="mono text-[10px] text-alert">{msg}</span>}
          <div className="mt-2 flex gap-1.5">
            <Btn size="sm" tone="accent" onClick={() => void onSimulate()} disabled={!cam || busy || !viewer}>
              {busy ? 'starting…' : '▶ simulate'}
            </Btn>
            <Btn size="sm" onClick={onStop} disabled={simCount == null}>
              stop
            </Btn>
          </div>
        </>
      )}
    </Widget>
  );
}
