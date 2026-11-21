// The dark AIP pages (ground station, map, target board): one root over the
// shared page nav, themed by dk.css under the same Blueprint scale as the
// light pages.
import type { ReactNode } from "react";
import { PageNav, type FoundryNav } from "./pg.js";
import "./dk.css";

export function DkPage({
  here,
  nav,
  cls,
  children,
}: {
  here: FoundryNav;
  nav: (v: FoundryNav) => void;
  cls: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`aip-pg aip-dk ${cls}`}>
      <PageNav here={here} nav={nav} />
      {children}
    </div>
  );
}

/** A count that stays "—" until its route answered, never a fabricated 0. */
export const cnt = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-US");
