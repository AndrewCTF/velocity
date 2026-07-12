import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';
import { TabbedPanel, type TabDef } from '../shell/TabbedPanel.js';
import {
  SectionLabel,
  Badge,
  Btn,
  KV,
  KVRow,
  MicroLabel,
  Widget,
  Hero,
  IconTile,
  StatusDot,
  type BadgeTone,
} from '../shell/instruments.js';
import { useSituations, type Severity, type Status, type Situation } from './situationStore.js';
import { useSelection } from '../state/stores.js';
import { useInvestigation } from '../graph/investigationStore.js';
import { apiFetch } from '../transport/http.js';
import { toast } from '../shell/toast.js';
import { CoaCards } from './CoaCards.js';
import { ImageryDiff } from '../imagery/ImageryDiff.js';
import { AiAssessmentCard } from '../entity-panel/AiAssessmentCard.js';

const SEV_TONE: Record<Severity, BadgeTone> = {
  critical: 'alert',
  high: 'warn',
  med: 'accent',
  low: 'neutral',
};
// Hex for the header glyph tile, keyed to severity (mirrors the alert/warn tokens).
const SEV_COLOR: Record<Severity, string> = {
  critical: '#ff5a52',
  high: '#f5a524',
  med: '#5b9dff',
  low: '#64748b',
};
const STATUS_DOT: Record<Status, string> = {
  active: 'red',
  monitoring: 'amber',
  resolved: 'ok',
  archived: 'neutral',
};
const SEVERITIES: Severity[] = ['critical', 'high', 'med', 'low'];
const STATUSES: Status[] = ['active', 'monitoring', 'resolved', 'archived'];
const KIND_GLYPH: Record<string, string> = {
  aircraft: '✈',
  vessel: '⛴',
  incident: '◆',
  sim: '◈',
  coa: '⊳',
  object: '◻',
};

interface OntObject {
  id: string;
  kind: string;
  props: Record<string, unknown>;
}
interface OntLink {
  src: string;
  dst: string;
  rel: string;
}
interface Detail {
  objects: OntObject[];
  links: OntLink[];
}

interface Props {
  id: string;
  viewer?: Cesium.Viewer | null;
}

// Detail view for a Situation, shown in the Selection tab (EntityPanel delegates
// here on a situation: id). Instrument-grade: IconTile header + severity Hero +
// Widget-framed tabs, mirroring EntityPanel's vocabulary.
export function SituationPanel({ id, viewer: _viewer }: Props): JSX.Element {
  const sit = useSituations((s) => s.situations.find((x) => x.id === id));
  const update = useSituations((s) => s.update);
  const error = useSituations((s) => s.error);
  const [detail, setDetail] = useState<Detail>({ objects: [], links: [] });

  useEffect(() => {
    let live = true;
    apiFetch(`/api/situations/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setDetail({ objects: d.objects ?? [], links: d.links ?? [] });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);

  if (!sit) {
    return (
      <div className="p-4">
        <SectionLabel title="Situation" />
        <p className="mt-2 text-txt-3 text-[11px]">Situation not found (it may be unsaved).</p>
      </div>
    );
  }

  const childCounts = detail.objects.reduce<Record<string, number>>((m, o) => {
    const k = o.kind || 'object';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

  const tabs: TabDef[] = [
    {
      id: 'summary',
      label: 'Summary',
      content: <SummaryTab sit={sit} update={update} error={error} childCounts={childCounts} />,
    },
    {
      id: 'intel',
      label: `Intel${detail.objects.length ? ` · ${detail.objects.length}` : ''}`,
      content: <IntelTab objects={detail.objects} />,
    },
    { id: 'reporting', label: 'Reporting', content: <ReportingTab sit={sit} update={update} /> },
    { id: 'properties', label: 'Properties', content: <PropertiesTab sit={sit} childCounts={childCounts} /> },
    { id: 'link', label: 'Link', content: <LinkTab id={id} links={detail.links} /> },
    {
      id: 'media',
      label: 'Media',
      content: sit.centroid ? (
        <div className="p-3">
          <Widget title="Satellite observation">
            <ImageryDiff aoi={sit.centroid} />
          </Widget>
        </div>
      ) : (
        <p className="p-3 text-txt-3 text-[11px]">No AOI set — add a centroid to load imagery.</p>
      ),
    },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Header ribbon — IconTile glyph + id line + title + status/severity badges. */}
      <header className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-line-2">
        <IconTile color={SEV_COLOR[sit.severity]}>◈</IconTile>
        <div className="min-w-0 flex-1">
          <div className="mono text-[10px] tracking-[0.03em] text-txt-3 truncate" title={sit.id}>
            SITUATION · {sit.id.replace(/^situation:/, '')}
          </div>
          <h2 className="text-[18px] font-semibold text-txt-0 leading-tight tracking-[-0.01em] truncate mt-1">
            {sit.name}
          </h2>
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <Badge tone={SEV_TONE[sit.severity]}>{sit.severity}</Badge>
            <span className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.5px] text-txt-2">
              <StatusDot tone={STATUS_DOT[sit.status]} />
              {sit.status}
            </span>
            {sit.centroid && (
              <span className="mono text-[10px] text-txt-3 tabular-nums">
                {sit.centroid.lat.toFixed(2)}, {sit.centroid.lon.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <TabbedPanel tabs={tabs} defaultTab="summary" ariaLabel="Situation detail tabs" />
      </div>
    </div>
  );
}

function SummaryTab({
  sit,
  update,
  error,
  childCounts,
}: {
  sit: Situation;
  update: (id: string, patch: Partial<Situation>) => Promise<void>;
  error: string | null;
  childCounts: Record<string, number>;
}): JSX.Element {
  const heroTone = sit.severity === 'critical' ? 'alert' : sit.severity === 'high' ? 'warn' : null;
  const childTotal = Object.values(childCounts).reduce((a, b) => a + b, 0);
  return (
    <div className="p-4 space-y-4">
      {/* Severity hero — only for critical/high (matches EntityPanel's CorrelationCard). */}
      {heroTone && (
        <Hero tone={heroTone} title={`${sit.severity} situation`}>
          <p className="text-[11px] text-txt-1 leading-snug">
            {sit.summary || 'No summary yet — describe what is happening and why it matters.'}
          </p>
          <div className="flex items-center gap-3 mt-2.5 mono text-[10px] tabular-nums text-txt-3">
            <span>{childTotal} linked</span>
            {Object.entries(childCounts).map(([k, n]) => (
              <span key={k}>
                {KIND_GLYPH[k] ?? '◻'} {n} {k}
              </span>
            ))}
          </div>
        </Hero>
      )}

      <Widget title="Disposition">
        <div className="space-y-3">
          <label className="block">
            <MicroLabel>Name</MicroLabel>
            <input
              value={sit.name}
              onChange={(e) => void update(sit.id, { name: e.target.value })}
              className="mt-1 w-full bg-bg-2 border border-line rounded-sm px-2 py-1 text-[12px] text-txt-0 focus:outline-none focus:border-accent-line"
            />
          </label>
          <div>
            <MicroLabel>Severity</MicroLabel>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {SEVERITIES.map((sv) => (
                <Btn
                  key={sv}
                  size="sm"
                  tone={sit.severity === sv ? 'accent' : 'neutral'}
                  onClick={() => void update(sit.id, { severity: sv })}
                >
                  {sv}
                </Btn>
              ))}
            </div>
          </div>
          <div>
            <MicroLabel>Status</MicroLabel>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {STATUSES.map((st) => (
                <Btn
                  key={st}
                  size="sm"
                  tone={sit.status === st ? 'accent' : 'neutral'}
                  onClick={() => void update(sit.id, { status: st })}
                >
                  {st}
                </Btn>
              ))}
            </div>
          </div>
        </div>
      </Widget>

      <Widget title="Summary">
        <textarea
          value={sit.summary}
          onChange={(e) => void update(sit.id, { summary: e.target.value })}
          rows={5}
          placeholder="What is happening, why it matters…"
          className="w-full bg-bg-2 border border-line rounded-sm px-2 py-1.5 text-[11px] text-txt-1 leading-snug resize-y focus:outline-none focus:border-accent-line"
        />
      </Widget>

      {/* Selection-tier AI brief — same card the map-entity EntityPanel shows.
          A situation is an aggregate case file (no Cesium snapshot), so the
          model gets its id plus name/severity. Inert unless selection AI is on. */}
      <AiAssessmentCard
        id={sit.id}
        kind="situation"
        properties={{ name: sit.name, category: sit.severity }}
      />
      {error && <p className="text-[10px] text-warn">{error}</p>}
    </div>
  );
}

function IntelTab({ objects }: { objects: OntObject[] }): JSX.Element {
  if (objects.length === 0) {
    return (
      <div className="p-4">
        <Widget title="Linked intel" count={0}>
          <p className="text-txt-3 text-[11px]">
            No linked intel yet. Right-click an entity → search-around, or promote an incident from
            the Intel tab.
          </p>
        </Widget>
      </div>
    );
  }
  return (
    <div className="p-4">
      <Widget title="Linked intel" count={objects.length}>
        <ul className="space-y-1.5">
          {objects.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => useSelection.getState().select(o.id)}
                className="w-full text-left rounded-sm border border-line bg-bg-2/60 hover:border-accent-line px-2.5 py-1.5 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] w-4 text-center text-txt-2">{KIND_GLYPH[o.kind] ?? '◻'}</span>
                  <Badge tone="neutral">{o.kind}</Badge>
                  <span className="mono text-[10px] text-txt-1 truncate flex-1">{o.id}</span>
                </div>
                {typeof o.props?.narrative === 'string' && (
                  <p className="mt-1 text-[10px] text-txt-3 leading-snug line-clamp-2">
                    {o.props.narrative as string}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      </Widget>
    </div>
  );
}

type ExportFmt = 'html' | 'json' | 'pptx';

const EXPORT_EXT: Record<ExportFmt, string> = { html: 'html', json: 'json', pptx: 'pptx' };

function ExportCard({ sit }: { sit: Situation }): JSX.Element {
  const [busy, setBusy] = useState<ExportFmt | null>(null);

  const run = (fmt: ExportFmt): void => {
    setBusy(fmt);
    void (async () => {
      try {
        const r = await apiFetch(`/api/situations/${encodeURIComponent(sit.id)}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fmt }),
        });
        if (!r.ok) {
          toast.error(r.status === 503 ? 'PPTX engine unavailable' : `export failed (${r.status})`);
          return;
        }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `case-${sit.id.replace(/:/g, '_')}.${EXPORT_EXT[fmt]}`;
        a.click();
        URL.revokeObjectURL(url);
        toast.ok(`exported ${fmt.toUpperCase()}`);
      } catch {
        toast.error('export failed (network)');
      } finally {
        setBusy(null);
      }
    })();
  };

  return (
    <Widget title="Export dossier">
      <p className="text-[10px] text-txt-3 mb-2">
        Walks this case's linked entities, their sourced assertions, and attached
        evidence into a report where every claim carries a provenance footnote and
        every exhibit is content-addressed.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn size="sm" tone="accent" disabled={busy !== null} onClick={() => run('html')}>
          {busy === 'html' ? '…' : 'HTML'}
        </Btn>
        <Btn size="sm" disabled={busy !== null} onClick={() => run('json')}>
          {busy === 'json' ? '…' : 'JSON bundle'}
        </Btn>
        <Btn size="sm" disabled={busy !== null} onClick={() => run('pptx')}>
          {busy === 'pptx' ? '…' : 'PPTX'}
        </Btn>
      </div>
    </Widget>
  );
}

function ReportingTab({
  sit,
  update,
}: {
  sit: Situation;
  update: (id: string, patch: Partial<Situation>) => Promise<void>;
}): JSX.Element {
  return (
    <div className="p-4 space-y-4">
      <Widget title="Report">
        <textarea
          value={sit.report}
          onChange={(e) => void update(sit.id, { report: e.target.value })}
          rows={6}
          placeholder="Narrative / after-action notes…"
          className="w-full bg-bg-2 border border-line rounded-sm px-2 py-1.5 text-[11px] text-txt-1 leading-snug resize-y focus:outline-none focus:border-accent-line"
        />
      </Widget>
      <ExportCard sit={sit} />
      <Widget title="Courses of action">
        <CoaCards situationId={sit.id} />
      </Widget>
    </div>
  );
}

function PropertiesTab({
  sit,
  childCounts,
}: {
  sit: Situation;
  childCounts: Record<string, number>;
}): JSX.Element {
  return (
    <div className="p-4 space-y-4">
      <Widget title="Properties">
        <KV>
          <KVRow k="ID" v={sit.id} />
          <KVRow k="Severity" v={sit.severity} warn={sit.severity === 'critical' || sit.severity === 'high'} />
          <KVRow k="Status" v={sit.status} />
          <KVRow
            k="AOI"
            v={sit.centroid ? `${sit.centroid.lat.toFixed(3)}, ${sit.centroid.lon.toFixed(3)}` : '—'}
          />
          <KVRow k="Radius" v={`${sit.radius_km} km`} />
          <KVRow k="Created" v={sit.created_at ?? '—'} />
          <KVRow k="Updated" v={sit.updated_at ?? '—'} />
        </KV>
      </Widget>
      <Widget title="Composition" count={Object.values(childCounts).reduce((a, b) => a + b, 0)}>
        {Object.keys(childCounts).length === 0 ? (
          <p className="text-txt-3 text-[11px]">No linked objects.</p>
        ) : (
          <KV>
            {Object.entries(childCounts).map(([k, n]) => (
              <KVRow key={k} k={`${KIND_GLYPH[k] ?? '◻'} ${k}`} v={n} />
            ))}
          </KV>
        )}
      </Widget>
    </div>
  );
}

function LinkTab({ id, links }: { id: string; links: OntLink[] }): JSX.Element {
  return (
    <div className="p-4">
      <Widget
        title="Graph"
        count={links.length}
        action={
          <Btn size="sm" onClick={() => useInvestigation.getState().searchAround(id)}>
            ⊹ Open graph
          </Btn>
        }
      >
        {links.length === 0 ? (
          <p className="text-txt-3 text-[11px]">No links yet.</p>
        ) : (
          <ul className="space-y-1">
            {links.map((lk, i) => (
              <li key={`${lk.src}-${lk.dst}-${i}`} className="mono text-[10px] text-txt-2 truncate">
                <span className="text-txt-3">{lk.src.replace(/^situation:/, '◈')}</span>
                <span className="text-accent"> —{lk.rel}→ </span>
                <span className="text-txt-1">{lk.dst}</span>
              </li>
            ))}
          </ul>
        )}
      </Widget>
    </div>
  );
}
