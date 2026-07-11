import { useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { useFoundry, type Build } from '../state/foundry.js';
import { Badge, Btn, StatusDot, Widget } from '../shell/instruments.js';
import { useFoundryNav } from './nav.js';
import { useFoundryPoll } from './useFoundryPoll.js';
import { UploadModal } from './UploadModal.js';
import { EmptyState, StatTile, Th, ViewHeader, cellMono, durationOf, rowCls, stamp, statusTone, tableHeadCls } from './ui.js';

// Overview — the FOUNDRY landing screen, rebuilt as an operations dashboard:
// a health strip, six KPI tiles, an activity feed (recent builds with transform
// NAMES + quarantined + duration), and a right rail of quick actions, a
// staleness callout, and failing checks. Every region deep-links into the view
// that owns the problem via the nav store.
export function HomeView(): JSX.Element {
  const summary = useFoundry((s) => s.summary);
  const lineage = useFoundry((s) => s.lineage);
  const transforms = useFoundry((s) => s.transforms);
  const error = useFoundry((s) => s.error);
  const loadSummary = useFoundry((s) => s.loadSummary);
  const loadLineage = useFoundry((s) => s.loadLineage);
  const loadTransforms = useFoundry((s) => s.loadTransforms);
  const buildPipeline = useFoundry((s) => s.buildPipeline);
  const navigate = useFoundryNav((s) => s.navigate);
  const setView = useFoundryNav((s) => s.setView);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedNote, setSeedNote] = useState<string | null>(null);

  // Seed the built-in reference datasets (airports/ports/bases, infrastructure,
  // military, country OSINT resources, indicator manifest) into Foundry.
  const seedReference = async (): Promise<void> => {
    setSeeding(true);
    setSeedNote(null);
    try {
      const r = await apiFetch('/api/foundry/seed/reference', { method: 'POST' });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const body = (await r.json()) as { results: { dataset: string; status: string }[] };
      const seeded = body.results.filter((x) => x.status === 'seeded').length;
      const exists = body.results.filter((x) => x.status === 'exists').length;
      setSeedNote(`${seeded} seeded, ${exists} already present`);
      await loadSummary();
    } catch (e) {
      setSeedNote(`seed failed: ${String(e)}`);
    } finally {
      setSeeding(false);
    }
  };

  useFoundryPoll(async () => {
    await Promise.all([loadSummary(), loadLineage(), loadTransforms()]);
  });

  const tfName = (id: string | null): string => {
    if (!id) return '—';
    return transforms.find((t) => t.id === id)?.name ?? id;
  };
  const staleNodes = (lineage?.nodes ?? []).filter((n) => n.stale);
  const checksFailing = summary?.checks_failing ?? 0;
  const failed24h = summary?.failed_builds_24h ?? 0;
  const lastBuild = summary?.recent_builds[0];
  const runningCount = (summary?.recent_builds ?? []).filter((b) => b.status === 'running').length;
  const monitorCount = summary?.monitors ?? 0;
  const monitorEvents24h = summary?.monitor_events_24h ?? 0;

  return (
    <div className="p-5 space-y-4">
      <ViewHeader
        title="Overview"
        subtitle="Bring your own data, govern it through pipelines, bind it into the ontology."
        actions={<Btn tone="accent" onClick={() => setUploadOpen(true)}>⊕ Upload dataset</Btn>}
      />
      {error && <p className="text-[11px] text-alert">{error}</p>}

      {/* health strip — one hairline row of posture cells, each deep-links */}
      <div className="flex items-center gap-3 flex-wrap rounded-md border border-line-2 bg-bg-1 px-3 py-2">
        <HealthCell tone={staleNodes.length > 0 ? 'warn' : 'ok'} label="pipeline" value={staleNodes.length ? `${staleNodes.length} stale` : 'fresh'} title="Stale transform nodes" onClick={() => navigate('pipeline')} />
        <HealthCell tone={checksFailing > 0 ? 'alert' : 'ok'} label="checks" value={checksFailing ? `${checksFailing} failing` : 'passing'} onClick={() => navigate('datasets')} />
        <HealthCell
          tone={lastBuild?.status === 'failed' ? 'alert' : lastBuild?.status === 'running' ? 'neutral' : 'ok'}
          label="last build"
          value={lastBuild?.status ?? '—'}
          onClick={() => lastBuild && navigate('builds', lastBuild.id)}
        />
        <HealthCell tone={failed24h > 0 ? 'alert' : 'ok'} label="builds 24h" value={`${summary?.builds_24h ?? '—'}${failed24h ? ` · ${failed24h} failed` : ''}`} onClick={() => navigate('builds')} />
        <HealthCell tone={runningCount > 0 ? 'accent' : 'neutral'} label="running" value={String(runningCount)} onClick={() => navigate('builds')} />
        <HealthCell tone="ok" label="objects synced" value={String(summary?.objects_synced ?? '—')} onClick={() => navigate('ontology')} />
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <StatTile label="Datasets" value={summary?.datasets ?? '—'} tone={checksFailing > 0 ? 'warn' : 'neutral'} {...(checksFailing > 0 ? { sub: `${checksFailing} check${checksFailing === 1 ? '' : 's'} failing` } : {})} onClick={() => navigate('datasets')} />
        <StatTile label="Total rows" value={summary ? summary.total_rows.toLocaleString() : '—'} />
        <StatTile label="Transforms" value={summary?.transforms ?? '—'} onClick={() => navigate('pipeline')} />
        <StatTile label="Builds (24h)" value={summary?.builds_24h ?? '—'} tone={failed24h > 0 ? 'alert' : 'neutral'} {...(failed24h > 0 ? { sub: `${failed24h} failed` } : {})} onClick={() => navigate('builds')} />
        <StatTile label="Stale nodes" value={staleNodes.length} tone={staleNodes.length > 0 ? 'warn' : 'ok'} onClick={() => navigate('pipeline')} />
        <StatTile label="Objects synced" value={summary?.objects_synced ?? '—'} tone="ok" onClick={() => navigate('ontology')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* activity feed */}
        <div className="lg:col-span-8 space-y-2">
          <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">Recent builds</div>
          <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr className={tableHeadCls()}>
                  <Th>Status</Th>
                  <Th>Scope</Th>
                  <Th>Transform</Th>
                  <Th align="right">Rows</Th>
                  <Th align="right">Quar</Th>
                  <Th align="right">Dur</Th>
                  <Th>Started</Th>
                </tr>
              </thead>
              <tbody>
                {(summary?.recent_builds ?? []).map((b: Build) => (
                  <tr key={b.id} className={`${rowCls} cursor-pointer`} onClick={() => navigate('builds', b.id)}>
                    <td className="px-2.5 py-1.5"><Badge tone={statusTone[b.status] ?? 'neutral'}>{b.status}</Badge></td>
                    <td className={`${cellMono} text-txt-2`}>{b.scope}</td>
                    <td className={`${cellMono} text-txt-1 truncate max-w-[200px]`} title={b.transform_id ?? ''}>{tfName(b.transform_id)}</td>
                    <td className={`${cellMono} text-right`}>{b.rows_out?.toLocaleString() ?? '—'}</td>
                    <td className={`${cellMono} text-right ${b.quarantined ? 'text-warn' : 'text-txt-3'}`}>{b.quarantined ?? '—'}</td>
                    <td className={`${cellMono} text-right text-txt-3`}>{durationOf(b)}</td>
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

        {/* right rail of widgets */}
        <div className="lg:col-span-4 space-y-3">
          <Widget title="Quick actions">
            <div className="grid grid-cols-2 gap-1.5">
              <Btn size="sm" onClick={() => setUploadOpen(true)}>⊕ Upload</Btn>
              <Btn size="sm" onClick={() => navigate('pipeline')}>⋔ New transform</Btn>
              <Btn size="sm" disabled={staleNodes.length === 0} onClick={() => void buildPipeline(true)}>Build stale{staleNodes.length ? ` (${staleNodes.length})` : ''}</Btn>
              <Btn size="sm" onClick={() => setView('ontology')}>◈ Sync bindings</Btn>
              <Btn size="sm" className="col-span-2" onClick={() => navigate('datasets')}>▤ Query a dataset (SQL)</Btn>
              <Btn size="sm" className="col-span-2" disabled={seeding} onClick={() => void seedReference()}>
                {seeding ? 'seeding…' : '⛁ Seed reference data'}
              </Btn>
            </div>
            {seedNote && <p className="mt-1.5 text-[10.5px] mono text-txt-3">{seedNote}</p>}
          </Widget>

          <Widget title="Monitor activity" {...(monitorEvents24h ? { count: monitorEvents24h } : {})}>
            {monitorCount === 0 ? (
              <div className="flex items-center gap-2 text-[11px] text-txt-3">
                <StatusDot tone="neutral" /> no monitors configured — add one from a dataset&apos;s Monitors tab
              </div>
            ) : (
              <button
                type="button"
                onClick={() => navigate('datasets')}
                className="w-full flex items-center justify-between gap-2 text-left hover:opacity-80"
              >
                <span className="flex items-center gap-2 text-[11px] text-txt-1">
                  <StatusDot tone={monitorEvents24h > 0 ? 'accent' : 'ok'} />
                  {monitorCount} monitor{monitorCount === 1 ? '' : 's'} watching
                </span>
                <span className="mono text-[11px] text-txt-0 tabular-nums">{monitorEvents24h} event{monitorEvents24h === 1 ? '' : 's'} (24h)</span>
              </button>
            )}
          </Widget>

          <Widget title="Staleness" {...(staleNodes.length ? { count: staleNodes.length } : {})}>
            {staleNodes.length === 0 ? (
              <div className="flex items-center gap-2 text-[11px] text-ok"><StatusDot tone="ok" /> pipeline fresh — no stale nodes</div>
            ) : (
              <div className="space-y-1">
                {staleNodes.slice(0, 8).map((n) => (
                  <button key={n.id} type="button" onClick={() => navigate('pipeline', n.id)} className="w-full flex items-center gap-2 text-left mono text-[11px] text-txt-1 hover:text-accent">
                    <StatusDot tone="warn" />
                    <Badge tone={n.type === 'transform' ? 'mag' : 'accent'}>{n.type}</Badge>
                    <span className="truncate">{n.name}</span>
                  </button>
                ))}
              </div>
            )}
          </Widget>

          <Widget title="Checks">
            {checksFailing > 0 ? (
              <button type="button" onClick={() => navigate('datasets')} className="flex items-center gap-2 text-[11px] text-alert hover:underline">
                <StatusDot tone="alert" /> {checksFailing} check{checksFailing === 1 ? '' : 's'} failing — review in Datasets
              </button>
            ) : (
              <div className="flex items-center gap-2 text-[11px] text-ok"><StatusDot tone="ok" /> all checks passing</div>
            )}
          </Widget>
        </div>
      </div>

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onDone={() => setUploadOpen(false)} />
    </div>
  );
}

function HealthCell({
  tone,
  label,
  value,
  title,
  onClick,
}: {
  tone: 'ok' | 'warn' | 'alert' | 'accent' | 'neutral';
  label: string;
  value: string;
  title?: string;
  onClick?: () => void;
}): JSX.Element {
  const inner = (
    <>
      <StatusDot tone={tone} />
      <span className="text-[10px] uppercase tracking-[0.4px] text-txt-3">{label}</span>
      <span className="mono text-[11px] text-txt-0 tabular-nums">{value}</span>
    </>
  );
  const cls = `flex items-center gap-1.5 ${onClick ? 'hover:opacity-80 cursor-pointer' : ''}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cls}>
        {inner}
      </button>
    );
  }
  return (
    <div title={title} className={cls}>
      {inner}
    </div>
  );
}
