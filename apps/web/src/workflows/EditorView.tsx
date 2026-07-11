import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useWorkflows,
  type BlockCatalogEntry,
  type BlockCategory,
  type ConfigFieldSpec,
  type PreviewResult,
  type WorkflowBlock,
  type WorkflowEdge,
  type WorkflowSpec,
} from '../state/workflows.js';
import { Badge, Btn, Toggle } from '../shell/instruments.js';
import { Modal, useConfirm } from '../shell/Modal.js';
import { useWorkflowsNav } from './nav.js';
import { useWorkflowsPoll } from './useWorkflowsPoll.js';
import {
  EmptyState,
  Field,
  Select,
  Th,
  cellMono,
  controlCls,
  fmtInterval,
  rowCls,
  stamp,
  tableHeadCls,
} from '../foundry/ui.js';

// Editor — the heart of Workflows. A pan/zoom SVG DAG canvas (same pattern as
// foundry/PipelineView.tsx: layered left-to-right auto-layout, node click to
// select, wheel/drag to navigate) plus a schema-driven config panel on the
// right, driven entirely by the GET /api/workflows/blocks catalog so the
// editor never hardcodes a block's fields. Editing state is local (a "draft"
// spec) — nothing is sent to the backend until Save or Preview.

const COL_W = 210;
const ROW_H = 76;
const NODE_W = 172;
const NODE_H = 54;
const PAD = 28;
const MIN_K = 0.4;
const MAX_K = 2.5;

interface Draft {
  id: string | null;
  name: string;
  description: string;
  enabled: boolean;
  spec: WorkflowSpec;
}

function blankDraft(): Draft {
  return { id: null, name: '', description: '', enabled: true, spec: { blocks: [], edges: [] } };
}

// Mint an id unique within the CURRENT draft. A module-level counter would
// reset to 0 on page reload and then collide with ids already saved in a
// reopened workflow (e.g. a second `op_python_1`), which the backend rejects
// with 422 "duplicate block id" — making the workflow permanently unsavable.
function newBlockId(type: string, existing: Set<string>): string {
  const slug = type.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'block';
  let n = 1;
  while (existing.has(`${slug}_${n}`)) n += 1;
  return `${slug}_${n}`;
}

interface Laid extends WorkflowBlock {
  x: number;
  y: number;
}

// Layered left-to-right auto-layout by topological depth. Tolerant of
// dangling edge refs and cycles (both possible mid-edit, pre-save/pre-
// validate) — anything not reachable via the normal BFS gets appended past
// the deepest resolved layer instead of being dropped, so the canvas always
// draws every block.
function layout(blocks: WorkflowBlock[], edges: WorkflowEdge[]): { laid: Laid[]; width: number; height: number } {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const b of blocks) {
    incoming.set(b.id, []);
    outgoing.set(b.id, []);
  }
  for (const e of edges) {
    if (!incoming.has(e.to) || !outgoing.has(e.from)) continue;
    incoming.get(e.to)?.push(e.from);
    outgoing.get(e.from)?.push(e.to);
  }
  const depth = new Map<string, number>();
  const indeg = new Map<string, number>();
  for (const b of blocks) indeg.set(b.id, (incoming.get(b.id) ?? []).length);
  const queue: string[] = blocks.filter((b) => (indeg.get(b.id) ?? 0) === 0).map((b) => b.id);
  for (const id of queue) depth.set(id, 0);
  const indegWork = new Map(indeg);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) {
      const d = Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1);
      depth.set(next, d);
      const left = (indegWork.get(next) ?? 0) - 1;
      indegWork.set(next, left);
      if (left <= 0 && !visited.has(next) && !queue.includes(next)) queue.push(next);
    }
  }
  let cycleDepth = Math.max(-1, ...Array.from(depth.values())) + 1;
  for (const b of blocks) if (!depth.has(b.id)) depth.set(b.id, cycleDepth++);

  const layers = new Map<number, string[]>();
  for (const b of blocks) {
    const d = depth.get(b.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)?.push(b.id);
  }
  const laid: Laid[] = [];
  let maxDepth = 0;
  let maxRows = 1;
  for (const [d, ids] of layers) {
    maxDepth = Math.max(maxDepth, d);
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, i) => {
      const b = blocks.find((x) => x.id === id) as WorkflowBlock;
      laid.push({ ...b, x: PAD + d * COL_W, y: PAD + i * ROW_H });
    });
  }
  return { laid, width: PAD * 2 + (maxDepth + 1) * COL_W, height: PAD * 2 + maxRows * ROW_H };
}

function nodeColors(category: BlockCategory): { fill: string; stroke: string; band: string } {
  if (category === 'source') return { fill: 'var(--accent-dim)', stroke: 'var(--accent-line)', band: 'var(--accent)' };
  if (category === 'sink') return { fill: 'var(--mag-dim)', stroke: 'var(--mag-line)', band: 'var(--mag)' };
  return { fill: 'var(--bg-3)', stroke: 'var(--line-2)', band: 'var(--txt-3)' };
}

function onTabInsert(e: React.KeyboardEvent<HTMLTextAreaElement>, onChange: (v: string) => void): void {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const el = e.currentTarget;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = `${el.value.slice(0, start)}  ${el.value.slice(end)}`;
  onChange(next);
  requestAnimationFrame(() => {
    try {
      el.selectionStart = el.selectionEnd = start + 2;
    } catch {
      /* element may have unmounted */
    }
  });
}

function SampleTable({ rows }: { rows: Array<Record<string, unknown>> }): JSX.Element {
  if (rows.length === 0) return <p className="p-3 text-[11px] text-txt-3">No rows.</p>;
  const cols = Object.keys(rows[0] ?? {});
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className={tableHeadCls()}>
          {cols.map((c) => (
            <Th key={c}>{c}</Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 50).map((row, i) => (
          <tr key={i} className={rowCls}>
            {cols.map((c) => (
              <td key={c} className={cellMono}>
                {String(row[c] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PythonContractNote(): JSX.Element {
  return (
    <div className="rounded-sm border border-line-2 bg-bg-0 px-2.5 py-2 text-[10.5px] text-txt-2 leading-relaxed space-y-1">
      <div className="text-txt-3 uppercase tracking-[0.4px] text-[9.5px]">Contract</div>
      <div className="mono text-[10px] text-txt-1">def run(rows: list[dict], memory: dict):</div>
      <div>
        Return <span className="mono">list[dict]</span> or{' '}
        <span className="mono">{'{"rows": [...], "memory": {...}}'}</span>. Runs in a
        resource-limited subprocess on your own machine (CPU / memory / open-file caps,
        timeout up to 60s) — BYO-compute, not a hostile-tenant sandbox.
      </div>
    </div>
  );
}

function SqlContractNote(): JSX.Element {
  return (
    <div className="rounded-sm border border-line-2 bg-bg-0 px-2.5 py-2 text-[10.5px] text-txt-2 leading-relaxed">
      <div className="text-txt-3 uppercase tracking-[0.4px] text-[9.5px] mb-1">Contract</div>
      Read-only <span className="mono">SELECT</span>/<span className="mono">WITH</span> over sqlite
      table <span className="mono">t</span> (this block&apos;s first input) and{' '}
      <span className="mono">t2</span> (second input, if wired). One statement only.
    </div>
  );
}

function LlmContractNote(): JSX.Element {
  return (
    <div className="rounded-sm border border-line-2 bg-bg-0 px-2.5 py-2 text-[10.5px] text-txt-2 leading-relaxed">
      <div className="text-txt-3 uppercase tracking-[0.4px] text-[9.5px] mb-1">Template variables</div>
      <span className="mono">{'{rows}'}</span> — input rows as JSON (capped 100 rows / 20KB).{' '}
      <span className="mono">{'{memory}'}</span> — this workflow&apos;s persisted memory. per_batch
      returns one summary row; per_row processes up to 50 rows and adds an{' '}
      <span className="mono">llm</span> column per row.
    </div>
  );
}

function FieldControl({
  field,
  blockType,
  value,
  onChange,
}: {
  field: ConfigFieldSpec;
  blockType: string;
  value: unknown;
  onChange: (v: unknown) => void;
}): JSX.Element {
  const isCode = blockType === 'op.python' && field.key === 'code';
  const isSql = blockType === 'op.sql' && field.key === 'query';

  if (field.type === 'bool') {
    return (
      <Field label={field.label} {...(field.help ? { hint: field.help } : {})}>
        <Toggle on={Boolean(value)} onChange={onChange} label={field.label} />
      </Field>
    );
  }
  if (field.type === 'select') {
    return (
      <Field label={field.label} {...(field.help ? { hint: field.help } : {})}>
        <Select
          value={String(value ?? field.default ?? '')}
          onChange={onChange}
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      </Field>
    );
  }
  if (field.type === 'int' || field.type === 'float') {
    return (
      <Field label={field.label} {...(field.help ? { hint: field.help } : {})}>
        <input
          type="number"
          className={controlCls}
          value={value == null ? '' : String(value)}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </Field>
    );
  }
  if (field.type === 'json') {
    return (
      <Field label={field.label} {...(field.help ? { hint: field.help } : {})}>
        <textarea
          value={typeof value === 'string' ? value : value == null ? '[]' : JSON.stringify(value, null, 2)}
          onChange={(e) => onChange(e.target.value)}
          rows={8}
          spellCheck={false}
          className={`${controlCls} leading-relaxed mono`}
        />
      </Field>
    );
  }
  if (field.type === 'text') {
    return (
      <Field label={field.label} {...(field.help ? { hint: field.help } : {})}>
        <textarea
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={isCode || isSql ? (e) => onTabInsert(e, onChange) : undefined}
          placeholder={field.placeholder}
          rows={isCode ? 14 : isSql ? 6 : 4}
          spellCheck={false}
          className={`${controlCls} leading-relaxed ${isCode || isSql ? 'mono' : ''}`}
        />
      </Field>
    );
  }
  return (
    <Field label={field.label} {...(field.help ? { hint: field.help } : {})}>
      <input
        className={controlCls}
        value={value == null ? '' : String(value)}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function ConfigPanel({
  block,
  spec,
  onChange,
  onDelete,
}: {
  block: WorkflowBlock | null;
  spec: BlockCatalogEntry | null | undefined;
  onChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
}): JSX.Element {
  if (!block) {
    return <p className="text-[11px] text-txt-3">Select a block to configure it.</p>;
  }
  if (!spec) {
    return <p className="text-[11px] text-alert">Unknown block type &quot;{block.type}&quot; — not in the catalog.</p>;
  }
  const set = (key: string, value: unknown): void => onChange({ ...block.config, [key]: value });

  return (
    <div className="space-y-3" data-testid="config-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] text-txt-0 truncate">{spec.title}</div>
          <div className="mono text-[10px] text-txt-3">{block.id}</div>
        </div>
        <Badge tone={spec.category === 'source' ? 'accent' : spec.category === 'sink' ? 'mag' : 'neutral'}>
          {spec.category}
        </Badge>
      </div>
      <p className="text-[10.5px] text-txt-3 leading-relaxed">{spec.description}</p>

      {block.type === 'op.python' && <PythonContractNote />}
      {block.type === 'op.sql' && <SqlContractNote />}
      {block.type === 'op.llm' && <LlmContractNote />}

      <div className="space-y-2.5">
        {spec.config_schema.map((f) => (
          <FieldControl key={f.key} field={f} blockType={block.type} value={block.config[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
        {spec.config_schema.length === 0 && <p className="text-[10px] text-txt-4">No configuration for this block.</p>}
      </div>

      <Btn size="sm" onClick={onDelete} className="border-[rgba(255,90,82,0.38)] text-[#ffc9c5] hover:border-alert">
        Delete block
      </Btn>
    </div>
  );
}

function PaletteModal({
  blocks,
  onPick,
  onClose,
}: {
  blocks: BlockCatalogEntry[];
  onPick: (type: string) => void;
  onClose: () => void;
}): JSX.Element {
  const groups: Array<{ key: BlockCategory; label: string }> = [
    { key: 'source', label: 'Sources' },
    { key: 'op', label: 'Ops' },
    { key: 'sink', label: 'Sinks' },
  ];
  return (
    <Modal open onClose={onClose} title="Add block" width={560}>
      <div className="space-y-4">
        {groups.map((g) => {
          const items = blocks.filter((b) => b.category === g.key);
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3 mb-1.5">{g.label}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((b) => (
                  <button
                    key={b.type}
                    type="button"
                    data-testid={`palette-block-${b.type}`}
                    onClick={() => onPick(b.type)}
                    className="text-left rounded-sm border border-line px-2.5 py-2 hover:border-accent-line hover:bg-bg-2 transition-colors"
                  >
                    <div className="text-[11px] text-txt-0">{b.title}</div>
                    <div className="text-[10px] text-txt-3 mt-0.5 leading-snug">{b.description}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {blocks.length === 0 && <p className="text-[11px] text-txt-3">Loading catalog…</p>}
      </div>
    </Modal>
  );
}

function ScheduleModal({ workflowId, onClose }: { workflowId: string; onClose: () => void }): JSX.Element {
  const schedules = useWorkflows((s) => s.schedules);
  const loadSchedules = useWorkflows((s) => s.loadSchedules);
  const createSchedule = useWorkflows((s) => s.createSchedule);
  const updateSchedule = useWorkflows((s) => s.updateSchedule);
  const deleteSchedule = useWorkflows((s) => s.deleteSchedule);
  const [intervalS, setIntervalS] = useState(3600);

  useEffect(() => {
    void loadSchedules(workflowId);
  }, [workflowId, loadSchedules]);

  const mine = schedules.filter((s) => s.workflow_id === workflowId);

  return (
    <Modal open onClose={onClose} title="Schedule" width={480}>
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <Field label="Interval (seconds)">
            <input
              type="number"
              min={1}
              value={intervalS}
              onChange={(e) => setIntervalS(Math.max(1, Number(e.target.value)))}
              className={controlCls}
            />
          </Field>
          <Btn tone="accent" onClick={() => void createSchedule(workflowId, intervalS)}>
            + Add
          </Btn>
        </div>
        <div className="rounded-sm border border-line-2 overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className={tableHeadCls()}>
                <Th align="right">Interval</Th>
                <Th>Last run</Th>
                <Th>State</Th>
                <Th align="center">Enabled</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {mine.map((s) => (
                <tr key={s.id} className={rowCls}>
                  <td className={`${cellMono} text-right`} title={`${s.interval_s}s`}>
                    {fmtInterval(s.interval_s)}
                  </td>
                  <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(s.last_run) || 'never'}</td>
                  <td className="px-2.5 py-1.5">
                    {s.last_error ? <Badge tone="alert">error</Badge> : <Badge tone="ok">ok</Badge>}
                  </td>
                  <td className="px-2.5 py-1.5 text-center">
                    <Toggle on={s.enabled} onChange={(next) => void updateSchedule(s.id, workflowId, s.interval_s, next)} label="enabled" />
                  </td>
                  <td className="px-2.5 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => void deleteSchedule(s.id)}
                      className="text-txt-3 hover:text-alert text-[12px]"
                      aria-label="Delete schedule"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {mine.length === 0 && <div className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">No schedules yet.</div>}
        </div>
      </div>
    </Modal>
  );
}

function MemoryModal({ workflowId, onClose }: { workflowId: string; onClose: () => void }): JSX.Element {
  const getMemory = useWorkflows((s) => s.getMemory);
  const putMemory = useWorkflows((s) => s.putMemory);
  const [text, setText] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mem = await getMemory(workflowId);
      if (!cancelled) {
        setText(JSON.stringify(mem ?? {}, null, 2));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, getMemory]);

  const onSave = async (): Promise<void> => {
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      setError('Invalid JSON.');
      return;
    }
    const res = await putMemory(workflowId, parsed);
    if (res) setText(JSON.stringify(res, null, 2));
    else setError('save failed');
  };

  return (
    <Modal open onClose={onClose} title="Memory" width={520} footer={<Btn tone="accent" onClick={() => void onSave()}>Save</Btn>}>
      <div className="space-y-2">
        <p className="text-[10.5px] text-txt-3">
          Persistent per-workflow key/value state (dedup, baselines) — read/written by blocks via{' '}
          <span className="mono">memory</span>. Saving replaces the whole memory wholesale.
        </p>
        {error && <p className="text-[11px] text-alert">{error}</p>}
        {loading ? (
          <p className="text-[11px] text-txt-3">Loading…</p>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            spellCheck={false}
            className={`${controlCls} leading-relaxed mono`}
            data-testid="memory-textarea"
          />
        )}
      </div>
    </Modal>
  );
}

export function EditorView(): JSX.Element {
  const workflows = useWorkflows((s) => s.workflows);
  const blocks = useWorkflows((s) => s.blocks);
  const storeError = useWorkflows((s) => s.error);
  const loadWorkflows = useWorkflows((s) => s.loadWorkflows);
  const loadBlocks = useWorkflows((s) => s.loadBlocks);
  const getWorkflow = useWorkflows((s) => s.getWorkflow);
  const createWorkflow = useWorkflows((s) => s.createWorkflow);
  const updateWorkflow = useWorkflows((s) => s.updateWorkflow);
  const deleteWorkflow = useWorkflows((s) => s.deleteWorkflow);
  const previewWorkflow = useWorkflows((s) => s.previewWorkflow);
  const runWorkflow = useWorkflows((s) => s.runWorkflow);

  const selectedId = useWorkflowsNav((s) => s.selectedId);
  const select = useWorkflowsNav((s) => s.select);
  const navigate = useWorkflowsNav((s) => s.navigate);
  const { confirm, confirmElement } = useConfirm();

  const [draft, setDraft] = useState<Draft>(blankDraft());
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useWorkflowsPoll(async () => {
    await Promise.all([loadWorkflows(), loadBlocks()]);
  });

  // Load the selected workflow into the local draft. Deliberately does NOT
  // depend on the `workflows` list (which re-fetches on every poll tick) —
  // only an explicit selection change reloads the draft, so in-progress edits
  // survive a background refresh.
  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setDraft(blankDraft());
      setSelectedBlockId(null);
      setPreviewResult(null);
      setPreviewError(null);
      setSaveError(null);
      return;
    }
    (async () => {
      const wf = await getWorkflow(selectedId);
      if (cancelled || !wf) return;
      setDraft({ id: wf.id, name: wf.name, description: wf.description, enabled: wf.enabled, spec: wf.spec });
      setSelectedBlockId(null);
      setPreviewResult(null);
      setPreviewError(null);
      setSaveError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, getWorkflow]);

  const catalogByType = useMemo(() => new Map(blocks.map((b) => [b.type, b])), [blocks]);
  const { laid, width, height } = useMemo(() => layout(draft.spec.blocks, draft.spec.edges), [draft.spec]);
  const byId = useMemo(() => new Map(laid.map((n) => [n.id, n])), [laid]);

  const fit = (): void => {
    const el = canvasRef.current;
    const cw = el?.clientWidth ?? 800;
    const ch = el?.clientHeight ?? 400;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(cw / width, ch / height)));
    setView({ k, tx: Math.max(0, (cw - width * k) / 2), ty: Math.max(0, (ch - height * k) / 2) });
  };
  const prevFitRef = useRef<{ id: string | null; len: number } | undefined>(undefined);
  useEffect(() => {
    const prev = prevFitRef.current;
    // Refit only when the selected workflow changes or its node count first
    // goes from empty to non-empty — NOT on every count change, which would
    // snap the view back and discard the user's manual pan/zoom each time a
    // block is added or deleted.
    const idChanged = !prev || prev.id !== draft.id;
    const firstContent = (prev?.len ?? 0) === 0 && laid.length > 0;
    if (idChanged || firstContent) fit();
    prevFitRef.current = { id: draft.id, len: laid.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id, laid.length]);

  const zoomBy = (factor: number): void => {
    const el = canvasRef.current;
    const cx = (el?.clientWidth ?? 800) / 2;
    const cy = (el?.clientHeight ?? 400) / 2;
    const k2 = Math.min(MAX_K, Math.max(MIN_K, view.k * factor));
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

  const addBlock = (type: string): void => {
    const spec = catalogByType.get(type);
    if (!spec) return;
    const config: Record<string, unknown> = {};
    for (const f of spec.config_schema) if (f.default !== undefined) config[f.key] = f.default;
    const id = newBlockId(type, new Set(draft.spec.blocks.map((b) => b.id)));
    setDraft((d) => ({ ...d, spec: { ...d.spec, blocks: [...d.spec.blocks, { id, type, config }] } }));
    setSelectedBlockId(id);
    setPaletteOpen(false);
  };

  const onDeleteBlock = async (id: string): Promise<void> => {
    const ok = await confirm({ title: 'Delete this block?', body: 'Its connections are removed too.', tone: 'danger', confirmLabel: 'Delete' });
    if (!ok) return;
    setDraft((d) => ({
      ...d,
      spec: {
        blocks: d.spec.blocks.filter((b) => b.id !== id),
        edges: d.spec.edges.filter((e) => e.from !== id && e.to !== id),
      },
    }));
    if (selectedBlockId === id) setSelectedBlockId(null);
  };

  const onNodeClick = (id: string): void => {
    if (connectMode) {
      if (!connectFrom) {
        setConnectFrom(id);
        return;
      }
      if (connectFrom === id) {
        setConnectFrom(null);
        return;
      }
      const from = connectFrom;
      setDraft((d) => {
        if (d.spec.edges.some((e) => e.from === from && e.to === id)) return d;
        return { ...d, spec: { ...d.spec, edges: [...d.spec.edges, { from, to: id }] } };
      });
      setConnectFrom(null);
      return;
    }
    setSelectedBlockId(id);
  };

  const onEdgeClick = async (edge: WorkflowEdge): Promise<void> => {
    const ok = await confirm({ title: 'Remove this connection?', tone: 'danger', confirmLabel: 'Remove' });
    if (!ok) return;
    setDraft((d) => ({ ...d, spec: { ...d.spec, edges: d.spec.edges.filter((e) => !(e.from === edge.from && e.to === edge.to)) } }));
  };

  const updateBlockConfig = (id: string, config: Record<string, unknown>): void => {
    setDraft((d) => ({ ...d, spec: { ...d.spec, blocks: d.spec.blocks.map((b) => (b.id === id ? { ...b, config } : b)) } }));
  };

  const onSave = async (): Promise<void> => {
    setSaveError(null);
    const specOut: WorkflowSpec = {
      blocks: draft.spec.blocks.map((b) => ({ id: b.id, type: b.type, config: b.config })),
      edges: draft.spec.edges,
    };
    const res = draft.id
      ? await updateWorkflow(draft.id, draft.name, draft.description, specOut, draft.enabled)
      : await createWorkflow(draft.name, draft.description, specOut, draft.enabled);
    if (res.ok) {
      setDraft((d) => ({ ...d, id: res.value.id }));
      select(res.value.id);
    } else {
      setSaveError(res.error);
    }
  };

  const onPreview = async (): Promise<void> => {
    setPreviewError(null);
    const res = await previewWorkflow({ blocks: draft.spec.blocks, edges: draft.spec.edges });
    if (res.ok) setPreviewResult(res.value);
    else setPreviewError(res.error);
  };

  const onRun = async (): Promise<void> => {
    if (!draft.id) return;
    const run = await runWorkflow(draft.id);
    if (run) navigate('runs', run.id);
  };

  const onDeleteWorkflow = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({ title: `Delete workflow "${name}"?`, body: 'Its runs, schedules, and memory are removed too.', tone: 'danger', confirmLabel: 'Delete' });
    if (!ok) return;
    await deleteWorkflow(id);
    if (draft.id === id) select(null);
  };

  const warnings = useMemo(() => {
    const out: string[] = [];
    const inCount = new Map<string, number>();
    const touched = new Set<string>();
    for (const b of draft.spec.blocks) inCount.set(b.id, 0);
    for (const e of draft.spec.edges) {
      inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1);
      touched.add(e.from);
      touched.add(e.to);
    }
    for (const b of draft.spec.blocks) {
      const spec = catalogByType.get(b.type);
      if (!spec) {
        out.push(`${b.id}: unknown block type "${b.type}"`);
        continue;
      }
      const n = inCount.get(b.id) ?? 0;
      if (n < spec.min_inputs || n > spec.max_inputs) {
        out.push(`${b.id} (${spec.title}) expects ${spec.min_inputs}-${spec.max_inputs} input(s), has ${n}`);
      }
      if (draft.spec.blocks.length > 1 && !touched.has(b.id)) {
        out.push(`${b.id} (${spec.title}) is not connected to anything`);
      }
    }
    return out;
  }, [draft.spec, catalogByType]);

  const selectedBlock = draft.spec.blocks.find((b) => b.id === selectedBlockId) ?? null;
  const selectedBlockSpec = selectedBlock ? catalogByType.get(selectedBlock.type) : null;
  const selectedPreview = selectedBlockId ? previewResult?.blocks[selectedBlockId] : undefined;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-line-2 px-4 py-2.5 shrink-0 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="h-3 w-[3px] rounded-sm bg-accent shrink-0" />
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="workflow name"
            aria-label="Workflow name"
            className={`${controlCls} max-w-[220px] font-semibold`}
          />
          <input
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="description (optional)"
            aria-label="Workflow description"
            className={`${controlCls} flex-1 max-w-[360px]`}
          />
          <Toggle on={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} label="enabled" />
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <Btn size="sm" onClick={() => void onPreview()}>Preview</Btn>
          <Btn size="sm" onClick={() => void onRun()} disabled={!draft.id}>Run</Btn>
          <Btn size="sm" onClick={() => setScheduleOpen(true)} disabled={!draft.id}>Schedule</Btn>
          <Btn size="sm" onClick={() => setMemoryOpen(true)} disabled={!draft.id}>Memory</Btn>
          <Btn tone="accent" size="sm" onClick={() => void onSave()} disabled={!draft.name.trim()}>
            {draft.id ? 'Save' : 'Create'}
          </Btn>
        </div>
      </div>

      {storeError && <p className="px-4 pt-1.5 text-[11px] text-alert">{storeError}</p>}
      {saveError && <p className="px-4 pt-1.5 text-[11px] text-alert">save: {saveError}</p>}
      {previewError && <p className="px-4 pt-1.5 text-[11px] text-alert">preview: {previewError}</p>}
      {warnings.length > 0 && (
        <div className="mx-4 mt-2 rounded-sm border border-[rgba(245,165,36,0.38)] bg-warn-bg px-2.5 py-1.5 text-[10.5px] text-[#fcd9a0] space-y-0.5" data-testid="spec-warnings">
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-3 p-3">
        <div className="w-[200px] shrink-0 rounded-md border border-line-2 bg-bg-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-line-2">
            <span className="text-[10px] uppercase tracking-[0.4px] text-txt-3">Workflows</span>
            <Btn size="sm" onClick={() => select(null)}>+ New</Btn>
          </div>
          <div className="flex-1 overflow-y-auto">
            {workflows.map((w) => (
              <div
                key={w.id}
                data-testid={`workflow-row-${w.id}`}
                className={[
                  'w-full flex items-center gap-1 px-2.5 py-1.5 border-b border-line text-[11px] transition-colors',
                  draft.id === w.id ? 'bg-accent-dim text-txt-0' : 'text-txt-2 hover:bg-bg-2 hover:text-txt-0',
                ].join(' ')}
              >
                <button type="button" onClick={() => select(w.id)} className="flex-1 min-w-0 text-left flex items-center gap-1.5">
                  <span className="truncate flex-1">{w.name}</span>
                  {!w.enabled && <Badge tone="neutral">off</Badge>}
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteWorkflow(w.id, w.name)}
                  className="text-txt-3 hover:text-alert text-[11px] shrink-0"
                  aria-label={`Delete ${w.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
            {workflows.length === 0 && <p className="px-2.5 py-3 text-[10px] text-txt-4">No workflows yet.</p>}
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-3 min-h-0">
          <div className="flex-1 min-h-0 flex flex-col rounded-md border border-line-2 bg-bg-1 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1 border-b border-line-2 bg-bg-2 shrink-0 flex-wrap">
              <Btn size="sm" onClick={() => zoomBy(1.2)} ariaLabel="Zoom in">+</Btn>
              <Btn size="sm" onClick={() => zoomBy(0.83)} ariaLabel="Zoom out">−</Btn>
              <Btn size="sm" onClick={fit}>⤢ fit</Btn>
              <span className="mono text-[10px] text-txt-4 ml-1">{Math.round(view.k * 100)}%</span>
              <Btn
                size="sm"
                tone={connectMode ? 'accent' : 'neutral'}
                onClick={() => {
                  setConnectMode((v) => !v);
                  setConnectFrom(null);
                }}
              >
                {connectMode ? (connectFrom ? 'pick target…' : 'pick source…') : 'connect'}
              </Btn>
              <Btn size="sm" tone="accent" onClick={() => setPaletteOpen(true)}>+ Add block</Btn>
              <span className="mono text-[10px] text-txt-4 ml-auto">drag to pan · wheel to zoom</span>
            </div>
            <div
              ref={canvasRef}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="flex-1 min-h-0 overflow-hidden relative cursor-grab active:cursor-grabbing"
              style={{ backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)', backgroundSize: '18px 18px' }}
              data-testid="workflow-dag"
            >
              <svg width="100%" height="100%" className="absolute inset-0">
                <defs>
                  <marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--line-2)" />
                  </marker>
                </defs>
                <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
                  {draft.spec.edges.map((e, i) => {
                    const a = byId.get(e.from);
                    const b = byId.get(e.to);
                    if (!a || !b) return null;
                    const x1 = a.x + NODE_W;
                    const y1 = a.y + NODE_H / 2;
                    const x2 = b.x;
                    const y2 = b.y + NODE_H / 2;
                    const mx = (x1 + x2) / 2;
                    return (
                      <path
                        key={i}
                        d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke="var(--line-2)"
                        strokeWidth={2.5 / view.k}
                        markerEnd="url(#wf-arrow)"
                        className="cursor-pointer"
                        onClick={() => void onEdgeClick(e)}
                        data-testid={`edge-${e.from}-${e.to}`}
                      />
                    );
                  })}
                  {laid.map((n) => {
                    const spec = catalogByType.get(n.type);
                    const colors = nodeColors(spec?.category ?? 'op');
                    const sel = selectedBlockId === n.id;
                    const picked = connectFrom === n.id;
                    const pb = previewResult?.blocks[n.id];
                    return (
                      <g
                        key={n.id}
                        data-node
                        role="button"
                        tabIndex={0}
                        aria-label={`${n.type} ${n.id}`}
                        transform={`translate(${n.x},${n.y})`}
                        onClick={() => onNodeClick(n.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onNodeClick(n.id);
                          }
                        }}
                        className="cursor-pointer focus:outline-none"
                        data-testid={`block-node-${n.id}`}
                      >
                        <rect
                          width={NODE_W}
                          height={NODE_H}
                          rx={5}
                          fill={colors.fill}
                          stroke={sel || picked ? 'var(--mag)' : colors.stroke}
                          strokeWidth={(sel || picked ? 2.5 : 1.25) / view.k}
                        />
                        <rect width={NODE_W} height={4} rx={2} fill={colors.band} />
                        <text x={8} y={22} className="mono" fontSize={10} fill="var(--txt-0)">
                          {n.type.length > 20 ? `${n.type.slice(0, 19)}…` : n.type}
                        </text>
                        <text x={8} y={36} className="mono" fontSize={8.5} fill="var(--txt-3)">
                          {n.id.length > 24 ? `${n.id.slice(0, 23)}…` : n.id}
                        </text>
                        {pb && (
                          <g data-testid={`block-node-${n.id}-badge`}>
                            <rect
                              x={NODE_W - 58}
                              y={NODE_H - 16}
                              width={54}
                              height={12}
                              rx={2}
                              fill={pb.error ? 'var(--alert-bg)' : 'var(--bg-0)'}
                              stroke={pb.error ? 'var(--alert)' : 'var(--line)'}
                              strokeWidth={0.75 / view.k}
                            />
                            <text
                              x={NODE_W - 31}
                              y={NODE_H - 7}
                              textAnchor="middle"
                              className="mono"
                              fontSize={7.5}
                              fill={pb.error ? 'var(--alert)' : 'var(--txt-2)'}
                            >
                              {pb.error ? 'error' : `${pb.rows_in}→${pb.rows_out}`}
                            </text>
                          </g>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
              {laid.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center p-6">
                  <EmptyState
                    icon="⋔"
                    title="No blocks yet"
                    hint="Add a source, wire it into ops and sinks — the graph draws here."
                    action={<Btn tone="accent" size="sm" onClick={() => setPaletteOpen(true)}>+ Add block</Btn>}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="h-[180px] shrink-0 rounded-md border border-line-2 bg-bg-1 overflow-hidden flex flex-col">
            <div className="px-2.5 py-1.5 border-b border-line-2 text-[10px] uppercase tracking-[0.4px] text-txt-3 flex items-center justify-between">
              <span>Sample rows{selectedBlockId ? ` — ${selectedBlockId}` : ''}</span>
              {selectedPreview && (
                <span className="mono text-txt-4">
                  {selectedPreview.rows_in}→{selectedPreview.rows_out}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              {!selectedBlockId && <p className="p-3 text-[11px] text-txt-3">Select a block to inspect its preview sample.</p>}
              {selectedBlockId && !previewResult && <p className="p-3 text-[11px] text-txt-3">Run Preview to see sample rows.</p>}
              {selectedBlockId && selectedPreview?.error && <p className="p-3 text-[11px] text-alert">{selectedPreview.error}</p>}
              {selectedBlockId && selectedPreview && !selectedPreview.error && <SampleTable rows={selectedPreview.sample} />}
            </div>
          </div>
        </div>

        <div className="w-[360px] shrink-0 rounded-md border border-line-2 bg-bg-1 p-3 overflow-y-auto">
          <ConfigPanel
            block={selectedBlock}
            spec={selectedBlockSpec}
            onChange={(config) => selectedBlockId && updateBlockConfig(selectedBlockId, config)}
            onDelete={() => selectedBlockId && void onDeleteBlock(selectedBlockId)}
          />
        </div>
      </div>

      {paletteOpen && <PaletteModal blocks={blocks} onPick={addBlock} onClose={() => setPaletteOpen(false)} />}
      {scheduleOpen && draft.id && <ScheduleModal workflowId={draft.id} onClose={() => setScheduleOpen(false)} />}
      {memoryOpen && draft.id && <MemoryModal workflowId={draft.id} onClose={() => setMemoryOpen(false)} />}
      {confirmElement}
    </div>
  );
}
