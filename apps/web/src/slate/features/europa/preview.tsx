// Dev-only entry (served by Vite at /src/slate/features/europa/preview.html):
// mounts the Europa pages alone, with the app's fonts and CSS, until
// shell/AppSurface.tsx routes the Slate Reports app here. `?page=` picks the
// first page.
import { createRoot } from "react-dom/client";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-sans-3/700.css";
import "../../../index.css";
import { EuropaApp } from "./EuropaApp.js";
import type { Page } from "./SatMap.js";

const page = (new URLSearchParams(location.search).get("page") ?? "gaia") as Page;
createRoot(document.getElementById("eu-root")!).render(<EuropaApp viewer={null} initial={page} />);
