// The AI app under the Slate scheme: the AIP copy (gotham/aip/features-a.html,
// A1-A33) wired to the live routes. Four pages share the copy's 1590x916
// window crop of the 1920x1080 frame, scaled to the surface: the AIP terminal,
// the master lineage, the transforms/evaluation workspace and the Registry
// Watch Manager. The terminal's logo tile opens the Foundry pages; their dark
// rail (home / build / applications / lineage) moves between them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as Cesium from "cesium";
import { AiHubApp } from "../../../ai/AiHubApp.js";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { Frame } from "./ui.js";
import { resetCache } from "./data.js";
import { Terminal } from "./Terminal.js";
import { LineageView, type FoundryNav } from "./Lineage.js";
import { TransformsView } from "./Transforms.js";
import { RegistryView } from "./Registry.js";
import { ControlPanel } from "./ControlPanel.js";
import { TitanView, bannerOf } from "./Titan.js";
import { MapApp } from "./MapApp.js";
import { BoardView } from "./Board.js";
import { useJson } from "./data.js";
import { PdfApp } from "../pdf/PdfApp.js";
import "./aip.css";

// each page's crop of the 1920x1080 frame (x0, y0, w, h), as the copy pages crop them
const CROP: Record<FoundryNav, [number, number, number, number]> = {
  terminal: [282, 98, 1590, 916],
  lineage: [282, 98, 1590, 916],
  transforms: [282, 98, 1590, 916],
  registry: [282, 98, 1590, 916],
  control: [281, 98, 1591, 917],
  titan: [405, 184, 1463, 754],
  map: [405, 184, 1463, 754],
  board: [405, 184, 1463, 754],
};

export function AipApp({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  const [view, setView] = useState<FoundryNav | "hub" | "pdf">("terminal");
  const [focus, setFocus] = useState<string | null>(null);
  // every open refetches every route: the copy's numbers are never stale here
  const [ready, setReady] = useState(false);
  useEffect(() => {
    resetCache();
    setReady(true);
  }, []);
  const hub = view === "hub" || view === "pdf";
  const [x0, y0, W, H] =
    CROP[view === "hub" || view === "pdf" ? "terminal" : view];
  const cfg = useJson<{ classification?: string }>("/api/config");
  const ban = bannerOf(cfg?.data?.classification);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = (): void =>
      setK(Math.min(el.clientWidth / W, el.clientHeight / H));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hub, W, H]);
  const nav = (v: FoundryNav): void => {
    setFocus(null);
    setView(v);
  };
  const toLineage = (id?: string): void => {
    setFocus(id ?? null);
    setView("lineage");
  };
  if (view === "pdf")
    // The investigation workspace (Explorer, Browser, object view, Chat,
    // Inbox, Slides, Dossier) from the terminal's Investigations tab.
    return <PdfApp onExit={() => setView("terminal")} />;
  if (view === "hub")
    // The watch officer, the analyst agent and the local engine: the AI hub
    // this app replaced under Slate, reached from the terminal's panel icon.
    return (
      <div className="absolute inset-0 z-(--z-overlay) flex flex-col bg-bg-0">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-2 bg-bg-1 px-3">
          <button
            type="button"
            className="text-[12px] text-accent"
            onClick={() => setView("terminal")}
          >
            AIP terminal
          </button>
          <span className="text-[12px] text-txt-3">· AI hub</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto csl2-app-measure">
          <AiHubApp viewer={viewer} />
        </div>
      </div>
    );
  return (
    <div className="sl-aip" ref={host} data-view={view}>
      <ErrorBoundary label="AIP">
        <Frame x0={x0} y0={y0} w={W} h={H} zoom={k}>
          {!ready ? null : view === "terminal" ? (
            <Terminal
              onFoundry={() => nav("lineage")}
              onHub={() => setView("hub")}
              onInvestigate={() => setView("pdf")}
            />
          ) : view === "lineage" ? (
            <LineageView key={focus ?? "all"} nav={nav} focus={focus} />
          ) : view === "transforms" ? (
            <TransformsView nav={nav} onLineage={toLineage} />
          ) : view === "registry" ? (
            <RegistryView nav={nav} />
          ) : view === "control" ? (
            <ControlPanel
              onConsole={() => nav("terminal")}
              onHub={() => setView("hub")}
            />
          ) : view === "titan" ? (
            <TitanView onHome={() => nav("terminal")} />
          ) : view === "map" ? (
            <MapApp onHome={() => nav("terminal")} ban={ban} />
          ) : (
            <BoardView
              onHome={() => nav("terminal")}
              ban={ban}
              onMap={() => nav("map")}
            />
          )}
        </Frame>
      </ErrorBoundary>
    </div>
  );
}
