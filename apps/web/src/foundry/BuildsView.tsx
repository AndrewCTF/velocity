import { Fragment, useEffect, useMemo, useState } from 'react';
import { useFoundry } from '../state/foundry.js';
import { Badge, Btn, Toggle } from '../shell/instruments.js';
import { useConfirm } from '../shell/Modal.js';
import { useFoundryNav } from './nav.js';
import { useFoundryPoll } from './useFoundryPoll.js';
import {
  EmptyState,
  Field,
  FilterChips,
  LogView,
  Select,
  Th,
  ViewHeader,
  cellMono,
  controlCls,
  durationOf,
  fmtInterval,
  rowCls,
  stamp,
  statusTone,
  tableHeadCls,
} from './ui.js';

// Builds — filterable history (status chips, transform, free-text) with
// transform NAMES, expandable logs, and schedules expressed in human units
// (minutes / hours / days). Deep-links from Overview land on the build
// expanded. Polls every 5s while a build is running, under the app-visibility
// gate.

type StatusFilter = 'all' | 'succeeded' | 'failed' | 'running';
type IntervalUnit = 'minutes' | 'hours' | 'days';
const UNIT_S: Record<IntervalUnit, number> = { minutes: 60, hours: 3600, days: 86400 };

function SchedulesSection(): JSX.Element {
  const schedules = useFoundry((s) => s.schedules);
  const transforms = useFoundry((s) => s.transforms);
  const createSchedule = useFoundry((s) => s.createSchedule);
  const updateSchedule = useFoundry((s) => s.updateSchedule);
  const deleteSchedule = useFoundry((s) => s.deleteSchedule);
  const { confirm, confirmElement } = useConfirm();

  const [transformId, setTransformId] = useState('');
  const [intervalN, setIntervalN] = useState(1);
  const [unit, setUnit] = useState<IntervalUnit>('hours');

  const nameOf = (id: string): string => transforms.find((t) => t.id === id)?.name ?? id;

  const onDelete = async (id: string, name: string): Promise<void> => {
    if (await confirm({ title: `Delete schedule for "${name}"?`, tone: 'danger', confirmLabel: 'Delete' })) {
      await deleteSchedule(id);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">Schedules</div>
      <div className="flex items-end gap-2 rounded-md border border-line-2 bg-bg-1 p-3 flex-wrap">
        <div className="w-56">
          <Field label="Transform">
            <Select value={transformId} onChange={setTransformId} placeholder="Select transform…" options={transforms.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
        </div>
        <div className="w-24">
          <Field label="Every"><input type="number" min={1} value={intervalN} onChange={(e) => setIntervalN(Math.max(1, Number(e.target.value)))} className={controlCls} /></Field>
        </div>
        <div className="w-32">
          <Field label="Unit">
            <Select value={unit} onChange={(v) => setUnit(v as IntervalUnit)} options={[{ value: 'minutes', label: 'minutes' }, { value: 'hours', label: 'hours' }, { value: 'days', label: 'days' }]} />
          </Field>
        </div>
        <Btn tone="accent" disabled={!transformId || intervalN <= 0} onClick={() => void createSchedule({ transform_id: transformId, interval_s: intervalN * UNIT_S[unit] })}>+ Schedule</Btn>
      </div>
      <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className={tableHeadCls()}>
              <Th>Transform</Th><Th align="right">Interval</Th><Th>Last run</Th><Th>State</Th><Th align="center">Enabled</Th><Th />
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} className={rowCls}>
                <td className={`${cellMono} text-txt-0`}>{nameOf(s.transform_id)}</td>
                <td className={`${cellMono} text-right`} title={`${s.interval_s}s`}>{fmtInterval(s.interval_s)}</td>
                <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(s.last_run) || 'never'}</td>
                <td className="px-2.5 py-1.5">
                  {s.last_error ? <Badge tone="alert" >error</Badge> : <Badge tone="ok">ok</Badge>}
                  {s.last_error && <span className="block text-[9px] text-alert mt-0.5 truncate max-w-[160px]" title={s.last_error}>{s.last_error}</span>}
                </td>
                <td className="px-2.5 py-1.5 text-center">
                  <Toggle on={s.enabled} onChange={(next) => void updateSchedule(s.id, { enabled: next })} label="enabled" />
                </td>
                <td className="px-2.5 py-1.5 text-right">
                  <button type="button" onClick={() => void onDelete(s.id, nameOf(s.transform_id))} className="text-txt-3 hover:text-alert text-[12px]" aria-label="Delete schedule">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {schedules.length === 0 && <div className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">No schedules yet.</div>}
      </div>
      {confirmElement}
    </div>
  );
}

export function BuildsView(): JSX.Element {
  const builds = useFoundry((s) => s.builds);
  const transforms = useFoundry((s) => s.transforms);
  const datasets = useFoundry((s) => s.datasets);
  const error = useFoundry((s) => s.error);
  const loadBuilds = useFoundry((s) => s.loadBuilds);
  const loadSchedules = useFoundry((s) => s.loadSchedules);
  const loadTransforms = useFoundry((s) => s.loadTransforms);
  const loadDatasets = useFoundry((s) => s.loadDatasets);
  const selectedId = useFoundryNav((s) => s.selectedId);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tfFilter, setTfFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(selectedId);

  useFoundryPoll(async () => {
    await Promise.all([loadBuilds(), loadSchedules(), loadTransforms(), loadDatasets()]);
  });

  // Land expanded on a deep-linked build from Overview.
  useEffect(() => {
    if (selectedId) setExpanded(selectedId);
  }, [selectedId]);

  // Fast 5s poll while a build is running (nested inside the app-visibility
  // gate via useFoundryPoll's parent — this just tightens the cadence).
  useEffect(() => {
    const anyRunning = builds.some((b) => b.status === 'running');
    if (!anyRunning) return;
    const id = window.setInterval(() => void loadBuilds(), 5000);
    return () => window.clearInterval(id);
  }, [builds, loadBuilds]);

  const tfName = (id: string | null): string => {
    if (!id) return '—';
    return transforms.find((t) => t.id === id)?.name ?? id;
  };
  const datasetName = (id: string): string => datasets.find((d) => d.id === id)?.name ?? id;

  const counts = useMemo(() => {
    const c = { all: builds.length, succeeded: 0, failed: 0, running: 0 };
    for (const b of builds) c[b.status === 'running' ? 'running' : b.status === 'failed' ? 'failed' : 'succeeded']++;
    return c;
  }, [builds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return builds.filter((b) => {
      if (status !== 'all' && b.status !== status) return false;
      if (tfFilter !== 'all' && b.transform_id !== tfFilter) return false;
      if (q) {
        const hay = `${tfName(b.transform_id)} ${b.id} ${b.error ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builds, status, tfFilter, query, transforms]);

  return (
    <div className="p-5 space-y-5">
      <ViewHeader title="Builds" subtitle="Every transform run, newest first. Click a row for its log and input versions." />
      {error && <p className="text-[11px] text-alert">{error}</p>}

      <div className="flex items-center gap-3 flex-wrap">
        <FilterChips<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[
            { key: 'all', label: 'all', count: counts.all },
            { key: 'succeeded', label: 'succeeded', count: counts.succeeded },
            { key: 'failed', label: 'failed', count: counts.failed },
            { key: 'running', label: 'running', count: counts.running },
          ]}
        />
        <div className="w-52">
          <Select value={tfFilter} onChange={setTfFilter} placeholder="all transforms" options={transforms.map((t) => ({ value: t.id, label: t.name }))} />
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search transform / error…" className={`${controlCls} w-56`} />
      </div>

      <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className={tableHeadCls()}>
              <Th>Status</Th><Th>Scope</Th><Th>Transform</Th><Th align="right">Rows</Th><Th align="right">Quarantined</Th><Th align="right">Duration</Th><Th>Started</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => (
              <Fragment key={b.id}>
                <tr className={`${rowCls} cursor-pointer`} onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                  <td className="px-2.5 py-1.5"><Badge tone={statusTone[b.status] ?? 'neutral'}>{b.status}</Badge></td>
                  <td className={`${cellMono} text-txt-2`}>{b.scope}</td>
                  <td className={`${cellMono} text-txt-1 truncate max-w-[200px]`} title={b.transform_id ?? ''}>{tfName(b.transform_id)}</td>
                  <td className={`${cellMono} text-right`}>{b.rows_out?.toLocaleString() ?? '—'}</td>
                  <td className={`${cellMono} text-right ${(b.quarantined ?? 0) > 0 ? 'text-warn' : 'text-txt-3'}`}>{b.quarantined ?? 0}</td>
                  <td className={`${cellMono} text-right text-txt-2`}>{durationOf(b)}</td>
                  <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(b.started_at)}</td>
                </tr>
                {expanded === b.id && (
                  <tr className="border-t border-line bg-bg-0">
                    <td colSpan={7} className="px-3 py-2.5 space-y-2">
                      {b.error && (
                        <div className="rounded-sm border border-[rgba(255,90,82,0.38)] bg-alert-bg px-2 py-1.5 text-[11px] text-[#ffc9c5]">{b.error}</div>
                      )}
                      {b.input_versions && Object.keys(b.input_versions).length > 0 && (
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3 mb-1">Input versions</div>
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(b.input_versions).map(([dsId, v]) => (
                              <span key={dsId} className="mono text-[10px] px-1.5 py-0.5 rounded-sm border border-line text-txt-2">
                                {datasetName(dsId)} <span className="text-accent">v{v}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      <LogView lines={b.log} className="max-h-56" />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="p-4">
            <EmptyState icon="⧉" title={builds.length === 0 ? 'No builds yet' : 'No builds match'} hint={builds.length === 0 ? 'Runs appear here once you build a transform or the whole pipeline.' : 'Adjust the filters above.'} />
          </div>
        )}
      </div>

      <SchedulesSection />
    </div>
  );
}
