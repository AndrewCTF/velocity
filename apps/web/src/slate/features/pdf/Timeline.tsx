// Timeline: bars are the AIS fixes of the Browser result set, one per (MMSI,
// fix time) across every box pull since the app opened, in 5 minute bins,
// stacked by the source each pull reported the fix under.
import { useState } from "react";
import { Btn, Ic } from "./kit.js";
import { dmy, fixBins, hhmm, recFixes, recorder } from "./data.js";
import type { Ctx } from "./model.js";

export const SRC_COL: Record<string, string> = {
  shipxplorer: "#da2c6e",
  openwaters: "#8eb024",
  vesselfinder: "#9c3e9c",
};
const BIN = 300;

export function Timeline({ c }: { c: Ctx }): JSX.Element {
  const [off, setOff] = useState<string[]>([]);
  const B = fixBins(recFixes(new Set(c.res.map((r) => r.mmsi))), BIN);
  const all = B ? B.order.map(([s]) => s) : [];
  const shown = all.filter((s) => !off.includes(s));
  const max = B
    ? Math.max(
        1,
        ...B.bins.map((b) => shown.reduce((a, s) => a + (b.get(s) ?? 0), 0)),
      )
    : 1;
  const step = 5 * Math.ceil(max / 3.3 / 5);
  const yMax = Math.max(3 * step, max);
  const ticks: { t: number; major: boolean }[] = [];
  if (B)
    for (let t = (Math.floor(B.t0 / 1800) + 1) * 1800; t < B.t1; t += 1800)
      ticks.push({ t, major: t % 3600 === 0 });
  const nb = B?.bins.length ?? 1;
  return (
    <div className="px-pg pxt">
      <section className="pxt-main" aria-label="Timeline">
        <div className="px-ph">
          <h2>Timeline</h2>
          <span className="px-mu">
            {B
              ? `Showing ${hhmm(B.t0)} to ${hhmm(B.t1)} ${dmy(B.t1)}`
              : c.boxRes && !c.boxRes.ok
                ? "No fixes: the AIS box pull failed"
                : "No fixes recorded yet"}
          </span>
          <span className="px-gap" />
          <span className="px-mu">Bin size: {BIN / 60} minutes</span>
          <Btn
            sq
            label="Close the timeline: the graph document"
            icon="cross"
            onClick={() => c.go("menubar")}
          />
        </div>
        <div className="pxt-chart">
          {B ? (
            <>
              <div className="pxt-y" aria-hidden>
                {[1, 2, 3].map((k) => (
                  <span
                    key={k}
                    style={{ bottom: `${(100 * k * step) / yMax}%` }}
                  >
                    {k * step}
                  </span>
                ))}
              </div>
              <div
                className="pxt-plot"
                role="img"
                aria-label={`Fixes per ${BIN / 60} minutes, ${B.t0 ? hhmm(B.t0) : ""} to ${hhmm(B.t1)}`}
              >
                {[1, 2, 3].map((k) => (
                  <i
                    key={k}
                    className="pxt-grid"
                    style={{ bottom: `${(100 * k * step) / yMax}%` }}
                  />
                ))}
                <div className="pxt-bars">
                  {B.bins.map((b, k) => (
                    <div key={k} className="pxt-col">
                      {shown.map((s) => {
                        const n = b.get(s) ?? 0;
                        return n ? (
                          <span
                            key={s}
                            title={`${s}: ${n}`}
                            style={{
                              height: `${(100 * n) / yMax}%`,
                              background: SRC_COL[s] ?? "#2e70d2",
                            }}
                          />
                        ) : null;
                      })}
                    </div>
                  ))}
                </div>
                {ticks.map(({ t, major }) => (
                  <span
                    key={t}
                    className={`pxt-tick${major ? " maj" : ""}`}
                    style={{ left: `${(100 * (t / BIN - B.b0)) / nb}%` }}
                  >
                    {major ? <b>{hhmm(t)}</b> : null}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="px-empty">
              {recorder().polls} box pull{recorder().polls === 1 ? "" : "s"}, no
              fixes in the result set
            </p>
          )}
        </div>
      </section>
      <aside className="px-pane r pxt-leg" aria-label="Sources">
        <div className="px-sect">Source</div>
        <ul>
          <li>
            <button
              type="button"
              className="px-row"
              aria-label="Source: show every source"
              title={
                off.length
                  ? "Source: show every source"
                  : "Every source is shown"
              }
              disabled={!off.length}
              onClick={() => setOff([])}
            >
              <Ic n={off.length ? "square" : "tick"} />
              All sources
            </button>
          </li>
          {(B?.order ?? []).map(([s, n]) => {
            const on = !off.includes(s);
            return (
              <li key={s}>
                <button
                  type="button"
                  className="px-row"
                  aria-label={`${on ? "Hide" : "Show"} ${s}`}
                  title={`${on ? "Hide" : "Show"} ${s}`}
                  aria-pressed={on}
                  onClick={() =>
                    setOff(on ? [...off, s] : off.filter((x) => x !== s))
                  }
                >
                  <Ic n={on ? "tick" : "square"} />
                  <span
                    className="pxt-sw"
                    style={{ background: SRC_COL[s] ?? "#2e70d2" }}
                    aria-hidden
                  />
                  {s} ({n})
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
