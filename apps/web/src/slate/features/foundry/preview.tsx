// Dev-only entry (served by Vite at /src/slate/features/foundry/preview.html):
// mounts the Foundry apps pages alone, with the app's fonts and CSS, until
// shell/AppSurface.tsx routes the Slate Foundry app here. `?page=` picks the
// first page.
import { createRoot } from "react-dom/client";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-sans-3/700.css";
import "../../../index.css";
import { SlateFoundry } from "./FoundryApp.js";
import type { Page } from "./nav.js";

const page = (new URLSearchParams(location.search).get("page") ??
  "d187") as Page;
createRoot(document.getElementById("fx-root")!).render(
  <SlateFoundry viewer={null} initial={page} />,
);
