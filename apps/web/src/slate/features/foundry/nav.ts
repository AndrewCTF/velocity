// The Foundry pages: one per section of gotham/docs/foundry-apps.html, each a
// native layout that fills the Slate surface. D192+D193 and D201+D202 share a
// section, so they share a page. Pages reach each other through the Apps
// button (the menu below), tabs, nav rows and buttons.
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
  /** opens the apps menu (each page toolbar's Apps button) */
  menu: () => void;
  /** the token-driven Foundry workbench this surface replaced under Slate */
  workbench: (view?: "home" | "datasets" | "pipeline" | "builds" | "ontology" | "connections") => void;
}

export const MENU: Array<[string, Array<[Page, string]>]> = [
  ["Control Panel", [["d182", "Map defaults"], ["d183", "Custom base map"]]],
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
  ["Map (legacy)", [["d200", "Selection card"], ["d201", "Legend and page tabs"]]],
];
