// Shared bits of the native AIP Foundry pages: the sprite icon and the one
// page nav that replaced each copy page's dark icon rail.
import "./pages.css";

export type FoundryNav =
  | "terminal"
  | "lineage"
  | "transforms"
  | "registry"
  | "control"
  | "titan"
  | "map"
  | "board";

const SPRITE = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;

export function Ico({ n, size = 16 }: { n: string; size?: number }): JSX.Element {
  return (
    <svg className="pg-ico" aria-hidden width={size} height={size}>
      <use href={SPRITE + n} />
    </svg>
  );
}

/** Every destination the old rail reached: label, then the old rail's tooltip. */
export const DESTINATIONS: [FoundryNav, string, string][] = [
  ["terminal", "AIP terminal", "AIP terminal"],
  ["transforms", "Transforms", "Manage transforms"],
  ["registry", "Registry", "Registry Watch Manager"],
  ["lineage", "Lineage", "Master lineage"],
  ["board", "Target board", "Target board (watch items)"],
  ["map", "Map", "Map: Gulf and Red Sea watch"],
  ["titan", "Ground station", "Ground station: devices, software, data connections"],
  ["control", "Control panel", "Control panel: language models and AI settings"],
];

export function PageNav({
  here,
  nav,
}: {
  here: FoundryNav;
  nav: (v: FoundryNav) => void;
}): JSX.Element {
  return (
    <nav className="pg-nav" aria-label="AIP pages">
      {DESTINATIONS.map(([v, label, tip]) => (
        <button
          key={v}
          type="button"
          className="pg-tab"
          title={tip}
          aria-current={v === here ? "page" : undefined}
          onClick={v === here ? undefined : () => nav(v)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export function Chip({
  tone,
  children,
}: {
  tone?: "ok" | "warn" | "bad" | "info" | undefined;
  children: React.ReactNode;
}): JSX.Element {
  return <span className={`pg-chip ${tone ?? ""}`}>{children}</span>;
}
