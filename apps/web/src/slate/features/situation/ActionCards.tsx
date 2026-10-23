import { useState, type CSSProperties, type ReactNode } from "react";
import "./actions.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import type { CoaDetail } from "../../SlateSituations.js";

// Situation panel card states (features-b copy): G50 expanded action card
// (estimate, feasibility, risk, review status, tasking strip, Review /
// Compare / Select action), G52 risk popover on the risk value, G54 selected
// action with its status footer, G46 explanation card with a status bar and
// G45 the inline confirm that replaces it. Geometry: the copy's, relative to
// each card's box (frame x 167, the panel at 153).

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({
  position: "absolute",
  left,
  top,
  width,
  height,
  ...extra,
});

export interface CardHead {
  title: string;
  dur: string;
  tag: { text: string; tone: "r" | "g" } | null;
  by: string;
}

function Head({ c, active }: { c: CardHead; active?: boolean }): JSX.Element {
  return (
    <>
      <span className="t1">{c.title}</span>
      <span className="chips">
        <span className="chip">{c.dur}</span>
        {active ? (
          <span className="chip sl-active">● Active</span>
        ) : (
          c.tag && <span className={`chip ${c.tag.tone}`}>{c.tag.text}</span>
        )}
      </span>
      <span className="by">{c.by}</span>
    </>
  );
}

function Tile({
  text,
  left,
  top,
}: {
  text: string;
  left: number;
  top: number;
}): JSX.Element {
  return (
    <span className="sl-tile" style={box(left, top, 26, 17)}>
      {text}
    </span>
  );
}

export function ExpandedAction({
  c,
  d,
  reviewStatus,
  onReview,
  onCompare,
  onSelect,
  onAnalysis,
  selectLabel = "Select action...",
}: {
  c: CardHead;
  d: CoaDetail;
  reviewStatus: string;
  onReview: () => void;
  onCompare: () => void;
  onSelect: () => void;
  onAnalysis: () => void;
  selectLabel?: string;
}): JSX.Element {
  const [pop, setPop] = useState(false);
  const high = d.risks.length > 0;
  const rows: [string, ReactNode][] = [
    ["Estimated time", d.est],
    [
      "Feasibility",
      <span key="f" className={d.feas === "Feasible" ? undefined : "sl-unk"}>
        {d.feas}
      </span>,
    ],
    [
      "Expected risk",
      high ? (
        <button
          key="r"
          type="button"
          className="sl-risk"
          aria-expanded={pop}
          onMouseEnter={() => setPop(true)}
          onClick={(e) => {
            e.stopPropagation();
            setPop((v) => !v);
          }}
        >
          High risk
        </button>
      ) : (
        "Low risk"
      ),
    ],
    ["Review status", reviewStatus],
  ];
  return (
    <div
      className="coa sl-flow sel sl-xcard"
      style={{ height: 250 }}
      onMouseLeave={() => setPop(false)}
    >
      <Head c={c} />
      {rows.map(([k, v], i) => (
        <span key={k}>
          <span className="sl-k" style={box(14, 67 + i * 23.5)}>
            {k}
          </span>
          <span className="sl-v" style={box(146, 67 + i * 23.5)}>
            {v}
          </span>
        </span>
      ))}
      <span className="sl-strip" style={box(2, 169, 404, 37)} />
      <span className="sl-k" style={box(14, 178)}>
        Tasking
      </span>
      <Tile text={d.tile} left={74} top={179} />
      <BpIcon
        name={d.tIcon}
        size={17}
        style={{
          position: "absolute",
          left: 108.5,
          top: 178.5,
          color: "#d5dce0",
        }}
      />
      <span className="sl-v sl-tt" style={box(135, 177, 260)}>
        {d.tText}
      </span>
      {(
        [
          [9, "Review...", onReview],
          [142, "Compare...", onCompare],
          [274, selectLabel, onSelect],
        ] as const
      ).map(([x, label, fn]) => (
        <button
          key={label}
          type="button"
          className="sl-xbtn"
          style={box(x, 207, 125, 30)}
          onClick={(e) => {
            e.stopPropagation();
            fn();
          }}
        >
          {label}
        </button>
      ))}
      {pop && high && (
        <div
          className="sl-riskpop"
          style={box(196, 75, 202)}
          onClick={(e) => e.stopPropagation()}
        >
          {d.risks.map((r) => (
            <span key={r} className="sl-riskrow">
              <BpIcon
                name="warning-sign"
                size={14}
                style={{ color: "#f0838b", flex: "none", marginTop: 2 }}
              />
              {r}
            </span>
          ))}
          <button type="button" className="sl-golink" onClick={onAnalysis}>
            Go to analysis <BpIcon name="arrow-right" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

export function SelectedAction({
  c,
  d,
  status,
  onResolve,
  resolveDisabled,
}: {
  c: CardHead;
  d: CoaDetail;
  status: string;
  onResolve: () => void;
  resolveDisabled: string | null;
}): JSX.Element {
  return (
    <div className="coa sl-flow sel sl-xcard" style={{ height: 218 }}>
      <Head c={c} active />
      {(
        [
          ["Estimated time", d.est],
          ["Expected risk", d.risks.length ? "High risk" : "Low risk"],
          ["Review status", status],
        ] as const
      ).map(([k, v], i) => (
        <span key={k}>
          <span className="sl-k" style={box(14, 66 + i * 24)}>
            {k}
          </span>
          <span className="sl-v" style={box(146, 66 + i * 24)}>
            {v}
          </span>
        </span>
      ))}
      <span className="sl-k" style={box(14, 137)}>
        Tasking
      </span>
      <Tile text={d.tile} left={136} top={139} />
      <BpIcon
        name={d.tIcon}
        size={17}
        style={{
          position: "absolute",
          left: 180.5,
          top: 138.5,
          color: "#d5dce0",
        }}
      />
      <span className="sl-v sl-tt" style={box(207, 137, 190)}>
        {d.tText}
      </span>
      <span className="sl-status" style={box(2, 176, 403, 40)}>
        <b>Status</b>
        <BpIcon
          name="tick"
          size={15}
          style={{
            position: "absolute",
            left: 147.5,
            top: 12.5,
            color: "#4fd6a0",
          }}
        />
        <span style={box(171, 10)}>Selected action</span>
        <button
          type="button"
          className="sl-resolve"
          disabled={resolveDisabled !== null}
          title={resolveDisabled ?? "Mark the situation resolved and save it"}
          onClick={(e) => {
            e.stopPropagation();
            onResolve();
          }}
        >
          Resolve
        </button>
      </span>
    </div>
  );
}

export type HypState = "open" | "confirm" | "verified";

export function ExplanationCard({
  title,
  risk,
  by,
  state,
  onState,
}: {
  title: string;
  risk: boolean;
  by: string;
  state: HypState;
  onState: (s: HypState) => void;
}): JSX.Element {
  if (state === "confirm")
    return (
      <div
        className="sl-hcard sl-hconfirm"
        role="group"
        aria-label="Confirm verification"
      >
        <span style={box(19, 14, 370)} className="sl-hq">
          Confirm verification for <b>{title}</b>?
        </span>
        <button
          type="button"
          className="sl-hcancel"
          style={box(213, 61, 74, 29)}
          onClick={() => onState("open")}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sl-hverify"
          style={box(292, 61, 94, 29)}
          onClick={() => onState("verified")}
        >
          Verify
        </button>
      </div>
    );
  return (
    <div className={`sl-hcard${state === "verified" ? " ver" : ""}`}>
      <span className="sl-ht" style={box(13, 12, 240)}>
        {title}
      </span>
      {risk && (
        <span className="sl-hrisk" style={box(261, 13)}>
          High risk
        </span>
      )}
      <span className="sl-hact" style={box(340, 14)}>
        ● Active
      </span>
      <span className="sl-hby" style={box(13, 37)}>
        {by}
      </span>
      {state === "verified" ? (
        <span className="sl-hstatus" style={box(2, 66, 403, 40)}>
          <b>Status</b>
          <BpIcon
            name="tick"
            size={15}
            style={{
              position: "absolute",
              left: 283.5,
              top: 12.5,
              color: "#4fd6a0",
            }}
          />
          <span style={box(306, 10)}>Verified</span>
        </span>
      ) : (
        <button
          type="button"
          className="sl-hupdate"
          style={box(0, 72, 407, 26)}
          onClick={() => onState("confirm")}
        >
          Update status
        </button>
      )}
    </div>
  );
}
