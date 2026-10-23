import type { AppId } from "../state/appView.js";

// Each app's Blueprint glyph and identity hue, shared by the tabs bar badges,
// the rail and the menu row's document line so an app looks the same in all
// three. Hues are the reference frame's sampled values; they are identity
// colours behind a white glyph, not text, so they hold in every scheme.
export const APP_BP: Record<AppId, string> = {
  map: "globe",
  ai: "lightning",
  explorer: "properties",
  graph: "graph",
  investigate: "people",
  targeting: "locate",
  video: "camera",
  sim: "play",
  reports: "edit",
  foundry: "th",
  workflows: "timeline-events",
  city: "office",
  country: "flag",
  markets: "timeline-line-chart",
  models: "predictive-analysis",
  quiver: "chart",
  vertex: "graph",
  workshop: "control",
};

/** Badge fill behind the tab glyph. */
export const APP_BADGE: Partial<Record<AppId, string>> = {
  map: "#2f7fd6",
  graph: "#7b5cd6",
  explorer: "#c8771a",
  investigate: "#7b5cd6",
  reports: "#a2559f",
  sim: "#c2393f",
  foundry: "#238a6c",
  workflows: "#2f7fd6",
  ai: "#238551",
};

/** Glyph ink on the rail. */
export const APP_INK: Partial<Record<AppId, string>> = {
  map: "#4c90f0",
  sim: "#e5484d",
  explorer: "#32a467",
  reports: "#d77ce8",
  foundry: "#3fbf8f",
  workflows: "#5aa9ff",
  graph: "#e9c046",
  investigate: "#a98bf0",
  ai: "#32a467",
};

/** The rail's coloured column, top to bottom, at the reference's pitch. */
export const RAIL_APPS: readonly AppId[] = [
  "map",
  "sim",
  "explorer",
  "reports",
  "foundry",
  "workflows",
  "graph",
  "investigate",
];
