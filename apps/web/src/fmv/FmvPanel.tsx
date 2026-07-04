// FmvPanel — simulated Full-Motion Video HUD for a selected sim drone.
//
// !! NOTIONAL // SIMULATED — NO REAL VIDEO OR CV !!
//
// This panel drives entirely off the browser-side SimController state.  When a
// sim drone is selected (entity id starts with "sim:") it:
//   - Shows a synthetic "frame" (dark canvas placeholder — there is no live
//     feed) overlaid with detection bounding boxes derived by detections.ts.
//   - Shows a Telemetry Widget (alt / heading / speed / link / mode + derived
//     pitch / roll / sensor az-el).
//   - Shows a <Caveat level="NOTIONAL // SIMULATED"> at the top so it is
//     impossible to mistake this for real imagery.
//   - Exposes a "Follow" button that calls camera.followEntity.
//
// When no sim drone is selected, it shows an empty-state message.

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as Cesium from 'cesium';
import { Widget, KV, KVRow, Caveat, Btn, MicroLabel, SectionLabel, Toggle } from '../shell/instruments.js';
import { useSelection } from '../state/stores.js';
import { useSpotlight } from '../globe/SpotlightLayer.js';
import { followEntity, stopFollow, isFollowing } from '../globe/camera.js';
import { projectDetections, classCounts } from './detections.js';
import type { FocalDrone, DetectionCandidate, Detection, DetectionClass } from './detections.js';
import { useDetectionTriage, SOAK_GRID } from './detectionTriage.js';

// ── types pulled from SimController internals via duck-typing ─────────────────
// SimController stores RtAgent state privately; we read back from the Cesium
// entity's properties (sim: true, kind: 'sim-uav') and the entity's position +
// billboard rotation, plus supplementary RtAgent data injected by the
// SimController tick listener where available.  If any field is missing, the
// panel degrades gracefully.

interface DroneSnapshot {
  id: string;
  lat: number;
  lon: number;
  altM: number;
  heading: number;
  speedMps: number;
  linkState: string;
  mode: string;
}

// ── class badge colours ───────────────────────────────────────────────────────

const CLS_COLOR: Record<string, string> = {
  drone: '#ef4444',
  aircraft: '#facc15',
  vehicle: '#14b8a6',
  structure: '#93c5fd',
};

// ── Bbox overlay ──────────────────────────────────────────────────────────────

function BboxOverlay({ dets }: { dets: Detection[] }): JSX.Element {
  const statusOf = useDetectionTriage((s) => s.status);
  return (
    <>
      {dets.map((d) => {
        const st = statusOf(d.id);
        if (st === 'dismissed') return null; // dismissed detections leave the frame
        const color = st === 'confirmed' ? '#36d399' : CLS_COLOR[d.cls] ?? '#ffffff';
        return (
        <div
          key={d.id}
          style={{
            position: 'absolute',
            left: `${d.bbox.x * 100}%`,
            top: `${d.bbox.y * 100}%`,
            width: `${d.bbox.w * 100}%`,
            height: `${d.bbox.h * 100}%`,
            border: `${st === 'confirmed' ? 2 : 1}px solid ${color}`,
            boxShadow: `0 0 0 1px rgba(0,0,0,0.5)`,
            pointerEvents: 'none',
          }}
        >
          {/* corner label */}
          <span
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              fontSize: '8px',
              fontFamily: '"IBM Plex Mono", monospace',
              color: CLS_COLOR[d.cls] ?? '#ffffff',
              background: 'rgba(0,0,0,0.6)',
              padding: '1px 3px',
              whiteSpace: 'nowrap',
              lineHeight: 1.4,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {d.cls} {Math.round(d.conf * 100)}%
          </span>
        </div>
        );
      })}
    </>
  );
}

// Soak Tool heatmap (§8) — density of CONFIRMED detections accumulated across the
// frame, drawn as translucent cells. Overlays the sensor frame when toggled on.
function SoakOverlay(): JSX.Element | null {
  // Select the STABLE soak Map (not soakCells() — that returns a fresh array each
  // call → Zustand sees a new ref every render → infinite update loop). Derive the
  // cell list here with useMemo, keyed on the map.
  const soak = useDetectionTriage((s) => s.soak);
  const cells = useMemo(
    () =>
      [...soak.entries()].map(([k, n]) => {
        const [cx, cy] = k.split(',').map(Number);
        return { cx: cx ?? 0, cy: cy ?? 0, n };
      }),
    [soak],
  );
  if (cells.length === 0) return null;
  const max = Math.max(1, ...cells.map((c) => c.n));
  return (
    <>
      {cells.map((c) => (
        <div
          key={`${c.cx},${c.cy}`}
          style={{
            position: 'absolute',
            left: `${(c.cx / SOAK_GRID) * 100}%`,
            top: `${(c.cy / SOAK_GRID) * 100}%`,
            width: `${100 / SOAK_GRID}%`,
            height: `${100 / SOAK_GRID}%`,
            background: `rgba(245,165,36,${0.15 + 0.55 * (c.n / max)})`,
            pointerEvents: 'none',
          }}
        />
      ))}
    </>
  );
}

// ── Frame area — REAL overhead satellite imagery of the sensor footprint ──────
// Renders the actual ground under the drone from the keyless same-origin
// /tiles/sat proxy (EOX Sentinel-2 ≤z10, Esri World Imagery >z10 — sharp,
// already licensed in this app), centred on the drone and scaled so the
// footprint fills the frame, with a footprint ring + heading arrow + crosshair.
// NORTH-UP. This is ARCHIVAL imagery composited to read as a nadir sensor frame
// — NOT a live feed and NOT computer vision — hence the NOTIONAL // SIMULATED
// caveat above the frame and the "ARCHIVE EO · NOT LIVE" stamp.

const EARTH_CIRC = 2 * Math.PI * 6378137;
function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

function FrameArea({ dets, snap, soak }: { dets: Detection[]; snap: DroneSnapshot | null; soak: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const [loadTick, setLoadTick] = useState(0);
  const radiusKm = useSpotlight((s) => s.radiusKm);

  const lat = snap?.lat ?? null;
  const lon = snap?.lon ?? null;
  const heading = snap?.heading ?? 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, W, H);

    if (lat != null && lon != null) {
      // Scale so the footprint diameter spans ~70% of the frame width, then pick
      // the slippy zoom whose native resolution matches and draw a tile mosaic.
      const footM = Math.max(200, radiusKm * 1000 * 2);
      const screenMpp = footM / (0.7 * W);
      const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
      let z = Math.round(Math.log2((EARTH_CIRC * cosLat) / (screenMpp * 256)));
      z = Math.max(3, Math.min(18, z));
      const nativeMpp = (EARTH_CIRC * cosLat) / (256 * 2 ** z);
      const draw = 256 * (nativeMpp / screenMpp);
      const fx = lonToTileX(lon, z);
      const fy = latToTileY(lat, z);
      const n = 2 ** z;
      const reach = Math.ceil(Math.max(W, H) / draw) + 1;
      const cx0 = Math.floor(fx);
      const cy0 = Math.floor(fy);
      for (let tx = cx0 - reach; tx <= cx0 + reach; tx++) {
        for (let ty = cy0 - reach; ty <= cy0 + reach; ty++) {
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          const url = `/tiles/sat/${z}/${tx}/${ty}.jpg`;
          let img = imgCache.current.get(url);
          if (!img) {
            img = new Image();
            img.onload = () => setLoadTick((t) => t + 1);
            img.onerror = () => {};
            img.src = url;
            imgCache.current.set(url, img);
          }
          const px = W / 2 + (tx - fx) * draw;
          const py = H / 2 + (ty - fy) * draw;
          if (img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, px, py, draw + 1, draw + 1);
          }
        }
      }

      const ringR = (radiusKm * 1000) / screenMpp;
      // Footprint ring + half-range ring
      ctx.strokeStyle = 'rgba(125,211,252,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, ringR, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(125,211,252,0.3)';
      ctx.lineWidth = 0.75;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, ringR * 0.5, 0, Math.PI * 2); ctx.stroke();

      // Heading arrow (0° = north = up)
      const hr = (heading * Math.PI) / 180;
      ctx.strokeStyle = 'rgba(245,200,100,0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(W / 2, H / 2);
      ctx.lineTo(W / 2 + Math.sin(hr) * ringR, H / 2 - Math.cos(hr) * ringR);
      ctx.stroke();
      // North tick
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('N', W / 2, 11);
    } else {
      ctx.fillStyle = 'rgba(125,150,180,0.55)';
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('acquiring drone telemetry…', W / 2, H / 2);
    }

    // Crosshair (always)
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 9, H / 2); ctx.lineTo(W / 2 + 9, H / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W / 2, H / 2 - 9); ctx.lineTo(W / 2, H / 2 + 9); ctx.stroke();
  }, [lat, lon, heading, radiusKm, loadTick]);

  const statusOf = useDetectionTriage((s) => s.status);

  // §8 burned-in export — composite the frame + detection boxes (+ soak) into one
  // PNG. Same-origin /tiles proxy, so the canvas isn't tainted → toDataURL works.
  const exportBurned = (): void => {
    const src = canvasRef.current;
    if (!src) return;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const c = out.getContext('2d');
    if (!c) return;
    c.drawImage(src, 0, 0);
    const soakCells = useDetectionTriage.getState().soakCells();
    if (soak && soakCells.length) {
      const max = Math.max(1, ...soakCells.map((x) => x.n));
      for (const cell of soakCells) {
        c.fillStyle = `rgba(245,165,36,${0.15 + 0.55 * (cell.n / max)})`;
        c.fillRect((cell.cx / SOAK_GRID) * out.width, (cell.cy / SOAK_GRID) * out.height, out.width / SOAK_GRID, out.height / SOAK_GRID);
      }
    }
    c.font = '9px "IBM Plex Mono", monospace';
    for (const d of dets) {
      const st = statusOf(d.id);
      if (st === 'dismissed') continue;
      const color = st === 'confirmed' ? '#36d399' : CLS_COLOR[d.cls] ?? '#ffffff';
      c.strokeStyle = color;
      c.lineWidth = st === 'confirmed' ? 2 : 1;
      const x = d.bbox.x * out.width;
      const y = d.bbox.y * out.height;
      c.strokeRect(x, y, d.bbox.w * out.width, d.bbox.h * out.height);
      c.fillStyle = color;
      c.fillText(`${d.cls} ${Math.round(d.conf * 100)}%`, x, Math.max(9, y - 2));
    }
    c.fillStyle = 'rgba(255,200,100,0.8)';
    c.fillText('ARCHIVE EO · NOT LIVE', out.width - 118, 12);
    try {
      const a = document.createElement('a');
      a.href = out.toDataURL('image/png');
      a.download = `fmv-frame-${snap ? `${snap.lat.toFixed(2)}_${snap.lon.toFixed(2)}` : 'frame'}.png`;
      a.click();
    } catch {
      /* tainted canvas (shouldn't happen with same-origin tiles) */
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', paddingTop: '62%', background: '#05070b', borderRadius: 3, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)' }}>
      <canvas
        ref={canvasRef}
        width={512}
        height={318}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      <button
        type="button"
        onClick={exportBurned}
        title="Export this frame with detections burned in (PNG)"
        style={{
          position: 'absolute', top: 4, left: 4, zIndex: 2,
          fontFamily: '"IBM Plex Mono", monospace', fontSize: '9px', textTransform: 'uppercase',
          letterSpacing: '0.4px', padding: '2px 6px', color: '#cdd6e2',
          background: 'rgba(8,10,15,0.7)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 2, cursor: 'pointer',
        }}
      >
        ⤓ Frame
      </button>
      {/* Soak heatmap (confirmed-detection density) beneath the boxes */}
      {soak && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <SoakOverlay />
        </div>
      )}
      {/* Bbox overlay — absolute divs over the imagery */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <BboxOverlay dets={dets} />
      </div>
      {/* Honest provenance stamps — archival EO, not a live sensor */}
      <span
        style={{
          position: 'absolute', top: 4, right: 4, fontSize: '7px',
          fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(255,200,100,0.6)',
          letterSpacing: '0.6px', textTransform: 'uppercase',
        }}
      >
        ARCHIVE EO · NOT LIVE
      </span>
      <span
        style={{
          position: 'absolute', bottom: 4, left: 4, fontSize: '7px',
          fontFamily: '"IBM Plex Mono", monospace', color: 'rgba(150,170,200,0.65)',
          letterSpacing: '0.4px',
        }}
      >
        EOX/Esri · {snap ? `${snap.lat.toFixed(2)}, ${snap.lon.toFixed(2)}` : '—'}
      </span>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function FmvPanel({ viewer }: { viewer: unknown }): JSX.Element | null {
  const selId = useSelection((s) => s.selectedEntityId);
  const [snapshot, setSnapshot] = useState<DroneSnapshot | null>(null);
  const [dets, setDets] = useState<Detection[]>([]);
  const [tick, setTick] = useState(0);
  const [following, setFollowing] = useState(false);
  const [soak, setSoak] = useState(false);
  // Sensor footprint spotlight (fog-of-war on the globe) — shared with SpotlightLayer.
  const sensorOn = useSpotlight((s) => s.enabled);
  const setSensor = useSpotlight((s) => s.setEnabled);
  const radiusKm = useSpotlight((s) => s.radiusKm);
  const setRadiusKm = useSpotlight((s) => s.setRadiusKm);
  // Root of the active HUD; used to skip the poll while the tab is hidden
  // (TabbedPanel hides inactive tabs with the `hidden` attr → offsetParent null).
  const rootRef = useRef<HTMLDivElement>(null);

  // Only care about sim drone selections.
  const isSim = selId != null && selId.startsWith('sim:');

  // Read telemetry from the Cesium entity on a regular interval.
  useEffect(() => {
    if (!isSim || !selId || !viewer) return;

    const v = viewer as { isDestroyed?: () => boolean; dataSources?: { length: number; get: (i: number) => { entities: { getById: (id: string) => unknown } } }; clock?: { currentTime: unknown }; entities?: { getById: (id: string) => unknown } };

    type RawEntity = {
      position?: { getValue: (t: unknown) => { x: number; y: number; z: number } | undefined };
      properties?: { kind?: { getValue?: () => string }; sim?: unknown };
      billboard?: { rotation?: { getValue: (t: unknown) => number } };
      name?: string;
    };

    const readSnap = (): void => {
      if (typeof v.isDestroyed === 'function' && v.isDestroyed()) return;
      // Skip the entity read + state churn while the FMV tab is hidden.
      if (rootRef.current && rootRef.current.offsetParent === null) return;

      // Find the entity across data sources + root.
      let entity: RawEntity | null = null;
      if (v.dataSources) {
        for (let i = 0; i < v.dataSources.length; i++) {
          const e = v.dataSources.get(i).entities.getById(selId);
          if (e != null) { entity = e as unknown as RawEntity; break; }
        }
      }
      if (entity == null && v.entities) {
        const e2 = v.entities.getById(selId);
        if (e2 != null) entity = e2 as unknown as RawEntity;
      }
      if (!entity) return;

      // Only handle sim drone entities.
      const kind = entity.properties?.kind?.getValue?.() as string | undefined;
      if (kind !== 'sim-uav' && kind !== 'sim-drone') return;

      const t = v.clock?.currentTime;
      const pos = entity.position?.getValue(t);
      if (!pos) return;

      // Convert Cartesian3 → lat/lon/alt using the imported Cesium module
      // directly. The old `globalThis.Cesium` lookup silently returned undefined
      // (vite-plugin-cesium does not attach Cesium to window), so the panel was
      // stuck at "—" for every reading — the "FMV doesn't show much" report.
      const cart = Cesium.Cartographic.fromCartesian(pos as unknown as Cesium.Cartesian3);
      const lat = Cesium.Math.toDegrees(cart.latitude);
      const lon = Cesium.Math.toDegrees(cart.longitude);
      const altM = Math.max(0, cart.height);

      // Heading from billboard rotation: stored as -toRadians(heading), so reverse.
      const rotRad = entity.billboard?.rotation?.getValue(t) ?? 0;
      const heading = ((-rotRad * 180) / Math.PI + 360) % 360;

      setSnapshot((prev) => {
        // Derive speed from position delta if we have a previous reading.
        let speedMps = 0;
        if (prev) {
          const dLat = (lat - prev.lat) * 111320;
          const dLon = (lon - prev.lon) * 111320 * Math.cos((lat * Math.PI) / 180);
          speedMps = Math.sqrt(dLat * dLat + dLon * dLon) / 0.5; // assuming ~0.5 s interval
        }
        return {
          id: selId,
          lat,
          lon,
          altM,
          heading,
          speedMps: Math.min(speedMps, 500), // cap runaway outliers at first read
          linkState: 'nominal',
          mode: 'cruise',
        };
      });

      setTick((t) => t + 1);
    };

    readSnap();
    const id = window.setInterval(readSnap, 500);
    return () => window.clearInterval(id);
  }, [isSim, selId, viewer]);

  // Recompute detections whenever the snapshot changes.
  useEffect(() => {
    if (!snapshot) { setDets([]); return; }
    const focal: FocalDrone = {
      lat: snapshot.lat,
      lon: snapshot.lon,
      altM: snapshot.altM,
      heading: snapshot.heading,
    };
    // For the demo, generate synthetic candidate positions around the drone —
    // stable per id+tick so they don't jump on every poll.
    const candidates: DetectionCandidate[] = buildSyntheticCandidates(focal, tick);
    setDets(projectDetections(focal, candidates, tick));
  }, [snapshot, tick]);

  // Track follow state changes.
  useEffect(() => {
    if (!viewer || !selId) return;
    const v = viewer as { isDestroyed?: () => boolean };
    if (typeof v.isDestroyed === 'function' && v.isDestroyed()) return;
    setFollowing(isFollowing(viewer as Parameters<typeof isFollowing>[0], selId));
  }, [viewer, selId, tick]);

  const handleFollow = useCallback(() => {
    if (!viewer || !selId) return;
    const v = viewer as Parameters<typeof followEntity>[0];
    if (following) {
      stopFollow(v);
      setFollowing(false);
    } else {
      const ok = followEntity(v, selId);
      setFollowing(ok);
    }
  }, [viewer, selId, following]);

  // ── render ──────────────────────────────────────────────────────────────────

  if (!isSim) {
    return (
      <Widget title="FMV">
        <Caveat level="NOTIONAL // SIMULATED" tone="warn" />
        <p className="text-[10px] text-txt-3 mt-2 leading-snug">
          Select a sim drone to see the sensor HUD. Run a Swarm or Attack
          scenario in the Simulation panel first.
        </p>
      </Widget>
    );
  }

  const counts = classCounts(dets);
  const snap = snapshot;

  // Derived pitch/roll and sensor az/el (synthetic — no IMU).
  const pitch = snap ? derivePitch(snap.altM, snap.speedMps) : 0;
  const roll = snap ? deriveRoll(snap.heading, tick) : 0;
  const sensorAz = snap ? (snap.heading + 180) % 360 : 0;
  const sensorEl = snap ? -30 + (snap.altM / 5000) * 10 : -30; // -30° at low alt, ~-20° at 5 km

  return (
    <div className="space-y-2" ref={rootRef}>
      <Widget title="FMV — sensor view">
        <div className="mb-2">
          <Caveat level="NOTIONAL // SIMULATED" tone="warn" />
        </div>

        <FrameArea dets={dets} snap={snap} soak={soak} />

        {/* Detection class-count badges + soak toggle */}
        <div className="flex flex-wrap items-center gap-1 mt-2">
          {(Object.entries(counts) as [string, number][])
            .filter(([, n]) => n > 0)
            .map(([cls, n]) => (
              <span
                key={cls}
                className="mono text-[10px] tracking-[0.6px] uppercase px-[7px] py-[3px] rounded-sm whitespace-nowrap border border-line text-txt-3"
                style={{ color: CLS_COLOR[cls] ?? 'var(--txt-3)' }}
              >
                {n} {cls}
              </span>
            ))}
          {dets.length === 0 && <MicroLabel>no contacts in footprint</MicroLabel>}
          <button
            type="button"
            onClick={() => setSoak((v) => !v)}
            className={`ml-auto mono text-[10px] uppercase tracking-[0.5px] px-[7px] py-[3px] rounded-sm border ${
              soak ? 'border-warn text-warn' : 'border-line text-txt-3 hover:text-txt-1'
            }`}
          >
            Soak
          </button>
        </div>
      </Widget>

      {/* Detection triage (§8) — confirm/dismiss AI detections; confirmed ones
          feed the Soak heatmap. Detections are NOTIONAL (exercise), like the sim. */}
      <DetectionTriageWidget dets={dets} />

      {/* Telemetry */}
      <Widget title="Telemetry" count={snap ? `${Math.round(snap.altM)} m` : '—'}>
        <KV>
          <KVRow k="Alt" v={snap ? `${Math.round(snap.altM)} m` : '—'} />
          <KVRow k="Heading" v={snap ? `${Math.round(snap.heading)}°` : '—'} />
          <KVRow k="Speed" v={snap ? `${Math.round(snap.speedMps)} m/s` : '—'} />
          <KVRow k="Link" v={snap?.linkState ?? '—'} />
          <KVRow k="Mode" v={snap?.mode ?? '—'} />
        </KV>
        <SectionLabel title="IMU (derived)" className="mt-2" />
        <KV className="mt-1">
          <KVRow k="Pitch" v={`${pitch > 0 ? '+' : ''}${pitch.toFixed(1)}°`} />
          <KVRow k="Roll" v={`${roll > 0 ? '+' : ''}${roll.toFixed(1)}°`} />
        </KV>
        <SectionLabel title="Sensor" className="mt-2" />
        <KV className="mt-1">
          <KVRow k="Az" v={`${Math.round(sensorAz)}°`} />
          <KVRow k="El" v={`${sensorEl.toFixed(1)}°`} />
        </KV>

        <SectionLabel title="Footprint (notional)" className="mt-2" />
        <KV className="mt-1">
          <KVRow k="Center" v={snap ? `${snap.lat.toFixed(3)}, ${snap.lon.toFixed(3)}` : '—'} />
          <KVRow k="Radius" v={`${radiusKm.toFixed(1)} km`} />
        </KV>
        <div className="mt-2 flex items-center justify-between gap-2">
          <Toggle on={sensorOn} onChange={setSensor} label="Sensor spotlight" />
          <div className="flex gap-1">
            <Btn size="sm" title="Shrink footprint" onClick={() => setRadiusKm(radiusKm - 0.5)}>
              −
            </Btn>
            <Btn size="sm" title="Grow footprint" onClick={() => setRadiusKm(radiusKm + 0.5)}>
              +
            </Btn>
          </div>
        </div>

        <div className="mt-2.5 flex gap-1.5">
          <Btn size="sm" tone={following ? 'accent' : 'neutral'} onClick={handleFollow}>
            {following ? 'Unfollow' : 'Follow'}
          </Btn>
        </div>
      </Widget>
    </div>
  );
}

// ── Derived IMU helpers ───────────────────────────────────────────────────────
// These are purely synthetic seat-of-pants numbers.  They are clearly labelled
// "(derived)" in the UI and should never be taken as real sensor data.

function derivePitch(altM: number, speedMps: number): number {
  // Positive pitch (nose up) during climb modelled by altitude–speed ratio.
  if (speedMps < 1) return 0;
  const climbRatio = Math.min(1, altM / 2000);
  return +(climbRatio * 8).toFixed(1); // max ~8° nose-up
}

function deriveRoll(heading: number, tick: number): number {
  // Small sinusoidal bank angle correlated to heading change (turns).
  const t = tick / 10;
  return +(Math.sin(t + heading * 0.01) * 4).toFixed(1); // ±4° max
}

// ── Synthetic detection candidates ───────────────────────────────────────────
// Generate plausible candidate positions from the focal drone's position so
// FmvPanel shows interesting detections even when no real SimController
// candidates are passed in.  These are deterministically keyed on the drone's
// lat/lon grid cell so they don't drift between renders.

function buildSyntheticCandidates(focal: FocalDrone, tick: number): DetectionCandidate[] {
  // Seed positions: 6 candidates in a fixed pattern relative to the focal point.
  // Using grid offsets (not Math.random) so they are stable across ticks.
  const DEG_PER_100M = 1 / 1111.32;
  const offsets: Array<[number, number, DetectionClass]> = [
    [1, 0, 'vehicle'],
    [-1, 1, 'vehicle'],
    [2, -1, 'structure'],
    [-2, -2, 'drone'],
    [0.5, 2, 'vehicle'],
    [-0.5, -0.5, 'drone'],
  ];
  // Suppress unused 'tick' lint; the tick is intended for future shimmer use.
  void tick;
  return offsets.map(([dlatFactor, dlonFactor, cls], i) => ({
    id: `synth:${i}:${focal.lat.toFixed(2)}:${focal.lon.toFixed(2)}`,
    lat: focal.lat + dlatFactor * DEG_PER_100M * 3,
    lon: focal.lon + dlonFactor * DEG_PER_100M * 3,
    cls,
  }));
}

// Detection triage (§8) — confirm/dismiss AI detections; confirmed ones feed the
// Soak heatmap. Detections are NOTIONAL (exercise), like the war-game sim.
function DetectionTriageWidget({ dets }: { dets: Detection[] }): JSX.Element {
  const statusOf = useDetectionTriage((s) => s.status);
  const confirm = useDetectionTriage((s) => s.confirm);
  const dismiss = useDetectionTriage((s) => s.dismiss);
  const soakCount = useDetectionTriage((s) => s.soak.size);
  const clearSoak = useDetectionTriage((s) => s.clearSoak);
  const pending = dets.filter((d) => statusOf(d.id) === 'pending');
  return (
    <Widget title="Detection triage" count={`${pending.length} pending`}>
      {dets.length === 0 ? (
        <MicroLabel>no detections to review</MicroLabel>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {dets.slice(0, 12).map((d) => {
            const st = statusOf(d.id);
            return (
              <li key={d.id} className="flex items-center gap-2 py-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CLS_COLOR[d.cls] ?? '#fff' }} />
                <span className="mono text-[11px] text-txt-1 flex-1 uppercase tracking-[0.4px]">
                  {d.cls} <span className="text-txt-3">{Math.round(d.conf * 100)}%</span>
                </span>
                {st === 'confirmed' && <span className="mono text-[10px] text-ok uppercase">confirmed</span>}
                {st === 'dismissed' && <span className="mono text-[10px] text-txt-4 uppercase">dismissed</span>}
                {st === 'pending' && (
                  <>
                    <button
                      type="button"
                      onClick={() => confirm(d.id, d.bbox.x + d.bbox.w / 2, d.bbox.y + d.bbox.h / 2)}
                      className="mono text-[10px] uppercase px-1.5 py-0.5 rounded-sm border border-line text-ok hover:border-ok"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      onClick={() => dismiss(d.id)}
                      className="mono text-[10px] uppercase px-1.5 py-0.5 rounded-sm border border-line text-alert hover:border-alert"
                    >
                      ✕
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center justify-between mt-2">
        <MicroLabel>soak cells: {soakCount}</MicroLabel>
        <button
          type="button"
          onClick={clearSoak}
          disabled={soakCount === 0}
          className="mono text-[10px] uppercase tracking-[0.4px] text-txt-3 hover:text-txt-1 disabled:opacity-40"
        >
          Clear soak
        </button>
      </div>
    </Widget>
  );
}
