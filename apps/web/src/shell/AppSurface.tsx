import { Suspense, lazy, type ReactNode } from "react";
import * as Cesium from "cesium";
import { useAppView, APP_META, type AppId } from "../state/appView.js";
import { TargetKanbanPanel } from "../target-kanban/TargetKanbanPanel.js";
import { TabbedPanel } from "./TabbedPanel.js";
import { useTheme } from "../state/theme.js";

// CityApp is the one surface that drags three + the splat renderer with it —
// code-split so the console bundle doesn't carry a 3D engine nobody opened.
const CityApp = lazy(() =>
  import("../city/CityApp.js").then((m) => ({ default: m.CityApp })),
);
// Every other app is split the same way. Statically imported, they were 452 KB
// of the 2.8 MB boot chunk (yjs via Reports, Foundry, Workflows, the graph
// canvas), parsed before the globe could start, for surfaces the console opens
// on demand. The Suspense below already covers them. Measured 2026-10-17.
const InvestigationCanvas = lazy(() =>
  import("../graph/InvestigationCanvas.js").then((m) => ({
    default: m.InvestigationCanvas,
  })),
);
const InvestigatePanel = lazy(() =>
  import("../osint/InvestigatePanel.js").then((m) => ({
    default: m.InvestigatePanel,
  })),
);
const VideoApp = lazy(() =>
  import("../fmv/VideoApp.js").then((m) => ({ default: m.VideoApp })),
);
const ReportsApp = lazy(() =>
  import("../reports/ReportsApp.js").then((m) => ({ default: m.ReportsApp })),
);
const ExplorerApp = lazy(() =>
  import("../explorer/ExplorerApp.js").then((m) => ({
    default: m.ExplorerApp,
  })),
);
const FoundryApp = lazy(() =>
  import("../foundry/FoundryApp.js").then((m) => ({ default: m.FoundryApp })),
);
const WorkflowsApp = lazy(() =>
  import("../workflows/WorkflowsApp.js").then((m) => ({
    default: m.WorkflowsApp,
  })),
);
const CountryApp = lazy(() =>
  import("../country/CountryApp.js").then((m) => ({ default: m.CountryApp })),
);
const AiHubApp = lazy(() =>
  import("../ai/AiHubApp.js").then((m) => ({ default: m.AiHubApp })),
);
const MarketsApp = lazy(() =>
  import("../markets/MarketsApp.js").then((m) => ({ default: m.MarketsApp })),
);
const ModelsApp = lazy(() =>
  import("../models/ModelsApp.js").then((m) => ({ default: m.ModelsApp })),
);
const QuiverApp = lazy(() =>
  import("../quiver/QuiverApp.js").then((m) => ({ default: m.QuiverApp })),
);
const VertexApp = lazy(() =>
  import("../vertex/VertexApp.js").then((m) => ({ default: m.VertexApp })),
);
const WorkshopApp = lazy(() =>
  import("../workshop/WorkshopApp.js").then((m) => ({
    default: m.WorkshopApp,
  })),
);
// The Slate scheme's targeting: the reference board page wired to the same
// store as TargetKanbanPanel, and its watch workspace (map, recommender,
// taskings) one click away.
const MavenTargeting = lazy(() =>
  import("../slate/features/maven/MavenTargeting.js").then((m) => ({
    default: m.MavenTargeting,
  })),
);
// The Slate scheme's AI app: the AIP copy (terminal, lineage, transforms,
// registry watch manager) over the live routes; the AI hub stays one click in.
const AipApp = lazy(() =>
  import("../slate/features/aip/AipApp.js").then((m) => ({
    default: m.AipApp,
  })),
);
// Slate's Reports app is the Europa copy; Explorer is the PDF copy's workspace.
const EuropaApp = lazy(() =>
  import("../slate/features/europa/EuropaApp.js").then((m) => ({
    default: m.EuropaApp,
  })),
);
const PdfApp = lazy(() =>
  import("../slate/features/pdf/PdfApp.js").then((m) => ({
    default: m.PdfApp,
  })),
);
const SlateFoundry = lazy(() =>
  import("../slate/features/foundry/FoundryApp.js").then((m) => ({
    default: m.SlateFoundry,
  })),
);
const ExtractPanel = lazy(() =>
  import("../extract/ExtractPanel.js").then((m) => ({
    default: m.ExtractPanel,
  })),
);
const CountriesPanel = lazy(() =>
  import("../osint/CountriesPanel.js").then((m) => ({
    default: m.CountriesPanel,
  })),
);
const SourcesPanel = lazy(() =>
  import("../osint/SourcesPanel.js").then((m) => ({ default: m.SourcesPanel })),
);

/** Apps whose content is forms and prose, not a table or a board.
 *
 *  Every one of these was written for the old ~380px rail flyout and then
 *  dropped into a 1,244px surface with no measure on it. Reports drew a
 *  600px-wide `Cancel` button beside a 600px-wide `Finish`; Investigate ran a
 *  paragraph of body text the full width of the console. Neither happens in the
 *  reference, which holds a column and lets the surface breathe around it.
 *
 *  Explorer, Targeting, Graph, Foundry, Workflows, City and Markets are left
 *  full-bleed: a result table, a kanban board and a link canvas all genuinely
 *  use the width. */
const MEASURED = new Set<AppId>([
  "ai",
  "investigate",
  "video",
  "reports",
  "country",
]);

// AppSurface (design §6.1) — the non-Map apps render as a full surface over the
// globe (which stays mounted behind for instant return + shared selection). Map +
// Sim show the globe (Sim's controls are an overlay), so they render nothing here.
export function AppSurface({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element | null {
  const app = useAppView((s) => s.app);
  const scheme = useTheme((s) => s.mode);
  if (app === "map" || app === "sim") return null;

  // Under Slate the board is the copied page, whose toolbar is its header.
  if (app === "targeting" && scheme === "slate")
    return (
      <Suspense
        fallback={
          <div className="mono absolute inset-0 z-(--z-overlay) bg-bg-0 p-3 text-[12px] text-txt-2">
            loading…
          </div>
        }
      >
        <MavenTargeting viewer={viewer} />
      </Suspense>
    );

  if (app === "ai" && scheme === "slate")
    return (
      <Suspense
        fallback={
          <div className="mono absolute inset-0 z-(--z-overlay) bg-bg-0 p-3 text-[12px] text-txt-2">
            loading…
          </div>
        }
      >
        <AipApp viewer={viewer} />
      </Suspense>
    );

  if ((app === "reports" || app === "explorer") && scheme === "slate")
    return (
      <Suspense
        fallback={
          <div className="mono absolute inset-0 z-(--z-overlay) bg-bg-0 p-3 text-[12px] text-txt-2">
            loading…
          </div>
        }
      >
        {app === "reports" ? <EuropaApp viewer={viewer} /> : <PdfApp />}
      </Suspense>
    );

  if (app === "foundry" && scheme === "slate")
    return (
      <Suspense
        fallback={
          <div className="mono absolute inset-0 z-(--z-overlay) bg-bg-0 p-3 text-[12px] text-txt-2">
            loading…
          </div>
        }
      >
        <SlateFoundry viewer={viewer} />
      </Suspense>
    );

  let node: ReactNode;
  switch (app) {
    case "ai":
      node = <AiHubApp viewer={viewer} />;
      break;
    case "explorer":
      node = <ExplorerApp viewer={viewer} />;
      break;
    case "graph":
      node = <InvestigationCanvas />;
      break;
    case "investigate":
      // `panels.ts` re-homes the old `extract` rail item here ("extract → the
      // investigate app"), and nothing rendered it, so the document/entity
      // extractor was constructed in App.tsx and discarded by `byHome`. A
      // recorded home only counts once something is at the address.
      node = (
        <TabbedPanel
          ariaLabel="Investigate"
          defaultTab="lookup"
          tabs={[
            { id: "lookup", label: "Lookup", content: <InvestigatePanel /> },
            { id: "extract", label: "Extract", content: <ExtractPanel /> },
            // Every backend feed with no position on it. It sits beside Lookup
            // because it IS lookup — the same act against a different registry.
            { id: "sources", label: "Sources", content: <SourcesPanel /> },
          ]}
        />
      );
      break;
    case "targeting":
      node = <TargetKanbanPanel viewer={viewer} />;
      break;
    case "video":
      node = <VideoApp viewer={viewer} />;
      break;
    case "reports":
      node = <ReportsApp viewer={viewer} />;
      break;
    case "foundry":
      node = <FoundryApp viewer={viewer} />;
      break;
    case "workflows":
      node = <WorkflowsApp />;
      break;
    case "models":
      node = <ModelsApp />;
      break;
    case "quiver":
      node = <QuiverApp />;
      break;
    case "vertex":
      node = <VertexApp />;
      break;
    case "workshop":
      node = <WorkshopApp />;
      break;
    case "city":
      node = <CityApp />;
      break;
    case "country":
      // Same story as Extract: `countries` is recorded "redundant with the
      // Country app", but the Country app is a per-country dossier and the old
      // panel is the catalogue of national OSINT sources. Two different things,
      // so the redundancy is only true once both are here.
      node = (
        <TabbedPanel
          ariaLabel="Country"
          defaultTab="dossier"
          tabs={[
            { id: "dossier", label: "Dossier", content: <CountryApp /> },
            {
              id: "sources",
              label: "National sources",
              content: <CountriesPanel />,
            },
          ]}
        />
      );
      break;
    case "markets":
      node = <MarketsApp />;
      break;
    default:
      node = null;
  }

  return (
    // inset-0, not `left-11` + `right: --rail-right-w`. Both offsets were sized
    // against the OLD shell's 44px icon rail and its own right rail; in this
    // shell the map column already excludes both, so the app opened 44px inside
    // the map well and left a dead 36px strip of globe down its left edge with
    // the map legend clipped to `ai / ve / da / GP`.
    <div className="absolute inset-0 z-(--z-overlay) flex flex-col bg-bg-0">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-2 bg-bg-1 px-3">
        <span className="font-label text-[12px] uppercase tracking-[0.9px] text-txt-0">
          {APP_META[app].label}
        </span>
        <span className="truncate text-[12px] text-txt-3">
          {APP_META[app].hint}
        </span>
      </div>
      <div
        className={`min-h-0 flex-1 overflow-auto ${MEASURED.has(app) && !(app === "video" && scheme === "slate") ? "csl2-app-measure" : ""}`}
      >
        <Suspense
          fallback={
            <div className="mono p-3 text-[12px] text-txt-2">loading…</div>
          }
        >
          {node}
        </Suspense>
      </div>
    </div>
  );
}
