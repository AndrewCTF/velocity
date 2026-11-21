// Video: there is no full-motion video. The still is the app's own satellite
// plate around the selected track (/tiles/sat, the maven video's plate maths)
// and the detections are the imagery route's answer for the hatched detection
// box. Readings with no source read "—". The strip under it is the AIS
// recorder window (fixes per 2 minutes of the result set).
import { useEffect, useMemo, useState } from "react";
import { Btn, Ic, Sat } from "./kit.js";
import { TRK, fixBins, hhmm, recFixes, recorder, fetchJson } from "./data.js";
import { SPAN, TILE, makePlate, tiles, toLL, toPx } from "../maven/fmvPlate.js";
import type { Ctx } from "./model.js";

const OR = "#e8872a";
// the frame is 864 x 480; the detection box keeps its offset from the fix
const FW = 864, FH = 480;
const ROI = { x: 239, y: 35, w: 400, h: 330 };
interface Det { lon: number; lat: number; cls: string; conf: number | null }

export function Video({ c }: { c: Ctx }): JSX.Element {
  const sel = c.sel;
  const plate = useMemo(() => (sel ? makePlate(sel.v.lat, sel.v.lon, 17) : null), [sel]);
  // plate px -> frame px: the fix sits at the frame centre, native tile scale
  const [ox, oy] = plate && sel ? toPx(plate, sel.v.lat, sel.v.lon) : [0, 0];
  const vpos = (px: number, py: number): [number, number] => [FW / 2 + (px - ox), FH / 2 + (py - oy)];
  const roiLL = plate ? [toLL(plate, ROI.x - FW / 2 + ox, ROI.y - FH / 2 + oy), toLL(plate, ROI.x + ROI.w - FW / 2 + ox, ROI.y + ROI.h - FH / 2 + oy)] : null;
  const [det, setDet] = useState<{ dets: Det[]; note: string | null } | null>(null);
  useEffect(() => {
    if (!roiLL) return;
    const [[n, w], [s, e]] = roiLL as [[number, number], [number, number]];
    let live = true;
    setDet(null);
    void fetchJson<{ features?: { geometry: { coordinates: [number, number] }; properties: { cls?: string; conf?: number } }[]; summary?: { note?: string } }>(
      `/api/imagery/detect?min_lon=${w.toFixed(5)}&min_lat=${s.toFixed(5)}&max_lon=${e.toFixed(5)}&max_lat=${n.toFixed(5)}&date=${new Date().toISOString().slice(0, 10)}`,
    ).then((r) => {
      if (!live) return;
      if (!r.ok) return setDet({ dets: [], note: `Detection unavailable (HTTP ${r.status})` });
      const dets = (r.data?.features ?? []).map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], cls: String(f.properties.cls ?? "object"), conf: f.properties.conf ?? null }));
      setDet({ dets: dets.sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0)), note: r.data?.summary?.note ?? null });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plate]);
  const dets = det?.dets ?? [];
  const vis = plate ? dets.map((d) => ({ d, p: vpos(...toPx(plate, d.lat, d.lon)) })) : [];
  const vin = ([x, y]: [number, number], m = 6): boolean => m <= x && x <= FW - m && m <= y && y <= FH - m;
  const visIn = vis.filter((v) => vin(v.p));
  const off = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const { p: [x, y] } of vis)
    if (!vin([x, y])) {
      if (y < 0) off.top += 1;
      else if (y > FH) off.bottom += 1;
      else if (x < 0) off.left += 1;
      else off.right += 1;
    }
  const d0 = visIn[0]?.d ?? null;
  const selT = sel ? TRK(sel.mmsi) : "No track";
  const rec = recorder();
  const hud = `SAT PLATE\nTILES Z${plate?.z ?? "—"}\nNO SENSOR POSE\n${SPAN * TILE} X ${SPAN * TILE} PX`;
  return (
    <div className="px-pg pxv">
      <aside className="px-pane l pxv-tag" aria-label="Tagging">
        <div className="px-ph">
          <Ic n="tag" />
          <h2>Tagging</h2>
          <span className="px-gap" />
          <Btn pri label="Done tagging: the map" onClick={() => c.go("gaia")}>Done tagging</Btn>
        </div>
        <button type="button" className="pxv-box" aria-label="Detection box: the map" title="Detection box: the map" onClick={() => c.go("gaia")}>
          <span className="px-thumb">{sel ? <Sat lon={sel.v.lon} lat={sel.v.lat} z={17} w={64} h={64} /> : null}</span>
          <span><b>Detection box</b><br /><span className="px-mu">Location</span></span>
          <span className="px-gap" />
          <Ic n="chevron-right" />
        </button>
        <div className="px-sect"><Ic n="caret-down" s={10} /> {det ? `${dets.length} linked observations` : "detecting…"}</div>
        <div className="pxv-det">
          {d0 ? (
            <>
              <div className="pxv-dh">
                <span className="px-thumb"><Sat lon={d0.lon} lat={d0.lat} z={17} w={64} h={64} /></span>
                <span><b>Detection 1</b><br /><b>{d0.cls} in the box</b><br /><span className="px-mu">Observation</span></span>
              </div>
            </>
          ) : (
            <div><b>No detection</b><p className="px-mu">{det ? (det.note ?? "No detections in the box") : "detecting…"}</p></div>
          )}
          <dl className="pxv-kv">
            <dt>Classification</dt><dd>OSINT</dd>
            <dt>Time interval</dt><dd>— (still plate)</dd>
            <dt>Location</dt><dd>{d0 ? `${d0.lat.toFixed(5)}, ${d0.lon.toFixed(5)}` : "—"}</dd>
            <dt>Date</dt><dd>— (tile date)</dd>
            <dt>Detector</dt><dd>YOLO, imagery route</dd>
            <dt>Confidence</dt><dd>{d0?.conf != null ? d0.conf.toFixed(2) : "—"}</dd>
            <dt>Analyst Assessment Summary</dt><dd>None recorded.</dd>
            <dt>QC Status</dt><dd><Btn label="QC status" why="No analyst review store exists">Unvalidated</Btn></dd>
          </dl>
          <p className="pxv-lk"><Ic n="link" s={12} /> Linked to Detection box</p>
          <p className="px-mu"><Ic n="user" s={12} /> Detector run, no analyst assigned</p>
        </div>
        <ul>
          {visIn.slice(1).map(({ d }, k) => (
            <li key={`${d.lon},${d.lat}`} className="pxv-more">
              <span className="px-thumb"><Sat lon={d.lon} lat={d.lat} z={17} w={64} h={64} /></span>
              <span><b>Detection {k + 2}</b><br /><span className="px-mu">Observation · Detection box</span></span>
            </li>
          ))}
        </ul>
      </aside>
      <section className="pxv-main" aria-label="Satellite plate">
        <div className="px-ph">
          <Btn label="Full screen: the map" icon="fullscreen" onClick={() => c.go("gaia")}>Full screen</Btn>
          <Btn label="Locate: the custom object view" icon="locate" onClick={sel ? () => c.go("cov") : undefined} why="No vessel selected">Locate</Btn>
          <span className="px-gap" />
          <span className="pxv-ttl"><b>Satellite plate</b> <span className="px-mu">{selT} (still image, no FMV)</span></span>
          <span className="px-gap" />
        </div>
        <div className="pxv-view">
          <div className="pxv-stage">
            <svg viewBox={`0 0 ${FW} ${FH}`} className="pxv-svg" role="img" aria-label={sel ? `Satellite plate around ${sel.name} with the detection box` : "No satellite plate"}>
              <defs>
                <pattern id="pdf-hz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(214,196,60,.20)" /><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(214,196,60,.55)" strokeWidth="2" /></pattern>
                <clipPath id="pdf-fc"><rect width={FW} height={FH} /></clipPath>
              </defs>
              <rect width={FW} height={FH} fill="#222" />
              <g clipPath="url(#pdf-fc)">
                {plate ? tiles(plate).map((t) => <image key={t.key} href={t.url} x={t.x - ox + FW / 2} y={t.y - oy + FH / 2} width={TILE} height={TILE} />) : null}
                <rect x={ROI.x} y={ROI.y} width={ROI.w} height={ROI.h} fill="url(#pdf-hz)" stroke="#d6c43c" strokeWidth={1.2} />
                {visIn.map(({ p: [x, y] }) => <polygon key={`${x},${y}`} points={`${x - 6},${y - 12} ${x + 6},${y - 12} ${x},${y - 1}`} fill={OR} stroke="#fff" strokeWidth={1} />)}
                {visIn[0] ? (
                  <>
                    <rect x={visIn[0].p[0] - 19} y={visIn[0].p[1] - 24} width={38} height={38} fill="rgba(232,135,42,.28)" stroke={OR} strokeWidth={1.5} />
                    <circle cx={visIn[0].p[0]} cy={visIn[0].p[1] - 6} r={28} fill="rgba(255,255,255,.22)" />
                  </>
                ) : null}
              </g>
            </svg>
            {!sel ? <p className="pxv-none">No vessel matches the search, so there is no plate.</p> : null}
            <span className="pxv-lab">Detection box</span>
            <pre className="pxv-hud tl">{hud}</pre>
            <pre className="pxv-hud bl">{"NO LASER, NO FMV\nTILE DATE —"}</pre>
            <pre className="pxv-hud br">{`BRG —  RNG —\nELV —  TWD —\nDET ${det ? dets.length : "—"}  ROI 1`}</pre>
            {(["top", "bottom", "left", "right"] as const).map((k) => (off[k] ? <span key={k} className={`pxv-off ${k}`} title={`${off[k]} detections beyond the ${k} edge`}>{off[k]}</span> : null))}
          </div>
        </div>
        <RecorderStrip c={c} now={rec.last ? hhmm(rec.last, true) : "—"} />
      </section>
    </div>
  );
}

/** The AIS recorder window: fixes per 2 minutes, the track's own fixes as markers. */
function RecorderStrip({ c, now }: { c: Ctx; now: string }): JSX.Element {
  const fx = recFixes(new Set(c.res.map((r) => r.mmsi)));
  const B = fixBins(fx, 120);
  const span = B ? Math.max(1, B.t1 - B.t0) : 1;
  const bins = new Map<number, number>();
  if (B) for (const f of fx) bins.set(Math.floor((f.t - B.t0) / 120), (bins.get(Math.floor((f.t - B.t0) / 120)) ?? 0) + 1);
  const nb = Math.floor(span / 120) + 1;
  const bmax = Math.max(1, ...bins.values());
  const win = Math.max(0, 1 - 3600 / span) * 100;
  return (
    <div className="pxv-strip">
      <div className="pxv-sh"><span className="px-mu">ZULU</span><b>{now}</b><span className="px-gap" /><span className="px-mu">A still plate has no playback</span></div>
      {B ? (
        <button type="button" className="pxv-tl" aria-label="Timeline: the AIS timeline" title="Timeline: the AIS timeline" onClick={() => c.go("timeline")}>
          {[...bins].map(([k, n]) => <i key={k} className="pxv-bar" style={{ left: `${(100 * k) / nb}%`, width: `${100 / nb}%`, height: `${(100 * n) / bmax}%` }} />)}
          {c.fixes.filter((f) => f[0] >= B.t0 && f[0] <= B.t1).map((f) => <b key={f[0]} className="pxv-fx" style={{ left: `${(100 * (f[0] - B.t0)) / span}%` }} />)}
          <span className="pxv-win" style={{ left: `${win}%` }} />
          <span className="pxv-t0">{hhmm(B.t0)}</span>
          <span className="pxv-t1">{hhmm(B.t1, true)}</span>
        </button>
      ) : (
        <p className="px-empty">No fixes recorded yet</p>
      )}
    </div>
  );
}
