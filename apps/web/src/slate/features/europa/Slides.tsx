// E7 / E8 / E9: the slides editor and presentation mode, laid out natively. The
// editor is a thumbnail column, the slide stage and a details column; the slide
// itself stays a fixed 16:9 canvas scaled to its pane (a slide, not app chrome).
// The map clip is the live E5 map; slide 1 carries the newest evidence item's
// SHA prefix; slide 2 profiles the freshest named cargo-type AIS track in the
// mosaic with a live sanctions lookup.
import { BpIcon } from "../../../shell/BpIcon.js";
import { BrandMark } from "../../../shell/instruments.js";
import {
  UTC,
  pickMarkers,
  unavailable,
  type Evid,
  type Res,
  type SatV,
} from "./data.js";
import { EuBar, SLIDE_H, SLIDE_W, Stage } from "./Bar.js";
import { Mosaic, coverView, type Go } from "./SatMap.js";

export interface Sanctions {
  matched: boolean;
  lists?: string[];
}

const NONE = "—"; // no value reported
const DECK = 4;

function Pager({ n, go }: { n: number; go: Go }): JSX.Element {
  return (
    <div className="eux-pager">
      <button
        type="button"
        className="eu-btn"
        aria-label="Previous slide"
        title={n > 1 ? "Previous slide" : "This is the first slide"}
        disabled={n <= 1}
        onClick={() => go(n === 3 ? "present2" : "present1")}
      >
        <BpIcon name="chevron-left" size={14} />
        Slide
      </button>
      <span>{`${n} of ${DECK}`}</span>
      <button
        type="button"
        className="eu-btn"
        aria-label="Next slide"
        title="Next slide"
        onClick={() => go(n === 1 ? "present2" : n === 2 ? "slides" : "globe")}
      >
        Slide
        <BpIcon name="chevron-right" size={14} />
      </button>
    </div>
  );
}

export function SlidesPage({
  vs,
  pv,
  ev,
  briefsN,
  go,
}: {
  vs: SatV[];
  pv: SatV | null;
  ev: Evid[];
  briefsN: number | null;
  go: Go;
}): JSX.Element {
  const items: [number, string, string, (() => void) | undefined][] = [
    [1, "Title", "presentation", () => go("present1")],
    [2, `${pv?.name ?? "Track"} Profile`, "id-number", () => go("present2")],
    [3, "Dubai Creek Watch", "map", undefined],
    [4, "Collection Schedule", "gantt-chart", () => go("globe")],
  ];
  const { k, mx, my } = coverView(SLIDE_W, SLIDE_H);
  const markers = pickMarkers(vs, 6, [mx, my, SLIDE_W / k, SLIDE_H / k]);
  const e0 = ev[0];
  const when = e0 ? UTC(Date.parse(e0.captured_at) / 1000, "%m/%d/%Y") : NONE;
  return (
    <div className="eux">
      <EuBar go={go} here="slides" crumb="Dubai Creek Watch Briefing">
        <button
          type="button"
          className="eu-btn"
          aria-label="New slide"
          title="The deck is built from live sources, not edited here"
          disabled
        >
          <BpIcon name="add" size={14} />
          New slide
        </button>
        <button
          type="button"
          className="eu-btn"
          aria-label="Publish"
          title="Publishing needs a signed-in workspace"
          disabled
        >
          <BpIcon name="upload" size={14} />
          Publish
        </button>
        <button
          type="button"
          className="eu-btn"
          aria-label="Print"
          title="Print"
          onClick={() => window.print()}
        >
          <BpIcon name="print" size={14} />
          Print
        </button>
        <button
          type="button"
          className="eu-btn"
          aria-label="Present"
          title="Present"
          onClick={() => go("present1")}
        >
          <BpIcon name="desktop" size={14} />
          Present
        </button>
      </EuBar>
      <div className="eux-main">
        <nav className="eux-side eux-left" aria-label="Slides">
          <div className="eux-h">
            <BpIcon name="presentation" size={14} />
            Slides
          </div>
          <ul className="eux-thumbs">
            {items.map(([n, lab, ic, open]) => (
              <li key={n}>
                <button
                  type="button"
                  className="eux-th"
                  aria-label={`Slide ${n}: ${lab}`}
                  aria-current={n === 3 ? "true" : undefined}
                  title={open ? `Slide ${n}: ${lab}` : "Current slide"}
                  disabled={!open}
                  onClick={open}
                >
                  <span>{n}</span>
                  <span>
                    <span className="eux-ph">
                      <BpIcon name={ic} size={24} />
                    </span>
                    <b>{lab}</b>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="eux-col">
          <Stage label="Slide 3: Dubai Creek Watch" className="eux-map">
            <Mosaic left={-mx * k} top={-my * k} k={k} />
            {markers.map((v) => (
              <span
                key={v.id}
                className="eux-ship"
                role="img"
                aria-label={v.name ?? String(v.mmsi)}
                title={`${v.name ?? NONE} · MMSI ${v.mmsi}`}
                style={{ left: (v.px[0] - mx) * k, top: (v.px[1] - my) * k }}
              >
                <BpIcon name="cargo-ship" size={28} />
              </span>
            ))}
          </Stage>
          <Pager n={3} go={go} />
        </div>
        <aside className="eux-side eux-right" aria-label="Slide details">
          <div className="eux-h">
            <BpIcon name="film" size={14} />
            Clip
          </div>
          <div className="eux-card">
            <h3>Dubai Creek Watch</h3>
            <small>{`By ${e0 ? e0.captured_by || "local" : NONE} · ${when}`}</small>
            <button
              type="button"
              className="eu-btn"
              aria-label="Open in the map"
              title="This slide will open in its source application"
              onClick={() => go("map")}
            >
              <BpIcon name="share" size={14} />
              Open in the map
            </button>
          </div>
          <div className="eux-card">
            <div className="eux-kv">
              <span>Watch-officer briefs</span>
              <span>{briefsN ?? NONE}</span>
            </div>
            <button
              type="button"
              className="eu-btn"
              aria-label="Evidence"
              title="Evidence"
              onClick={() => go("gaia")}
            >
              <BpIcon name="duplicate" size={14} />
              Evidence <span className="eu-dim">{ev.length}</span>
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PresentBar({
  n,
  go,
  why,
}: {
  n: number;
  go: Go;
  why: string;
}): JSX.Element {
  return (
    <EuBar
      go={go}
      here={n === 1 ? "present1" : "present2"}
      crumb={`Presentation ${n} of ${DECK}`}
    >
      <button
        type="button"
        className="eu-btn"
        aria-label="Edit deck"
        title="Edit deck"
        onClick={() => go("slides")}
      >
        <BpIcon name="edit" size={14} />
        Edit deck
      </button>
      <button
        type="button"
        className="eu-btn"
        aria-label="Previous slide"
        title={n > 1 ? "Previous slide" : "This is the first slide"}
        disabled={n <= 1}
        onClick={() => go("present1")}
      >
        <BpIcon name="chevron-left" size={14} />
        Previous
      </button>
      <button
        type="button"
        className="eu-btn"
        aria-label="Next slide"
        title="Next slide"
        onClick={() => go(n === 1 ? "present2" : "slides")}
      >
        Next
        <BpIcon name="chevron-right" size={14} />
      </button>
      <button
        type="button"
        className="eu-btn"
        aria-label="Broadcast"
        title={why}
        disabled
      >
        <BpIcon name="feed" size={14} />
        Broadcast
      </button>
      <button
        type="button"
        className="eu-btn"
        aria-label="Exit presentation"
        title="Exit presentation"
        onClick={() => go("slides")}
      >
        <BpIcon name="cross" size={14} />
        Exit
      </button>
    </EuBar>
  );
}

const Footer = (): JSX.Element => (
  <div className="eux-foot">
    <BrandMark size={44} />
    Velocity
  </div>
);

export function Present1({
  ev,
  evRes,
  now,
  go,
  chatWhy,
}: {
  ev: Evid[];
  evRes: Res<unknown> | null;
  now: number;
  go: Go;
  chatWhy: string;
}): JSX.Element {
  return (
    <div className="eux">
      <PresentBar n={1} go={go} why={chatWhy} />
      <Stage label="Slide 1: Title" className="eux-s1">
        <div className="eux-rule" />
        <h1>{`Dubai Creek Watch Briefing - ${UTC(now, "%Y")}`}</h1>
        <p style={{ top: 560 }}>
          {ev[0]
            ? `Evidence ID: ${ev[0].sha256.slice(0, 12)}`
            : unavailable("Evidence", evRes)}
        </p>
        <p style={{ top: 630, color: "#55636d" }}>{UTC(now, "%-d %B %Y")}</p>
        <Footer />
      </Stage>
    </div>
  );
}

export function Present2({
  pv,
  vRes,
  sanc,
  go,
  chatWhy,
}: {
  pv: SatV | null;
  vRes: Res<unknown> | null;
  sanc: Res<Sanctions> | null;
  go: Go;
  chatWhy: string;
}): JSX.Element {
  const k = 1.8;
  const matched = sanc?.data?.matched;
  const sog = pv?.sog != null ? `${pv.sog.toFixed(1)} kn` : NONE;
  return (
    <div className="eux">
      <PresentBar n={2} go={go} why={chatWhy} />
      <Stage label="Slide 2: Profile" className="eux-s2">
        <div className="eux-rule" />
        {pv ? (
          <>
            <h1>{pv.name ?? `MMSI ${pv.mmsi}`}</h1>
            <div className="eux-photo">
              <Mosaic
                left={-Math.round(pv.px[0] * k - 350)}
                top={-Math.round(pv.px[1] * k - 270)}
                k={k}
              />
              <span className="eux-box" />
              <div className="eux-cap">
                {`${pv.ageS != null ? `Last AIS fix ${pv.ageS.toFixed(0)} s before this frame` : "Last AIS fix time not reported"} · ${pv.lat.toFixed(4)} N ${pv.lon.toFixed(4)} E · Esri World Imagery`}
              </div>
            </div>
            <dl className="eux-fields">
              <dt>Name(s):</dt>
              <dd>
                {`"${pv.name ?? NONE}"`}
                <br />
                {`"MMSI ${pv.mmsi}"`}
              </dd>
              <dt>Type:</dt>
              <dd>{`"${pv.shipType || NONE}"`}</dd>
              <dt>Position(s):</dt>
              <dd>
                {`"${pv.lat.toFixed(4)} N, ${pv.lon.toFixed(4)} E"`}
                <br />
                {`"Flag ${pv.flag || NONE}, sog ${sog}"`}
              </dd>
            </dl>
            <div className="eux-sanc" title={sanc?.data?.lists?.join(", ")}>
              Sanctions Registry:{" "}
              <span className={matched === false ? "eux-good" : "eux-bad"}>
                {sanc?.ok
                  ? matched
                    ? '"Match"'
                    : '"No match"'
                  : `"${unavailable("Lookup", sanc)}"`}
              </span>
            </div>
          </>
        ) : (
          <h1 style={{ fontSize: 48 }}>
            {vRes?.ok
              ? "No named track in the view"
              : unavailable("AIS tracks", vRes)}
          </h1>
        )}
        <Footer />
      </Stage>
    </div>
  );
}
