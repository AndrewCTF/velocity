// The AI app under the Slate scheme: the AIP pages as native reflowing layouts
// wired to the live routes. The terminal, the Foundry pages (lineage,
// transforms, registry, control panel) and the dark pages (ground station, map,
// target board) all fill the surface and reach each other through the shared
// page nav; the terminal's panel icon opens the AI hub, its Investigations tab
// the investigation workspace.
import { useEffect, useState } from "react";
import type * as Cesium from "cesium";
import { AiHubApp } from "../../../ai/AiHubApp.js";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { resetCache } from "./data.js";
import { Terminal } from "./Terminal.js";
import { LineageView, type FoundryNav } from "./Lineage.js";
import { TransformsView } from "./Transforms.js";
import { RegistryView } from "./Registry.js";
import { ControlPanel } from "./ControlPanel.js";
import { TitanView } from "./Titan.js";
import { MapApp } from "./MapApp.js";
import { BoardView } from "./Board.js";
import { PdfApp } from "../pdf/PdfApp.js";

export function AipApp({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element {
  const [view, setView] = useState<FoundryNav | "hub" | "pdf">("terminal");
  const [focus, setFocus] = useState<string | null>(null);
  // every open refetches every route: the numbers are never stale here
  const [ready, setReady] = useState(false);
  useEffect(() => {
    resetCache();
    setReady(true);
  }, []);
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
    <ErrorBoundary label="AIP">
      {!ready ? null : view === "lineage" ? (
        <LineageView key={focus ?? "all"} nav={nav} focus={focus} />
      ) : view === "transforms" ? (
        <TransformsView nav={nav} onLineage={toLineage} />
      ) : view === "registry" ? (
        <RegistryView nav={nav} />
      ) : view === "control" ? (
        <ControlPanel
          nav={nav}
          onConsole={() => nav("terminal")}
          onHub={() => setView("hub")}
        />
      ) : view === "titan" ? (
        <TitanView nav={nav} />
      ) : view === "map" ? (
        <MapApp nav={nav} />
      ) : view === "board" ? (
        <BoardView nav={nav} />
      ) : (
        <Terminal
          onFoundry={() => nav("lineage")}
          onHub={() => setView("hub")}
          onInvestigate={() => setView("pdf")}
        />
      )}
    </ErrorBoundary>
  );
}
