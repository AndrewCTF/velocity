// The Foundry app under the Slate scheme: the Foundry apps (D182-D202) as native
// layouts on the live routes. Every page fills the surface and reflows; there is
// no inner app chrome, the Slate shell already names the app. Pages reach each
// other through the Apps button (the menu below), tabs and nav rows, and "Home" /
// "Datasources" open the token-driven Foundry workbench this surface replaced.
import { useEffect, useState } from "react";
import type * as Cesium from "cesium";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { FoundryApp as Workbench } from "../../../foundry/FoundryApp.js";
import { useFoundryNav } from "../../../foundry/nav.js";
import { resetCache } from "./data.js";
import { MENU, type Nav, type Page } from "./nav.js";
import { D182, D183 } from "./ControlPanel.js";
import { D184, D185, D186, D187, D190 } from "./Ontology.js";
import { D188, D189 } from "./Params.js";
import { D191 } from "./Marketplace.js";
import { D192, D194, D195, D196 } from "./WorkshopMap.js";
import { D197, D198, D199 } from "./WorkshopConfig.js";
import { D200, D201 } from "./LegacyMap.js";
import "./foundry.css";

const FRAMES: Record<Page, (p: { nav: Nav }) => JSX.Element> = {
  d182: D182,
  d183: D183,
  d184: D184,
  d185: D185,
  d186: D186,
  d187: D187,
  d188: D188,
  d189: D189,
  d190: D190,
  d191: D191,
  d192: D192,
  d194: D194,
  d195: D195,
  d196: D196,
  d197: D197,
  d198: D198,
  d199: D199,
  d200: D200,
  d201: D201,
};

export function SlateFoundry({ viewer, initial = "d187" }: { viewer: Cesium.Viewer | null; initial?: Page }): JSX.Element {
  const [page, setPage] = useState<Page | "workbench">(initial);
  const [menu, setMenu] = useState(false);
  // every open refetches every route: the copy's numbers are never stale here
  const [ready, setReady] = useState(false);
  useEffect(() => {
    resetCache();
    setReady(true);
  }, []);
  const setView = useFoundryNav((s) => s.setView);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const nav: Nav = {
    go: (q) => {
      setMenu(false);
      setPage(q);
    },
    menu: () => setMenu(true),
    workbench: (v = "home") => {
      setMenu(false);
      setView(v);
      setPage("workbench");
    },
  };
  if (page === "workbench")
    return (
      <div className="absolute inset-0 z-(--z-overlay) bg-bg-0">
        <Workbench viewer={viewer} />
        {/* over the workbench rail's own footer: the way back to the copied apps */}
        <button
          type="button"
          onClick={() => setPage(initial)}
          className="absolute bottom-0 left-0 h-[29px] w-[168px] border-t border-line-2 bg-bg-1 px-3 text-left text-[11px] text-accent hover:bg-bg-2"
        >
          Foundry apps
        </button>
      </div>
    );
  const Frame = FRAMES[page];
  return (
    <div className="sl-fx" data-page={page}>
      <ErrorBoundary label="Foundry">{ready ? <Frame nav={nav} /> : null}</ErrorBoundary>
      {menu ? (
        <>
          <button type="button" aria-label="Close menu" className="sl-hit" style={{ position: "absolute", inset: 0, zIndex: 5 }} onClick={() => setMenu(false)} />
          <div className="fx-menu" role="menu" style={{ left: 8, top: 44 }}>
            {MENU.map(([group, items]) => (
              <div key={group}>
                <h6>{group}</h6>
                {items.map(([id, label]) => (
                  <button key={id} type="button" role="menuitem" aria-current={id === page ? "page" : undefined} onClick={() => nav.go(id)}>
                    {label}
                  </button>
                ))}
              </div>
            ))}
            <h6>Workbench</h6>
            <button type="button" role="menuitem" onClick={() => nav.workbench("home")}>
              Datasets, pipelines and builds
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
