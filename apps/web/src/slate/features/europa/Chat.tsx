// E1 / E2: the chat frame of the copy (chat(), chat_drop() in
// _build_features.py), crop 766,279 1100x631. Velocity has no chat store: the
// only route is /api/collab/channels, which answers 401 without sign-in, so
// every slot the copy filled with authored channel rows and messages carries
// that route's honest state instead. The drop zone (E2) is live: it opens on a
// real drag over the message pane, and a drop says why nothing was shared.
import { useState } from "react";
import { A, I, T, Hit, circ, frag, insetFrame, titlebar, type N } from "./ui.js";
import { unavailable, type Res } from "./data.js";
import { dragTitle } from "./drag.js";

export interface ChatRow {
  name: string;
  private?: boolean;
}

const BANNER =
  "background:#007a33;color:#eef5ee;font-size:7.6px;font-weight:700;letter-spacing:.05em;display:grid;place-items:center";

function sidebar(ch: Res<unknown> | null, sel: number, pick: (i: number) => void): N {
  const rows: ChatRow[] =
    ch?.ok && Array.isArray(ch.data) ? (ch.data as ChatRow[]).filter((r) => typeof r?.name === "string") : [];
  const why = unavailable("Channels", ch);
  const s: N[] = [
    A(767, 305, 182, 605, "background:#242a30"),
    T(779, 327, "Chat", 11, "#f2f4f6", 600),
    A(778, 351, 160, 21, "background:#1a1e22;border-bottom:1.5px solid #3a4a60;border-radius:1px"),
    I("search", 790, 361, 10, "#c4ccd2"),
    T(800, 361.5, "Search...", 8, "#7f8890"),
    I("chevron-down", 783, 390, 9, "#c4ccd2"),
    T(798, 390.5, "Channels", 8.3, "#e4e8ec", 600),
    I("plus", 932, 390, 9, "#c4ccd2"),
    Hit(925, 383, 15, 15, "New channel", undefined, why),
  ];
  if (!rows.length)
    s.push(I("info-sign", 792, 416, 10, "#9aa4ab"), T(804, 416.5, ch?.ok ? "No channels" : why, 8, "#a4adb4", 400, "l", 0.04));
  rows.slice(0, 8).forEach((r, i) => {
    const yc = 416 + i * 26;
    if (i === sel) s.push(A(767, yc - 13, 181, 26, "background:#363e46"), A(767, yc - 13, 3, 26, "background:#3e568c"));
    s.push(
      I(r.private === false ? "globe-network" : "lock", 792, yc, 10, i === sel ? "#e4e8ec" : "#9aa4ab"),
      T(804, yc + 0.5, r.name, 8, i === sel ? "#f2f4f6" : "#a4adb4", 400, "l", 0.04),
      Hit(767, yc - 13, 181, 26, `Open ${r.name}`, () => pick(i)),
    );
  });
  s.push(
    I("chevron-down", 783, 626, 9, "#c4ccd2"),
    T(798, 626.5, "Direct messages", 8.3, "#e4e8ec", 600),
    I("plus", 932, 626, 9, "#c4ccd2"),
    Hit(925, 619, 15, 15, "New direct message", undefined, why),
    circ(792, 651, 2.2, "#9aa2a8"),
    T(804, 651.5, ch?.ok ? "No direct messages" : unavailable("Messages", ch), 8, "#8e979e"),
  );
  return frag(s);
}

function header(name: string | null, ch: Res<unknown> | null): N {
  const s: N[] = [
    A(949, 323, 917, 44, "background:#14181c;border-bottom:1px solid #262c32"),
    I("lock", 968, 338, 10, "#dfe4e8"),
    T(981, 338.5, name ?? "No channel open", 9.8, "#f2f4f6", 600, "l", 0.02),
    T(963, 352, ch?.ok ? "Members not reported" : unavailable("Members", ch), 7.2, "#7c858c"),
  ];
  const why = unavailable("Chat", ch);
  for (const [ic, x] of [
    ["search", 1751],
    ["person", 1781],
    ["folder-close", 1803],
    ["pin", 1825],
    ["cog", 1847],
  ] as const)
    s.push(I(ic, x, 344, 10.5, "#c0c8ce"), Hit(x - 7, 337, 14, 14, ic, undefined, why));
  s.push(A(1772, 337, 1, 15, "background:#2c343a"));
  return frag(s);
}

function pane(ch: Res<unknown> | null): N {
  return frag([
    A(949, 367, 911, 543, "background:#101416"),
    I("chat", 1407, 600, 24, "#59626a"),
    T(1407, 630, ch?.ok ? "No messages in this channel" : unavailable("Messages", ch), 9, "#7a838a", 400, "c"),
  ]);
}

function composer(ch: Res<unknown> | null): N {
  const why = unavailable("Chat", ch);
  return frag([
    A(963, 872, 887, 30, "border:1px solid #2c343c;background:#101416;border-radius:1px;box-sizing:border-box"),
    T(971, 887.5, "Send a message...", 8.1, "#4a5258", 400),
    I("paperclip", 1788, 887, 10, "#9aa4ab"),
    I("emoji", 1810, 887, 10, "#9aa4ab"),
    I("key-enter", 1831, 887, 10, "#9aa4ab"),
    Hit(963, 872, 887, 30, "Send a message", undefined, why),
  ]);
}

export function ChatFrame({ ch, toGaia }: { ch: Res<unknown> | null; toGaia: () => void }): N {
  const [sel, setSel] = useState(0);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rows = ch?.ok && Array.isArray(ch.data) ? (ch.data as ChatRow[]) : [];
  const name = rows[sel]?.name ?? null;
  const body = frag([pane(ch), composer(ch)]);
  const title = dragTitle();
  return frag([
    insetFrame(766, 279, 1866, 910),
    titlebar("Chat", "chat", 1324),
    Hit(770, 283, 18, 18, "Home", toGaia),
    A(949, 305, 917, 17, BANNER, "UNCLASSIFIED // OPEN SOURCE"),
    sidebar(ch, sel, setSel),
    header(name, ch),
    drag ? (
      <div key="blur" style={{ left: 0, top: 0, width: 1920, height: 1080, filter: "blur(2.2px)", opacity: 0.62, clipPath: "inset(367px 54px 170px 949px)" }}>
        {body}
      </div>
    ) : (
      <div key="clip" style={{ left: 0, top: 0, width: 1920, height: 1080, clipPath: "inset(367px 0 170px 949px)" }}>
        {body}
      </div>
    ),
    drag
      ? frag([
          A(963, 381, 887, 514, "border:2px dashed #f4f6f8;box-sizing:border-box"),
          I("circle-arrow-down", 1337, 638, 24, "#e8ecee"),
          T(1360, 638.5, "DROP HERE", 20, "#e8ecee", 400, "l", 0.02),
          title
            ? frag([
                A(1089, 548, 132, 20, "background:#e6e9f2;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.5)"),
                I("document", 1102, 558, 9, "#9a4fc0"),
                T(1111, 558.5, title.length < 26 ? title : `${title.slice(0, 24)}…`, 7.0, "#242a38", 600, "l", 0.0),
                circ(1127, 572, 5, "#2fb34a", "box-shadow:0 0 0 1px #fff"),
                T(1127, 572.5, "+", 9, "#fff", 700, "c", 0),
              ])
            : null,
        ])
      : null,
    note ? T(1407, 660, note, 8, "#e8923a", 600, "c") : null,
    // the drop target: the message pane and composer, as in the copy
    <div
      key="drop"
      data-testid="eu-chat-drop"
      style={{ left: 949, top: 367, width: 911, height: 543 }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!drag) setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const what = e.dataTransfer.getData("text/plain") || "Artifact";
        setNote(`${what.slice(0, 40)} not shared: ${unavailable("Chat", ch)}`);
      }}
    />,
  ]);
}
