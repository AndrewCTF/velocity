// Quiver app: time-series analysis over the owned history archive. A list of
// cards (persisted in localStorage), a canvas grid that renders them, and an
// editor for the selected card. Every number comes from the backend:
// GET /api/history/timeseries and GET /api/history/stats.
import { useEffect, useState } from "react";
import { apiFetch } from "../transport/http.js";
import { Trace } from "../entity-panel/ArchiveSeriesCard.js";

type Metric = "aircraft" | "vessel" | "total";
type CardType = "series" | "number" | "stats";
export interface QuiverCard {
  id: string;
  type: CardType;
  title: string;
  metric: Metric;
  windowSec: number;
}

interface Bucket {
  t: number;
  aircraft: number;
  vessel: number;
  total: number;
}
interface SeriesResponse {
  bucket_sec: number;
  buckets: Bucket[];
  degraded?: boolean;
  error?: string;
}

const STORE_KEY = "velocity.quiver.cards.v1";
const WINDOWS: { sec: number; label: string; bucket: number }[] = [
  { sec: 3600, label: "1h", bucket: 60 },
  { sec: 21600, label: "6h", bucket: 300 },
  { sec: 86400, label: "24h", bucket: 900 },
];
const METRICS: Metric[] = ["aircraft", "vessel", "total"];
const TYPE_LABEL: Record<CardType, string> = {
  series: "Series chart",
  number: "Number",
  stats: "Archive stats",
};

function windowLabel(sec: number): string {
  return WINDOWS.find((w) => w.sec === sec)?.label ?? `${sec}s`;
}

function newCard(type: CardType): QuiverCard {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type,
    title: TYPE_LABEL[type],
    metric: "total",
    windowSec: 3600,
  };
}

function loadCards(): QuiverCard[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as QuiverCard[];
    }
  } catch {
    /* corrupt or blocked storage: start from the default set */
  }
  return [newCard("series"), newCard("number"), newCard("stats")];
}

function saveCards(cards: QuiverCard[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cards));
  } catch {
    /* storage full or blocked: the cards still live for this session */
  }
}

/** One GET, reduced to data or an honest reason string. */
function useJson<T>(path: string | null): { data: T | null; err: string | null } {
  const [state, setState] = useState<{ data: T | null; err: string | null }>({
    data: null,
    err: null,
  });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState({ data: null, err: null });
    void (async () => {
      try {
        const r = await apiFetch(path);
        if (!r.ok) {
          if (live) setState({ data: null, err: `HTTP ${r.status}` });
          return;
        }
        const body = (await r.json()) as T;
        if (live) setState({ data: body, err: null });
      } catch {
        if (live) setState({ data: null, err: "backend unreachable" });
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

function seriesPath(windowSec: number): string {
  const bucket = WINDOWS.find((w) => w.sec === windowSec)?.bucket ?? 300;
  return `/api/history/timeseries?window_sec=${windowSec}&bucket_sec=${bucket}`;
}

/** Reason the series cannot be drawn, or null when it can. */
function seriesProblem(
  data: SeriesResponse | null,
  err: string | null,
): string | null {
  if (err) return `History unavailable (${err}).`;
  if (!data) return null;
  if (data.degraded || data.error)
    return `History is off in this profile (HTTP 200, degraded${data.error ? `: ${data.error}` : ""}).`;
  if (data.buckets.length === 0)
    return "Nothing recorded in this window (HTTP 200, 0 buckets).";
  return null;
}

function fmtTime(t: number): string {
  return new Date(t * 1000).toISOString().slice(11, 16) + "Z";
}

function SeriesBody({ card }: { card: QuiverCard }): JSX.Element {
  const { data, err } = useJson<SeriesResponse>(seriesPath(card.windowSec));
  const problem = seriesProblem(data, err);
  if (problem) return <div className="k-empty">{problem}</div>;
  if (!data) return <div className="k-empty">loading…</div>;
  const values = data.buckets.map((b) => b[card.metric]);
  const first = data.buckets[0]!;
  const last = data.buckets[data.buckets.length - 1]!;
  return (
    <div className="px-3 pb-2">
      {values.length < 2 ? (
        <div className="k-empty">One bucket recorded, a line needs two.</div>
      ) : (
        <Trace values={values} width={320} height={90} />
      )}
      <div className="mt-1 flex justify-between text-[12px] text-txt-3">
        <span className="mono">{fmtTime(first.t)}</span>
        <span>
          min <span className="mono">{Math.min(...values)}</span> · max{" "}
          <span className="mono">{Math.max(...values)}</span>
        </span>
        <span className="mono">{fmtTime(last.t)}</span>
      </div>
    </div>
  );
}

function NumberBody({ card }: { card: QuiverCard }): JSX.Element {
  const { data, err } = useJson<SeriesResponse>(seriesPath(card.windowSec));
  const problem = seriesProblem(data, err);
  if (problem) return <div className="k-empty">{problem}</div>;
  if (!data) return <div className="k-empty">loading…</div>;
  const first = data.buckets[0]![card.metric];
  const last = data.buckets[data.buckets.length - 1]![card.metric];
  const delta = last - first;
  return (
    <div className="px-3 pb-3">
      <div className="mono text-[32px] font-semibold text-txt-0">{last}</div>
      <span className={`k-chip ${delta > 0 ? "g" : delta < 0 ? "r" : ""}`}>
        <span className="mono">
          {delta > 0 ? "+" : ""}
          {delta}
        </span>{" "}
        vs {fmtTime(data.buckets[0]!.t)}
      </span>
    </div>
  );
}

const STAT_FIELDS: { key: string; label: string; fmt?: (v: unknown) => string }[] =
  [
    { key: "enabled", label: "Enabled", fmt: (v) => (v ? "yes" : "no") },
    { key: "backend", label: "Backend" },
    { key: "row_count", label: "Rows" },
    {
      key: "archive_bytes",
      label: "Archive size",
      fmt: (v) => `${(Number(v) / 1e6).toFixed(1)} MB`,
    },
    {
      key: "oldest_ts",
      label: "Oldest record",
      fmt: (v) => new Date(Number(v) * 1000).toISOString().slice(0, 16) + "Z",
    },
    { key: "retention_hours", label: "Retention", fmt: (v) => `${String(v)} h` },
  ];

function StatsBody(): JSX.Element {
  const { data, err } = useJson<Record<string, unknown>>("/api/history/stats");
  if (err) return <div className="k-empty">Archive stats unavailable ({err}).</div>;
  if (!data) return <div className="k-empty">loading…</div>;
  const rows = STAT_FIELDS.filter((f) => data[f.key] != null);
  if (rows.length === 0)
    return (
      <div className="k-empty">
        The archive reported none of the expected fields (HTTP 200).
      </div>
    );
  return (
    <div className="k-kv">
      {rows.map((f) => (
        <div key={f.key} className="contents">
          <span className="k">{f.label}</span>
          <span className="v mono">
            {f.fmt ? f.fmt(data[f.key]) : String(data[f.key])}
          </span>
        </div>
      ))}
    </div>
  );
}

function CardView({
  card,
  selected,
  onSelect,
}: {
  card: QuiverCard;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <section
      className={`k-card ${selected ? "sel" : ""}`}
      onClick={onSelect}
      aria-label={card.title}
    >
      <div className="k-card-hd">{card.title}</div>
      <div className="k-card-by">
        {card.type === "stats"
          ? "history archive"
          : `${card.metric} · last ${windowLabel(card.windowSec)}`}
      </div>
      {card.type === "series" && <SeriesBody card={card} />}
      {card.type === "number" && <NumberBody card={card} />}
      {card.type === "stats" && <StatsBody />}
    </section>
  );
}

function Editor({
  card,
  onChange,
}: {
  card: QuiverCard;
  onChange: (c: QuiverCard) => void;
}): JSX.Element {
  const [tab, setTab] = useState<"data" | "display">("data");
  const sel = "w-full border border-line bg-bg-2 px-2 py-1 text-txt-0";
  return (
    <>
      <div className="k-ptabs" role="tablist">
        {(["data", "display"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="k-ptab"
            onClick={() => setTab(t)}
          >
            {t === "data" ? "Data" : "Display"}
          </button>
        ))}
      </div>
      {tab === "data" &&
        (card.type === "stats" ? (
          <div className="k-empty">
            Archive stats read GET /api/history/stats and take no parameters.
          </div>
        ) : (
          <div className="space-y-3 px-4 py-3 text-[14px]">
            <label className="block">
              <span className="text-txt-3">Metric</span>
              <select
                className={sel}
                value={card.metric}
                onChange={(e) =>
                  onChange({ ...card, metric: e.target.value as Metric })
                }
              >
                {METRICS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-txt-3">Window</span>
              <select
                className={sel}
                value={card.windowSec}
                onChange={(e) =>
                  onChange({ ...card, windowSec: Number(e.target.value) })
                }
              >
                {WINDOWS.map((w) => (
                  <option key={w.sec} value={w.sec}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
      {tab === "display" && (
        <div className="px-4 py-3 text-[14px]">
          <label className="block">
            <span className="text-txt-3">Title</span>
            <input
              className={sel}
              value={card.title}
              onChange={(e) => onChange({ ...card, title: e.target.value })}
            />
          </label>
        </div>
      )}
    </>
  );
}

export function QuiverApp(): JSX.Element {
  const [cards, setCards] = useState<QuiverCard[]>(loadCards);
  const [selId, setSelId] = useState<string | null>(null);
  useEffect(() => saveCards(cards), [cards]);
  const selected = cards.find((c) => c.id === selId) ?? null;

  const add = (type: CardType): void => {
    const c = newCard(type);
    setCards((cs) => [...cs, c]);
    setSelId(c.id);
  };

  return (
    <div className="flex h-full min-h-0 bg-bg-1 font-sans text-txt-0">
      <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-line">
        <div className="k-title">Analysis contents</div>
        <div className="k-band">
          Cards <span className="k-n">{cards.length}</span>
        </div>
        {cards.length === 0 && (
          <div className="k-empty">No cards yet. Add one below.</div>
        )}
        {cards.map((c) => (
          <div
            key={c.id}
            className={`flex items-center justify-between px-4 py-1.5 text-[14px] ${c.id === selId ? "bg-bg-3" : ""}`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => setSelId(c.id)}
            >
              {c.title}
            </button>
            <button
              type="button"
              className="text-txt-3 hover:text-txt-0"
              aria-label={`Remove ${c.title}`}
              onClick={() => {
                setCards((cs) => cs.filter((x) => x.id !== c.id));
                if (selId === c.id) setSelId(null);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="k-band">Add card</div>
        <div className="flex flex-wrap gap-1.5 px-4 py-2">
          {(Object.keys(TYPE_LABEL) as CardType[]).map((t) => (
            <button
              key={t}
              type="button"
              className="k-chip"
              onClick={() => add(t)}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))]">
          {cards.map((c) => (
            <CardView
              key={c.id}
              card={c}
              selected={c.id === selId}
              onSelect={() => setSelId(c.id)}
            />
          ))}
        </div>
      </main>

      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line">
        {selected ? (
          <Editor
            card={selected}
            onChange={(next) =>
              setCards((cs) => cs.map((c) => (c.id === next.id ? next : c)))
            }
          />
        ) : (
          <div className="k-empty">Select a card to edit its data and display.</div>
        )}
      </aside>
    </div>
  );
}
