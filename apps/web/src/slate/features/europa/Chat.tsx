// E1 / E2: the Reports chat page, laid out natively (it used to be a crop of
// the copied 1920x1080 frame). Velocity has no chat store: the only route is
// /api/collab/channels, which answers 401 without sign-in, so every slot the
// copy filled with authored channel rows and messages carries that route's
// honest state instead. The drop zone (E2) is live: it opens on a real drag
// over the message pane, and a drop says why nothing was shared.
import { useState } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { unavailable, type Res } from "./data.js";
import { dragTitle } from "./drag.js";
import "./eupages.css";

export interface ChatRow {
  name: string;
  private?: boolean;
}

const HEADER_TOOLS = ["search", "person", "folder-close", "pin", "cog"] as const;

export function ChatPage({ ch, toGaia }: { ch: Res<unknown> | null; toGaia: () => void }): JSX.Element {
  const [sel, setSel] = useState(0);
  const [q, setQ] = useState("");
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const all: ChatRow[] =
    ch?.ok && Array.isArray(ch.data) ? (ch.data as ChatRow[]).filter((r) => typeof r?.name === "string") : [];
  const needle = q.trim().toLowerCase();
  const rows = all.map((r, i) => ({ r, i })).filter(({ r }) => r.name.toLowerCase().includes(needle));
  const name = all[sel]?.name ?? null;
  const why = unavailable("Chat", ch);
  const title = dragTitle();
  return (
    <div className="euc">
      <div className="eu-bar">
        <button type="button" className="eu-btn" aria-label="Home" title="Gaia home" onClick={toGaia}>
          <BpIcon name="chevron-left" size={14} />
          Gaia home
        </button>
        <span className="eu-crumb">
          <span className="eu-dim">Reports</span>
          <BpIcon name="chevron-right" size={12} />
          <b>Chat</b>
        </span>
      </div>
      <div className="eu-body">
        <nav className="euc-side" aria-label="Channels">
          <label className="eu-search">
            <BpIcon name="search" size={14} />
            <input aria-label="Search channels" placeholder="Search channels" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="euc-sec">
            <span>Channels</span>
            <button type="button" className="eu-ico" aria-label="New channel" title={why} disabled>
              <BpIcon name="plus" size={14} />
            </button>
          </div>
          {rows.length === 0 && (
            <p className="eu-note">
              <BpIcon name="info-sign" size={12} />
              {ch?.ok ? (all.length ? `No channel matches "${q}"` : "No channels") : why}
            </p>
          )}
          {rows.slice(0, 40).map(({ r, i }) => (
            <button
              key={`${r.name}.${i}`}
              type="button"
              className={`euc-row${i === sel ? " eu-on" : ""}`}
              aria-label={`Open ${r.name}`}
              aria-pressed={i === sel}
              title={`Open ${r.name}`}
              onClick={() => setSel(i)}
            >
              <BpIcon name={r.private === false ? "globe-network" : "lock"} size={12} />
              <span>{r.name}</span>
            </button>
          ))}
          <div className="euc-sec">
            <span>Direct messages</span>
            <button type="button" className="eu-ico" aria-label="New direct message" title={why} disabled>
              <BpIcon name="plus" size={14} />
            </button>
          </div>
          <p className="eu-note">{ch?.ok ? "No direct messages" : unavailable("Messages", ch)}</p>
        </nav>
        <section className="euc-main">
          <header className="euc-head">
            <div className="euc-title">
              <BpIcon name="lock" size={14} />
              <b>{name ?? "No channel open"}</b>
              <span className="eu-dim">{ch?.ok ? "Members not reported" : unavailable("Members", ch)}</span>
            </div>
            <div className="eu-tools">
              {HEADER_TOOLS.map((ic) => (
                <button key={ic} type="button" className="eu-ico" aria-label={ic} title={why} disabled>
                  <BpIcon name={ic} size={14} />
                </button>
              ))}
            </div>
          </header>
          <div
            className={`euc-pane${drag ? " eu-drag" : ""}`}
            data-testid="eu-chat-drop"
            onDragOver={(e) => {
              e.preventDefault();
              if (!drag) setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const what = e.dataTransfer.getData("text/plain") || "Artifact";
              setNote(`${what.slice(0, 40)} not shared: ${why}`);
            }}
          >
            {drag ? (
              <div className="euc-drop">
                <BpIcon name="circle-arrow-down" size={32} />
                <span>DROP HERE</span>
                {title && (
                  <span className="euc-chip">
                    <BpIcon name="document" size={12} />
                    {title.length < 40 ? title : `${title.slice(0, 38)}…`}
                  </span>
                )}
              </div>
            ) : (
              <div className="euc-empty">
                <BpIcon name="chat" size={32} />
                <span>{ch?.ok ? "No messages in this channel" : unavailable("Messages", ch)}</span>
                {note && <span className="euc-warn">{note}</span>}
              </div>
            )}
          </div>
          <div className="euc-comp">
            <input aria-label="Send a message" placeholder="Send a message..." title={why} disabled />
            {(["paperclip", "emoji", "key-enter"] as const).map((ic) => (
              <button key={ic} type="button" className="eu-ico" aria-label={ic} title={why} disabled>
                <BpIcon name={ic} size={14} />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
