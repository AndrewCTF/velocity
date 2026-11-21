// The investigation workspace under the Slate scheme: the Object Explorer
// (landing), the Browser, the custom object view, Chat, Inbox, Slides, the
// Dossier, the graph document and its Search around state, the Timeline, the
// map and the video, each laid out natively in the surface. One slim toolbar
// moves between them (the Slate shell already names the app); Escape returns
// to the Explorer, and leaves the workspace from it when a host gives a way out.
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { Ic } from "./kit.js";
import { resetCache } from "./data.js";
import { useModel, type Ctx, type Page } from "./model.js";
import { ORDER, PAGES } from "./pages.js";
import { Explorer } from "./Explorer.js";
import { Browser } from "./Browser.js";
import { Cov } from "./Cov.js";
import { Chat } from "./Chat.js";
import { Inbox } from "./Inbox.js";
import { Slides } from "./Slides.js";
import { Dossier } from "./Dossier.js";
import { Graph, Graph2 } from "./Graph.js";
import { Timeline } from "./Timeline.js";
import { Gaia } from "./Gaia.js";
import { Video } from "./Video.js";
import "./px.css";
import "./pages.css";

function Body({ page, c }: { page: Page; c: Ctx }): JSX.Element {
  switch (page) {
    case "explorer": return <Explorer c={c} />;
    case "browser": return <Browser c={c} />;
    case "cov": return <Cov c={c} />;
    case "chat": return <Chat c={c} />;
    case "inbox": return <Inbox c={c} />;
    case "slides": return <Slides c={c} />;
    case "dossier": return <Dossier c={c} />;
    case "menubar": return <Graph c={c} />;
    case "graph2": return <Graph2 c={c} />;
    case "timeline": return <Timeline c={c} />;
    case "gaia": return <Gaia c={c} />;
    case "video": return <Video c={c} />;
  }
}

export function PdfApp({
  initial = "explorer",
  onExit,
}: {
  initial?: Page;
  /** Escape on the Explorer leaves the workspace (when a host gives a way out). */
  onExit?: () => void;
}): JSX.Element {
  const [page, setPage] = useState<Page>(initial);
  const pageRef = useRef(page);
  pageRef.current = page;
  // every open refetches every route
  const [ready, setReady] = useState(false);
  useEffect(() => {
    resetCache();
    setReady(true);
  }, []);
  const c = useModel(setPage);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.target instanceof HTMLInputElement) return;
      if (pageRef.current === "explorer") onExit?.();
      else setPage("explorer");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);
  const info = PAGES[page];
  return (
    <div className="px" data-page={page} data-tone={info.tone} aria-label={info.label}>
      <nav className="px-bar" aria-label="Workspace pages">
        {ORDER.map((p) => (
          <button key={p} type="button" className="px-btn" aria-label={PAGES[p].label} title={PAGES[p].label} aria-current={p === page ? "page" : undefined} onClick={() => setPage(p)}>
            <Ic n={PAGES[p].icon} />
            <span className="px-lab">{PAGES[p].label}</span>
          </button>
        ))}
      </nav>
      <div className="px-body">
        <ErrorBoundary label={info.label}>{ready ? <Body page={page} c={c} /> : null}</ErrorBoundary>
      </div>
    </div>
  );
}
