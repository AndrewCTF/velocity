// D182 Control Panel map defaults and D183 the custom base map form, native.
// Values are the live ones: the replay archive's day count, the globe's own
// opening camera, and the app's real OpenTopo base map entry.
import { THIRD_PARTY_BASEMAPS } from "../../../globe/GlobeCanvas.js";
import { useAppView } from "../../../state/appView.js";
import { useJson, why } from "./data.js";
import { Bar, Btn, Card, Field, Page, Pick } from "./native.js";
import type { Nav } from "./nav.js";

const FIXED = "Fixed by the app; not stored per user here";

export function D182({ nav }: { nav: Nav }): JSX.Element {
  const setApp = useAppView((s) => s.setApp);
  const r = useJson<{ dates: string[] }>("/api/adsb/history/dates");
  const nd = r?.data ? String(r.data.dates.length) : "—";
  const err = why("Replay archive", r);
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Control Panel · <b>Map defaults</b>
          </>
        }
      >
        <Btn icon="share" onClick={() => setApp("map")}>
          Open Velocity
        </Btn>
      </Bar>
      <nav className="fxn-tabs" aria-label="Map settings">
        <button type="button" aria-current="page" disabled title="This section">
          New map defaults
        </button>
        <button
          type="button"
          disabled
          title="Data loading limits are not configurable in this build"
        >
          Data loading
        </button>
        <button
          type="button"
          disabled
          title="Map API keys are set in the server environment"
        >
          API keys
        </button>
        <button type="button" onClick={() => nav.go("d183")}>
          Base maps
        </button>
      </nav>
      <div className="fxn-body">
        <div className="fxn-scroll">
          <div className="fxn-col">
            <div>
              <h1 className="fxn-h1">Map</h1>
              <p className="fxn-sub">
                Defaults for new maps and the replay window.
              </p>
            </div>
            <div className="fxn-grid">
              <Card title="Default viewport">
                <p className="fxn-p">
                  The initial view of the globe: the point it centres on and how
                  far it zooms.
                </p>
                {/* the literal arguments of flyToGlobal (apps/web/src/globe/camera.ts); the globe fits its altitude, so no numeric zoom */}
                <div className="fxn-pair">
                  <Field
                    label="Latitude"
                    value="35"
                    hint="(default: 35)"
                    why={FIXED}
                  />
                  <Field
                    label="Longitude"
                    value="20"
                    hint="(default: 20)"
                    why={FIXED}
                  />
                  <Field
                    label="Zoom"
                    placeholder="Fit globe"
                    hint="(default: fit globe)"
                    why={FIXED}
                  />
                </div>
              </Card>
              <Card title="Default time selection">
                <p className="fxn-p">
                  The number of days that the default time selection spans.
                </p>
                <Field
                  label="Days"
                  value={nd}
                  hint={`(default: ${nd})`}
                  why="Read from the replay archive"
                />
                {err ? (
                  <p
                    className="fxn-p"
                    role="alert"
                    style={{ color: "#ac2f33" }}
                  >
                    {err}
                  </p>
                ) : null}
              </Card>
              <Card title="Default unit system">
                <p className="fxn-p">Sets the default unit system for users.</p>
                <Pick
                  label="Organization default"
                  value="Feed native"
                  why="Units follow each feed"
                />
                <div>
                  <div className="fxn-lbl">Group overrides</div>
                  <p className="fxn-p">
                    The first group a user belongs to decides their unit system;
                    with none, the organization default applies.
                  </p>
                </div>
                <div className="fxn-item">
                  <span>No group overrides configured</span>
                </div>
                <div>
                  <Btn why="Velocity has no user groups to override">
                    Add group override
                  </Btn>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}

export function D183({ nav }: { nav: Nav }): JSX.Element {
  // the app's real OpenTopo entry (apps/web/src/globe/GlobeCanvas.tsx THIRD_PARTY_BASEMAPS)
  const ot = THIRD_PARTY_BASEMAPS.opentopo;
  const credit = ot.credit.replace(/:/g, "");
  const zmax = ot.maximumLevel;
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Control Panel · Map · <b>Custom base map</b>
          </>
        }
      >
        <Btn onClick={() => nav.go("d182")}>Cancel</Btn>
        <Btn
          primary
          why="OpenTopo is already one of the app's base maps; custom base maps are not stored"
        >
          Save
        </Btn>
      </Bar>
      <div className="fxn-body">
        <div className="fxn-scroll">
          <div className="fxn-col" style={{ maxWidth: 760 }}>
            <h1 className="fxn-h1">Custom base map configuration</h1>
            <Card>
              <fieldset
                className="fxn-pair"
                style={{ border: 0, padding: 0, margin: 0 }}
              >
                <legend
                  className="fxn-lbl"
                  style={{ padding: 0, marginBottom: 4 }}
                >
                  Type
                </legend>
                <label className="fxn-tile on fxn-chk">
                  <input
                    type="radio"
                    name="bm-type"
                    checked
                    onChange={() => undefined}
                  />
                  Raster
                </label>
                <label
                  className="fxn-tile fxn-chk"
                  title="Only raster tile sets are supported here"
                >
                  <input type="radio" name="bm-type" disabled />
                  Mapbox
                </label>
              </fieldset>
              <Field
                label="Name"
                value="OpenTopo"
                why="OpenTopo is the app's own entry"
              />
              <Field
                label="Attribution"
                value={credit}
                why="OpenTopo is the app's own entry"
              />
              <Field
                label="Raster tile URL"
                value={ot.url}
                why="OpenTopo is the app's own entry"
              />
              {/* Cesium UrlTemplateImageryProvider's default tile size; the app does not set one */}
              <Field
                label="Tile size (px)"
                value="256"
                why="The Cesium default; the app does not set one"
              />
              <div>
                <div className="fxn-lbl">Zoom range</div>
                <p className="fxn-p">
                  The maximum and minimum zoom levels for which the tileset has
                  data
                </p>
                <div
                  className="fxn-range"
                  role="img"
                  aria-label={`Zoom 0 to ${zmax} of 24`}
                >
                  <i style={{ width: `${(zmax / 24) * 100}%` }} />
                </div>
                <div className="fxn-range-l">
                  <span>0</span>
                  <span>{zmax}</span>
                  <span>24</span>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </Page>
  );
}
