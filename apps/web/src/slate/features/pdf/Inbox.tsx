// Inbox: the object feed is the selected track; a "change" is a new AIS fix
// (archive plus this session's box pulls).
import { useState } from "react";
import { Btn, Ic, N_MEDIA, Sat, Tab } from "./kit.js";
import { TRK, hhmm, mdy, series, unavailable } from "./data.js";
import type { Ctx } from "./model.js";

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const p2 = (n: number): string => String(n).padStart(2, "0");
/** "October 22, 2026 9:51 UTC" */
const longUtc = (t: number): string => {
  const d = new Date(t * 1000);
  return `${MONTH[d.getUTCMonth()]} ${p2(d.getUTCDate())}, ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`.replace(/ 0/g, " ");
};
const mdyhm = (t: number): string => {
  const d = new Date(t * 1000);
  return `${mdy(t)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
};

export function Inbox({ c }: { c: Ctx }): JSX.Element {
  const [q, setQ] = useState("");
  const sel = c.sel;
  const corr = (c.watch?.changes.new ?? []).slice(0, 7).map((n) => {
    const [x, y] = n.key.split(":");
    return `${x}E ${y}N`;
  });
  const near = c.res.find((r) => r !== sel) ?? null;
  const nch = (m: number): number => Math.max(0, (m === sel?.mmsi ? c.fixes : series(m)).length - 1);
  const rows = [sel, near].filter((r): r is NonNullable<typeof r> => !!r);
  return (
    <div className="px-pg pxi">
      <aside className="px-pane l pxi-feeds" aria-label="Feeds">
        <div className="px-ph">
          <Btn label="Search for feeds: the Browser" icon="search" onClick={() => c.go("browser")}>Search for feeds...</Btn>
          <Btn sq label="Feed settings" icon="cog" why="Feeds are derived from the selection, not saved subscriptions" />
        </div>
        <ul>
          <li><button type="button" className="px-row" aria-label="All messages" aria-current="true" disabled>All messages</button></li>
          {["Requests", "High priority topics", "Shared with me"].map((t) => (
            <li key={t}><button type="button" className="px-row" aria-label={t} title="No request, topic or sharing store exists" disabled>{t}</button></li>
          ))}
        </ul>
        <div className="px-sect">Object feeds <span className="px-badge">{sel ? 1 : 0}</span></div>
        {sel ? (
          <div className="pxi-feed">
            <span className="px-thumb pxi-th"><Sat lon={sel.v.lon} lat={sel.v.lat} z={15} w={64} h={64} /></span>
            <span className="px-mu">{TRK(sel.mmsi)}</span>
            <span className="px-gap" />
            <span className="px-mu">1</span>
          </div>
        ) : null}
        <div className="px-sect">Search feeds</div>
        <div className="px-sect">Artifact feeds</div>
        <ul>
          {corr.map((nm) => <li key={nm} className="pxi-corr px-mu">Correlations - {nm}</li>)}
        </ul>
        {!c.watch ? <p className="px-empty">Correlations loading</p> : null}
      </aside>
      <section className="px-pane l pxi-list" aria-label="All messages">
        <div className="px-ph"><h2>All messages</h2></div>
        <ul>
          {rows.map((r) => {
            const on = r === sel;
            return (
              <li key={r.mmsi}>
                <button type="button" className="pxi-msg" aria-label={`${TRK(r.mmsi)} feed`} title={`${TRK(r.mmsi)} feed`} aria-pressed={on} onClick={() => c.pick(r.mmsi)}>
                  <span className="px-thumb pxi-th"><Sat lon={r.v.lon} lat={r.v.lat} z={15} w={64} h={64} /></span>
                  <span className="pxi-mt">
                    <b>{TRK(r.mmsi)}</b>
                    <span>{TRK(r.mmsi)} has {nch(r.mmsi)} changes</span>
                    <span className="px-mu">{mdy(r.v.t)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="px-pane pxi-detail" aria-label="Feed">
        <div className="px-ph">
          <span className="px-gap" />
          <Btn pri label="Open the object view" icon="eye-open" onClick={() => c.go("cov")}>Open</Btn>
        </div>
        {!sel ? (
          <p className="px-empty">{c.boxRes && !c.boxRes.ok ? unavailable("AIS box", c.boxRes) : "No object feed"}</p>
        ) : (
          <FeedDetail c={c} q={q} setQ={setQ} nch={nch(sel.mmsi)} />
        )}
      </section>
    </div>
  );
}

function FeedDetail({ c, q, setQ, nch }: { c: Ctx; q: string; setQ: (s: string) => void; nch: number }): JSX.Element {
  const s = c.sel!;
  const trk = TRK(s.mmsi);
  const pts = c.fixes.length ? c.fixes : [[s.v.t, s.v.lon, s.v.lat, s.sog] as const];
  const tl = pts[pts.length - 1]![0];
  const nsrc = s.v.sources?.length ?? 1;
  const all = pts.slice(-7).reverse();
  const fx = q ? all.filter((f) => `${f[2].toFixed(5)} ${f[1].toFixed(5)} ${hhmm(f[0], true)}`.includes(q)) : all;
  const tabs: [string, (() => void) | undefined][] = [
    ["Overview", () => c.go("cov")], ["Properties", () => c.go("cov")], ["Links", () => c.go("cov")], ["Media", () => c.go("cov")],
    ["Evidence", () => c.go("chat")], ["Notes", undefined], ["Map", () => c.go("cov")], ["History", undefined],
    ["Sources", undefined], ["AI brief", undefined], ["Replay", undefined], ["More", undefined],
  ];
  return (
    <div className="pxi-body">
      <div className="pxi-top">
        <h2>{trk} has {nch} changes</h2>
        <div className="px-mu">{longUtc(tl)}</div>
        <div className="pxi-from"><span className="px-mu">From:</span><span className="px-thumb pxi-th"><Sat lon={s.v.lon} lat={s.v.lat} z={15} w={64} h={64} /></span>{trk}</div>
        <div><span className="px-mu">Data:</span> No linked items</div>
      </div>
      <header className="pxi-obj">
        <span className="px-thumb pxi-th"><Sat lon={s.v.lon} lat={s.v.lat} z={15} w={64} h={64} /></span>
        <div><b>{trk}</b><div className="px-mu">Vessel</div></div>
        <span className="px-gap" />
        <Btn label="Actions: the object view" icon="caret-down" onClick={() => c.go("cov")}>Actions</Btn>
      </header>
      <div className="px-tabs">
        {tabs.map(([t, fn]) => (
          <Tab key={t} label={t} current={t === "History"} onClick={fn} why={`${t} is not part of this feed`} badge={t === "Media" ? N_MEDIA : undefined} />
        ))}
      </div>
      <div className="pxi-hist">
        <div className="px-inp pxi-q"><Ic n="search" /><input aria-label="Filter the history" placeholder="Filter..." value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <h3 className="pxi-day">{mdy(tl)}</h3>
        <div className="pxi-ev">
          <b><Ic n="add" s={12} /> Added {fx.length} position fix{fx.length === 1 ? "" : "es"}</b>
          {fx.map((f) => (
            <p key={f[0]} className="px-mu">
              Added AIS position fix {f[2].toFixed(5)} N, {f[1].toFixed(5)} E at {hhmm(f[0], true)} with data source
              <br />AIS recorder ({nsrc} source{nsrc === 1 ? "" : "s"} merged)
            </p>
          ))}
        </div>
        <div className="pxi-ev">
          <b><Ic n="add" s={12} /> Added 1 sanctions lookup</b>
          {c.sanc ? (
            <>
              <p className="px-mu">Looked up {s.mmsi} against {c.sanc.lists.join(", ")}: {c.sanc.matched ? "match" : "no match"}</p>
              <p className="px-mu">(Fetched {mdyhm(c.sanc.fetched_at)})</p>
            </>
          ) : (
            <p className="px-mu">{unavailable("Sanctions lookup", c.sancRes)}</p>
          )}
          <p className="px-mu">Added {pts.length} fix{pts.length === 1 ? "" : "es"} to {trk} from the AIS recorder</p>
        </div>
      </div>
    </div>
  );
}
