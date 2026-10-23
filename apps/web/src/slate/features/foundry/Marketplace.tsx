// D191 the Marketplace product page (sec_d191, _build_foundry_apps.py:806-850):
// the repo's own plugin marketplace and product. The manifests are repo files
// with no endpoint, so they are imported at build time, and the content rows
// count files in plugin/osint-geoint exactly as the builder's globs do.
import {
  BLU,
  CONTENT,
  DARK,
  E,
  GREY,
  Fr,
  Hit,
  I,
  frag,
  hairline,
  kit,
  vline,
  type N,
} from "./kit.js";
import type { Nav } from "./nav.js";

// Eager globs, not imports: the web image builds from apps/web alone, so a
// manifest outside it is absent there and the page shows "—" instead of failing
// the build.
interface PluginJson {
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
}
interface MarketJson {
  name?: string;
  plugins?: { description?: string; category?: string }[];
}
const firstJson = <T,>(m: Record<string, unknown>): T =>
  ((Object.values(m)[0] as { default?: T } | undefined)?.default ?? {}) as T;
const pj: Required<PluginJson> = {
  name: "—",
  displayName: "—",
  version: "—",
  description: "",
  ...firstJson<PluginJson>(
    import.meta.glob(
      "../../../../../../plugin/osint-geoint/.claude-plugin/plugin.json",
      { eager: true },
    ),
  ),
};
const mk = firstJson<MarketJson>(
  import.meta.glob("../../../../../../.claude-plugin/marketplace.json", {
    eager: true,
  }),
);
const mkName = mk.name ?? "—";

const COUNTS = {
  Skills: Object.keys(
    import.meta.glob("../../../../../../plugin/osint-geoint/skills/*/SKILL.md"),
  ).length,
  Commands: Object.keys(
    import.meta.glob("../../../../../../plugin/osint-geoint/commands/*.md"),
  ).length,
  Agents: Object.keys(
    import.meta.glob("../../../../../../plugin/osint-geoint/agents/*.md"),
  ).length,
};

/** Python textwrap.wrap: greedy word wrap at `width` columns. */
export function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += " " + w;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The builder's rewrite of the plugin descriptions: no em dash reaches the page. */
export function descOf(d: string): string {
  const [head, ...rest] = d.split(" — ");
  return (
    (head ?? "").replace(/—/g, ":") + ". " + rest.join(" — ").replace(/—/g, ":")
  );
}
export const subOf = (d: string): string =>
  (d.split(", as ")[0] ?? "").replace(/ — /g, ", ");

export function D191({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx } = kit(2.3, 1.16);
  const W = 2642;
  const H = 1380;
  const pl = { description: "", category: "—", ...mk.plugins?.[0] };
  const desc = descOf(pj.description);
  const sub = subOf(pl.description);
  const ST = "#e8553b";
  const fs = (n: number): string => `font-size:${n}px`;
  const o: N[] = [
    E(0, 0, W, H, `background:${CONTENT}`),
    E(0, 0, W, 559, "background:#fff"),
    hairline(0, 99, W, "#c5cbd3"),
    E(0, 0, 99, 99, "background:#eaf0fa;border-right:1px solid #c5d3ea"),
    I("shop", 49, 49, 44, ST),
    txt(124, 49, "Marketplace", 12.5, "#394048", 700, null, "l", false, fs(26)),
    I("chevron-right", 318, 49, 24, "#5f6b7c"),
    I("shop", 360, 49, 30, ST),
    txt(391, 49.5, mkName, 12.5, GREY, 400, null, "l", false, fs(26)),
    I("chevron-right", 583, 49, 24, "#5f6b7c"),
    I("cube", 629, 49, 34, "#8f99a8"),
    txt(662, 49.5, pj.name, 12.5, GREY, 400, null, "l", false, fs(26)),
    bx(1536, 20, 629, 59, "#fff", "#c5cbd3", 3),
    I("search", 1568, 50, 34, "#404854"),
    E(1604, 27, 88, 45, "background:#eef0f2;border-radius:3px"),
    txt(1614, 50, "In", 12.5, DARK, 400, null, "l", false, fs(23)),
    I("shop", 1656, 50, 30, ST),
    txt(
      1700,
      50,
      "Search products in store...",
      12.5,
      GREY,
      400,
      null,
      "l",
      false,
      fs(25),
    ),
    vline(2188, 15, 66),
    I("cube-add", 2244, 49, 30, "#8f99a8"),
    txt(2273, 49.5, "Installations", 12.5, DARK, 400, null, "l", false, fs(25)),
    bx(2457, 20, 143, 58, "#fff", "#c5cbd3", 3),
    txt(2478, 49.5, "Help", 12.5, DARK, 400, null, "l", false, fs(25)),
    I("help", 2568, 49, 34, "#394048"),
    I("arrow-left", 156, 210, 30, "#5f6b7c"),
    txt(188, 210.5, "Back to store", 12.5, DARK, 400, null, "l", false, fs(25)),
    I("cube", 153, 311, 60, "#a5acb6"),
    txt(
      215,
      310,
      pj.displayName,
      12.5,
      "#1c2127",
      700,
      null,
      "l",
      false,
      fs(40),
    ),
    bx(680, 280, 144, 59, "#fff", "#c5cbd3", 3),
    txt(702, 311, pj.version, 12.5, DARK, 400, null, "l", false, fs(25)),
    I("double-caret-vertical", 788, 311, 26, "#5f6b7c"),
    txt(215, 362, sub, 12.5, GREY, 400, null, "l", false, fs(25)),
    E(2181, 250, 148, 60, "background:#2c72d2;border-radius:3px"),
    txt(2200, 280.5, "Open", 12.5, "#fff", 400, null, "l", false, fs(25)),
    I("caret-down", 2305, 280, 24, "#fff"),
    bx(2339, 250, 181, 60, "#f6f7f9", "#c5cbd3", 3),
    txt(2429, 280.5, "Install again", 12.5, DARK, 400, 181, "c", false, fs(25)),
  ];
  (
    [
      ["Overview", 121],
      ["Changelogs", 287],
      ["Content", 482],
      ["Inputs", 630],
      ["Installations", 755],
      ["Linked products", 959],
    ] as const
  ).forEach(([lab, xx]) =>
    o.push(
      txt(
        xx,
        520,
        lab,
        12.5,
        lab === "Overview" ? "#215db0" : DARK,
        400,
        null,
        "l",
        false,
        fs(28),
      ),
    ),
  );
  o.push(
    E(121, 555, 126, 5, `background:${BLU}`),
    hairline(0, 560, W, "#d3d8de"),
    bx(120, 621, 1761, 347, "#fff", "#d3d8de", 3),
    txt(162, 671, "Description", 12.5, DARK, 700, null, "l", false, fs(25)),
    hairline(121, 720, 1759, "#d3d8de"),
  );
  wrap(desc, 112)
    .slice(0, 3)
    .forEach((ln, i) =>
      o.push(
        txt(162, 803 + 42 * i, ln, 12.5, DARK, 400, null, "l", false, fs(26)),
      ),
    );
  o.push(
    bx(120, 1007, 1761, 330, "#fff", "#d3d8de", 3),
    txt(162, 1058, "Content", 12.5, DARK, 700, null, "l", false, fs(25)),
    txt(1840, 1058, "See all", 12.5, "#215db0", 400, 100, "r", false, fs(25)),
    hairline(121, 1107, 1759, "#d3d8de"),
  );
  (
    [
      ["Skills", COUNTS.Skills, "book"],
      ["Commands", COUNTS.Commands, "console"],
      ["Agents", COUNTS.Agents, "person"],
    ] as const
  ).forEach(([lab, n, _ic], i) => {
    const yy = 1127 + 63 * i;
    o.push(
      bx(160, yy, 1681, 56, "#fff", "#d3d8de", 3),
      I("link", 215, yy + 28, 30, "#8f99a8"),
      txt(242, yy + 28.5, lab, 12.5, DARK, 400, null, "l", false, fs(27)),
      E(1771, yy + 11, 40, 34, "background:#eef0f2;border-radius:3px"),
      txt(1791, yy + 28, String(n), 12.5, DARK, 400, 40, "c", false, fs(22)),
    );
  });
  o.push(bx(1919, 621, 603, 234, "#fff", "#d3d8de", 3));
  (
    [
      ["Version", pj.version],
      ["Category", pl.category],
      ["Store", mkName],
    ] as const
  ).forEach(([k, v], i) => {
    const yy = 680 + 58 * i;
    o.push(txt(1965, yy, k, 12.5, GREY, 400, null, "l", false, fs(25)));
    if (k === "Category")
      o.push(
        E(
          2480 - (v.length * 14 + 30),
          yy - 21,
          v.length * 14 + 30,
          42,
          "background:#eef0f2;border-radius:3px",
        ),
        txt(2465, yy + 0.5, v, 12.5, DARK, 400, 200, "r", false, fs(22)),
      );
    else if (k === "Store")
      o.push(
        I("shop", 2480 - v.length * 15 - 40, yy, 30, ST),
        txt(2480, yy, v, 12.5, DARK, 400, 300, "r", false, fs(25)),
      );
    else o.push(txt(2480, yy, v, 12.5, DARK, 400, 200, "r", false, fs(25)));
  });
  o.push(
    Hit(0, 0, 99, 99, "Foundry apps", nav.menu),
    Hit(136, 185, 330, 50, "Back to store", nav.menu),
    Hit(
      2181,
      250,
      148,
      60,
      "Open",
      undefined,
      "Claude Code opens plugins; there is no install registry here",
    ),
    Hit(
      2339,
      250,
      181,
      60,
      "Install again",
      undefined,
      "Claude Code owns installs: /plugin install osint-geoint@osint-velocity",
    ),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}
