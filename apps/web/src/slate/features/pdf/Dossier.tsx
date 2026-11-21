// Dossier: a view-only document written from the live routes. Every chip is a
// real record (place, track, chokepoint, nearby vessels, satellite pass, sources).
import { useState } from "react";
import { Ic, Ship, type N } from "./kit.js";
import {
  R_KM,
  TRK,
  hhmm,
  recorder,
  title,
  unavailable,
  useJson,
} from "./data.js";
import { nextSarPass } from "../../../situations/DetectedSituation.js";
import type { Ctx } from "./model.js";

const MON = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const p2 = (n: number): string => String(n).padStart(2, "0");
const SECS = [
  "SITUATION:",
  "ASSESSMENT:",
  "COLLECTION:",
  "DATA SOURCES:",
  "DISTRIBUTION:",
];

function Chip({
  icon,
  text,
  tint,
  open,
}: {
  icon: string;
  text: string;
  tint: string;
  open?: () => void;
}): JSX.Element {
  const g = (
    <span style={{ color: tint, display: "inline-flex" }}>
      {icon === "ship" ? <Ship s={12} /> : <Ic n={icon} s={12} />}
    </span>
  );
  return open ? (
    <button type="button" className="px-chip" title={text} onClick={open}>
      {g}
      {text}
    </button>
  ) : (
    <span className="px-chip">
      {g}
      {text}
    </span>
  );
}

export function Dossier({ c }: { c: Ctx }): JSX.Element {
  const [at, setAt] = useState(0);
  const place = c.place;
  // the SAR pass over the searched place
  const gp = useJson<{ items?: Parameters<typeof nextSarPass>[0] }>(
    "/api/space/gp?group=active&limit=20000",
  );
  const pass =
    place && gp?.data?.items
      ? nextSarPass(gp.data.items, place.lat, place.lon, c.now * 1000)
      : null;
  const d = new Date(c.now * 1000);
  const name = `DOSSIER ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const area = (place?.name ?? "No place").replace("Lpg", "LPG");
  const rec = recorder();
  const chok = c.chokes.find((x) => x.name.includes("Hormuz"));
  const sel = c.sel;
  const near = c.list.filter((r) => r !== sel).slice(0, 2);
  const nstat = c.res.filter((r) => r.sog === 0).length;
  const feeds = [...new Set(c.box.flatMap((v) => v.sources ?? []))];
  const sancTxt = sel
    ? c.sanc
      ? `A lookup of MMSI ${sel.mmsi} against ${c.sanc.lists.join(", ").replace(/, ([^,]*)$/, " and the $1")} lists returned ${c.sanc.matched ? "a match" : "no match"}.`
      : `${unavailable("Sanctions lookup", c.sancRes)}.`
    : "";
  const body: [string, N][] = [
    [
      "SITUATION:",
      <>
        The AIS recorder ({rec.polls} poll{rec.polls === 1 ? "" : "s"} to{" "}
        {rec.last ? hhmm(rec.last) : "—"}) holds {c.res.length} vessels within{" "}
        {R_KM} km of{" "}
        <Chip
          icon="map-marker"
          text={area}
          tint="#a8752a"
          open={() => c.go("browser")}
        />{" "}
        on the coast of the UAE; {nstat} of them last reported 0.0 kn. A count
        of reported positions, not an assessment of intent.
      </>,
    ],
    [
      "ASSESSMENT:",
      sel ? (
        <>
          <Chip
            icon="ship"
            text={TRK(sel.mmsi)}
            tint="#2a72d4"
            open={() => c.go("cov")}
          />{" "}
          reported {sel.sog.toFixed(1)} kn at {hhmm(sel.v.t, true)},{" "}
          {sel.d.toFixed(1)} km from the cluster centre
          {near.length ? (
            <>
              ; nearby are{" "}
              {near.map((r, i) => (
                <span key={r.mmsi}>
                  {i ? " and " : ""}
                  <Chip
                    icon="ship"
                    text={title(r.name)}
                    tint="#2a72d4"
                    open={() => {
                      c.pick(r.mmsi);
                      c.go("cov");
                    }}
                  />
                </span>
              ))}
            </>
          ) : null}
          .{" "}
          <Chip
            icon="waves"
            text={chok?.name ?? "Strait of Hormuz"}
            tint="#1d8fa8"
          />{" "}
          reads {chok?.congestion ?? "—"} congestion ({chok?.stationary ?? "—"}{" "}
          of {chok?.vessels ?? "—"} stationary).
        </>
      ) : (
        "No vessel matches the search."
      ),
    ],
    [
      "COLLECTION:",
      <>
        {sancTxt}{" "}
        {pass ? (
          <>
            The next{" "}
            <Chip
              icon="satellite"
              text={pass.satName ?? "Sentinel-1"}
              tint="#6b4fc7"
            />{" "}
            pass over the area is at {hhmm(pass.startMs / 1000)}, about{" "}
            {((pass.startMs / 1000 - c.now) / 3600).toFixed(1)} hours from now.
            No SAR detection from that pass exists yet.
          </>
        ) : gp && !gp.ok ? (
          `${unavailable("Satellite catalogue", gp)}.`
        ) : gp ? (
          "No Sentinel-1 pass above 30 degrees over the area in the next 48 hours."
        ) : (
          "Sentinel-1 passes loading…"
        )}
      </>,
    ],
    [
      "DATA SOURCES:",
      <>
        AIS positions merge{" "}
        {feeds.length
          ? feeds.map((f) => (
              <span key={f}>
                <Chip icon="feed" text={f} tint="#59666f" />{" "}
              </span>
            ))
          : "—"}
        ;{" "}
        {c.warnRes && !c.warnRes.ok
          ? unavailable("NGA warnings", c.warnRes)
          : `${c.warnings.length} NGA broadcast warnings cover the Gulf box`}
        ; {(c.status?.vessel_count ?? 0).toLocaleString("en")} vessels are in
        the live store.
      </>,
    ],
    [
      "DISTRIBUTION:",
      `Open source. Export this dossier as a report; ${c.evidence.length} evidence-locker items are attached. The AIS recorder keeps polling every minute, so every count above is a snapshot at the time shown. Nothing here is an assessment of intent.`,
    ],
  ];
  const go = (i: number): void => {
    setAt(i);
    document.getElementById(`pxd-${i}`)?.scrollIntoView?.({ block: "start" });
  };
  return (
    <div className="px-pg pxd">
      <nav className="px-pane l pxd-out" aria-label="Outline">
        <div className="px-ph">
          <Ic n="document" />
          <h2>{name}</h2>
        </div>
        <div className="pxd-ttl">
          <b>{area.split(" ").slice(0, 2).join(" ").toUpperCase()} DOSSIER</b>
          <span>
            INCIDENT {p2(d.getUTCDate())} {MON[d.getUTCMonth()]}{" "}
            {d.getUTCFullYear()}
          </span>
        </div>
        <ul>
          {SECS.map((t, i) => (
            <li key={t}>
              <button
                type="button"
                className="px-row"
                aria-label={t}
                title={t}
                aria-pressed={i === at}
                onClick={() => go(i)}
              >
                {t}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <article className="pxd-doc" aria-label={name}>
        <div className="pxd-page">
          <div className="px-mu pxd-ro">
            <Ic n="lock" s={12} /> View only: this dossier is read from the live
            routes
          </div>
          {body.map(([h, txt], i) => (
            <section key={h} id={`pxd-${i}`} className="pxd-sec">
              <h3>{h}</h3>
              <p>{txt}</p>
            </section>
          ))}
        </div>
      </article>
    </div>
  );
}
