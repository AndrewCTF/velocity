// Workshop map widget configuration pages D197-D199, native: the map fills the
// pane and the configurator is a side panel that reflows. D197 reads the layer
// registry and basemaps.ts, D198 the TimeDock behaviour, D199 a real Foundry
// transform; D198 sits on the live aircraft plate and D199 on the live vessel
// plate (the layer it styles).
import { useEffect, useMemo, useState } from "react";
import { BASEMAP_OPTIONS } from "../../../globe/basemaps.js";
import { defaultLayers } from "../../../registry/defaults.js";
import { Glyph, Ii } from "./kit.js";
import { VesselMap } from "./LegacyMap.js";
import {
  Bar,
  Btn,
  Field,
  MapNote,
  MapStage,
  Page,
  Pick,
  Sec,
  Seg,
  Switch,
  dash,
  useMap,
} from "./native.js";
import { Plate } from "./Plate.js";
import {
  aircraftOf,
  densCenter,
  nf,
  proj,
  useJson,
  why,
  type Dataset,
  type Status,
  type Transform,
} from "./data.js";
import type { Nav } from "./nav.js";

const LOCKED = "Fixed by the app; the layer registry sets this";

/** The live ADS-B plate at its densest airborne cell; `onCenter` reports that cell. */
function AircraftMap({
  onCenter,
}: {
  onCenter?: (c: [number, number]) => void;
}): JSX.Element {
  const m = useMap(10.2, 795);
  const g = useJson<Parameters<typeof aircraftOf>[0]>("/api/adsb/global");
  const ac = useMemo(() => (g?.data ? aircraftOf(g.data) : null), [g]);
  const [lo, la] = useMemo(
    () =>
      ac && m.w > 0
        ? densCenter(
            m.zf,
            m.w,
            m.h,
            ac.filter((a) => !a.on_ground),
          )
        : [0, 0, 0],
    [ac, m.zf, m.w, m.h],
  );
  useEffect(() => {
    if (ac && m.w > 0) onCenter?.([lo, la]);
  }, [ac, m.w, lo, la, onCenter]);
  const fn = useMemo(
    () => proj(lo, la, m.zf, m.w, m.h),
    [lo, la, m.zf, m.w, m.h],
  );
  const svg = ac ? (
    <g className="fxn-halo">
      {ac
        .map((a) => [a, ...fn(a.lon, a.lat)] as const)
        .filter(([, x, y]) => x > 0 && x < m.w && y > 0 && y < m.h)
        .map(([a, x, y], i) => {
          const em = a.emergency && a.emergency !== "none";
          return (
            <Glyph
              key={i}
              name="airplane"
              x={x}
              y={y}
              s={24}
              col={em ? "#c14a4a" : a.on_ground ? "#b9a9ee" : "#3d6fd1"}
              rot={(a.track_deg ?? 45) - 45}
            />
          );
        })}
    </g>
  ) : null;
  return (
    <MapStage m={m} lon={ac ? lo : null} lat={ac ? la : null} svg={svg}>
      <MapNote text={why("Live aircraft", g)} />
    </MapStage>
  );
}

function Thumb({ c }: { c: [number, number] | null }): JSX.Element {
  return (
    <span className="fxn-thumb" aria-hidden>
      {c ? (
        <div>
          <Plate lon={c[0]} lat={c[1]} zf={6} W={80} H={80} />
        </div>
      ) : null}
    </span>
  );
}

function Cap({ children }: { children: string }): JSX.Element {
  return <div className="fxn-cap">{children}</div>;
}

function Row({
  label,
  children,
  desc,
}: {
  label: string;
  children: JSX.Element;
  desc?: string;
}): JSX.Element {
  return (
    <div className="fxn-toggle-row">
      <div>
        <Cap>{label}</Cap>
        {desc ? <p className="fxn-p">{desc}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function D197({ nav }: { nav: Nav }): JSX.Element {
  const st = useJson<Status>("/api/status");
  const [c, setC] = useState<[number, number] | null>(null);
  const [layers, setLayers] = useState(true);
  const [bm, setBm] = useState(true);
  const nAc = st?.data?.aircraft_count;
  const L0 = defaultLayers.find((l) => l.id === "aviation.adsb.global");
  const bmLabels = BASEMAP_OPTIONS.map((b) => b.label);
  const bmT = BASEMAP_OPTIONS.find((b) => b.value === "3d-sat");
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workshop map · <b>Layers and base map</b>
          </>
        }
      />
      <div className="fxn-body">
        <AircraftMap onCenter={setC} />
        <aside className="fxn-panel" aria-label="Map configuration">
          <Sec
            title="LAYERS"
            open={layers}
            onToggle={() => setLayers((o) => !o)}
          >
            <Seg
              label="Configuration source"
              options={["Local configuration", "Import map template"]}
              value="Local configuration"
              why="Map templates are not stored in this build"
            />
            <Cap>Object layers</Cap>
            <div>
              <Btn
                icon="add"
                why="Object layers come from the layer registry (registry/defaults.ts)"
              >
                Add object layer
              </Btn>
            </div>
            <div className="fxn-layer">
              <div>
                <b>{dash(L0?.title)}</b>
                <div className="fxn-by">
                  Current value: {nAc === undefined ? "—" : nf(nAc)}
                </div>
              </div>
              <span className="fxn-leg">
                <span
                  className="fxn-sw-tile"
                  style={{ background: "#2d72d2", width: 24, height: 24 }}
                >
                  {Ii("airplane", 14, "#fff")}
                </span>
                Aircraft
              </span>
            </div>
            <Cap>Overlays</Cap>
            <div>
              <Btn icon="add" why="Overlays are not stored in this build">
                Add overlay
              </Btn>
            </div>
            <Cap>Base map</Cap>
            <button
              type="button"
              className="fxn-layer"
              aria-expanded={bm}
              onClick={() => setBm((o) => !o)}
              style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
            >
              <Thumb c={c} />
              <div>Esri light gray</div>
              {Ii(bm ? "chevron-down" : "chevron-right", 16, "#5f6b7c")}
            </button>
            {bm ? (
              <div
                className="fxn-layer"
                style={{
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: 16,
                  background: "#fff",
                  padding: 16,
                }}
              >
                <Pick label="Base map" value="Esri light gray" why={LOCKED} />
                <div>
                  <div className="fxn-lbl">Base map options</div>
                  <p className="fxn-p">
                    The picker lists {bmLabels.length} base maps; the default is{" "}
                    {bmLabels[0] ?? "—"}.
                  </p>
                  <p className="fxn-p">
                    Esri light gray is a proposed light Esri canvas.
                  </p>
                </div>
                <Pick
                  label="Listed base maps"
                  value={bmLabels.slice(0, 5).join(", ") + ", ..."}
                  why={LOCKED}
                />
                <div>
                  <div className="fxn-lbl">Elevation source</div>
                  <p className="fxn-p">
                    {dash(bmT?.title)}. Choose the {dash(bmT?.label)} base map
                    to use it.
                  </p>
                </div>
              </div>
            ) : null}
            <Row label="Show base layer picker">
              <Switch on label="Show base layer picker" why={LOCKED} />
            </Row>
          </Sec>
          <Sec
            title="INTERACTION"
            why="Interaction options are not configurable in this build"
          />
          <Sec title="TIME CONFIGURATION" onToggle={() => nav.go("d198")} />
        </aside>
      </div>
    </Page>
  );
}

export function D198({ nav }: { nav: Nav }): JSX.Element {
  // states read from apps/web/src/shell/TimeDock.tsx: dock always mounted (timeline Enabled), playhead
  // scrubbable (selected time Enabled), coverage window fixed to retention (TimeDock.tsx:735, off), open at boot (on)
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workshop map · <b>Time configuration</b>
          </>
        }
      />
      <div className="fxn-body">
        <AircraftMap />
        <aside className="fxn-panel" aria-label="Map configuration">
          <div className="fxn-panel-h">
            <b>Map</b>
            <span>MAP</span>
          </div>
          <nav className="fxn-tabs" aria-label="Widget sections">
            <button
              type="button"
              aria-current="page"
              disabled
              title="This section"
            >
              Widget setup
            </button>
            <button
              type="button"
              disabled
              title="Widget metadata is not stored in this build"
            >
              Metadata
            </button>
            <button
              type="button"
              disabled
              title="Display options are not stored in this build"
            >
              Display
            </button>
          </nav>
          <div className="fxn-sec-b" style={{ paddingTop: 16 }}>
            <Row label="Show base layer picker">
              <Switch on={false} label="Show base layer picker" why={LOCKED} />
            </Row>
          </div>
          <Sec
            title="INTERACTION"
            why="Interaction options are not configurable in this build"
          />
          <Sec title="TIME CONFIGURATION" open onToggle={() => nav.go("d197")}>
            <Cap>Enable timeline</Cap>
            <Seg
              label="Enable timeline"
              options={["Disabled", "Enabled"]}
              value="Enabled"
              why="The time dock is always mounted"
            />
            <Cap>Allow user to change selected time</Cap>
            <Seg
              label="Allow user to change selected time"
              options={["Disabled", "Enabled"]}
              value="Enabled"
              why="The playhead is always scrubbable"
            />
            <Row label="Allow user to change time window">
              <Switch
                on={false}
                label="Allow user to change time window"
                why="The coverage window is fixed to the replay retention"
              />
            </Row>
            <Row label="Open timeline by default">
              <Switch
                on
                label="Open timeline by default"
                why="The dock opens at boot"
              />
            </Row>
          </Sec>
        </aside>
      </div>
    </Page>
  );
}

// the app's AIS ship-type and aircraft category colours (apps/web/src/globe/adapters/styles.ts:38-56, not exported):
// cargo, tanker, fishing, passenger, military, sailing, pleasure, tug, SAR, airliner, private, glider
const PAL = [
  "#14b8a6",
  "#d97706",
  "#5eead4",
  "#38bdf8",
  "#f59e0b",
  "#a5f3fc",
  "#4ade80",
  "#c084fc",
  "#ef4444",
  "#facc15",
  "#2dd4bf",
  "#93c5fd",
];

export function D199({ nav }: { nav: Nav }): JSX.Element {
  const tR = useJson<Transform[]>("/api/foundry/transforms");
  const dR = useJson<Dataset[]>("/api/foundry/datasets");
  const tf = tR?.data?.find((t) => t.name === "fast_vessels_tf");
  const dsn = tf
    ? dR?.data?.find((d) => d.id === tf.inputs[0])?.name
    : undefined;
  const steps = tf?.steps ?? [];
  const s0 = steps[0];
  const s1 = steps[1];
  const inputs: Array<[string, string]> =
    s0 && s1
      ? [
          [`${s0.type.toUpperCase()} EXPR`, String(s0.expr ?? "")],
          [`${s1.type.toUpperCase()} COLUMN`, String(s1.column ?? "")],
          [`${s1.type.toUpperCase()} EXPR`, String(s1.expr ?? "")],
        ]
      : [];
  const vis = defaultLayers.find((l) => l.id === "maritime.aisstream")
    ?.visibleByDefault
    ? "Visible"
    : "Hidden";
  const err =
    why("Foundry transforms", tR) ??
    (tR?.ok && !tf ? "Transform fast_vessels_tf not found" : null);
  const [style, setStyle] = useState(true);
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workshop map · <b>Layer style by function</b>
          </>
        }
      >
        <Btn
          primary
          why="The layer style is the app's own palette; there is nothing to publish"
        >
          Save and publish
        </Btn>
        <Btn icon="play" onClick={() => nav.go("d201")}>
          View
        </Btn>
      </Bar>
      <div className="fxn-body">
        <VesselMap legend={false} />
        <aside className="fxn-panel" aria-label="Layer style">
          <div className="fxn-panel-h">
            <b>AIS vessels</b>
            <span>MAP</span>
          </div>
          <nav className="fxn-tabs" aria-label="Widget sections">
            <button
              type="button"
              aria-current="page"
              disabled
              title="This section"
            >
              Widget setup
            </button>
            <button
              type="button"
              disabled
              title="Widget metadata is not stored in this build"
            >
              Metadata
            </button>
            <button
              type="button"
              disabled
              title="Display options are not stored in this build"
            >
              Display
            </button>
          </nav>
          <div className="fxn-sec-b" style={{ paddingTop: 16 }}>
            <Cap>Layer visibility</Cap>
            <Seg
              label="Layer visibility"
              options={["Visible", "Hidden"]}
              value={vis}
              why="Set by the layer registry's default"
            />
            <Row label="Lock layer">
              <Switch on={false} label="Lock layer" why={LOCKED} />
            </Row>
          </div>
          <Sec title="STYLE" open={style} onToggle={() => setStyle((o) => !o)}>
            <Pick
              label="Color by"
              value="Function"
              why="Colour comes from the transform below"
            />
            <div
              className="fxn-layer"
              style={{
                flexDirection: "column",
                alignItems: "stretch",
                gap: 8,
                background: "#fff",
              }}
            >
              <div className="fxn-row">
                <b
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflowWrap: "anywhere",
                    color: tf ? undefined : "#ac2f33",
                  }}
                >
                  {tf?.name ?? err ?? "—"}
                </b>
                <button
                  type="button"
                  className="fxn-btn"
                  aria-label="Open the transform in the pipeline"
                  title={
                    tf
                      ? "Open the transform in the pipeline"
                      : "Transform not loaded"
                  }
                  disabled={!tf}
                  onClick={() => nav.workbench("pipeline")}
                >
                  {Ii("info-sign", 16, "#404854")}
                </button>
              </div>
              <div className="fxn-by">
                on <b>{dash(dsn)}</b>
              </div>
            </div>
            {/* Velocity transforms are not semver-versioned: the version box shows updated_at */}
            <Field
              label="Version"
              value={tf ? tf.updated_at.slice(0, 10) : "—"}
              why="The transform's last update"
            />
            <label
              className="fxn-chk"
              title="Velocity transforms are not versioned"
            >
              <Switch
                on={false}
                label="Auto upgrade to compatible versions"
                why="Velocity transforms are not versioned"
              />
              Auto upgrade to compatible versions
            </label>
            <Cap>Function inputs</Cap>
            {inputs.map(([lab, val]) => (
              <Field
                key={lab}
                label={lab}
                value={val}
                why="The transform step's own expression"
              />
            ))}
            <Pick
              label="Color mapping"
              value="Automatic"
              why="Colours come from the app's own palette"
            />
            <div>
              <div className="fxn-lbl">Select colors</div>
              <div
                className="fxn-swatches"
                role="img"
                aria-label="The app's ship-type and aircraft palette"
              >
                {PAL.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </div>
            </div>
            <Field
              label="Opacity"
              value="1"
              why="The layer registry sets opacity"
            />
          </Sec>
        </aside>
      </div>
    </Page>
  );
}
