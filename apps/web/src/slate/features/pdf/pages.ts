// The workspace's pages: the switcher's order, labels, icons and each page's
// tone (the copy drew some light, some dark, and the page keeps its own).
import type { Page } from "./model.js";

export interface PageInfo {
  label: string;
  icon: string;
  tone: "dark" | "light";
}

export const PAGES: Record<Page, PageInfo> = {
  explorer: { label: "Explorer", icon: "th", tone: "dark" },
  browser: { label: "Browser", icon: "search-text", tone: "light" },
  cov: { label: "Object view", icon: "properties", tone: "dark" },
  chat: { label: "Chat", icon: "chat", tone: "dark" },
  inbox: { label: "Inbox", icon: "inbox", tone: "dark" },
  slides: { label: "Slides", icon: "presentation", tone: "light" },
  dossier: { label: "Dossier", icon: "document", tone: "light" },
  menubar: { label: "Graph", icon: "graph", tone: "dark" },
  graph2: { label: "Search around", icon: "search-around", tone: "dark" },
  timeline: { label: "Timeline", icon: "timeline-events", tone: "dark" },
  gaia: { label: "Map", icon: "map", tone: "light" },
  video: { label: "Video", icon: "video", tone: "dark" },
};

export const ORDER: Page[] = ["explorer", "browser", "cov", "chat", "inbox", "slides", "dossier", "menubar", "graph2", "timeline", "gaia", "video"];
