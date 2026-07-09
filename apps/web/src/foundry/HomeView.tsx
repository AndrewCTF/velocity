import { useEffect } from 'react';
import { useFoundry, type Build } from '../state/foundry.js';
import { Badge } from '../shell/instruments.js';
import type { FoundryView } from './FoundryApp.js';
import { EmptyState, StatTile, Th, ViewHeader, cellMono, rowCls, stamp, statusTone, tableHeadCls } from './ui.js';

// Overview — the first screen on the FOUNDRY tab. KPI tiles summarize the BYO
// pipeline's state (GET /api/foundry/summary), tinting amber/red when checks or
// builds need attention, then the recent-builds feed lets an operator drill
// into the view that owns the problem.

export function HomeView({ onNavigate }: { onNavigate: (v: FoundryView) => void }): JSX.Element {
  const summary = useFoundry((s) => s.summary);
  const error = useFoundry((s) => s.error);
  const loadSummary = useFoundry((s) => s.loadSummary);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const checksFailing = summary?.checks_failing ?? 0;
  const failed24h = summary?.failed_builds_24h ?? 0;

  return (
    <div className="p-5 space-y-5">
      <ViewHeader
        title="Overview"
        subtitle="Bring your own data, govern it through pipelines, bind it into the ontology."
      />
      {error && <p className="text-[11px] text-alert">{error}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <StatTile
          label="Datasets"
          value={summary?.datasets ?? '—'}
          tone={checksFailing > 0 ? 'warn' : 'neutral'}
          {...(checksFailing > 0 ? { sub: `${checksFailing} check${checksFailing === 1 ? '' : 's'} failing` } : {})}
          onClick={() => onNavigate('datasets')}
        />
        <StatTile label="Total rows" value={summary ? summary.total_rows.toLocaleString() : '—'} />
        <StatTile label="Transforms" value={summary?.transforms ?? '—'} onClick={() => onNavigate('pipeline')} />
        <StatTile
          label="Builds (24h)"
          value={summary?.builds_24h ?? '—'}
          tone={failed24h > 0 ? 'alert' : 'neutral'}
          {...(failed24h > 0 ? { sub: `${failed24h} failed` } : {})}
          onClick={() => onNavigate('builds')}
        />
        <StatTile label="Objects synced" value={summary?.objects_synced ?? '—'} tone="ok" onClick={() => onNavigate('ontology')} />
      </div>

      <div className="space-y-2">
        <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">Recent builds</div>
        <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className={tableHeadCls()}>
                <Th>Status</Th>
                <Th>Scope</Th>
                <Th>Transform</Th>
                <Th align="right">Rows</Th>
                <Th>Started</Th>
              </tr>
            </thead>
            <tbody>
              {(summary?.recent_builds ?? []).map((b: Build) => (
                <tr key={b.id} className={`${rowCls} cursor-pointer`} onClick={() => onNavigate('builds')}>
                  <td className="px-2.5 py-1.5">
                    <Badge tone={statusTone[b.status] ?? 'neutral'}>{b.status}</Badge>
                  </td>
                  <td className={`${cellMono} text-txt-2`}>{b.scope}</td>
                  <td className={`${cellMono} text-txt-2 truncate max-w-[180px]`}>{b.transform_id ?? '—'}</td>
                  <td className={`${cellMono} text-right`}>{b.rows_out?.toLocaleString() ?? '—'}</td>
                  <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(b.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(!summary || summary.recent_builds.length === 0) && (
            <div className="p-4">
              <EmptyState icon="⧉" title="No builds yet" hint="Author a transform and run it — builds show up here with row counts and status." />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
