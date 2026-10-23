// The copy's pages: one per section of gotham/docs/foundry-apps.html, each at
// its own logical frame size. D192+D193 and D201+D202 share a section, so they
// share a page. Pages reach each other through the copy's own chrome (logo
// tiles open the apps menu; tabs, nav rows and buttons go where they say).
export type Page =
  | "d182"
  | "d183"
  | "d184"
  | "d185"
  | "d186"
  | "d187"
  | "d188"
  | "d189"
  | "d190"
  | "d191"
  | "d192"
  | "d194"
  | "d195"
  | "d196"
  | "d197"
  | "d198"
  | "d199"
  | "d200"
  | "d201";

export interface Nav {
  go: (p: Page) => void;
  /** opens the apps menu (each frame's logo tile) */
  menu: () => void;
  /** the token-driven Foundry workbench this surface replaced under Slate */
  workbench: (
    view?:
      "home" | "datasets" | "pipeline" | "builds" | "ontology" | "connections",
  ) => void;
}

/** [W, H, letterbox background] of each page's frame (the section's crop). */
export const SIZE: Record<Page, [number, number, string]> = {
  d182: [2225, 1158, "#f6f6f8"],
  d183: [810, 630, "#f6f6f8"],
  d184: [1225, 766, "#f6f6f8"],
  d185: [1226, 1113, "#f6f6f8"],
  d186: [1226, 711, "#f6f6f8"],
  d187: [1335, 736, "#f6f6f8"],
  d188: [876, 584, "#f6f6f8"],
  d189: [1192, 1126, "#f6f6f8"],
  d190: [810, 1546, "#fff"],
  d191: [2642, 1380, "#f6f6f8"],
  d192: [1131, 699, "#f4f4f2"],
  d194: [1135, 620, "#f4f4f2"],
  d195: [1131, 703, "#fff"],
  d196: [1135, 778, "#fff"],
  d197: [1544, 1038, "#fff"],
  d198: [722, 942, "#fff"],
  d199: [794, 1953, "#fff"],
  d200: [897, 375, "#f4f4f2"],
  d201: [1661, 866, "#fff"],
};

export const MENU: Array<[string, Array<[Page, string]>]> = [
  [
    "Control Panel",
    [
      ["d182", "Map defaults"],
      ["d183", "Custom base map"],
    ],
  ],
  [
    "Ontology Manager",
    [
      ["d184", "Situation · Capabilities"],
      ["d185", "Aircraft · Event"],
      ["d186", "Resource · Search Around"],
      ["d187", "Vessel · Selection panel"],
      ["d190", "Vessel · property mmsi"],
      ["d188", "Parameter bbox · Details"],
      ["d189", "Parameter bbox · Value"],
    ],
  ],
  ["Marketplace", [["d191", "OSINT GEOINT"]]],
  [
    "Workshop map",
    [
      ["d192", "Legend and radius selection"],
      ["d194", "Satellites and countries"],
      ["d195", "Quake tooltip"],
      ["d196", "Routes and timeline"],
      ["d197", "Layers and base map"],
      ["d198", "Time configuration"],
      ["d199", "Layer style by function"],
    ],
  ],
  [
    "Map (legacy)",
    [
      ["d200", "Selection card"],
      ["d201", "Legend and page tabs"],
    ],
  ],
];
