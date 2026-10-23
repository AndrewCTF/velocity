// The document-figure workspace under the Slate scheme: the copy page
// gotham/pdf/gotham-a.html (D1-D29) and gotham-b.html (D30-D58) wired to the
// live routes. Twelve figures, each at its own pixel size, fitted to the
// surface: the Object Explorer (landing), the Browser, the custom object view,
// Chat, Inbox, Slides, the Dossier, the graph document and its Search around
// state, the Timeline, the map and the video. The figures' own tabs and links
// move between them; Escape returns to the Explorer. The Explorer is cropped
// below the figure's window chrome (the console's shell draws its own) and
// stretched to fill the surface edge to edge.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { Frame } from "./kit.js";
import { resetCache } from "./data.js";
import { useModel, type Ctx, type Page } from "./model.js";
import { Explorer } from "./Explorer.js";
import { Browser } from "./Browser.js";
import { Cov } from "./Cov.js";
import { Chat } from "./Chat.js";
import { Inbox } from "./Inbox.js";
import { Slides } from "./Slides.js";
import { Dossier, MenuBar } from "./Dossier.js";
import { Graph, Graph2 } from "./Graph.js";
import { Timeline } from "./Timeline.js";
import { Gaia } from "./Gaia.js";
import { Video } from "./Video.js";
import "./pdf.css";

// each figure: W x H, the crop the copy shows, its background
const FIG: Record<
  Page,
  {
    W: number;
    H: number;
    crop: [number, number, number, number];
    bg: string;
    label: string;
  }
> = {
  explorer: {
    W: 1161,
    H: 653,
    crop: [26, 58, 1135, 595],
    bg: "#121418",
    label: "Object Explorer",
  },
  browser: {
    W: 1171,
    H: 615,
    crop: [0, 0, 1171, 615],
    bg: "#eeeef2",
    label: "Browser",
  },
  cov: {
    W: 1000,
    H: 702,
    crop: [0, 0, 1000, 702],
    bg: "#1c2024",
    label: "Custom object view",
  },
  chat: {
    W: 1094,
    H: 667,
    crop: [0, 0, 1094, 667],
    bg: "#101216",
    label: "Chat",
  },
  inbox: {
    W: 1163,
    H: 615,
    crop: [0, 0, 1163, 615],
    bg: "#242832",
    label: "Inbox",
  },
  slides: {
    W: 1157,
    H: 636,
    crop: [0, 0, 1157, 636],
    bg: "#f6f6f8",
    label: "Slides",
  },
  dossier: {
    W: 1165,
    H: 701,
    crop: [0, 0, 1165, 701],
    bg: "#fff",
    label: "Dossier",
  },
  menubar: {
    W: 1157,
    H: 648,
    crop: [0, 0, 1157, 648],
    bg: "#1c2028",
    label: "Graph document",
  },
  graph2: {
    W: 1143,
    H: 691,
    crop: [0, 0, 1143, 691],
    bg: "#1c2028",
    label: "Search around",
  },
  timeline: {
    W: 1139,
    H: 358,
    crop: [0, 0, 1139, 358],
    bg: "#10141a",
    label: "Timeline",
  },
  gaia: {
    W: 1153,
    H: 591,
    crop: [0, 0, 1153, 591],
    bg: "#fefefe",
    label: "Map",
  },
  video: {
    W: 1154,
    H: 644,
    crop: [0, 0, 1154, 644],
    bg: "#181e26",
    label: "Video",
  },
};

function Body({
  page,
  c,
  dw,
  dh,
}: {
  page: Page;
  c: Ctx;
  dw: number;
  dh: number;
}): JSX.Element {
  switch (page) {
    case "explorer":
      return <Explorer c={c} dw={dw} dh={dh} />;
    case "browser":
      return <Browser c={c} />;
    case "cov":
      return <Cov c={c} />;
    case "chat":
      return <Chat c={c} />;
    case "inbox":
      return <Inbox c={c} />;
    case "slides":
      return <Slides c={c} />;
    case "dossier":
      return <Dossier c={c} />;
    case "menubar":
      return (
        <>
          <Graph c={c} />
          <MenuBar c={c} />
        </>
      );
    case "graph2":
      return <Graph2 c={c} />;
    case "timeline":
      return <Timeline c={c} />;
    case "gaia":
      return <Gaia c={c} />;
    case "video":
      return <Video c={c} />;
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
  const host = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<Page>(initial);
  const pageRef = useRef(page);
  pageRef.current = page;
  // zoom, and how far the stretched Explorer outgrows its crop (figure px)
  const [fit, setFit] = useState({ k: 1, dw: 0, dh: 0 });
  // every open refetches every route
  const [ready, setReady] = useState(false);
  useEffect(() => {
    resetCache();
    setReady(true);
  }, []);
  const c = useModel(setPage);
  const f = FIG[page];
  const { dw, dh } = fit;
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const refit = (): void => {
      const k = Math.min(
        el.clientWidth / f.crop[2],
        el.clientHeight / f.crop[3],
      );
      const stretch = page === "explorer";
      setFit({
        k,
        dw: stretch ? el.clientWidth / k - f.crop[2] : 0,
        dh: stretch ? el.clientHeight / k - f.crop[3] : 0,
      });
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [f, page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.target instanceof HTMLInputElement) return;
      if (pageRef.current === "explorer") onExit?.();
      else setPage("explorer");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);
  return (
    <div
      className="sl-pdf"
      ref={host}
      data-page={page}
      aria-label={f.label}
      style={{ background: f.bg }}
    >
      <ErrorBoundary label={f.label}>
        <Frame
          crop={[f.crop[0], f.crop[1], f.crop[2] + dw, f.crop[3] + dh]}
          W={f.W + dw}
          H={f.H + dh}
          bg={f.bg}
          zoom={fit.k}
        >
          {ready ? <Body page={page} c={c} dw={dw} dh={dh} /> : null}
        </Frame>
      </ErrorBoundary>
    </div>
  );
}
