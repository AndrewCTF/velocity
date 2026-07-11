import { useEffect } from 'react';
import { useWorkflows, type BlockCatalogEntry, type BlockCategory } from '../state/workflows.js';
import { Badge } from '../shell/instruments.js';
import { useWorkflowsPoll } from './useWorkflowsPoll.js';
import { EmptyState, ViewHeader } from '../foundry/ui.js';

// Blocks — a rendered reference for the catalog served by GET
// /api/workflows/blocks (apps/api/app/workflows/blocks.py). One card per
// block: title/category/arity, its config_schema as a table, and — for the
// three power blocks — the authoring contract the editor also shows inline.

const GROUPS: Array<{ key: BlockCategory; label: string; hint: string }> = [
  { key: 'source', label: 'Sources', hint: '0 inputs — pull live platform data into the DAG' },
  { key: 'op', label: 'Ops', hint: '0-2 inputs — transform, filter, join, compute, or call an external HTTP server' },
  { key: 'sink', label: 'Sinks', hint: '1 input — act on the result, rows pass through unchanged' },
  { key: 'control', label: 'Control', hint: '1 input — act on EXTERNAL systems: webhooks, drones, devices via your control server' },
];

const CONTRACTS: Record<string, { title: string; body: string }> = {
  'op.python': {
    title: 'Python contract',
    body:
      'Define def run(rows: list[dict], memory: dict) -> list[dict] | {"rows": [...], "memory": {...}}. ' +
      'Executes in a resource-limited subprocess on your own machine (CPU/memory/open-file caps, timeout up ' +
      'to 60s) — BYO-compute, not a hostile-tenant sandbox. A crash or timeout fails the run, never the request.',
  },
  'op.sql': {
    title: 'SQL contract',
    body:
      'Read-only SELECT/WITH over an in-memory sqlite table t (this block’s first input) and t2 (second ' +
      'input, if wired). PRAGMA query_only=ON, single statement, 10s interrupt.',
  },
  'op.llm': {
    title: 'LLM template variables',
    body:
      '{rows} — input rows as JSON (capped 100 rows / 20KB). {memory} — this workflow’s persisted memory. ' +
      'mode=per_batch returns one summary row; mode=per_row processes up to 50 rows individually and adds an ' +
      'llm column (or llm_error on failure) per row.',
  },
};

function FieldsTable({ block }: { block: BlockCatalogEntry }): JSX.Element {
  if (block.config_schema.length === 0) {
    return <p className="text-[10px] text-txt-4">No configuration.</p>;
  }
  return (
    <table className="w-full border-collapse text-[10.5px]">
      <thead>
        <tr className="text-txt-3 mono text-[9.5px] uppercase tracking-[0.4px]">
          <th className="text-left font-medium py-1 pr-2">Key</th>
          <th className="text-left font-medium py-1 pr-2">Type</th>
          <th className="text-left font-medium py-1 pr-2">Default</th>
          <th className="text-left font-medium py-1">Notes</th>
        </tr>
      </thead>
      <tbody>
        {block.config_schema.map((f) => (
          <tr key={f.key} className="border-t border-line align-top">
            <td className="py-1 pr-2 mono text-txt-0 whitespace-nowrap">
              {f.key}
              {f.required && <span className="text-alert"> *</span>}
            </td>
            <td className="py-1 pr-2 mono text-txt-2 whitespace-nowrap">{f.type}</td>
            <td className="py-1 pr-2 mono text-txt-2">{f.default != null ? String(f.default) : '—'}</td>
            <td className="py-1 text-txt-3 leading-snug">
              {f.help}
              {f.options && f.options.length > 0 && (
                <div className="mono text-[9.5px] text-txt-4 mt-0.5">options: {f.options.join(', ')}</div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlockCard({ block }: { block: BlockCatalogEntry }): JSX.Element {
  const contract = CONTRACTS[block.type];
  return (
    <div className="rounded-md border border-line-2 bg-bg-1 p-3 space-y-2" data-testid={`block-card-${block.type}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] text-txt-0">{block.title}</div>
          <div className="mono text-[10px] text-txt-3">{block.type}</div>
        </div>
        <Badge tone={block.category === 'source' ? 'accent' : block.category === 'sink' ? 'mag' : block.category === 'control' ? 'warn' : 'neutral'}>
          {block.min_inputs}-{block.max_inputs} in
        </Badge>
      </div>
      <p className="text-[10.5px] text-txt-2 leading-relaxed">{block.description}</p>
      {contract && (
        <div className="rounded-sm border border-line-2 bg-bg-0 px-2.5 py-2 text-[10.5px] text-txt-2 leading-relaxed">
          <div className="text-txt-3 uppercase tracking-[0.4px] text-[9.5px] mb-1">{contract.title}</div>
          {contract.body}
        </div>
      )}
      <FieldsTable block={block} />
    </div>
  );
}

export function BlocksView(): JSX.Element {
  const blocks = useWorkflows((s) => s.blocks);
  const error = useWorkflows((s) => s.error);
  const loadBlocks = useWorkflows((s) => s.loadBlocks);

  useWorkflowsPoll(async () => {
    await loadBlocks();
  }, 60_000);
  // loadBlocks fetches once per session (guarded in the store); still call it
  // eagerly on mount so a cold app doesn't wait for the first poll tick.
  useEffect(() => {
    void loadBlocks();
  }, [loadBlocks]);

  return (
    <div className="p-5 space-y-5">
      <ViewHeader title="Blocks" subtitle="The DAG's typed vocabulary — sources pull data in, ops transform it, sinks act on it." />
      {error && <p className="text-[11px] text-alert">{error}</p>}

      {blocks.length === 0 && <EmptyState icon="◈" title="Loading catalog…" />}

      {GROUPS.map((g) => {
        const items = blocks.filter((b) => b.category === g.key);
        if (items.length === 0) return null;
        return (
          <div key={g.key} className="space-y-2.5">
            <div>
              <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">{g.label}</div>
              <div className="text-[10.5px] text-txt-4">{g.hint}</div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {items.map((b) => (
                <BlockCard key={b.type} block={b} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
