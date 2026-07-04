// Investigation canvas (Track C4) — a multi-hop link-analysis graph over the
// persisted ontology. Where ConnectionsCard does a one-shot scan of LIVE Cesium
// entities around a selection, THIS reads the saved Object/Link graph from
// `/api/ontology/*`, lets the analyst expand node-by-node across many hops,
// find the shortest chain between two entities, and persist the result as a
// named `investigation:<id>` node.
//
// Design notes:
//   - All backend calls go through `apiFetch` (Supabase Bearer / X-API-Key) —
//     these are the gated `/api/ontology/*` routes, NOT the keyless chip proxy.
//   - The graph is a dependency-free SVG (same idiom as ConnectionsCard): a tiny
//     deterministic spring/repulsion relaxation positions the nodes; the user
//     can drag a node to pin it, and pan/zoom the canvas. No d3/cytoscape dep.
//   - Layout runs in a ref-held loop driven by requestAnimationFrame ONLY while
//     the graph is "warming" (a fixed number of ticks after the node set
//     changes), then idles — it never busy-loops, mirroring the repo's
//     render-on-demand discipline.
//   - Seeded by `useInvestigation.rootId`. Clicking a node = re-select it on the
//     globe (so the EntityPanel follows) + expand its neighbourhood. Degrades
//     honestly: 503 (Supabase unset) → an explicit "not configured" state;
//     empty graph → an empty-state, never a crash.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInvestigation } from './investigationStore.js';
import { GraphHistory } from './GraphHistory.js';
import { useSelection } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';
import { search, LOCATION_KINDS } from '../transport/search.js';
import { SectionLabel, Btn, MicroLabel, Badge } from '../shell/instruments.js';

// ── ontology wire types (mirror intel/ontology.py response models) ────────────

interface OntObject {
  id: string;
  kind: string;
  props: Record<string, unknown>;
  created_at?: string | null;
}
interface OntLink {
  id?: string | null;
  src: string;
  dst: string;
  rel: string;
  props?: Record<string, unknown>;
}
interface SearchAround {
  center: string;
  depth: number;
  objects: OntObject[];
  links: OntLink[];
}
interface PathResult {
  a: string;
  b: string;
  found: boolean;
  hops: number;
  path: string[];
  objects: OntObject[];
  links: OntLink[];
}

// ── per-kind colour (reuses the shell theme vars, matches ConnectionsCard) ─────
// The ontology kinds are derived from the id prefix server-side.
const KIND_COLOR: Record<string, string> = {
  aircraft: 'var(--accent)',
  vessel: 'var(--ok)',
  incident: 'var(--alert)',
  sim: 'var(--mag)',
  target: 'var(--warn)',
  watch: 'var(--warn)',
  investigation: 'var(--txt-1)',
  // digital-OSINT infra kinds (minted by app/osint)
  domain: 'var(--accent)',
  ip: 'var(--ok)',
  cert: 'var(--txt-1)',
  asn: 'var(--warn)',
  service: 'var(--mag)',
  threat: 'var(--alert)',
  org: 'var(--txt-1)',
  email: 'var(--txt-2)',
  object: 'var(--txt-2)',
};
function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? KIND_COLOR['object']!;
}

// A short human label for a node: a distilled prop (callsign / name / title) →
// the id's local part (after the prefix) → the whole id.
function nodeLabel(o: OntObject): string {
  const p = o.props ?? {};
  for (const k of ['callsign', 'name', 'title', 'label', 'registration']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const local = o.id.includes(':') ? o.id.slice(o.id.indexOf(':') + 1) : o.id;
  return local || o.id;
}

// ── layout model ──────────────────────────────────────────────────────────────

interface LNode {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean; // dragged nodes stay put
}
interface LEdge {
  src: string;
  dst: string;
  rel: string;
  onPath: boolean;
}

const VIEW_W = 320;
const VIEW_H = 340;
const WARM_TICKS = 220; // relaxation iterations after a graph change, then idle

// One step of a small spring-embedder: links pull connected nodes to a target
// distance; every pair repels (Coulomb-ish); a weak centring force keeps the
// graph on-canvas. Deterministic given the same input, so the layout is stable.
function relax(nodes: LNode[], edges: LEdge[]): void {
  const k = 64; // ideal link length
  const repel = 2600; // repulsion constant
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 };
  // Repulsion (O(n^2) — node counts here are tens, not thousands).
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (Math.random() - 0.5) * 0.1;
        dy = (Math.random() - 0.5) * 0.1;
        d2 = 0.01;
      }
      const d = Math.sqrt(d2);
      const f = repel / d2;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }
  // Spring along edges.
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  for (const e of edges) {
    const a = byId.get(e.src);
    const b = byId.get(e.dst);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - k) * 0.06;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
  // Integrate + weak centring + damping.
  for (const n of nodes) {
    if (n.pinned) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx += (center.x - n.x) * 0.008;
    n.vy += (center.y - n.y) * 0.008;
    n.vx *= 0.86;
    n.vy *= 0.86;
    n.x += Math.max(-12, Math.min(12, n.vx));
    n.y += Math.max(-12, Math.min(12, n.vy));
    n.x = Math.max(14, Math.min(VIEW_W - 14, n.x));
    n.y = Math.max(14, Math.min(VIEW_H - 14, n.y));
  }
}

// ── fetch helpers ───────────────────────────────────────────────────────────────

type LoadState = 'idle' | 'loading' | 'error' | 'unconfigured';

async function fetchAround(id: string, depth: number, signal: AbortSignal): Promise<SearchAround | number> {
  const r = await apiFetch(
    `/api/ontology/search-around/${encodeURIComponent(id)}?depth=${depth}`,
    { signal },
  );
  if (!r.ok) return r.status;
  return (await r.json()) as SearchAround;
}

// ── component ─────────────────────────────────────────────────────────────────

export function InvestigationCanvas(): JSX.Element {
  const rootId = useInvestigation((s) => s.rootId);
  const setRoot = useInvestigation((s) => s.setRoot);
  const clear = useInvestigation((s) => s.clear);
  const revisions = useInvestigation((s) => s.revisions);
  const viewRev = useInvestigation((s) => s.viewRev);
  const select = useSelection((s) => s.select);

  // The accumulated graph (objects keyed by id + the edge set). Expansion MERGES
  // into this — the analyst builds the picture up hop by hop.
  const [objects, setObjects] = useState<Map<string, OntObject>>(new Map());
  const [edges, setEdges] = useState<OntLink[]>([]);
  // Mirror of `objects` so the async fetch callbacks (root seed / expand resolve
  // later, remove fires from a memoised handler) can read the latest committed
  // id-set for the history revision — a plain state read there would be stale.
  // Kept fresh by an effect and, for back-to-back mutations, synchronously at
  // each commit below.
  const objectsRef = useRef(objects);
  const [status, setStatus] = useState<LoadState>('idle');
  const [expanding, setExpanding] = useState<string | null>(null);

  // Path-finding: pick two endpoints; the result highlights the chain.
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [pathTo, setPathTo] = useState<string | null>(null);
  const [path, setPath] = useState<PathResult | null>(null);

  // Save-investigation UI.
  const [saveName, setSaveName] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Keep the mirror ref fresh after every committed object-set change.
  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  // Reset everything when the root changes (a new "Search around").
  useEffect(() => {
    setObjects(new Map());
    setEdges([]);
    setPath(null);
    setPathFrom(null);
    setPathTo(null);
    setSaveMsg(null);
    if (!rootId) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    const ab = new AbortController();
    fetchAround(rootId, 1, ab.signal)
      .then((res) => {
        if (typeof res === 'number') {
          setStatus(res === 503 ? 'unconfigured' : 'error');
          return;
        }
        const seeded = indexObjects(res.objects);
        objectsRef.current = seeded;
        setObjects(seeded);
        setEdges(res.links);
        setStatus('idle');
        useInvestigation.getState().record({
          kind: 'root',
          label: `seed ${rootId}`,
          nodeIds: [...seeded.keys()],
        });
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name !== 'AbortError') setStatus('error');
      });
    return () => ab.abort();
  }, [rootId]);

  // Expand a node: fetch its 1-hop neighbourhood and merge into the graph.
  const expand = useCallback(
    (id: string) => {
      setExpanding(id);
      const ab = new AbortController();
      fetchAround(id, 1, ab.signal)
        .then((res) => {
          if (typeof res === 'number') {
            if (res === 503) setStatus('unconfigured');
            return;
          }
          const prev = objectsRef.current;
          const next = new Map(prev);
          const before = next.size;
          for (const o of res.objects) {
            // Prefer a persisted row over a derived stub already present.
            const cur = next.get(o.id);
            if (!cur || (Object.keys(o.props ?? {}).length > 0 && Object.keys(cur.props ?? {}).length === 0)) {
              next.set(o.id, o);
            } else if (!next.has(o.id)) {
              next.set(o.id, o);
            }
          }
          objectsRef.current = next;
          setObjects(next);
          setEdges((prevEdges) => mergeEdges(prevEdges, res.links));
          useInvestigation.getState().record({
            kind: 'expand',
            label: `expanded ${id} (+${next.size - before} nodes)`,
            nodeIds: [...next.keys()],
          });
        })
        .catch(() => undefined)
        .finally(() => setExpanding((cur) => (cur === id ? null : cur)));
    },
    [],
  );

  // Node click: re-select on the globe (EntityPanel follows) + expand it. A live
  // aircraft/vessel id reselects the Cesium entity; any id is still expandable.
  const onNodeClick = useCallback(
    (id: string) => {
      if (/^(aircraft|vessel|sim):/.test(id)) select(id);
      expand(id);
    },
    [expand, select],
  );

  // Remove a node from the canvas (alt-click): drop it + any incident edges and
  // forget it as a path endpoint. Declutters an over-expanded graph; the node is
  // only hidden from THIS canvas — search-around can surface it again.
  const removeNode = useCallback((id: string) => {
    const pruned = new Map(objectsRef.current);
    pruned.delete(id);
    objectsRef.current = pruned;
    setObjects(pruned);
    setEdges((prev) => prev.filter((e) => e.src !== id && e.dst !== id));
    setPathFrom((p) => (p === id ? null : p));
    setPathTo((p) => (p === id ? null : p));
    setPath(null);
    useInvestigation.getState().record({ kind: 'remove', label: `removed ${id}`, nodeIds: [...pruned.keys()] });
  }, []);

  // Run path-finding between the two chosen endpoints.
  const runPath = useCallback(() => {
    if (!pathFrom || !pathTo) return;
    setPath(null);
    const ab = new AbortController();
    apiFetch(
      `/api/ontology/path?a=${encodeURIComponent(pathFrom)}&b=${encodeURIComponent(pathTo)}&max_depth=6`,
      { signal: ab.signal },
    )
      .then((r) => (r.ok ? (r.json() as Promise<PathResult>) : null))
      .then((res) => {
        if (!res) return;
        setPath(res);
        // Fold any newly-revealed path nodes/edges into the graph so the chain
        // is actually drawn (the path may traverse nodes not yet expanded).
        if (res.found) {
          setObjects((prev) => {
            const next = new Map(prev);
            for (const o of res.objects) if (!next.has(o.id)) next.set(o.id, o);
            return next;
          });
          setEdges((prev) => mergeEdges(prev, res.links));
        }
      })
      .catch(() => undefined);
  }, [pathFrom, pathTo]);

  // Save the current node set as a named investigation object.
  const saveInvestigation = useCallback(() => {
    const name = saveName.trim();
    if (!name || objects.size === 0) return;
    setSaving(true);
    setSaveMsg(null);
    const id = `investigation:${slug(name)}-${Date.now().toString(36)}`;
    const body = {
      id,
      kind: 'investigation',
      props: {
        title: name,
        root: rootId,
        nodes: Array.from(objects.keys()),
        node_count: objects.size,
        saved_at: new Date().toISOString(),
      },
    };
    apiFetch('/api/ontology/object', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (r) => {
        if (r.ok) {
          setSaveMsg(`saved · ${objects.size} nodes`);
          setSaveName('');
        } else {
          setSaveMsg(r.status === 503 ? 'backend store not configured' : `failed (${r.status})`);
        }
      })
      .catch(() => setSaveMsg('network error'))
      .finally(() => setSaving(false));
  }, [saveName, objects, rootId]);

  // Path id set for edge/node highlighting.
  const pathIds = useMemo(() => new Set(path?.found ? path.path : []), [path]);
  const pathEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    if (path?.found) for (const l of path.links) s.add(edgeKey(l.src, l.dst));
    return s;
  }, [path]);

  // History scrubber: when a past revision is selected (viewRev !== null) render
  // read-only that revision's node set — filter objects to its ids and drop any
  // edge touching a hidden id. Live (null) renders the full accumulated graph.
  const scrubIds = useMemo(
    () => (viewRev !== null && revisions[viewRev] ? new Set(revisions[viewRev]!.nodeIds) : null),
    [viewRev, revisions],
  );
  const viewObjects = useMemo(() => {
    if (!scrubIds) return objects;
    const m = new Map<string, OntObject>();
    for (const [id, o] of objects) if (scrubIds.has(id)) m.set(id, o);
    return m;
  }, [objects, scrubIds]);
  const viewEdges = useMemo(() => {
    if (!scrubIds) return edges;
    return edges.filter((e) => scrubIds.has(e.src) && scrubIds.has(e.dst));
  }, [edges, scrubIds]);

  if (!rootId) {
    return (
      <div className="p-4">
        <SectionLabel title="Investigation" />
        <p className="mt-2 text-txt-3 text-[11px] leading-snug">
          No investigation open. Select an entity and press{' '}
          <span className="mono text-txt-2">⊹ Search around</span> in its panel to build a
          multi-hop link graph from the saved ontology — or seed it by name below.
        </p>
        <div className="mt-3">
          <SeedSearch />
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel title="Investigation" {...(objects.size ? { count: `${objects.size} nodes` } : {})} />
        <button
          type="button"
          onClick={clear}
          className="mono text-[10px] text-txt-3 hover:text-alert px-1"
          title="Close investigation"
        >
          ✕
        </button>
      </div>

      <div className="mono text-[10px] text-txt-3 leading-snug">
        root <span className="text-txt-1">{rootId}</span> · click expands · alt-click removes
      </div>

      {/* Re-seed the graph by typing (callsign / MMSI / name), without a map click. */}
      <SeedSearch />

      {viewRev !== null && revisions[viewRev] && (
        <div className="mono text-[10px] text-warn leading-snug">
          viewing revision {viewRev + 1}/{revisions.length} — click{' '}
          <span className="text-accent">live</span> to return
        </div>
      )}

      <GraphView
        objects={viewObjects}
        edges={viewEdges}
        rootId={rootId}
        pathIds={pathIds}
        pathEdgeKeys={pathEdgeKeys}
        expanding={expanding}
        status={status}
        onNodeClick={onNodeClick}
        onNodeRemove={removeNode}
        onSetRoot={setRoot}
        onPick={(id) => {
          // Cycle the two path endpoints: first pick = from, second = to.
          if (!pathFrom) setPathFrom(id);
          else if (!pathTo && id !== pathFrom) setPathTo(id);
          else {
            setPathFrom(id);
            setPathTo(null);
            setPath(null);
          }
        }}
      />

      {/* Path-finding controls */}
      <section className="rounded-md border border-line bg-bg-1/70 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between">
          <MicroLabel>Path between</MicroLabel>
          <button
            type="button"
            className="mono text-[10px] text-txt-3 hover:text-txt-1"
            onClick={() => {
              setPathFrom(null);
              setPathTo(null);
              setPath(null);
            }}
          >
            reset
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <EndpointSlot label="A" id={pathFrom} color="var(--accent)" />
          <EndpointSlot label="B" id={pathTo} color="var(--mag)" />
        </div>
        <p className="mono text-[10px] text-txt-3 leading-tight">
          shift-click two nodes to set A and B
        </p>
        <Btn size="sm" tone="accent" disabled={!pathFrom || !pathTo} onClick={runPath}>
          ⇆ Find path
        </Btn>
        {path && (
          <div className="mono text-[10px] leading-snug mt-1">
            {path.found ? (
              <span className="text-ok">
                connected · {path.hops} hop{path.hops === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="text-warn">no connection within 6 hops</span>
            )}
          </div>
        )}
      </section>

      {/* Save investigation */}
      <section className="rounded-md border border-line bg-bg-1/70 p-2.5 space-y-1.5">
        <MicroLabel>Save investigation</MicroLabel>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="name…"
            maxLength={120}
            className="flex-1 min-w-0 bg-bg-2 border border-line-2 rounded-sm px-2 py-1 mono text-[10px] text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
          <Btn size="sm" disabled={saving || !saveName.trim() || objects.size === 0} onClick={saveInvestigation}>
            {saving ? '…' : 'Save'}
          </Btn>
        </div>
        {saveMsg && (
          <span
            className={`mono text-[10px] ${saveMsg.startsWith('saved') ? 'text-ok' : 'text-alert'}`}
          >
            {saveMsg}
          </span>
        )}
        <p className="mono text-[10px] text-txt-3 leading-tight">
          persists the {objects.size} node id{objects.size === 1 ? '' : 's'} as an{' '}
          <span className="text-txt-2">investigation:</span> object on your account
        </p>
      </section>

      {/* Change-over-time: revision log + read-only scrubber. */}
      <GraphHistory />
    </div>
  );
}

// ── path endpoint chip ──────────────────────────────────────────────────────────
function EndpointSlot({ label, id, color }: { label: string; id: string | null; color: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 border border-line-2 rounded-sm px-1.5 py-1 bg-bg-2 min-w-0">
      <span className="mono text-[10px] text-txt-3 flex-none">{label}</span>
      <span className="h-2 w-2 rounded-full flex-none" style={{ background: id ? color : 'var(--line-2)' }} />
      <span className="mono text-[10px] text-txt-1 truncate" title={id ?? ''}>
        {id ?? '—'}
      </span>
    </div>
  );
}

// ── seed-by-search ────────────────────────────────────────────────────────────
// Seed the graph by TYPING (callsign / MMSI / name / place) instead of only via a
// map click or selection. Resolves the text through /api/search and centres the
// canvas on the first aircraft/vessel hit via `searchAround`. LOCATION_KINDS
// (place/airport/port/chokepoint) carry no live-store entity id, so they can't
// seed a graph — surfaced as an inline hint. Purely additive to the existing
// click-to-seed path; self-contained local state so it can live in both the
// empty-state and the open-canvas header without lifting anything.
function SeedSearch(): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const run = useCallback(() => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setHint(null);
    search(q)
      .then((results) => {
        // First aircraft/vessel result → a real entity id searchAround accepts.
        const entity = results.find((r) => !LOCATION_KINDS.has(r.kind));
        if (entity) {
          useInvestigation.getState().searchAround(entity.id);
          setText('');
        } else if (results.length > 0) {
          setHint("no aircraft/vessel matched — places can't seed a graph");
        } else {
          setHint('no match');
        }
      })
      .catch(() => setHint('search failed'))
      .finally(() => setBusy(false));
  }, [text, busy]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (hint) setHint(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
          placeholder="callsign / MMSI / name / place…"
          maxLength={120}
          className="flex-1 min-w-0 bg-bg-2 border border-line-2 rounded-sm px-2 py-1 mono text-[10px] text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
        />
        <Btn size="sm" tone="accent" disabled={busy || !text.trim()} onClick={run}>
          {busy ? '…' : 'Seed'}
        </Btn>
      </div>
      {hint && <span className="mono text-[10px] text-warn leading-snug block">{hint}</span>}
    </div>
  );
}

// ── the SVG graph view (layout loop + pan/zoom + drag) ──────────────────────────

function GraphView({
  objects,
  edges,
  rootId,
  pathIds,
  pathEdgeKeys,
  expanding,
  status,
  onNodeClick,
  onNodeRemove,
  onSetRoot,
  onPick,
}: {
  objects: Map<string, OntObject>;
  edges: OntLink[];
  rootId: string;
  pathIds: Set<string>;
  pathEdgeKeys: Set<string>;
  expanding: string | null;
  status: LoadState;
  onNodeClick: (id: string) => void;
  onNodeRemove: (id: string) => void;
  onSetRoot: (id: string) => void;
  onPick: (id: string) => void;
}): JSX.Element {
  // Layout state lives in a ref (mutated by the rAF loop) with a render tick to
  // flush positions to React. Nodes persist across re-renders so expansion
  // doesn't reset the layout — new nodes are seeded near the centre.
  const nodesRef = useRef<Map<string, LNode>>(new Map());
  const warmRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [, force] = useState(0);

  // View transform (pan/zoom) — pure presentation, doesn't perturb layout.
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{ kind: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  );

  // Reconcile layout nodes with the object set whenever it changes.
  const ledges: LEdge[] = useMemo(
    () => edges.map((e) => ({ src: e.src, dst: e.dst, rel: e.rel, onPath: pathEdgeKeys.has(edgeKey(e.src, e.dst)) })),
    [edges, pathEdgeKeys],
  );

  useEffect(() => {
    const m = nodesRef.current;
    // Add new nodes near the centre (root pinned at centre on first sight).
    let i = 0;
    for (const o of objects.values()) {
      if (!m.has(o.id)) {
        const isRoot = o.id === rootId;
        const angle = (i * 137.5 * Math.PI) / 180; // golden-angle scatter
        const rad = isRoot ? 0 : 40 + (i % 5) * 14;
        m.set(o.id, {
          id: o.id,
          kind: o.kind,
          label: nodeLabel(o),
          x: VIEW_W / 2 + Math.cos(angle) * rad,
          y: VIEW_H / 2 + Math.sin(angle) * rad,
          vx: 0,
          vy: 0,
          pinned: isRoot,
        });
      } else {
        // Refresh label/kind if a stub got upgraded to a persisted row.
        const n = m.get(o.id)!;
        n.kind = o.kind;
        n.label = nodeLabel(o);
      }
      i++;
    }
    // Drop layout nodes no longer in the object set (shouldn't happen — we only
    // ever merge — but keeps the map honest).
    for (const id of Array.from(m.keys())) if (!objects.has(id)) m.delete(id);
    warmRef.current = WARM_TICKS;
  }, [objects, rootId]);

  // The relaxation loop — runs only while warming, then stops (no busy loop).
  useEffect(() => {
    const step = (): void => {
      const nodes = Array.from(nodesRef.current.values());
      if (warmRef.current > 0 && nodes.length > 0) {
        relax(nodes, ledges);
        warmRef.current -= 1;
        force((t) => t + 1);
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [ledges]);

  // Pointer handlers: drag a node to pin it, or drag the background to pan.
  // Typed to the common SVG base so it accepts both the root <svg> pointerdown
  // (pan) and a node <g> pointerdown (drag).
  const onPointerDown = (e: React.PointerEvent<SVGElement>, nodeId?: string): void => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (nodeId) {
      const n = nodesRef.current.get(nodeId);
      if (n) {
        n.pinned = true;
        dragRef.current = { kind: 'node', id: nodeId, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
      }
    } else {
      dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'node' && d.id) {
      const n = nodesRef.current.get(d.id);
      if (n) {
        n.x = Math.max(14, Math.min(VIEW_W - 14, d.ox + (e.clientX - d.sx) / view.scale));
        n.y = Math.max(14, Math.min(VIEW_H - 14, d.oy + (e.clientY - d.sy) / view.scale));
        force((t) => t + 1);
      }
    } else {
      setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
    }
  };
  const onPointerUp = (): void => {
    dragRef.current = null;
  };
  const onWheel = (e: React.WheelEvent<SVGSVGElement>): void => {
    const next = Math.max(0.5, Math.min(2.4, view.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    setView((v) => ({ ...v, scale: next }));
  };

  const nodes = Array.from(nodesRef.current.values());
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full rounded-md border border-line bg-bg-2/40 touch-none select-none"
        style={{ height: VIEW_H, cursor: dragRef.current?.kind === 'pan' ? 'grabbing' : 'grab' }}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {/* edges */}
          {ledges.map((e, i) => {
            const a = byId.get(e.src);
            const b = byId.get(e.dst);
            if (!a || !b) return null;
            return (
              <g key={`e${i}-${e.src}-${e.dst}-${e.rel}`}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={e.onPath ? 'var(--mag)' : 'var(--line-2)'}
                  strokeWidth={e.onPath ? 2 : 1}
                />
                <text
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 2}
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize={6.5}
                  fill="var(--txt-3)"
                >
                  {e.rel}
                </text>
              </g>
            );
          })}
          {/* nodes */}
          {nodes.map((n) => {
            const isRoot = n.id === rootId;
            const onPath = pathIds.has(n.id);
            const r = isRoot ? 7 : 5;
            return (
              <g
                key={n.id}
                style={{ cursor: 'pointer' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDown(e, n.id);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  // alt-click removes; shift-click picks a path endpoint; plain
                  // click expands+selects.
                  if (e.altKey) onNodeRemove(n.id);
                  else if (e.shiftKey) onPick(n.id);
                  else onNodeClick(n.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onSetRoot(n.id);
                }}
              >
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill={kindColor(n.kind)}
                  stroke={onPath ? 'var(--mag)' : isRoot ? 'var(--txt-0)' : 'transparent'}
                  strokeWidth={onPath || isRoot ? 1.5 : 0}
                />
                {expanding === n.id && (
                  <circle cx={n.x} cy={n.y} r={r + 3} fill="none" stroke="var(--accent)" strokeWidth={1} opacity={0.7} />
                )}
                <text
                  x={n.x}
                  y={n.y + r + 7}
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize={7.5}
                  fill="var(--txt-1)"
                >
                  {n.label.slice(0, 16)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* status / empty overlays */}
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <MicroLabel>loading graph…</MicroLabel>
        </div>
      )}
      {status === 'unconfigured' && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center pointer-events-none">
          <MicroLabel className="block text-warn">
            ontology store not configured — sign in with a Supabase account to persist + traverse a
            graph
          </MicroLabel>
        </div>
      )}
      {status === 'error' && objects.size === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <MicroLabel className="block text-warn">could not load graph</MicroLabel>
        </div>
      )}
      {status === 'idle' && objects.size <= 1 && (
        <div className="absolute bottom-2 left-0 right-0 flex justify-center px-4 pointer-events-none">
          <MicroLabel className="block text-center text-txt-3">
            no saved links yet — flag / nominate / promote this entity (Actions) to grow its graph
          </MicroLabel>
        </div>
      )}

      {/* legend */}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {Array.from(new Set(nodes.map((n) => n.kind))).slice(0, 6).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: kindColor(k) }} />
            <span className="mono text-[10px] text-txt-3">{k}</span>
          </span>
        ))}
        {nodes.length > 0 && <Badge tone="neutral">dbl-click = re-root</Badge>}
      </div>
    </div>
  );
}

// ── small pure helpers ──────────────────────────────────────────────────────────

function indexObjects(objs: OntObject[]): Map<string, OntObject> {
  const m = new Map<string, OntObject>();
  for (const o of objs) m.set(o.id, o);
  return m;
}

function edgeKey(src: string, dst: string): string {
  // Undirected key so an a→b edge and a b→a path edge highlight the same line.
  return src < dst ? `${src}|${dst}` : `${dst}|${src}`;
}

function mergeEdges(prev: OntLink[], incoming: OntLink[]): OntLink[] {
  const seen = new Set(prev.map((e) => `${e.src}|${e.dst}|${e.rel}`));
  const out = prev.slice();
  for (const e of incoming) {
    const k = `${e.src}|${e.dst}|${e.rel}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'inv';
}
