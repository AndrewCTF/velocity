import { Fragment, useEffect, useState } from 'react';
import { useFoundry, type Build } from '../state/foundry.js';
import { Badge, Btn, Toggle } from '../shell/instruments.js';
import {
  EmptyState,
  Field,
  LogView,
  Select,
  Th,
  ViewHeader,
  cellMono,
  controlCls,
  rowCls,
  stamp,
  statusTone,
  tableHeadCls,
} from './ui.js';

// Builds — history (auto-refreshing every 5s while a build runs) with an
// expandable log viewer and input-version chips, plus the interval-schedule
// manager. Each build surfaces its status, rows out, quarantined count, and
// duration so an operator can see at a glance what a run did.

function durationOf(b: Build): string {
  if (!b.finished_at) return '—';
  const ms = new Date(b.finished_at).getTime() - new Date(b.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function SchedulesSection(): JSX.Element {
  const schedules = useFoundry((s) => s.schedules);
  const transforms = useFoundry((s) => s.transforms);
  const loadSchedules = useFoundry((s) => s.loadSchedules);
  const loadTransforms = useFoundry((s) => s.loadTransforms);
  const createSchedule = useFoundry((s) => s.createSchedule);
  const updateSchedule = useFoundry((s) => s.updateSchedule);
  const deleteSchedule = useFoundry((s) => s.deleteSchedule);

  const [transformId, setTransformId] = useState('');
  const [intervalS, setIntervalS] = useState(3600);

  useEffect(() => {
    void loadSchedules();
    void loadTransforms();
  }, [loadSchedules, loadTransforms]);

  const nameOf = (id: string): string => transforms.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">Schedules</div>
      <div className="flex items-end gap-2 rounded-md border border-line-2 bg-bg-1 p-3">
        <div className="w-56">
          <Field label="Transform">
            <Select
              value={transformId}
              onChange={setTransformId}
              placeholder="Select transform…"
              options={transforms.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Field>
        </div>
        <div className="w-32">
          <Field label="Interval (s)">
            <input
              type="number"
              value={intervalS}
              onChange={(e) => setIntervalS(Number(e.target.value))}
              className={controlCls}
            />
          </Field>
        </div>
        <Btn
          tone="accent"
          disabled={!transformId || intervalS <= 0}
          onClick={() => void createSchedule({ transform_id: transformId, interval_s: intervalS })}
        >
          + Schedule
        </Btn>
      </div>
      <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className={tableHeadCls()}>
              <Th>Transform</Th>
              <Th align="right">Interval (s)</Th>
              <Th>Last run</Th>
              <Th>State</Th>
              <Th align="center">Enabled</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} className={rowCls}>
                <td className={`${cellMono} text-txt-0`}>{nameOf(s.transform_id)}</td>
                <td className={`${cellMono} text-right`}>{s.interval_s}</td>
                <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(s.last_run) || 'never'}</td>
                <td className="px-2.5 py-1.5">
                  {s.last_error ? <Badge tone="alert">error</Badge> : <Badge tone="ok">ok</Badge>}
                </td>
                <td className="px-2.5 py-1.5 text-center">
                  <Toggle on={s.enabled} onChange={(next) => void updateSchedule(s.id, { enabled: next })} label="enabled" />
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
        {schedules.length === 0 && (
          <div className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">No schedules yet.</div>
        )}
      </div>
    </div>
  );
}

export function BuildsView(): JSX.Element {
  const builds = useFoundry((s) => s.builds);
  const datasets = useFoundry((s) => s.datasets);
  const error = useFoundry((s) => s.error);
  const loadBuilds = useFoundry((s) => s.loadBuilds);
  const loadDatasets = useFoundry((s) => s.loadDatasets);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void loadBuilds();
    void loadDatasets();
  }, [loadBuilds, loadDatasets]);

  const datasetName = (id: string): string => datasets.find((d) => d.id === id)?.name ?? id;

  useEffect(() => {
    const anyRunning = builds.some((b) => b.status === 'running');
    if (!anyRunning) return;
    const id = window.setInterval(() => void loadBuilds(), 5000);
    return () => window.clearInterval(id);
  }, [builds, loadBuilds]);

  return (
    <div className="p-5 space-y-5">
      <ViewHeader title="Builds" subtitle="Every transform run, newest first. Click a row for its log and input versions." />
      {error && <p className="text-[11px] text-alert">{error}</p>}

      <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className={tableHeadCls()}>
              <Th>Status</Th>
              <Th>Scope</Th>
              <Th>Transform</Th>
              <Th align="right">Rows</Th>
              <Th align="right">Quarantined</Th>
              <Th align="right">Duration</Th>
              <Th>Started</Th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <Fragment key={b.id}>
                <tr className={`${rowCls} cursor-pointer`} onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                  <td className="px-2.5 py-1.5">
                    <Badge tone={statusTone[b.status] ?? 'neutral'}>{b.status}</Badge>
                  </td>
                  <td className={`${cellMono} text-txt-2`}>{b.scope}</td>
                  <td className={`${cellMono} text-txt-2 truncate max-w-[180px]`}>{b.transform_id ?? '—'}</td>
                  <td className={`${cellMono} text-right`}>{b.rows_out?.toLocaleString() ?? '—'}</td>
                  <td className={`${cellMono} text-right ${(b.quarantined ?? 0) > 0 ? 'text-warn' : 'text-txt-3'}`}>
                    {b.quarantined ?? 0}
                  </td>
                  <td className={`${cellMono} text-right text-txt-2`}>{durationOf(b)}</td>
                  <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(b.started_at)}</td>
                </tr>
                {expanded === b.id && (
                  <tr className="border-t border-line bg-bg-0">
                    <td colSpan={7} className="px-3 py-2.5 space-y-2">
                      {b.error && (
                        <div className="rounded-sm border border-[rgba(255,90,82,0.38)] bg-alert-bg px-2 py-1.5 text-[11px] text-[#ffc9c5]">
                          {b.error}
                        </div>
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
        {builds.length === 0 && (
          <div className="p-4">
            <EmptyState icon="⧉" title="No builds yet" hint="Runs appear here once you build a transform or the whole pipeline." />
          </div>
        )}
      </div>

      <SchedulesSection />
    </div>
  );
}
