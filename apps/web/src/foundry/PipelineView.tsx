import { GitBranch } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useFoundry,
  type LineageEdge,
  type LineageNode,
  type PreviewData,
  type StepType,
  type Transform,
  type TransformStep,
} from '../state/foundry.js';
import { Badge, Btn } from '../shell/instruments.js';
import { Drawer, useConfirm } from '../shell/Modal.js';
import { InlineAlert } from '../shell/InlineAlert.js';
import { useFoundryNav } from './nav.js';
import { useFoundryPoll } from './useFoundryPoll.js';
import { EmptyState, Field, ViewHeader, controlCls } from './ui.js';

// Pipeline — the lineage DAG (datasets as rounded nodes, transforms as
// diamonds, bezier edges in topological layers) now with zoom/pan + keyboard-
// focusable nodes, an inspector that deep-links into Datasets, and a transform
// editor that lives in a Drawer (so it's reachable over a tall DAG) and can
// preview an UNSAVED spec. Validation errors (cycle/step 422) render inline
// in the drawer instead of a shared global error line.

const COL_W = 200;
const ROW_H = 68;
const NODE_W = 156;
const NODE_H = 42;
const PAD = 28;

const STEP_TYPES: StepType[] = [
  'select', 'rename', 'filter', 'derive', 'join', 'aggregate', 'union', 'sort', 'limit', 'dedup', 'cast', 'window', 'pivot',
];

interface Laid extends LineageNode {
  x: number;
  y: number;
}

function layout(nodes: LineageNode[], edges: LineageEdge[]): { laid: Laid[]; width: number; height: number } {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const n of nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const e of edges) {
    incoming.get(e.dst)?.push(e.src);
    outgoing.get(e.src)?.push(e.dst);
  }
  const depth = new Map<string, number>();
  const order: string[] = [];
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, (incoming.get(n.id) ?? []).length);
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  const indegWork = new Map(indeg);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const d = Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1);
      depth.set(next, d);
      const left = (indegWork.get(next) ?? 0) - 1;
      indegWork.set(next, left);
      if (left <= 0 && !queue.includes(next) && !order.includes(next)) queue.push(next);
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  const layers = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)?.push(n.id);
  }
  const laid: Laid[] = [];
  let maxDepth = 0;
  let maxRows = 1;
  for (const [d, ids] of layers) {
    maxDepth = Math.max(maxDepth, d);
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, i) => {
      const n = nodes.find((x) => x.id === id) as LineageNode;
      laid.push({ ...n, x: PAD + d * COL_W, y: PAD + i * ROW_H });
    });
  }
  return { laid, width: PAD * 2 + (maxDepth + 1) * COL_W, height: PAD * 2 + maxRows * ROW_H };
}

function StepRow({
  step,
  onChange,
  onRemove,
}: {
  step: TransformStep;
  onChange: (s: TransformStep) => void;
  onRemove: () => void;
}): JSX.Element {
  const set = (patch: Record<string, unknown>): void => onChange({ ...step, ...patch });
  return (
    <div className="flex items-start gap-2 border border-line rounded-sm bg-bg-1 px-2 py-1.5">
      <select
        value={step.type}
        onChange={(e) => onChange(defaultStep(e.target.value as StepType))}
        className="mono text-[11px] bg-bg-0 border border-line rounded-sm px-1 py-1 text-accent w-[84px] shrink-0 outline-none focus:border-accent-line"
      >
        {STEP_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <div className="flex-1 grid grid-cols-2 gap-1.5">
        {step.type === 'select' && (
          <input className={controlCls} placeholder="columns (comma-separated)" value={(step.columns as string[] | undefined)?.join(',') ?? ''} onChange={(e) => set({ columns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        )}
        {step.type === 'rename' && (
          <input className={controlCls} placeholder="old:new, old2:new2" value={Object.entries((step.map as Record<string, string>) ?? {}).map(([k, v]) => `${k}:${v}`).join(', ')} onChange={(e) => {
            const map: Record<string, string> = {};
            for (const pair of e.target.value.split(',')) {
              const [k, v] = pair.split(':').map((s) => s.trim());
              if (k && v) map[k] = v;
            }
            set({ map });
          }} />
        )}
        {step.type === 'filter' && (
          <input className={`${controlCls} col-span-2`} placeholder="expr, e.g. speed > 10 and country == 'DE'" value={(step.expr as string | undefined) ?? ''} onChange={(e) => set({ expr: e.target.value })} />
        )}
        {step.type === 'derive' && (
          <>
            <input className={controlCls} placeholder="new column" value={(step.column as string | undefined) ?? ''} onChange={(e) => set({ column: e.target.value })} />
            <input className={controlCls} placeholder="expr, e.g. speed * 1.852" value={(step.expr as string | undefined) ?? ''} onChange={(e) => set({ expr: e.target.value })} />
          </>
        )}
        {step.type === 'join' && (
          <>
            <input className={controlCls} placeholder="right dataset id" value={(step.right as string | undefined) ?? ''} onChange={(e) => set({ right: e.target.value })} />
            <input className={controlCls} placeholder="on (left col)" value={(step.on as string | undefined) ?? ''} onChange={(e) => set({ on: e.target.value })} />
            <input className={controlCls} placeholder="right_on" value={(step.right_on as string | undefined) ?? ''} onChange={(e) => set({ right_on: e.target.value })} />
            <select className={controlCls} value={(step.how as string | undefined) ?? 'left'} onChange={(e) => set({ how: e.target.value })}>
              <option value="left">left</option>
              <option value="inner">inner</option>
            </select>
          </>
        )}
        {step.type === 'aggregate' && (
          <>
            <input className={controlCls} placeholder="group_by (comma-separated)" value={(step.group_by as string[] | undefined)?.join(',') ?? ''} onChange={(e) => set({ group_by: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            <input className={controlCls} placeholder="aggs: out=count, out2=sum:col" value={Object.entries((step.aggs as Record<string, string>) ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')} onChange={(e) => {
              const aggs: Record<string, string> = {};
              for (const pair of e.target.value.split(',')) {
                const [k, v] = pair.split('=').map((s) => s.trim());
                if (k && v) aggs[k] = v;
              }
              set({ aggs });
            }} />
          </>
        )}
        {step.type === 'union' && (
          <input className={controlCls} placeholder="right dataset id" value={(step.right as string | undefined) ?? ''} onChange={(e) => set({ right: e.target.value })} />
        )}
        {step.type === 'sort' && (
          <>
            <input className={controlCls} placeholder="by column" value={(step.by as string | undefined) ?? ''} onChange={(e) => set({ by: e.target.value })} />
            <label className="flex items-center gap-1.5 text-[10px] text-txt-2">
              <input type="checkbox" checked={Boolean(step.desc)} onChange={(e) => set({ desc: e.target.checked })} />
              descending
            </label>
          </>
        )}
        {step.type === 'limit' && (
          <input className={controlCls} type="number" placeholder="n" value={(step.n as number | undefined) ?? ''} onChange={(e) => set({ n: Number(e.target.value) })} />
        )}
        {step.type === 'dedup' && (
          <input className={controlCls} placeholder="by (comma-separated; blank = whole row)" value={(step.by as string[] | undefined)?.join(',') ?? ''} onChange={(e) => set({ by: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        )}
        {step.type === 'cast' && (
          <>
            <input className={controlCls} placeholder="column" value={(step.column as string | undefined) ?? ''} onChange={(e) => set({ column: e.target.value })} />
            <select className={controlCls} value={(step.to as string | undefined) ?? 'str'} onChange={(e) => set({ to: e.target.value })}>
              <option value="str">str</option>
              <option value="int">int</option>
              <option value="float">float</option>
              <option value="bool">bool</option>
            </select>
          </>
        )}
        {step.type === 'window' && (
          <>
            <input className={controlCls} placeholder="fn: row_number | rank | lag:col | running_sum:col" value={(step.fn as string | undefined) ?? ''} onChange={(e) => set({ fn: e.target.value })} />
            <input className={controlCls} placeholder="into (new column)" value={(step.into as string | undefined) ?? ''} onChange={(e) => set({ into: e.target.value })} />
            <input className={controlCls} placeholder="partition_by (comma)" value={(step.partition_by as string[] | undefined)?.join(',') ?? ''} onChange={(e) => set({ partition_by: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            <input className={controlCls} placeholder="order_by column" value={(step.order_by as string | undefined) ?? ''} onChange={(e) => set({ order_by: e.target.value })} />
            <label className="flex items-center gap-1.5 text-[10px] text-txt-2">
              <input type="checkbox" checked={Boolean(step.desc)} onChange={(e) => set({ desc: e.target.checked })} />
              descending
            </label>
          </>
        )}
        {step.type === 'pivot' && (
          <>
            <input className={controlCls} placeholder="index (comma)" value={(step.index as string[] | undefined)?.join(',') ?? ''} onChange={(e) => set({ index: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            <input className={controlCls} placeholder="column (to spread)" value={(step.column as string | undefined) ?? ''} onChange={(e) => set({ column: e.target.value })} />
            <input className={controlCls} placeholder="value column" value={(step.value as string | undefined) ?? ''} onChange={(e) => set({ value: e.target.value })} />
            <select className={controlCls} value={(step.agg as string | undefined) ?? 'sum'} onChange={(e) => set({ agg: e.target.value })}>
              {['sum', 'count', 'avg', 'min', 'max', 'first'].map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </>
        )}
      </div>
      <button type="button" onClick={onRemove} className="text-txt-3 hover:text-alert text-[12px] px-1" aria-label="Remove step">
        ✕
      </button>
    </div>
  );
}

function defaultStep(type: StepType): TransformStep {
  switch (type) {
    case 'cast':
      return { type, to: 'str' };
    case 'join':
      return { type, how: 'left' };
    case 'sort':
      return { type, desc: false };
    case 'window':
      return { type, fn: 'row_number', into: '' };
    case 'pivot':
      return { type, agg: 'sum' };
    default:
      return { type };
  }
}

function TransformEditor({ editing, onDone }: { editing: Transform | null; onDone: () => void }): JSX.Element {
  const datasets = useFoundry((s) => s.datasets);
  const createTransform = useFoundry((s) => s.createTransform);
  const updateTransform = useFoundry((s) => s.updateTransform);
  const previewSpec = useFoundry((s) => s.previewSpec);

  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [outputName, setOutputName] = useState(editing?.name ? `${editing.name}_out` : '');
  const [inputs, setInputs] = useState<string[]>(editing?.inputs ?? []);
  const [steps, setSteps] = useState<TransformStep[]>(editing?.steps ?? []);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('[]');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [mutError, setMutError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const toggleInput = (id: string): void => setInputs((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const enterJsonMode = (): void => { setJsonText(JSON.stringify(steps, null, 2)); setJsonError(null); setJsonMode(true); };
  const leaveJsonMode = (): void => {
    try { setSteps(JSON.parse(jsonText) as TransformStep[]); setJsonMode(false); setJsonError(null); }
    catch { setJsonError('Invalid JSON — fix it or switch back to the form editor.'); }
  };
  const save = async (): Promise<void> => {
    setMutError(null);
    const body = { name, description, inputs, output_name: outputName || `${name}_out`, steps };
    const res = editing ? await updateTransform(editing.id, body) : await createTransform(body);
    if (res.ok) onDone();
    else setMutError(res.error);
  };
  const runPreview = async (): Promise<void> => {
    setPreviewError(null);
    const res = await previewSpec({ inputs, steps, limit: 20 });
    if (res.ok) setPreview(res.value);
    else setPreviewError(res.error);
  };

  return (
    <Drawer
      open
      onClose={onDone}
      title={editing ? `Edit transform · ${editing.name}` : 'New transform'}
      size={560}
      footer={
        <>
          <Btn onClick={() => void runPreview()} disabled={inputs.length === 0}>Preview</Btn>
          <Btn tone="accent" onClick={() => void save()} disabled={!name || inputs.length === 0}>{editing ? 'Save' : 'Create'}</Btn>
        </>
      }
    >
      <div className="space-y-3">
        {mutError && (
          <div data-testid="transform-error">
            <InlineAlert tone="alert">{mutError}</InlineAlert>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Transform name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="filter-vessels" className={controlCls} /></Field>
          <Field label="Output dataset"><input value={outputName} onChange={(e) => setOutputName(e.target.value)} placeholder={`${name || 'transform'}_out`} className={controlCls} /></Field>
        </div>
        <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" className={controlCls} /></Field>

        <div>
          <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3 mb-1.5">Inputs</div>
          <div className="flex flex-wrap gap-1.5">
            {datasets.map((d) => (
              <label key={d.id} className={`mono text-[10px] px-2 py-1 rounded-sm border cursor-pointer transition-colors ${inputs.includes(d.id) ? 'border-accent-line text-accent bg-accent-dim' : 'border-line text-txt-2 hover:border-line-2'}`}>
                <input type="checkbox" className="hidden" checked={inputs.includes(d.id)} onChange={() => toggleInput(d.id)} />
                {d.name}
              </label>
            ))}
            {datasets.length === 0 && <span className="text-[10px] text-txt-4">No datasets — upload one first.</span>}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3">Steps</div>
            <div className="flex items-center gap-2">
              {!jsonMode && <Btn size="sm" onClick={() => setSteps((s) => [...s, { type: 'select', columns: [] }])}>+ Step</Btn>}
              <Btn size="sm" onClick={() => (jsonMode ? leaveJsonMode() : enterJsonMode())}>{jsonMode ? 'Form editor' : 'Edit as JSON'}</Btn>
            </div>
          </div>
          {jsonMode ? (
            <div className="space-y-1">
              <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={8} className={`${controlCls} leading-relaxed`} />
              {jsonError && <p className="text-[10px] text-alert">{jsonError}</p>}
            </div>
          ) : (
            <div className="space-y-1.5">
              {steps.map((s, i) => (
                <StepRow key={i} step={s} onChange={(next) => setSteps((cur) => cur.map((c, j) => (j === i ? next : c)))} onRemove={() => setSteps((cur) => cur.filter((_, j) => j !== i))} />
              ))}
              {steps.length === 0 && <p className="text-[10px] text-txt-4">No steps yet — the output mirrors the first input. Add a step above.</p>}
            </div>
          )}
        </div>

        {previewError && <p className="text-[10px] text-alert">{previewError}</p>}
        {preview && (preview.quarantined ?? 0) > 0 && <Badge tone="warn">{preview.quarantined} quarantined</Badge>}
        {preview && (
          <div className="overflow-auto rounded-sm border border-line max-h-52" data-testid="transform-preview">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-txt-3 mono text-[10px] uppercase tracking-[0.4px] bg-bg-2 sticky top-0">
                  {preview.schema.map((f) => (
                    <th key={f.name} className="text-left font-medium px-2 py-1 whitespace-nowrap">{f.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-t border-line">
                    {preview.schema.map((f) => (
                      <td key={f.name} className="px-2 py-1 mono text-[11px] text-txt-1 whitespace-nowrap">{String(row[f.name] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function nodeColors(n: LineageNode): { fill: string; stroke: string } {
  if (n.type === 'transform') return { fill: 'var(--bg-3)', stroke: n.stale ? 'var(--warn)' : 'var(--line-2)' };
  if (n.stale) return { fill: 'var(--warn-bg)', stroke: 'var(--warn)' };
  return n.kind === 'derived'
    ? { fill: 'var(--mag-dim)', stroke: 'var(--mag-line)' }
    : { fill: 'var(--accent-dim)', stroke: 'var(--accent-line)' };
}

const MIN_K = 0.4;
const MAX_K = 2.5;

export function PipelineView(): JSX.Element {
  const lineage = useFoundry((s) => s.lineage);
  const transforms = useFoundry((s) => s.transforms);
  const error = useFoundry((s) => s.error);
  const loadLineage = useFoundry((s) => s.loadLineage);
  const loadTransforms = useFoundry((s) => s.loadTransforms);
  const loadDatasets = useFoundry((s) => s.loadDatasets);
  const buildTransform = useFoundry((s) => s.buildTransform);
  const buildPipeline = useFoundry((s) => s.buildPipeline);
  const deleteTransform = useFoundry((s) => s.deleteTransform);
  const selectedId = useFoundryNav((s) => s.selectedId);
  const select = useFoundryNav((s) => s.select);
  const navigate = useFoundryNav((s) => s.navigate);
  const { confirm, confirmElement } = useConfirm();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTransform, setEditingTransform] = useState<Transform | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useFoundryPoll(async () => {
    await Promise.all([loadLineage(), loadTransforms(), loadDatasets()]);
  });

  const { laid, width, height } = useMemo(() => layout(lineage?.nodes ?? [], lineage?.edges ?? []), [lineage]);
  const byId = useMemo(() => new Map(laid.map((n) => [n.id, n])), [laid]);
  const staleCount = (lineage?.nodes ?? []).filter((n) => n.stale).length;
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  const fit = (): void => {
    const el = canvasRef.current;
    const cw = el?.clientWidth ?? 800;
    const ch = el?.clientHeight ?? 400;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(cw / width, ch / height)));
    setView({ k, tx: Math.max(0, (cw - width * k) / 2), ty: Math.max(0, (ch - height * k) / 2) });
  };
  useEffect(() => {
    // Fit once when the layout first has content.
    if (laid.length > 0 && view.k === 1 && view.tx === 0 && view.ty === 0) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laid.length]);

  const zoomBy = (factor: number): void => {
    const el = canvasRef.current;
    const cx = (el?.clientWidth ?? 800) / 2;
    const cy = (el?.clientHeight ?? 400) / 2;
    const k2 = Math.min(MAX_K, Math.max(MIN_K, view.k * factor));
    // keep the center point fixed
    const tx2 = cx - ((cx - view.tx) * k2) / view.k;
    const ty2 = cy - ((cy - view.ty) * k2) / view.k;
    setView({ k: k2, tx: tx2, ty: ty2 });
  };

  const onWheel = (e: React.WheelEvent): void => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const k2 = Math.min(MAX_K, Math.max(MIN_K, view.k * factor));
    const tx2 = px - ((px - view.tx) * k2) / view.k;
    const ty2 = py - ((py - view.ty) * k2) / view.k;
    setView({ k: k2, tx: tx2, ty: ty2 });
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    // only pan when starting on the canvas background, not a node
    if ((e.target as Element).closest('[data-node]')) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const onDelete = async (id: string): Promise<void> => {
    if (await confirm({ title: 'Delete this transform?', body: 'The output dataset stays; its versions remain. The transform definition is removed.', tone: 'danger', confirmLabel: 'Delete' })) {
      await deleteTransform(id);
      select(null);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <ViewHeader
        title="Pipeline"
        subtitle="Transforms map input datasets to derived outputs; the graph shows lineage and staleness."
        actions={
          <>
            <Btn tone="accent" onClick={() => { setEditingTransform(null); setEditorOpen(true); }}>+ New transform</Btn>
            <Btn onClick={() => void buildPipeline()}>Build all</Btn>
            <Btn onClick={() => void buildPipeline(true)}>Build stale</Btn>
          </>
        }
        meta={
          <>
            <span className="flex items-center gap-1.5 text-[10px] text-txt-3"><span className="w-2.5 h-2.5 rounded-sm bg-accent-dim border border-accent-line" /> raw</span>
            <span className="flex items-center gap-1.5 text-[10px] text-txt-3"><span className="w-2.5 h-2.5 rounded-sm bg-mag-dim border border-mag-line" /> derived</span>
            <span className="flex items-center gap-1.5 text-[10px] text-txt-3"><span className="w-2.5 h-2.5 rounded-sm bg-warn-bg border border-warn" /> stale{staleCount > 0 ? ` (${staleCount})` : ''}</span>
          </>
        }
      />
      {error && <p className="px-5 text-[11px] text-alert">{error}</p>}

      <div className="flex-1 min-h-0 flex gap-3 p-3">
        <div className="flex-1 min-w-0 flex flex-col rounded-md border border-line-2 bg-bg-1 overflow-hidden">
          <div className="flex items-center gap-1.5 px-2 py-1 border-b border-line-2 bg-bg-2 shrink-0">
            <Btn size="sm" onClick={() => zoomBy(1.2)} ariaLabel="Zoom in">+</Btn>
            <Btn size="sm" onClick={() => zoomBy(0.83)} ariaLabel="Zoom out">−</Btn>
            <Btn size="sm" onClick={fit}>⤢ fit</Btn>
            <span className="mono text-[10px] text-txt-4 ml-1">{Math.round(view.k * 100)}%</span>
            <span className="mono text-[10px] text-txt-4 ml-auto">drag to pan · wheel to zoom · tab+enter to select</span>
          </div>
          <div
            ref={canvasRef}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="flex-1 min-h-0 overflow-hidden relative cursor-grab active:cursor-grabbing"
            style={{ backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)', backgroundSize: '18px 18px' }}
            data-testid="lineage-dag"
          >
            <svg width="100%" height="100%" className="absolute inset-0">
              <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
                {(lineage?.edges ?? []).map((e, i) => {
                  const a = byId.get(e.src);
                  const b = byId.get(e.dst);
                  if (!a || !b) return null;
                  const x1 = a.x + NODE_W;
                  const y1 = a.y + NODE_H / 2;
                  const x2 = b.x;
                  const y2 = b.y + NODE_H / 2;
                  const mx = (x1 + x2) / 2;
                  return <path key={i} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--line-2)" strokeWidth={1.5 / view.k} />;
                })}
                {laid.map((n) => {
                  const { fill, stroke } = nodeColors(n);
                  const sel = selected?.id === n.id;
                  return (
                    <g
                      key={n.id}
                      data-node
                      role="button"
                      tabIndex={0}
                      aria-label={`${n.type} ${n.name}`}
                      transform={`translate(${n.x},${n.y})`}
                      onClick={() => select(n.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n.id); } }}
                      className="cursor-pointer focus:outline-none"
                      data-testid={`lineage-node-${n.id}`}
                    >
                      {n.type === 'dataset' ? (
                        <rect width={NODE_W} height={NODE_H} rx={5} fill={fill} stroke={sel ? 'var(--mag)' : stroke} strokeWidth={(sel ? 2.5 : 1.25) / view.k} />
                      ) : (
                        <polygon points={`${NODE_W / 2},2 ${NODE_W - 4},${NODE_H / 2} ${NODE_W / 2},${NODE_H - 2} 4,${NODE_H / 2}`} fill={fill} stroke={sel ? 'var(--mag)' : stroke} strokeWidth={(sel ? 2.5 : 1.25) / view.k} />
                      )}
                      <text x={NODE_W / 2} y={NODE_H / 2 - 3} textAnchor="middle" dominantBaseline="middle" className="mono" fontSize={10.5} fill="var(--txt-0)">
                        {n.name.length > 18 ? `${n.name.slice(0, 17)}…` : n.name}
                      </text>
                      <text x={NODE_W / 2} y={NODE_H / 2 + 9} textAnchor="middle" dominantBaseline="middle" className="mono" fontSize={8} fill="var(--txt-3)">
                        {n.type === 'dataset' ? `${(n.row_count ?? 0).toLocaleString()} rows` : 'transform'}
                      </text>
                      {n.stale && (
                        <g data-testid={`lineage-node-${n.id}-stale`}>
                          <circle cx={NODE_W - 8} cy={8} r={4.5} fill="var(--warn)" />
                          <text x={NODE_W - 8} y={8} textAnchor="middle" dominantBaseline="middle" fontSize={7} fill="var(--bg-0)" className="mono">!</text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
            {laid.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <EmptyState icon={GitBranch} title="No pipeline yet" hint="Upload a dataset, then author a transform — its lineage graph draws here." />
              </div>
            )}
          </div>
        </div>

        <div className="w-[280px] shrink-0 rounded-md border border-line-2 bg-bg-1 p-3 overflow-y-auto">
          <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3 mb-2">Inspector</div>
          {!selected && <p className="text-[11px] text-txt-3">Select a node to inspect it.</p>}
          {selected && (
            <div className="space-y-2.5">
              <div className="text-[12px] text-txt-0 break-all">{selected.name}</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge tone={selected.type === 'dataset' ? (selected.kind === 'derived' ? 'mag' : 'accent') : 'neutral'}>{selected.type}</Badge>
                {selected.kind && <Badge tone="neutral">{selected.kind}</Badge>}
                {selected.stale && <Badge tone="warn">stale</Badge>}
              </div>
              {selected.type === 'dataset' && selected.row_count != null && (
                <div className="mono text-[11px] text-txt-2 tabular-nums">{selected.row_count.toLocaleString()} rows</div>
              )}
              {selected.type === 'dataset' && (
                <Btn size="sm" onClick={() => navigate('datasets', selected.id)}>Open dataset →</Btn>
              )}
              {selected.type === 'transform' && (
                <div className="flex flex-col gap-1.5 pt-1">
                  <Btn tone="accent" size="sm" onClick={() => void buildTransform(selected.id).then(() => void loadLineage())}>Build</Btn>
                  <Btn size="sm" onClick={() => { const t = transforms.find((x) => x.id === selected.id); if (t) { setEditingTransform(t); setEditorOpen(true); } }}>Edit</Btn>
                  <Btn size="sm" onClick={() => void onDelete(selected.id)}>Delete</Btn>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {editorOpen && (
        <TransformEditor
          editing={editingTransform}
          onDone={() => { setEditorOpen(false); setEditingTransform(null); void loadLineage(); }}
        />
      )}
      {confirmElement}
    </div>
  );
}
