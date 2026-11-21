// D191 the Marketplace product page, native:
// the repo's own plugin marketplace and product. The manifests are repo files
// with no endpoint, so they are imported at build time, and the content rows
// count files in plugin/osint-geoint exactly as the builder's globs do.
import { Ii } from "./kit.js";
import { Bar, Btn, Card, Page } from "./native.js";
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

/** The builder's rewrite of the plugin descriptions: no em dash reaches the page. */
export function descOf(d: string): string {
  const [head, ...rest] = d.split(" — ");
  return (
    (head ?? "").replace(/—/g, ":") + ". " + rest.join(" — ").replace(/—/g, ":")
  );
}
export const subOf = (d: string): string =>
  (d.split(", as ")[0] ?? "").replace(/ — /g, ", ");

const ST = "#e8553b";

export function D191({ nav }: { nav: Nav }): JSX.Element {
  const pl = mk.plugins?.[0] ?? {};
  const desc = descOf(pj.description);
  const sub = subOf(pl.description ?? "");
  const content: Array<[string, number]> = [
    ["Skills", COUNTS.Skills],
    ["Commands", COUNTS.Commands],
    ["Agents", COUNTS.Agents],
  ];
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Marketplace · {mkName} · <b>{pj.name}</b>
          </>
        }
      >
        <Btn icon="arrow-left" onClick={nav.menu}>
          Back to store
        </Btn>
      </Bar>
      <nav className="fxn-tabs" aria-label="Product sections">
        <button type="button" aria-current="page" disabled title="This section">
          Overview
        </button>
        {[
          "Changelogs",
          "Content",
          "Inputs",
          "Installations",
          "Linked products",
        ].map((t) => (
          <button
            key={t}
            type="button"
            disabled
            title="Claude Code owns the plugin's install state; this page shows the repository manifest"
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="fxn-body">
        <div className="fxn-scroll">
          <div className="fxn-col">
            <div className="fxn-prod">
              {Ii("cube", 48, "#8f99a8")}
              <div>
                <h1>{pj.displayName}</h1>
                <p className="fxn-sub">{sub}</p>
              </div>
              <span className="fxn-box" title="Plugin version">
                {pj.version}
              </span>
              <Btn
                primary
                why="Claude Code opens plugins; there is no install registry here"
              >
                Open
              </Btn>
              <Btn why="Claude Code owns installs: /plugin install osint-geoint@osint-velocity">
                Install again
              </Btn>
            </div>
            <div className="fxn-split">
              <div className="fxn-col" style={{ padding: 0 }}>
                <Card title="Description">
                  <p style={{ margin: 0 }}>{desc}</p>
                </Card>
                <Card title="Content">
                  <ul className="fxn-list">
                    {content.map(([lab, n]) => (
                      <li key={lab} className="fxn-item">
                        {Ii("link", 16, "#5f6b7c")}
                        <span>{lab}</span>
                        <span className="fxn-count">{n}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
              <Card title="Details">
                <div className="fxn-kv">
                  <span>Version</span>
                  <span>{pj.version}</span>
                </div>
                <div className="fxn-kv">
                  <span>Category</span>
                  <span className="fxn-tag">{pl.category}</span>
                </div>
                <div className="fxn-kv">
                  <span>Store</span>
                  <span>
                    {Ii("shop", 16, ST)} {mkName}
                  </span>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
