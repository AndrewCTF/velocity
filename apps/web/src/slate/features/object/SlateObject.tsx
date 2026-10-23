import { useEffect, useMemo, useState, type ReactNode } from "react";
import type * as Cesium from "cesium";
import "./object.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import {
  fetchEnrichment,
  type AircraftEnrichment,
  type Enrichment,
  type PortEnrichment,
  type VesselEnrichment,
} from "../../../transport/entity.js";
import {
  findEntity,
  readPosition,
  readProperties,
} from "../../../entity-panel/read.js";
import { safeHttpUrl } from "../../../shell/safeUrl.js";
import { useDetected } from "../../../situations/detectedStore.js";
import { useRingFx } from "../mapfx/store.js";
import { useObsPopover } from "../observation/ObsPopover.js";
import { VesselPanel } from "./VesselPanel.js";
import {
  BAND_KM,
  BANDS,
  RING_BANDS,
  bandCounts,
  bboxAround,
  distKm,
  hourlyBaseline,
  scaleMax,
  type ArchiveTrack,
} from "./activity.js";

// The object side panel (reference hero-object page, `.obj`): header,
// key-values, DETAILS with a photo and description, DETECTED ACTIVITY with a
// warning callout and a distance histogram against the archive baseline, and
// OBSERVATIONS. The copy's absolute rows are re-expressed in flow at the same
// y (hd 10, kv 76, band 137, photo 181, text 330, kv 407, band 503, warn 550,
// chart 608, band 797, card 838), so collapsing a band closes its gap.
//
// Every value comes from GET /api/entity/<id> (NGA WPI for ports, the vessel
// and aircraft registries), the live entity on the map, GET
// /api/maritime/vessels and GET /api/history/tracks.

/** Kinds this panel draws; every other selection keeps the Selection panel. */
export function isSlateObject(id: string | null): boolean {
  return !!id && /^(port|vessel|aircraft):/.test(id);
}

type Kind = "port" | "vessel" | "aircraft";
interface Pos {
  lat: number;
  lon: number;
  id?: string;
}
interface Live {
  props: Record<string, unknown>;
  pos?: Pos;
  name?: string;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && v !== "Unknown" ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const fmtPos = (p: Pos): string =>
  `${Math.abs(p.lat).toFixed(2)}° ${p.lat >= 0 ? "N" : "S"}, ${Math.abs(p.lon).toFixed(2)}° ${p.lon >= 0 ? "E" : "W"}`;
const hhmmZ = (ms: number): string =>
  `${new Date(ms).toISOString().slice(11, 16)}Z`;

/** Keyless Sentinel-2 chip around a point; backdated because revisit is ~5 days. */
function chipUrl(p: Pos): string {
  const d = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  const q = new URLSearchParams({
    lat: p.lat.toFixed(2),
    lon: p.lon.toFixed(2),
    radius_km: "4",
    date: d,
    source: "sentinel",
  });
  return `/api/imagery/chip?${q.toString()}`;
}

/** "Coastal (Breakwater)" reads as "coastal harbour (breakwater)". */
function harbourPhrase(e: PortEnrichment): string {
  const size = str(e.harborSize)?.toLowerCase();
  const type = str(e.harborType)?.toLowerCase();
  const m = type?.match(/^(.*?)\s*\((.*)\)$/);
  const core = m
    ? `${m[1]} harbour (${m[2]})`
    : type
      ? `${type} harbour`
      : "harbour";
  return [size, core].filter(Boolean).join(" ");
}

export interface View {
  icon: string;
  title: string;
  sub: string;
  kv1: [string, string][];
  photo: { url: string; credit?: string } | null;
  photoWhy: string;
  desc: string | null;
  kv2: [string, string][];
  pos: Pos | null;
}

function viewOf(
  kind: Kind,
  id: string,
  e: Enrichment | null,
  live: Live | null,
): View {
  const p = live?.props ?? {};
  const raw = id.slice(id.indexOf(":") + 1);
  const ePos =
    e &&
    num((e as PortEnrichment).lat) !== null &&
    num((e as PortEnrichment).lon) !== null
      ? {
          lat: (e as PortEnrichment).lat as number,
          lon: (e as PortEnrichment).lon as number,
        }
      : null;
  const pos = live?.pos ?? ePos;
  const dash = "—";
  if (kind === "port") {
    const pe = e?.kind === "port" ? (e as PortEnrichment) : null;
    const name = str(pe?.name) ?? str(p["name"]) ?? `WPI ${raw}`;
    const use = str(pe?.harborUse);
    const sentences: string[] = [];
    if (pe) {
      sentences.push(
        `${name} is a ${harbourPhrase(pe)}, listed in the NGA World Port Index as ${pe.wpi}${use ? ` and used mainly for ${use.toLowerCase()}` : ""}.`,
      );
      const sh = str(pe.shelter)?.toLowerCase();
      const rp = str(pe.repairs)?.toLowerCase();
      const sr = [sh && `shelter is ${sh}`, rp && `repairs ${rp}`]
        .filter(Boolean)
        .join(" and ");
      if (sr) sentences.push(`${sr[0]?.toUpperCase()}${sr.slice(1)}.`);
      const ch = num(pe.channelDepth);
      const dr = num(pe.maxVesselDraft);
      if (ch !== null) sentences.push(`Channel depth ${ch.toFixed(1)} m.`);
      if (dr !== null)
        sentences.push(`Largest draft on record ${dr.toFixed(1)} m.`);
    }
    const len = num(pe?.maxVesselLength);
    const pier = num(pe?.cargoPierDepth);
    return {
      icon: "anchor",
      title: name,
      sub: "Port",
      kv1: [
        ["Location", pos ? fmtPos(pos) : dash],
        ["Type", str(pe?.harborType) ?? dash],
      ],
      photo: pos ? { url: chipUrl(pos), credit: "Sentinel-2" } : null,
      photoWhy: "No position for an imagery chip",
      desc: sentences.length ? sentences.join(" ") : null,
      kv2: [
        ["Max vessel length", len !== null ? `${Math.round(len)} m` : dash],
        ["Cargo pier depth", pier !== null ? `${pier.toFixed(1)} m` : dash],
        ["Primary use", use ?? dash],
      ],
      pos,
    };
  }
  if (kind === "vessel") {
    const ve = e?.kind === "vessel" ? (e as VesselEnrichment) : null;
    const name = str(ve?.name) ?? str(p["name"]) ?? live?.name ?? `MMSI ${raw}`;
    const type =
      str(ve?.vessel_type) ?? str(p["shipType"]) ?? str(p["ship_type"]);
    const near = str(ve?.nearest_port);
    const nd = num(ve?.nearest_port_distance_km);
    const len = num(ve?.length_m);
    const sog = num(p["sog"]);
    const thumb = safeHttpUrl(ve?.photo_thumb_url);
    return {
      icon: "ship",
      title: name,
      sub: type ?? "Vessel",
      kv1: [
        [
          "Location",
          near
            ? nd !== null
              ? `${nd.toFixed(0)} km from ${near}`
              : near
            : pos
              ? fmtPos(pos)
              : dash,
        ],
        ["Type", type ?? dash],
      ],
      photo: thumb
        ? { url: thumb, credit: str(ve?.photo_credit) ?? "Wikipedia" }
        : pos
          ? { url: chipUrl(pos), credit: "Sentinel-2" }
          : null,
      photoWhy: "No photo or position on record",
      desc: str(ve?.description),
      kv2: [
        [
          "Flag",
          str(ve?.flag_country) ?? str(ve?.flag) ?? str(p["flag"]) ?? dash,
        ],
        ["Length", len !== null ? `${Math.round(len)} m` : dash],
        ["Speed", sog !== null ? `${sog.toFixed(1)} kn` : dash],
      ],
      pos,
    };
  }
  const ae = e?.kind === "aircraft" ? (e as AircraftEnrichment) : null;
  const call = str(p["callsign"]);
  const reg = str(ae?.registration) ?? str(p["registration"]);
  const type = str(ae?.type) ?? str(p["type"]);
  const op = str(ae?.route_airline) ?? str(ae?.operator);
  const alt = num(p["baro_alt_m"]) ?? num(p["geo_alt_m"]);
  const thumb = safeHttpUrl(ae?.photo_thumb_url);
  const from = str(ae?.origin?.name);
  const to = str(ae?.destination?.name);
  const desc = [
    type &&
      `${type}${reg ? ` registered ${reg}` : ""}${op ? `, operated by ${op}` : ""}.`,
    from && to && `Filed route ${from} to ${to}.`,
    str(ae?.country_origin) && `Registered in ${ae?.country_origin}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    icon: "airplane",
    title: call ?? reg ?? raw.toUpperCase(),
    sub: type ?? "Aircraft",
    kv1: [
      ["Location", pos ? fmtPos(pos) : dash],
      ["Type", type ?? dash],
    ],
    photo: thumb
      ? {
          url: thumb,
          credit: `Planespotters${ae?.photo_photographer ? ` · ${ae.photo_photographer}` : ""}`,
        }
      : null,
    photoWhy: "No photo on record for this airframe",
    desc: desc || null,
    kv2: [
      ["Registration", reg ?? dash],
      ["Operator", op ?? dash],
      [
        "Altitude",
        alt !== null
          ? `${Math.round(alt * 3.28084).toLocaleString()} ft`
          : p["on_ground"] === true
            ? "On ground"
            : dash,
      ],
    ],
    pos,
  };
}

interface Activity {
  counts: number[];
  /** Live contacts inside the selection ring (drawn as glows, G17). */
  ring: Pos[];
  baseline: number | null;
  at: number;
  err: string | null;
  liveDone: boolean;
  baseErr: string | null;
  baseDone: boolean;
}

/** Live contacts by band, and the archive baseline, for one object. */
function useActivity(id: string, kind: Kind, pos: Pos | null): Activity | null {
  const [a, setA] = useState<Activity | null>(null);
  // ~10 km grid: a moving contact refetches as it travels, not every fix
  // (a 2 s refetch aborted the 24 h archive query before it answered).
  const key = pos ? `${pos.lat.toFixed(1)},${pos.lon.toFixed(1)}` : "";
  useEffect(() => setA(null), [id]);
  useEffect(() => {
    if (!pos) return;
    const ac = new AbortController();
    const [w, s, e, n] = bboxAround(pos.lat, pos.lon);
    const contact = kind === "aircraft" ? "aircraft" : "vessel";
    const nowS = Date.now() / 1000;
    const hist = (from: number): Promise<Response> =>
      apiFetch(
        `/api/history/tracks?kind=${contact}&min_lon=${w}&min_lat=${s}&max_lon=${e}&max_lat=${n}&from_ts=${Math.floor(from)}&limit_ids=2000`,
        { signal: ac.signal },
      );
    const pullLive = (): Promise<{ pts: Pos[]; err: string | null }> =>
      contact === "vessel"
        ? apiFetch(`/api/maritime/vessels?bbox=${w},${s},${e},${n}`, {
            signal: ac.signal,
          }).then(async (r) => {
            if (!r.ok)
              return {
                pts: [],
                err: `Live AIS unavailable (HTTP ${r.status})`,
              };
            const j = (await r.json()) as {
              vessels?: { id: string; lat: number; lon: number }[];
            };
            return {
              pts: (j.vessels ?? [])
                .filter((v) => v.id !== id)
                .map((v) => ({ id: v.id, lat: v.lat, lon: v.lon })),
              err: null,
            };
          })
        : // Aircraft: the last fix per airframe in the archive's last 5 minutes.
          hist(nowS - 300).then(async (r) => {
            if (!r.ok)
              return {
                pts: [],
                err: `Live ADS-B unavailable (HTTP ${r.status})`,
              };
            const j = (await r.json()) as { tracks?: ArchiveTrack[] };
            return {
              pts: (j.tracks ?? [])
                .filter((t) => t.id !== id && t.points.length)
                .map((t) => {
                  const last = t.points[t.points.length - 1] ?? [];
                  return { id: t.id, lon: last[0] ?? NaN, lat: last[1] ?? NaN };
                }),
              err: null,
            };
          });
    const base: Promise<{ b: number | null; err: string | null }> = hist(
      nowS - 86400,
    ).then(async (r) => {
      if (!r.ok)
        return { b: null, err: `Archive unavailable (HTTP ${r.status})` };
      const j = (await r.json()) as { tracks?: ArchiveTrack[] };
      return {
        b: hourlyBaseline(
          pos.lat,
          pos.lon,
          (j.tracks ?? []).filter((t) => t.id !== id),
        ),
        err: null,
      };
    });
    // Live counts land first; the 24 h archive scan can take seconds.
    const empty: Activity = {
      counts: new Array<number>(BANDS).fill(0),
      ring: [],
      at: Date.now(),
      err: null,
      liveDone: false,
      baseline: null,
      baseErr: null,
      baseDone: false,
    };
    // "Inside the ring now" stays true: the live count re-pulls every 30 s
    // (the 24 h baseline below is pulled once).
    const applyLive = (): void => {
      pullLive()
        .then((l) =>
          setA((prev) => ({
            ...(prev ?? empty),
            counts: bandCounts(pos.lat, pos.lon, l.pts),
            ring: l.pts.filter(
              (q) =>
                distKm(pos.lat, pos.lon, q.lat, q.lon) < RING_BANDS * BAND_KM,
            ),
            at: Date.now(),
            err: l.err,
            liveDone: true,
          })),
        )
        .catch(() => undefined);
    };
    applyLive();
    const poll = window.setInterval(applyLive, 30_000);
    base
      .then((b) =>
        setA((prev) => ({
          ...(prev ?? empty),
          baseline: b.b,
          baseErr: b.err,
          baseDone: true,
        })),
      )
      .catch(() => undefined);
    return () => {
      window.clearInterval(poll);
      ac.abort();
    };
  }, [id, kind, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return a;
}

type Section = "details" | "activity" | "obs" | "props" | "series";

export function SlateObject({
  id,
  viewer,
  onClose,
  selection,
  series,
}: {
  id: string;
  viewer: Cesium.Viewer | null;
  onClose: () => void;
  selection?: ReactNode;
  series?: ReactNode;
}): JSX.Element {
  const kind = id.slice(0, id.indexOf(":")) as Kind;
  const [enr, setEnr] = useState<Enrichment | null>(null);
  const [enrDone, setEnrDone] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [open, setOpen] = useState<Record<Section, boolean>>({
    details: true,
    activity: true,
    obs: true,
    props: false,
    series: false,
  });
  const [more, setMore] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [imgDone, setImgDone] = useState<{ url: string; ok: boolean } | null>(
    null,
  );

  // The live entity on the map, re-read every 2 s (position and speed move).
  useEffect(() => {
    setLive(null);
    if (!viewer) return;
    const tick = (): void => {
      if (viewer.isDestroyed()) return;
      const e = findEntity(viewer, id);
      if (!e) return;
      const pos = readPosition(e, viewer);
      setLive({
        props: readProperties(e),
        ...(pos ? { pos: { lat: pos.lat, lon: pos.lon } } : {}),
        ...(e.name ? { name: e.name } : {}),
      });
    };
    tick();
    const t = window.setInterval(tick, 2000);
    return () => window.clearInterval(t);
  }, [viewer, id]);

  const callsign =
    typeof live?.props["callsign"] === "string" ? live.props["callsign"] : null;
  useEffect(() => {
    setEnr(null);
    setEnrDone(false);
    setMore(false);
    const ac = new AbortController();
    fetchEnrichment(id, ac.signal, callsign ? { callsign } : undefined)
      .then((e) => setEnr(e))
      .catch(() => undefined)
      .finally(() => setEnrDone(true));
    return () => ac.abort();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Off-map contacts (the layer caps what it holds): the archive's last fix.
  const [archPos, setArchPos] = useState<{ pos: Pos; t: number } | null>(null);
  const noLive = !live?.pos;
  useEffect(() => {
    setArchPos(null);
    if (kind === "port" || !noLive) return;
    const ac = new AbortController();
    const from = Math.floor(Date.now() / 1000 - 6 * 3600);
    apiFetch(
      `/api/history/track?id=${encodeURIComponent(id)}&from_ts=${from}&limit=20000`,
      { signal: ac.signal },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { tracks?: ArchiveTrack[] } | null) => {
        const pts = j?.tracks?.[0]?.points ?? [];
        const last = pts[pts.length - 1];
        if (last && typeof last[0] === "number" && typeof last[1] === "number")
          setArchPos({ pos: { lon: last[0], lat: last[1] }, t: last[2] ?? 0 });
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [id, kind, noLive]);

  const v = useMemo(
    () =>
      viewOf(
        kind,
        id,
        enr,
        live?.pos || !archPos
          ? live
          : { props: live?.props ?? {}, pos: archPos.pos },
      ),
    [kind, id, enr, live, archPos],
  );
  const imgState: "wait" | "ok" | "err" =
    imgDone && imgDone.url === v.photo?.url
      ? imgDone.ok
        ? "ok"
        : "err"
      : "wait";
  const act = useActivity(id, kind, v.pos);
  // G17: the ring the count is taken inside, and its contacts, on the map.
  useEffect(() => {
    if (!act?.liveDone || !v.pos) return;
    useRingFx
      .getState()
      .set({ center: v.pos, km: RING_BANDS * BAND_KM, glows: act.ring });
    return () => useRingFx.getState().set(null);
  }, [act, v.pos?.lat, v.pos?.lon]); // eslint-disable-line react-hooks/exhaustive-deps
  const det = useDetected((s) => s.det);
  const near =
    det && v.pos ? distKm(v.pos.lat, v.pos.lon, det.lat, det.lon) : Infinity;
  const obs = det && near <= 50 + det.r_km && dismissed !== id ? det : null;

  const toggle = (s: Section): void => setOpen((o) => ({ ...o, [s]: !o[s] }));
  const band = (s: Section, text: string, mt: number): JSX.Element => (
    <button
      type="button"
      className="oband"
      style={{ marginTop: mt }}
      aria-expanded={open[s]}
      onClick={() => toggle(s)}
    >
      <BpIcon name={open[s] ? "chevron-down" : "chevron-right"} size={12} />
      {text}
    </button>
  );

  const contact = kind === "aircraft" ? "aircraft" : "vessels";
  const inRing = act
    ? act.counts.slice(0, RING_BANDS).reduce((a, b) => a + b, 0)
    : 0;
  const M = act ? scaleMax(act.counts, act.baseline) : 6;
  const px = 66 / M;

  const rest = (
    <>
      {band("obs", "OBSERVATIONS", 24)}
      {open.obs && (
        <div className="obs" style={{ marginTop: 10 }}>
          <span className="t">
            <BpIcon
              name="predictive-analysis"
              size={20}
              style={{ color: "#3fa59b" }}
            />
            {obs
              ? `Anchorage detector rates this area ${obs.sanctioned > 0 ? "high" : "medium"}: ${obs.n} vessels stationary within ${obs.r_km} km`
              : det
                ? "No detector observation within 50 km of this object."
                : "The anchorage detector has not reported yet."}
          </span>
          {obs && (
            <span className="acts">
              <button
                type="button"
                className="rv"
                onClick={() => useObsPopover.getState().open(obs)}
              >
                Review
              </button>
              <button
                type="button"
                className="ds"
                onClick={() => setDismissed(id)}
              >
                Dismiss
              </button>
            </span>
          )}
        </div>
      )}

      {/* Below the copy's frame: the full Selection and Series panels, so
          nothing the old inspector offered is lost. */}
      {selection !== undefined && band("props", "ALL PROPERTIES", 24)}
      {selection !== undefined && open.props && (
        <div className="sl-oinner">{selection}</div>
      )}
      {series !== undefined && band("series", "SERIES", 1)}
      {series !== undefined && open.series && (
        <div className="sl-oinner">{series}</div>
      )}
    </>
  );

  if (kind === "vessel")
    return (
      <VesselPanel
        id={id}
        v={v}
        enr={enr?.kind === "vessel" ? (enr as VesselEnrichment) : null}
        props={live?.props ?? {}}
        onClose={onClose}
        onMore={() => setOpen((o) => ({ ...o, props: true }))}
        rest={rest}
      />
    );

  return (
    <div className="sl-obj">
      <div className="hd">
        <span className="ic">
          <BpIcon name={v.icon} size={40} />
        </span>
        <div>
          <h3>{v.title}</h3>
          <div className="sub">{v.sub}</div>
        </div>
      </div>
      <button
        type="button"
        className="x"
        aria-label="Close the object panel"
        title="Close"
        onClick={onClose}
      >
        <BpIcon name="cross" size={16} />
      </button>
      <div className="okv" style={{ marginTop: 20 }}>
        {v.kv1.map(([k, val]) => (
          <KV key={k} k={k} v={val} />
        ))}
      </div>

      {band("details", "DETAILS", 14)}
      {open.details && (
        <>
          <div className="sl-photo">
            {v.photo ? (
              <>
                {imgState !== "ok" && (
                  <span className="sl-oempty">
                    {imgState === "err"
                      ? `${v.photo.credit ?? "Imagery"} unavailable for this point`
                      : "loading imagery…"}
                  </span>
                )}
                <img
                  src={v.photo.url}
                  alt={`${v.title}, ${v.photo.credit ?? "photo"}`}
                  style={
                    imgState === "ok"
                      ? undefined
                      : { position: "absolute", opacity: 0 }
                  }
                  onLoad={(e) =>
                    setImgDone({
                      url: e.currentTarget.getAttribute("src") ?? "",
                      ok: true,
                    })
                  }
                  onError={(e) =>
                    setImgDone({
                      url: e.currentTarget.getAttribute("src") ?? "",
                      ok: false,
                    })
                  }
                />
                {v.photo.credit && <span className="cr">{v.photo.credit}</span>}
              </>
            ) : (
              <span className="sl-oempty">{v.photoWhy}</span>
            )}
          </div>
          <div className="sl-desc">
            {v.desc ? (
              <>
                {more ? v.desc : clip(v.desc)}{" "}
                {(more || clip(v.desc) !== v.desc) && (
                  <button
                    type="button"
                    className="sl-showmore"
                    onClick={() => setMore((m) => !m)}
                  >
                    {more ? "Show less." : "Show more."}
                  </button>
                )}
              </>
            ) : enrDone ? (
              "No description on record for this object."
            ) : (
              "loading…"
            )}
          </div>
          <div className="okv" style={{ marginTop: 18 }}>
            {v.kv2.map(([k, val]) => (
              <KV key={k} k={k} v={val} />
            ))}
          </div>
        </>
      )}

      {band("activity", "DETECTED ACTIVITY", 21)}
      {open.activity && (
        <>
          <div className="warnc" style={{ marginTop: 16 }}>
            <BpIcon name="warning-sign" size={22} />
            {!v.pos
              ? "No position to measure activity around"
              : !act?.liveDone
                ? "Counting live contacts…"
                : act.err
                  ? act.err
                  : `${inRing} ${inRing === 1 ? contact.replace(/s$/, "") : contact} inside the selection ring now`}
          </div>
          <div className="chart" style={{ marginTop: 10 }}>
            <span className="yl">
              # {kind === "aircraft" ? "Aircraft" : "Vessels"}
            </span>
            <span className="yt">
              {M}
              <br />
              {(2 * M) / 3}
              <br />
              {M / 3}
              <br />0
            </span>
            <svg
              width="432"
              height="165"
              aria-label="Contacts by distance band"
            >
              {act?.baseline != null && (
                <line
                  x1="64"
                  y1={86 - act.baseline * px}
                  x2="406"
                  y2={86 - act.baseline * px}
                  stroke="#4c90f0"
                  strokeWidth="2"
                >
                  <title>{`Archive baseline ${act.baseline.toFixed(1)} per band per hour`}</title>
                </line>
              )}
              {(act?.counts ?? new Array<number>(BANDS).fill(0)).map((n, i) => (
                <rect
                  key={i}
                  x={70 + i * 42}
                  y={86 - n * px}
                  width="26"
                  height={n * px + 1}
                  fill={i < RING_BANDS ? "#4c3a2a" : "#3a464a"}
                  stroke={i < RING_BANDS ? "#c58a4a" : "#5b6a6e"}
                >
                  <title>{`${n} within ${(i * BAND_KM).toFixed(1)} to ${((i + 1) * BAND_KM).toFixed(1)} km`}</title>
                </rect>
              ))}
            </svg>
            <span className="xt">
              {Array.from({ length: BANDS }, (_, i) => (
                <span key={i}>{(i * BAND_KM).toString()}</span>
              ))}
            </span>
            <span className="cap">
              km from the {kind}, live {kind === "aircraft" ? "ADS-B" : "AIS"}
              {act?.liveDone ? `, ${hhmmZ(act.at)}` : ""}
              {!act?.baseDone
                ? ". Reading the 24 h archive…"
                : act.baseline == null
                  ? act.baseErr
                    ? `. ${act.baseErr}`
                    : ". No archived positions here in 24 h"
                  : ""}
            </span>
          </div>
        </>
      )}

      {rest}
    </div>
  );
}

/** The copy's three-line description: cut at a word, then "Show more.". */
const CLIP = 160;
function clip(t: string): string {
  if (t.length <= CLIP) return t;
  const cut = t.lastIndexOf(" ", CLIP);
  return `${t.slice(0, cut > 0 ? cut : CLIP).replace(/[.,;:]$/, "")}…`;
}

function KV({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </>
  );
}
