import "./toolCatalog.css";
import type { LayerRegistry } from "../../../registry/LayerRegistry.js";
import { BpIcon } from "../../../shell/BpIcon.js";
import { useAppView, type AppId } from "../../../state/appView.js";
import { useMapTools, type MapTool } from "../../../globe/mapTools.js";
import { openMapToolPanel } from "../../../shell/panels/MapToolPanels.js";
import {
  MAP_LAYER_FOLDERS,
  rowEnabled,
  toggleRow,
} from "../../../normal/layerCatalog.js";

// The map panel's Tools tab as the reference catalog (row M6): tool groups,
// each with its description and tiles. Every tile is wired to something this
// app really does (a map tool, a layer, a tool panel or an app); a tile with
// nothing behind it is disabled and says why.

type Act =
  | { tool: MapTool }
  | { layer: string }
  | { panel: string }
  | { app: AppId }
  | { none: string };

interface Tile {
  label: string;
  icon: string;
  act: Act;
  title: string;
}
interface Group {
  title: string;
  icon: string;
  desc: string;
  guided?: AppId;
  tiles: Tile[];
}

const GROUPS: Group[] = [
  {
    title: "Range ring",
    icon: "target",
    desc: "Calculate the distance between any given point and a vessel or port",
    tiles: [
      {
        label: "Range ring",
        icon: "circle",
        act: { tool: "measure" },
        title: "Measure out from a point on the map",
      },
      {
        label: "Line of bearing",
        icon: "arrow-top-right",
        act: { tool: "measure" },
        title: "Draw a line and read its length",
      },
      {
        label: "Chokepoint buffer",
        icon: "polygon-filter",
        act: { layer: "Chokepoint congestion" },
        title: "Show the chokepoint congestion layer",
      },
    ],
  },
  {
    title: "Alerts",
    icon: "notifications",
    desc: "Get alerted when vessels enter a designated region based on your selections and alert conditions",
    tiles: [
      {
        label: "Geofence",
        icon: "polygon-filter",
        act: { panel: "watch" },
        title: "Open the watchbox rules",
      },
      {
        label: "Proximity",
        icon: "locate",
        act: { panel: "watch" },
        title: "Open the watchbox rules",
      },
    ],
  },
  {
    title: "Imagery",
    icon: "satellite",
    desc: "Collect and review imagery in an area to inform movement",
    guided: "video",
    tiles: [
      {
        label: "Collect",
        icon: "media",
        act: { app: "video" },
        title: "Open the video and imagery app",
      },
      {
        label: "SAR scenes",
        icon: "satellite",
        act: { layer: "Dark-vessel SAR" },
        title: "Show the SAR detection layer",
      },
      {
        label: "Detect vessels",
        icon: "search",
        act: { app: "video" },
        title: "Run detection on an imagery plate",
      },
      {
        label: "Compare",
        icon: "comparison",
        act: { app: "video" },
        title: "Open the imagery app",
      },
      {
        label: "Change",
        icon: "changes",
        act: { app: "video" },
        title: "Open the imagery app",
      },
    ],
  },
  {
    title: "Track analysis",
    icon: "route",
    desc: "Detect important behaviour in vessel tracks",
    guided: "targeting",
    tiles: [
      {
        label: "Dark gaps",
        icon: "eye-off",
        act: { none: "No AIS-gap detector runs on this deployment" },
        title: "",
      },
      {
        label: "Loitering",
        icon: "time",
        act: { layer: "Parking mode" },
        title: "Show vessels holding position",
      },
      {
        label: "Ship-to-ship",
        icon: "exchange",
        act: { none: "No ship-to-ship detector runs on this deployment" },
        title: "",
      },
    ],
  },
  {
    title: "Heatmap",
    icon: "heatmap",
    desc: "Visually aggregate on your map",
    tiles: [
      {
        label: "Heatmap",
        icon: "heatmap",
        act: { layer: "AIS coverage" },
        title: "Show AIS coverage density",
      },
      {
        label: "Choropleth",
        icon: "map",
        act: { none: "No choropleth layer is built yet" },
        title: "",
      },
    ],
  },
  {
    title: "GRG builder",
    icon: "layout-grid",
    desc: "Add groups of sequential reference points to your map to coordinate communications about important locations",
    tiles: [
      {
        label: "Select an area",
        icon: "layout-grid",
        act: { tool: "area" },
        title: "Drag an area on the map",
      },
      {
        label: "Annotate",
        icon: "map-marker",
        act: { tool: "annotate" },
        title: "Drop an annotation on the map",
      },
      {
        label: "Annotations",
        icon: "annotation",
        act: { panel: "annotate" },
        title: "Open the annotation panel",
      },
      {
        label: "Field kit",
        icon: "wrench",
        act: { panel: "field" },
        title: "Open the field kit",
      },
    ],
  },
];

const ROW_BY_LABEL = new Map(
  MAP_LAYER_FOLDERS.flatMap((f) => f.rows).map((r) => [r.label, r]),
);

export function ToolCatalog({
  registry,
  match,
}: {
  registry: LayerRegistry;
  match: (s: string) => boolean;
}): JSX.Element {
  const setApp = useAppView((s) => s.setApp);
  const tool = useMapTools((s) => s.tool);
  const setTool = useMapTools((s) => s.setTool);
  const groups = GROUPS.map((g) => ({
    ...g,
    tiles: match(g.title) ? g.tiles : g.tiles.filter((t) => match(t.label)),
  })).filter((g) => g.tiles.length > 0);

  const run = (a: Act): void => {
    if ("tool" in a) setTool(tool === a.tool ? "pan" : a.tool);
    else if ("layer" in a) {
      const row = ROW_BY_LABEL.get(a.layer);
      if (row) toggleRow(registry, row);
    } else if ("panel" in a) openMapToolPanel(a.panel);
    else if ("app" in a) setApp(a.app);
  };
  const on = (a: Act): boolean | undefined => {
    if ("tool" in a) return tool === a.tool;
    if ("layer" in a) {
      const row = ROW_BY_LABEL.get(a.layer);
      return row ? rowEnabled(registry, row) : false;
    }
    return undefined;
  };

  return (
    <div className="tcat">
      {groups.map((g) => (
        <section key={g.title} className="card">
          <BpIcon name={g.icon} className="gi" />
          <h4>{g.title}</h4>
          <p>{g.desc}</p>
          {g.guided && (
            <button
              type="button"
              className="gw"
              onClick={() => setApp(g.guided!)}
            >
              Guided workflow →
            </button>
          )}
          <div className="tiles">
            {g.tiles.map((t) => {
              const pressed = on(t.act);
              const why = "none" in t.act ? t.act.none : null;
              return (
                <button
                  key={t.label}
                  type="button"
                  className={pressed ? "on" : ""}
                  disabled={why !== null}
                  title={why ?? t.title}
                  {...(pressed !== undefined
                    ? { "aria-pressed": pressed }
                    : {})}
                  onClick={() => run(t.act)}
                >
                  <span className="th">
                    <BpIcon name={t.icon} />
                  </span>
                  {t.label}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {groups.length === 0 && <p className="empty">No tool matches.</p>}
    </div>
  );
}
