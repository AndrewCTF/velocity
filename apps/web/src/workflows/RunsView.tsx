import { Fragment, useEffect, useState } from 'react';
import { useWorkflows } from '../state/workflows.js';
import { Badge } from '../shell/instruments.js';
import { useWorkflowsNav } from './nav.js';
import { useWorkflowsPoll } from './useWorkflowsPoll.js';
import {
  EmptyState,
  LogView,
  Select,
  Th,
  ViewHeader,
  cellMono,
  rowCls,
  stamp,
  statusTone,
  tableHeadCls,
} from '../foundry/ui.js';

// Runs — history for one workflow at a time (the backend has no cross-
// workflow run listing: GET /api/workflows/{id}/runs is scoped, see
// routes/workflows.py). A workflow picker drives the query; a deep link from
// the editor's Run button (navigate('runs', run.id)) resolves the run's
// workflow via GET /api/workflows/runs/{run_id} and lands expanded.

function OutputTables({ output }: { output: Record<string, Array<Record<string, unknown>>> }): JSX.Element | null {
  const blockIds = Object.keys(output);
  if (blockIds.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3">Terminal block output (sample)</div>
      {blockIds.map((bid) => {
        const rows = output[bid] ?? [];
        const cols = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
        return (
          <div key={bid} className="rounded-sm border border-line overflow-hidden">
            <div className="px-2 py-1 bg-bg-2 mono text-[10px] text-txt-2 flex items-center justify-between">
              <span>{bid}</span>
              <span className="text-txt-4">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
            </div>
            {rows.length === 0 ? (
              <div className="px-2 py-2 text-[10.5px] text-txt-4">No rows.</div>
            ) : (
              <div className="overflow-auto max-h-40">
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RunsView(): JSX.Element {
  const workflows = useWorkflows((s) => s.workflows);
  const runs = useWorkflows((s) => s.runs);
  const error = useWorkflows((s) => s.error);
  const loadWorkflows = useWorkflows((s) => s.loadWorkflows);
  const loadRuns = useWorkflows((s) => s.loadRuns);
  const getRun = useWorkflows((s) => s.getRun);
  const selectedId = useWorkflowsNav((s) => s.selectedId);

  const [workflowId, setWorkflowId] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // Resolve a deep-linked run id (from EditorView's Run button) to its
  // workflow, once, on arrival.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      const run = await getRun(selectedId);
      if (cancelled || !run) return;
      setWorkflowId(run.workflow_id);
      setExpanded(run.id);
    })();
    return () => {
      cancelled = true;
    };
    // Only re-resolve when the deep-linked id itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Default to the first workflow once the list loads, if nothing is picked yet.
  useEffect(() => {
    if (!workflowId && workflows.length > 0) setWorkflowId(workflows[0]?.id ?? '');
  }, [workflowId, workflows]);

  // Fetch runs the moment a workflow becomes selected (default pick, deep
  // link, or manual dropdown change) — the poll below only refreshes an
  // ALREADY-selected workflow, so this covers the immediate case.
  useEffect(() => {
    if (workflowId) void loadRuns(workflowId);
  }, [workflowId, loadRuns]);

  useWorkflowsPoll(async () => {
    await loadWorkflows();
    if (workflowId) await loadRuns(workflowId);
  });

  // Fast 5s poll while a run is in flight.
  useEffect(() => {
    const anyRunning = runs.some((r) => r.status === 'running' || r.status === 'queued');
    if (!anyRunning || !workflowId) return;
    const id = window.setInterval(() => void loadRuns(workflowId), 5000);
    return () => window.clearInterval(id);
  }, [runs, workflowId, loadRuns]);

  const nameOf = (id: string): string => workflows.find((w) => w.id === id)?.name ?? id;

  return (
    <div className="p-5 space-y-5">
      <ViewHeader
        title="Runs"
        subtitle="Every workflow execution, newest first. Click a row for its log and terminal output."
        actions={
          <div className="w-56">
            <Select
              value={workflowId}
              onChange={(v) => {
                setWorkflowId(v);
                setExpanded(null);
              }}
              placeholder="select a workflow…"
              options={workflows.map((w) => ({ value: w.id, label: w.name }))}
            />
          </div>
        }
      />
      {error && <p className="text-[11px] text-alert">{error}</p>}

      {!workflowId && (
        <EmptyState icon="⧉" title="No workflow selected" hint="Pick a workflow above, or trigger a Run from the editor to land here." />
      )}

      {workflowId && (
        <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className={tableHeadCls()}>
                <Th>Status</Th>
                <Th>Trigger</Th>
                <Th align="right">Blocks logged</Th>
                <Th>Started</Th>
                <Th>Finished</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <Fragment key={r.id}>
                  <tr className={`${rowCls} cursor-pointer`} onClick={() => setExpanded(expanded === r.id ? null : r.id)} data-testid={`run-row-${r.id}`}>
                    <td className="px-2.5 py-1.5">
                      <Badge tone={statusTone[r.status] ?? 'neutral'}>{r.status}</Badge>
                    </td>
                    <td className={`${cellMono} text-txt-2`}>{r.trigger}</td>
                    <td className={`${cellMono} text-right`}>{r.log.length}</td>
                    <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(r.started_at)}</td>
                    <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(r.finished_at)}</td>
                  </tr>
                  {expanded === r.id && (
                    <tr className="border-t border-line bg-bg-0">
                      <td colSpan={5} className="px-3 py-2.5 space-y-2.5">
                        {r.error && (
                          <div className="rounded-sm border border-[rgba(255,90,82,0.38)] bg-alert-bg px-2 py-1.5 text-[11px] text-[#ffc9c5]">
                            {r.error}
                          </div>
                        )}
                        <LogView lines={r.log} className="max-h-56" />
                        <OutputTables output={r.output} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {runs.length === 0 && (
            <div className="p-4">
              <EmptyState
                icon="⧉"
                title="No runs yet"
                hint={`Runs appear here once you trigger "${nameOf(workflowId)}" manually or via a schedule.`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
