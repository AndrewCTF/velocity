// Dossier (gotham-011-051, D28 D29) and the graph document menu bar
// (gotham-012-056, D4): sec_dossier() and sec_menubar() of _build_gotham_a.py.
import { useState } from "react";
import { A, Hit, I, IS, T, Tc, frag, type N } from "./kit.js";
import { R_KM, TRK, hhmm, recorder, title, unavailable, useJson } from "./data.js";
import { nextSarPass } from "../../../situations/DetectedSituation.js";
import type { Ctx } from "./model.js";

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const p2 = (n: number): string => String(n).padStart(2, "0");

export function Dossier({ c }: { c: Ctx }): JSX.Element {
  const W = 1165, H = 701;
  const place = c.place;
  // the SAR pass over the searched place (the builder read situation.json)
  const gp = useJson<{ items?: Parameters<typeof nextSarPass>[0] }>("/api/space/gp?group=active&limit=20000");
  const pass = place && gp?.data?.items ? nextSarPass(gp.data.items, place.lat, place.lon, c.now * 1000) : null;
  const d = new Date(c.now * 1000);
  const o: N[] = [A(0, 0, W, H, "background:#fff")];
  o.push(A(0, 0, W, 27, "background:#101418"), IS("globe", 14, 13, 14, "#e5e8eb"), Hit(5, 4, 18, 18, "Home: the exploration", () => c.go("explorer")));
  for (const [x, t_] of [[42, "File"], [78, "View"], [122, "Navigate"], [187, "Support"]] as const)
    o.push(T(x, 13, t_, "#f1f4f5", 10.5, 400, "font-weight:500"), Hit(x - 3, 5, t_.length * 6 + 6, 16, t_, undefined, "View only: this dossier is read from the live routes"));
  o.push(A(248, 5, 54, 16, "background:#fab260;border-radius:2px"), Tc(275, 13, "View only", "#3a2a10", 8.8, 60));
  const name = `DOSSIER ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  o.push(I("document", 621, 13, 12, "#8a7cf0"), T(635, 13, name, "#f1f4f5", 10.5, 400, "font-weight:500"), I("star-empty", 760, 13, 11, "#c3ccd2"), I("caret-down", 778, 13, 9, "#8f99a8"));
  o.push(Hit(752, 5, 34, 16, "Favourite", undefined, "No favourites store exists"));
  o.push(I("pulse", 964, 13, 12, "#c3ccd2"), A(983, 5, 18, 17, "border:1px solid #3a8fe0;border-radius:2px"), I("desktop", 992, 13, 11, "#4c9bf0"), T(1015, 13, "Share", "#f1f4f5", 10.5));
  o.push(Hit(956, 5, 16, 16, "Activity: the inbox feed", () => c.go("inbox")), Hit(983, 5, 70, 17, "Present: the slides", () => c.go("slides")));
  o.push(I("shield", 1083, 13, 12, "#f1f4f5"), T(1096, 13, "OSINT", "#f1f4f5", 10.5, 400, "font-weight:500"));
  // formatting toolbar, greyed because the document is view only (D57)
  o.push(A(0, 27, W, 36, "background:#f6f6f8;border-bottom:1px solid #e3e5ea"));
  const G = "#b3bac3";
  o.push(I("undo", 18, 45, 13, G), I("redo", 44, 45, 13, G), A(62, 36, 1, 18, "background:#dcdfe4"));
  o.push(I("header-two", 80, 45, 13, G), T(96, 45, "Medium header", "#b3bac3", 10.8), I("caret-down", 231, 45, 9, G));
  o.push(A(253, 36, 1, 18, "background:#dcdfe4"));
  for (const [ic, x] of [["bold", 268], ["italic", 295], ["underline", 321], ["strikethrough", 347], ["font", 376], ["highlight", 408]] as const) o.push(I(ic, x, 45, 13, G));
  o.push(A(430, 36, 1, 18, "background:#dcdfe4"), I("align-left", 447, 45, 13, G), A(466, 36, 1, 18, "background:#dcdfe4"));
  o.push(I("plus", 485, 45, 12, G), T(499, 45, "Insert", "#b3bac3", 10.8), I("link", 551, 45, 13, G), I("database", 578, 45, 13, G), A(597, 36, 1, 18, "background:#dcdfe4"));
  o.push(I("anchor", 617, 45, 13, G), T(630, 45, "Anchor link", "#b3bac3", 10.8), I("comment", 714, 45, 13, G), T(728, 45, "Comment", "#b3bac3", 10.8));
  o.push(Hit(8, 32, 780, 26, "Formatting toolbar", undefined, "View only: the dossier body is read from the live routes"));
  // outline rail
  const area = (place?.name ?? "No place").replace("Lpg", "LPG");
  o.push(A(17, 77, 1, 144, "background:#c0c5cc"));
  o.push(T(32, 85, `${area.split(" ").slice(0, 2).join(" ").toUpperCase()} DOSSIER`, "#3a4450", 9.8, 400, "font-weight:500"), T(46, 107, `INCIDENT ${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`, "#3a4450", 9.8));
  const [at, setAt] = useState(0);
  const SECS: [number, string][] = [[128, "SITUATION:"], [150, "ASSESSMENT:"], [172, "COLLECTION:"], [193, "DATA SOURCES:"], [215, "DISTRIBUTION:"]];
  o.push(A(14, (SECS[at]?.[0] ?? 128) - 3, 6, 6, "background:#2a72d4;border-radius:3px"));
  SECS.forEach(([yc, t_], i) => o.push(T(39, yc, t_, "#3a4450", 10.2), Hit(30, yc - 9, 120, 18, t_, () => setAt(i))));
  // body (D30): every chip is a real record (place, track, chokepoint, nearby vessels, satellite pass, sources)
  const rec = recorder();
  const CHOK = c.chokes.find((x) => x.name.includes("Hormuz"));
  const SELR = c.sel;
  const near = c.list.filter((r) => r !== SELR).slice(0, 2);
  const nstat = c.res.filter((r) => r.sog === 0).length;
  const feeds = [...new Set(c.box.flatMap((v) => v.sources ?? []))];
  const pa = (y: number, h: string, txt: N): N => A(340, y, 705, 90, "", <div className="para"><b className="h">{h}</b>{txt}</div>);
  o.push(pa(102, "SITUATION:", <>
    The AIS recorder ({rec.polls} poll{rec.polls === 1 ? "" : "s"} to {rec.last ? hhmm(rec.last) : "n/a"}) holds {c.res.length} vessels within {R_KM} km of {chip("map-marker", area, "#a8752a", () => c.go("browser"))} on the coast of the UAE; {nstat} of them last reported 0.0 kn. A count of reported positions, not an assessment of intent.
  </>));
  o.push(pa(202, "ASSESSMENT:", SELR ? <>
    {chip("ship", TRK(SELR.mmsi), "#2a72d4", () => c.go("cov"), true)} reported {SELR.sog.toFixed(1)} kn at {hhmm(SELR.v.t, true)}, {SELR.d.toFixed(1)} km from the cluster centre{near.length ? <>; nearby are {near.map((r, i) => <span key={r.mmsi}>{i ? " and " : ""}{chip("ship", title(r.name), "#2a72d4", () => { c.pick(r.mmsi); c.go("cov"); }, true)}</span>)}</> : null}.{" "}
    {chip("waves", CHOK?.name ?? "Strait of Hormuz", "#1d8fa8")} reads {CHOK?.congestion ?? "n/a"} congestion ({CHOK?.stationary ?? "n/a"} of {CHOK?.vessels ?? "n/a"} stationary).
  </> : "No vessel matches the search."));
  const sancTxt = SELR ? (c.sanc ? `A lookup of MMSI ${SELR.mmsi} against ${c.sanc.lists.join(", ").replace(/, ([^,]*)$/, " and the $1")} lists returned ${c.sanc.matched ? "a match" : "no match"}.` : `${unavailable("Sanctions lookup", c.sancRes)}.`) : "";
  o.push(pa(302, "COLLECTION:", <>
    {sancTxt}{" "}
    {pass ? <>The next {chip("satellite", pass.satName ?? "Sentinel-1", "#6b4fc7")} pass over the area is at {hhmm(pass.startMs / 1000)}, about {((pass.startMs / 1000 - c.now) / 3600).toFixed(1)} hours from now. No SAR detection from that pass exists yet.</>
      : gp && !gp.ok ? `${unavailable("Satellite catalogue", gp)}.` : gp ? "No Sentinel-1 pass above 30 degrees over the area in the next 48 hours." : "Sentinel-1 passes loading…"}
  </>));
  o.push(pa(422, "DATA SOURCES:", <>
    AIS positions merge {feeds.length ? feeds.map((f) => <span key={f}>{chip("feed", f, "#59666f")}</span>) : "n/a"}; {c.warnRes && !c.warnRes.ok ? unavailable("NGA warnings", c.warnRes) : `${c.warnings.length} NGA broadcast warnings cover the Gulf box`}; {(c.status?.vessel_count ?? 0).toLocaleString("en")} vessels are in the live store.
  </>));
  o.push(pa(522, "DISTRIBUTION:", `Open source. Export this dossier as a report; ${c.evidence.length} evidence-locker items are attached. The AIS recorder keeps polling every minute, so every count above is a snapshot at the time shown. Nothing here is an assessment of intent.`));
  o.push(A(0, 694, W, 1, "background:#e3e5ea"));
  return frag(o);
}

/** chip(icon, text, ic, sprite): an inline object chip (the copy's .chip span);
 *  `stroke` takes the stroke ship glyph the builder pulls from sprite.svg. */
function chip(icon: string, text: string, ic: string, open?: () => void, stroke = false): N {
  const g = stroke ? IS("ship", 0, 0, 12, ic) : I(icon, 0, 0, 12, ic);
  return open ? (
    <button type="button" className="chip sl-hit" title={text} onClick={open}>{g}{text}</button>
  ) : (
    <span className="chip">{g}{text}</span>
  );
}

export function MenuBar({ c }: { c: Ctx }): JSX.Element {
  const W = 1157;
  const SELT = c.sel ? TRK(c.sel.mmsi) : "no track";
  const o: N[] = [A(0, 0, W, 40, "background:#101418"), A(0, 0, W, 13, "background:#0e9860"), Tc(W / 2, 6, "OSINT", "#fff", 8.5, 100, "font-weight:600")];
  o.push(IS("globe", 12, 26, 14, "#e5e8eb"), Hit(3, 17, 18, 18, "Home: the exploration", () => c.go("explorer")));
  const menus: [number, string, () => void][] = [
    [36, "File", () => c.go("dossier")], [67, "Edit", () => c.go("browser")], [100, "View", () => c.go("cov")],
    [137, "Insert", () => c.go("slides")], [178, "Selection", () => c.go("inbox")], [236, "Support", () => c.go("chat")],
  ];
  for (const [x, t_, fn] of menus) o.push(T(x, 26, t_, "#f1f4f5", 10.5, 400, "font-weight:500"), Hit(x - 3, 18, t_.length * 6.2 + 6, 16, t_, fn));
  o.push(A(281, 17, 1, 18, "background:#2a3038"), I("tick", 295, 26, 11, "#3fb27f"), T(306, 26, "Saved", "#8f99a8", 9.5));
  o.push(A(471, 19, 14, 14, "border:1px solid #e0a64a;border-radius:2px"), I("send-to-graph", 478, 26, 9, "#e0a64a"), T(491, 26, `Investigation into ${SELT}`, "#f1f4f5", 10.5, 400, "font-weight:500"),
    I("star-empty", 662, 26, 11, "#c3ccd2"), I("caret-down", 678, 26, 9, "#8f99a8"));
  o.push(Hit(654, 18, 32, 16, "Favourite", undefined, "No favourites store exists"));
  o.push(I("zoom-to-fit", 861, 26, 12, "#c3ccd2"), I("desktop", 886, 26, 12, "#4c9bf0"), A(900, 17, 1, 18, "background:#2a3038"), T(906, 26, "Share", "#6aa6e8", 10.5), A(941, 17, 1, 18, "background:#2a3038"),
    I("shield", 950, 26, 11, "#f1f4f5"), T(960, 26, "OSINT", "#f1f4f5", 8.5, 400, "font-weight:500"));
  o.push(Hit(853, 18, 16, 16, "Zoom to fit: the map card", () => c.go("cov")), Hit(878, 18, 60, 16, "Present: the slides", () => c.go("slides")));
  o.push(A(993, 17, 159, 20, "border:1px solid #3d444c;border-radius:2px;background:#0c1014"), I("search", 1005, 27, 11, "#dfe5e7"), T(1015, 27, c.kw, "#c3ccd2", 10.5));
  o.push(Hit(993, 17, 159, 20, "Search: the Browser", () => c.go("browser")));
  return frag(o);
}
