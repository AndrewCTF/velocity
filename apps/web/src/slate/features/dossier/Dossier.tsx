import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "./dossier.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import { safeHttpUrl } from "../../../shell/safeUrl.js";
import {
  chipRuns,
  countries,
  storyParagraphs,
  useDossier,
  type Country,
} from "./data.js";

// Dossier panel (features-a copy G19 "translating and extracting entities"
// progress, G20 text with entity chips and an entity hover card), in the
// object panel's slot, geometry relative to the copy's box at frame
// (1351, 103). The document is a news-edition story; extraction is
// POST /api/extract with commit=false (nothing written). If the extraction
// model is down, the chips fall back to the story's own ISO3 country tags,
// and the progress card says why.

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

interface Ent {
  name: string;
  type: string;
  attrs: [string, string][];
}

type Phase = { s: "run" } | { s: "done" } | { s: "err"; why: string };

export function Dossier(): JSX.Element | null {
  const story = useDossier((s) => s.story);
  const close = useDossier((s) => s.close);
  const [cmap, setCmap] = useState<Map<string, Country>>(new Map());
  const [ents, setEnts] = useState<Ent[]>([]);
  const [phase, setPhase] = useState<Phase>({ s: "run" });
  const [hover, setHover] = useState<{ e: Ent; top: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void countries().then(setCmap);
  }, []);
  const paras = useMemo(() => (story ? storyParagraphs(story) : []), [story]);

  useEffect(() => {
    setEnts([]);
    setHover(null);
    if (!story) return;
    setPhase({ s: "run" });
    const ac = new AbortController();
    apiFetch("/api/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: [story.title, ...paras].join("\n\n").slice(0, 8000),
        title: story.title.slice(0, 200),
        commit: false,
      }),
      signal: ac.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as {
            detail?: unknown;
          } | null;
          const d = typeof j?.detail === "string" ? j.detail : null;
          setPhase({
            s: "err",
            why: `Entity extraction unavailable (HTTP ${r.status}${d ? `: ${d}` : ""})`,
          });
          return;
        }
        const j = (await r.json()) as {
          entities?: {
            name: string;
            entity_type: string;
            props?: Record<string, unknown>;
          }[];
        };
        setEnts(
          (j.entities ?? []).map((e) => ({
            name: e.name,
            type: e.entity_type,
            attrs: Object.entries(e.props ?? {})
              .filter(([, v]) => typeof v === "string" || typeof v === "number")
              .slice(0, 2)
              .map(([k, v]) => [k, String(v)]),
          })),
        );
        setPhase({ s: "done" });
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [story, paras]);

  useEffect(() => {
    if (!story) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [story, close]);

  if (!story) return null;
  const tags = (story.countries ?? [])
    .map((c) => cmap.get(c))
    .filter((c): c is Country => !!c);
  // Chips: the extracted entities; without a model, the story's country tags.
  const chipEnts: Ent[] = ents.length
    ? ents
    : phase.s === "run"
      ? []
      : tags.map((c) => ({
          name: c.name,
          type: "Country",
          attrs: [
            ["Region", c.region ?? "—"],
            ["Sub-region", c.sub_region ?? "—"],
          ],
        }));
  const byName = new Map(chipEnts.map((e) => [e.name.toLowerCase(), e]));
  const srcs = story.corroboration?.sources ?? [];
  const source = srcs.length
    ? `${srcs[0]}${srcs.length > 1 ? ` +${srcs.length - 1}` : ""}`
    : "—";
  const top = phase.s === "run" || phase.s === "err" ? 263 : 175;
  const link = safeHttpUrl(story.proofs?.[0]?.url);

  return (
    <aside className="sl-dossier" aria-label="Dossier">
      <svg
        style={box(25, 23, 38, 40, {
          overflow: "visible",
          fill: "none",
          stroke: "#b9c8f0",
          strokeWidth: 2.2,
        })}
        viewBox="0 0 38 40"
        aria-hidden="true"
      >
        <path d="M7 2 H23 L33 12 V36 H7 Z M23 2 V12 H33" />
        <path d="M13 20 H27 M13 26 H27 M13 31 H21" strokeWidth="1.8" />
      </svg>
      <div
        className="t"
        style={box(83, 20, 330, undefined, {
          fontSize: 19,
          fontWeight: 600,
          color: "#f6f7f9",
          overflow: "hidden",
          textOverflow: "ellipsis",
        })}
        title={story.title}
      >
        {story.title}
      </div>
      <div
        className="t"
        style={box(82, 42, undefined, undefined, {
          fontSize: 14.5,
          color: "#9fabb2",
        })}
      >
        Dossier
      </div>
      <button
        type="button"
        className="sl-dlink"
        style={box(430, 16, 16, 16, { color: "#b6c0c6" })}
        aria-label="Close the dossier"
        onClick={close}
      >
        <BpIcon name="cross" size={16} />
      </button>
      <div
        className="t"
        style={box(15, 76, undefined, undefined, {
          fontSize: 15,
          color: "#9fabb2",
        })}
      >
        Affiliation
      </div>
      <div
        className="t"
        style={box(130, 76, 320, undefined, {
          fontSize: 15.5,
          color: "#f1f4f6",
          overflow: "hidden",
          textOverflow: "ellipsis",
        })}
      >
        {tags.map((c) => c.name).join(", ") || "No country tag"}
      </div>
      <div
        className="t"
        style={box(15, 100, undefined, undefined, {
          fontSize: 15,
          color: "#9fabb2",
        })}
      >
        Source
      </div>
      {link ? (
        <a
          className="t sl-dsrc"
          style={box(128, 100, 320)}
          href={link}
          target="_blank"
          rel="noopener noreferrer"
        >
          {source}
        </a>
      ) : (
        <div
          className="t"
          style={box(128, 100, 320, undefined, {
            fontSize: 15.5,
            color: "#f1f4f6",
          })}
        >
          {source}
        </div>
      )}
      <div className="sl-dband" style={box(1, 142, 461, 26)}>
        <BpIcon name="chevron-down" size={14} />
        DETAILS
      </div>
      {phase.s !== "done" && (
        <div className="sl-dprog" style={box(16, 180, 432, 68)}>
          <BpIcon
            name="predictive-analysis"
            size={25}
            style={{
              position: "absolute",
              left: 17.5,
              top: 21.5,
              color: "#5fd6cb",
            }}
          />
          <div
            className="t"
            style={box(57, 15, 360, undefined, {
              fontSize: 15,
              color: "#e9eef0",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
            title={phase.s === "err" ? phase.why : undefined}
          >
            {phase.s === "run"
              ? "Translating and extracting entities..."
              : phase.why}
          </div>
          <div
            style={box(57, 44, 293, 7, {
              background: "#3b474d",
              borderRadius: 1,
            })}
          />
          <div
            className={phase.s === "run" ? "sl-dbar run" : "sl-dbar"}
            style={box(57, 44, phase.s === "run" ? 90 : 0, 7)}
          />
        </div>
      )}
      <div ref={bodyRef} className="sl-dbody" style={box(24, top, 424)}>
        {paras.map((p, i) => (
          <p key={i}>
            {chipRuns(
              p,
              chipEnts.map((e) => e.name),
            ).map((r, j) =>
              r.chip ? (
                <span
                  key={j}
                  className="chip"
                  onMouseEnter={(e) => {
                    const ent = byName.get(r.chip!.toLowerCase());
                    if (ent)
                      setHover({
                        e: ent,
                        top: e.currentTarget.offsetTop + top + 26,
                      });
                  }}
                  onMouseLeave={() => setHover(null)}
                >
                  {r.t}
                </span>
              ) : (
                <span key={j}>{r.t}</span>
              ),
            )}
          </p>
        ))}
        {!paras.length && (
          <p className="sl-dmute">The story carries no body text.</p>
        )}
      </div>
      {hover && (
        <div className="sl-dhover" style={box(0, hover.top, 406, 98)}>
          <div
            style={box(16, 18, 59, 60, {
              border: "1px solid #4a5a64",
              background: "#26323a",
              display: "grid",
              placeItems: "center",
              color: "#cfd6da",
              fontWeight: 700,
            })}
          >
            {hover.e.name.slice(0, 2).toUpperCase()}
          </div>
          <div
            className="t"
            style={box(89, 14, 290, undefined, {
              fontSize: 15,
              fontWeight: 700,
              color: "#f6f7f9",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
          >
            {hover.e.name}
          </div>
          {(hover.e.attrs.length
            ? hover.e.attrs
            : [["Type", hover.e.type] as [string, string]]
          ).map(([k, v], i) => (
            <div key={k}>
              <div
                className="t"
                style={box(89, 40 + 24 * i, undefined, undefined, {
                  fontSize: 14,
                  color: "#9fabb2",
                })}
              >
                {k}
              </div>
              <div
                className="t"
                style={box(187, 40 + 24 * i, 200, undefined, {
                  fontSize: 14.5,
                  color: "#e5e8eb",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                })}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
