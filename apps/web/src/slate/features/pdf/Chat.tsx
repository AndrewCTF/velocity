// Chat: no chat store exists, so channels are the alert feeds, the thread is
// the standing detection, embeds and the locker are the evidence store, and
// watch rules stand in for direct messages. Nothing sends.
import { useState } from "react";
import { Btn, Ic } from "./kit.js";
import { hhmm, regionAlerts } from "./data.js";
import type { Ctx, Page } from "./model.js";

export function Chat({ c }: { c: Ctx }): JSX.Element {
  const [draft, setDraft] = useState("");
  const nStand = Object.values(c.standing?.counts ?? {}).reduce((a, b) => a + b, 0);
  // the builder badges only the two feeds with hits for this workspace
  const channels: [string, string, number, Page | null][] = [
    ["Gulf incident alerts", "globe", regionAlerts(c.alerts).length, "inbox"],
    ["Standing detections", "lock", nStand, null],
    ["NGA warnings, Gulf", "lock", 0, "inbox"],
    ["Chokepoint congestion", "globe", 0, "dossier"],
    ["Watch officer briefs", "globe", 0, null],
  ];
  const sd = c.standing?.detections[0] ?? null;
  const ts = c.standing?.as_of ?? 0;
  const ev = c.evidence.map((e) => e.props);
  const embeds = [ev[0], ev.length > 3 ? ev[3] : ev[ev.length - 1]].filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <div className="px-pg pxc">
      <aside className="px-pane l pxc-side" aria-label="Channels">
        <div className="px-ph"><h2>Chat</h2></div>
        <div className="pxc-pad">
          <Btn label="Search: the Browser" icon="search" onClick={() => c.go("browser")} className="pxc-wide">Search...</Btn>
        </div>
        <div className="px-sect pxc-sh">Channels <span className="px-gap" /><Btn sq label="Add channel" icon="add" why="Channels are the alert feeds; there is no channel store" /></div>
        <ul>
          {channels.map(([nm, ic, cnt, d]) => {
            const on = nm === "Standing detections";
            return (
              <li key={nm}>
                <button type="button" className="px-row" aria-label={nm} title={on ? "This is the open channel" : d ? nm : "Read in the AI app"} aria-current={on ? "true" : undefined} disabled={on || !d} onClick={d ? () => c.go(d) : undefined}>
                  <Ic n={ic} />
                  <span className="pxc-nm">{nm}</span>
                  {cnt ? <span className="px-badge">{cnt}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="px-sect pxc-sh">Watch rules <span className="px-gap" /><Btn sq label="Add watch rule" icon="add" why="Watch rules are added from the alert rules list" /></div>
        <ul>
          {c.rules.slice(0, 4).map((r) => <li key={r.id} className="pxc-rule"><Ic n="dot" s={12} /> {r.label}</li>)}
        </ul>
      </aside>
      <section className="pxc-thread" aria-label="Standing detections">
        <div className="px-ph">
          <Ic n="lock" />
          <div>
            <h2>Standing detections</h2>
            <div className="px-mu">{nStand} detection{nStand === 1 ? "" : "s"} · Alert rules</div>
          </div>
          <span className="px-gap" />
          <Btn label="Search: the Browser" icon="search" onClick={() => c.go("browser")}>Search</Btn>
        </div>
        <div className="pxc-msgs">
          <h2 className="pxc-h">Standing detections</h2>
          <p>These are the alert-rule hits for this workspace. This is the start of <b>Standing detections</b>.</p>
          <p>Topic: Rules evaluated on every snapshot</p>
          <Btn label="Edit rules" icon="people" why="Rules are edited from the alert rules list">Edit rules</Btn>
          <article className="pxc-msg">
            <header><span className="pxc-av" aria-hidden>SD</span><b>standing-detection engine</b><span className="px-mu">{ts ? hhmm(ts) : "—"}</span></header>
            <p>{sd ? sd.summary : c.standing ? "No standing detections" : "Standing detections loading"}</p>
            {sd ? (
              <>
                <p className="pxc-ok"><Ic n="download" s={12} /> Open {sd.entity_id} at {sd.lat.toFixed(3)} N, {sd.lon.toFixed(3)} E</p>
                <p>Rule: {sd.rule_label}, kind {sd.kind}, severity {sd.severity_word}</p>
              </>
            ) : null}
            {embeds.map((e, i) => (
              <div key={`${e.filename ?? e.source_url ?? i}`} className="pxc-embed">
                <Ic n={i ? "send-to-graph" : "document"} s={16} />
                <div>
                  <div className="px-lk">{e.filename || (i ? "capture" : "evidence")}</div>
                  <div className="px-mu">By {e.captured_by} · {e.capture_method}</div>
                  <div className="px-mu">{e.title ?? ""}</div>
                </div>
              </div>
            ))}
          </article>
        </div>
        <form className="pxc-in" onSubmit={(e) => e.preventDefault()}>
          <div className="px-inp pxc-inp">
            <input aria-label="Message" placeholder="Send a message..." value={draft} onChange={(e) => setDraft(e.target.value)} />
          </div>
          <Btn sq label="Attach" icon="paperclip" why="Attachments go to the evidence locker from Investigate" />
          <Btn sq label="Emoji" icon="emoji" why="No chat store exists, so nothing is sent" />
          <Btn sq label="Send" icon="send-message" why="No chat store exists, so nothing is sent" />
        </form>
      </section>
      <aside className="px-pane r pxc-lock" aria-label="Evidence locker">
        <div className="px-ph">
          <div>
            <h2>Evidence locker</h2>
            <div className="px-mu">Standing detections</div>
          </div>
          <span className="px-gap" />
          <Btn sq label="Close: the exploration" icon="cross" onClick={() => c.go("explorer")} />
        </div>
        <ul className="pxc-files">
          {ev.slice(0, 4).map((e, k) => (
            <li key={k} className="pxc-file">
              <Ic n="paperclip" />
              <div>
                <div className="px-lk pxc-fn">{e.filename || e.source_url || "capture"}</div>
                <div className="px-mu">Captured by {e.captured_by}</div>
              </div>
            </li>
          ))}
        </ul>
        {!ev.length ? <p className="px-empty">The evidence locker is empty</p> : null}
      </aside>
    </div>
  );
}
