// The Foundry app under the Slate scheme: the Foundry apps copy
// (gotham/docs/foundry-apps.html, D182-D202) wired to the live routes. Each
// page is one section of the copy at its own logical frame size, fitted to the
// surface with CSS zoom and letterboxed in the frame's own background. Pages
// reach each other through the copy's own chrome: every frame's logo tile
// opens the apps menu, tabs and nav rows go where they say, and "Back home" /
// "Datasources" open the token-driven Foundry workbench this surface replaced.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as Cesium from "cesium";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { FoundryApp as Workbench } from "../../../foundry/FoundryApp.js";
import { useFoundryNav } from "../../../foundry/nav.js";
import { resetCache } from "./data.js";
import { MENU, SIZE, type Nav, type Page } from "./nav.js";
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
  const host = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<Page | "workbench">(initial);
  const [menu, setMenu] = useState(false);
  const [k, setK] = useState(1);
  // every open refetches every route: the copy's numbers are never stale here
  const [ready, setReady] = useState(false);
  useEffect(() => {
    resetCache();
    setReady(true);
  }, []);
  const setView = useFoundryNav((s) => s.setView);
  const p: Page = page === "workbench" ? initial : page;
  const [W, H, bg] = SIZE[p];
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = (): void => setK(Math.min(el.clientWidth / W, el.clientHeight / H));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page, W, H]);
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
    <div className="sl-fx" ref={host} data-page={page} style={{ background: bg }}>
      <ErrorBoundary label="Foundry">
        <div className="copy" style={{ width: W, height: H, zoom: k, background: bg }}>
          {ready ? <Frame nav={nav} /> : null}
        </div>
      </ErrorBoundary>
      {menu ? (
        <>
          <button type="button" aria-label="Close menu" className="sl-hit" style={{ position: "absolute", inset: 0, zIndex: 5 }} onClick={() => setMenu(false)} />
          <div className="fx-menu" role="menu" style={{ left: 8, top: 8 }}>
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
