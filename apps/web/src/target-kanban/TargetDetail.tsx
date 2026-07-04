// Target detail — the right-side panel of the F2T2EA board (image 4 parity).
// Opens for the focused card and shows Overview / Details / Intelligence tabs:
//   - Overview: classification, stage, priority, and the CONFIRMATION CHECKLIST
//     that gates stage advancement (+ an "advance anyway" force override).
//   - Details: live location (+ "verify location" toggle), note.
//   - Intelligence: course-of-action (existing /api/sim/reason) + move audit.
// Reads/writes the shared useTargetBoard store; gate logic mirrors the backend
// (apps/api/app/routes/targets.py). Never touches Cesium billboard/label owners.

import { useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';
import {
  useTargetBoard,
  TARGET_STAGES,
  REQUIREMENT_KEYS,
  REQUIREMENT_LABEL,
  unmetFor,
  isLocked,
  nextStage,
  type RequirementKey,
  type TargetEntry,
} from '../state/targetBoard.js';
import { apiFetch } from '../transport/http.js';
import { Widget, KV, KVRow, Btn, SectionLabel, Badge, MicroLabel, MeterBar } from '../shell/instruments.js';
import { weaponeeringSolutions } from './weaponeering.js';

const STAGE_LABEL: Record<string, string> = {
  confirm: 'Confirm',
  attach_intel: 'Attach intel',
  approvals: 'Approvals',
  weaponeer: 'Weaponeer',
  execute: 'Execute',
  assess: 'Assess',
  complete: 'Complete',
};

type Tab = 'overview' | 'details' | 'weaponeer' | 'intel';
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  details: 'Details',
  weaponeer: 'Weaponeer',
  intel: 'Intelligence',
};

function livePosition(
  viewer: Cesium.Viewer | null | undefined,
  entityId: string,
): { lat: number; lon: number } | null {
  if (!viewer || viewer.isDestroyed()) return null;
  let ent: Cesium.Entity | undefined;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    ent = viewer.dataSources.get(i).entities.getById(entityId);
    if (ent) break;
  }
  ent = ent ?? viewer.entities.getById(entityId);
  const cart = ent?.position?.getValue(viewer.clock.currentTime);
  if (!cart) return null;
  const c = Cesium.Cartographic.fromCartesian(cart);
  return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
}

export function TargetDetail({ viewer }: { viewer?: Cesium.Viewer | null }): JSX.Element | null {
  const selectedId = useSelection((s) => s.selectedEntityId);
  const entries = useTargetBoard((s) => s.entries);
  const toggleRequirement = useTargetBoard((s) => s.toggleRequirement);
  const setClassification = useTargetBoard((s) => s.setClassification);
  const move = useTargetBoard((s) => s.move);

  const entry = useMemo(
    () => entries.find((e) => e.entityId === selectedId) ?? null,
    [entries, selectedId],
  );

  const [tab, setTab] = useState<Tab>('overview');
  if (!entry) return null;

  const locked = isLocked(entry.stage, entry.requirements);
  const nxt = nextStage(entry.stage);
  const blockingNext = nxt ? unmetFor(nxt, entry.requirements) : [];

  return (
    <div className="w-[240px] shrink-0 h-full min-h-0 overflow-y-auto pl-2 border-l border-line space-y-2">
      <div className="flex items-center gap-2">
        <SectionLabel title="Target detail" className="flex-1" />
        {locked ? <Badge tone="alert">🔒 locked</Badge> : <Badge tone="ok">cleared</Badge>}
      </div>

      {/* classification banner — per-target caveat (image 4: "SP GOLDEN WARRIOR") */}
      <input
        value={entry.classification}
        onChange={(e) => setClassification(entry.entityId, e.target.value)}
        spellCheck={false}
        className="w-full bg-warn-bg border border-[rgba(245,165,36,0.5)] rounded-sm mono text-[10px] uppercase tracking-[0.6px] text-[#fcd9a0] text-center px-2 py-1"
        title="Per-target classification caveat"
      />

      <div className="flex flex-wrap gap-1">
        {(['overview', 'details', 'weaponeer', 'intel'] as Tab[]).map((t) => (
          <Btn key={t} size="sm" onClick={() => setTab(t)} className={tab === t ? 'border-accent-line text-accent' : ''}>
            {TAB_LABEL[t]}
          </Btn>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab entry={entry} locked={locked} nxt={nxt} blockingNext={blockingNext} toggle={toggleRequirement} move={move} />
      )}
      {tab === 'details' && <DetailsTab entry={entry} viewer={viewer ?? null} toggle={toggleRequirement} />}
      {tab === 'weaponeer' && <WeaponeerTab entry={entry} />}
      {tab === 'intel' && <IntelTab entry={entry} />}
    </div>
  );
}

function OverviewTab({
  entry,
  locked,
  nxt,
  blockingNext,
  toggle,
  move,
}: {
  entry: TargetEntry;
  locked: boolean;
  nxt: string | null;
  blockingNext: RequirementKey[];
  toggle: (id: string, k: RequirementKey) => void;
  move: (id: string, stage: (typeof TARGET_STAGES)[number], force?: boolean) => boolean;
}): JSX.Element {
  const stageIdx = TARGET_STAGES.indexOf(entry.stage);
  const priorityPct = ((6 - entry.priority) / 5) * 100;
  return (
    <>
      <Widget title="Status">
        <KV>
          <KVRow k="Stage" v={STAGE_LABEL[entry.stage] ?? entry.stage} />
          <KVRow k="Priority" v={<span className="flex items-center gap-1.5"><MeterBar pct={priorityPct} tone={entry.priority <= 1 ? 'alert' : entry.priority === 2 ? 'warn' : 'accent'} className="w-12" /> P{entry.priority}</span>} />
        </KV>
        <div className="flex items-center gap-[3px] mt-2" aria-label={`stage ${entry.stage}`}>
          {TARGET_STAGES.map((_, i) => (
            <span key={i} className="h-[3px] flex-1 rounded-sm" style={{ background: i <= stageIdx ? 'var(--accent-line)' : 'var(--bg-3)' }} />
          ))}
        </div>
      </Widget>

      <Widget title="Confirmation checklist" count={`${REQUIREMENT_KEYS.filter((k) => entry.requirements[k]).length}/${REQUIREMENT_KEYS.length}`}>
        <ul className="space-y-1">
          {REQUIREMENT_KEYS.map((k) => {
            const met = !!entry.requirements[k];
            const blocks = blockingNext.includes(k);
            return (
              <li key={k}>
                <button
                  onClick={() => toggle(entry.entityId, k)}
                  className="w-full flex items-center gap-2 text-left rounded-sm px-1.5 py-1 hover:bg-bg-2/60"
                >
                  <span className={`mono text-[12px] leading-none ${met ? 'text-ok' : 'text-txt-4'}`}>{met ? '☑' : '☐'}</span>
                  <span className={`text-[10.5px] flex-1 ${met ? 'text-txt-1' : 'text-txt-2'}`}>{REQUIREMENT_LABEL[k]}</span>
                  {blocks && !met ? <span className="mono text-[10px] uppercase tracking-[0.5px] text-warn">gates next</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Widget>

      {nxt ? (
        <Widget title={`Advance → ${STAGE_LABEL[nxt] ?? nxt}`}>
          {locked ? (
            <>
              <MicroLabel className="block text-warn mb-1.5">
                checklist incomplete: {blockingNext.map((k) => REQUIREMENT_LABEL[k]).join(', ')}
              </MicroLabel>
              <div className="flex gap-1.5">
                <Btn size="sm" disabled className="flex-1 justify-center opacity-50">🔒 Advance</Btn>
                <Btn
                  size="sm"
                  className="flex-1 justify-center border-[rgba(255,90,82,0.5)] text-alert"
                  title="Override the checklist (audited as a forced move)"
                  onClick={() => move(entry.entityId, nxt as (typeof TARGET_STAGES)[number], true)}
                >
                  Advance anyway
                </Btn>
              </div>
            </>
          ) : (
            <Btn size="md" tone="accent" className="w-full justify-center" onClick={() => move(entry.entityId, nxt as (typeof TARGET_STAGES)[number])}>
              ▶ Advance to {STAGE_LABEL[nxt] ?? nxt}
            </Btn>
          )}
        </Widget>
      ) : (
        <MicroLabel className="block">final stage — kill chain complete</MicroLabel>
      )}
    </>
  );
}

function DetailsTab({
  entry,
  viewer,
  toggle,
}: {
  entry: TargetEntry;
  viewer?: Cesium.Viewer | null;
  toggle: (id: string, k: RequirementKey) => void;
}): JSX.Element {
  const pos = livePosition(viewer, entry.entityId);
  return (
    <Widget title="Details">
      <KV>
        <KVRow k="Entity" v={<span className="mono text-[10px]">{entry.entityId}</span>} />
        <KVRow k="Type" v={entry.kind ?? '—'} />
        <KVRow k="Location" v={pos ? <span className="mono text-[10px]">{pos.lat.toFixed(3)}, {pos.lon.toFixed(3)}</span> : <span className="text-txt-3">no live fix</span>} />
      </KV>
      <div className="mt-2">
        <Btn
          size="sm"
          disabled={!pos || !!entry.requirements['location_verified']}
          onClick={() => toggle(entry.entityId, 'location_verified')}
          title={pos ? 'Mark the location as verified from the live fix' : 'No live position to verify'}
        >
          {entry.requirements['location_verified'] ? '✓ Location verified' : 'Verify location'}
        </Btn>
      </div>
    </Widget>
  );
}

function IntelTab({ entry }: { entry: TargetEntry }): JSX.Element {
  const persisted = !entry.id.startsWith('tb_');
  const [coa, setCoa] = useState<string | null>(entry.note || null);
  const [phase, setPhase] = useState<'idle' | 'running' | 'error'>('idle');

  const generate = async (): Promise<void> => {
    setPhase('running');
    try {
      const r = await apiFetch('/api/sim/reason', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fast: true,
          scenario: { target: entry.entityId, label: entry.label, stage: entry.stage, priority: entry.priority },
          outcome: {},
          question:
            'Draft a brief, clearly-estimated course-of-action assessment for tracking this object ' +
            'through the F2T2EA chain. Public, analytical framing only.',
        }),
      });
      const j = (await r.json()) as { ok?: boolean; assessment?: string };
      if (!r.ok || !j.ok || !j.assessment) {
        setPhase('error');
        return;
      }
      const text = j.assessment.slice(0, 2000);
      setCoa(text);
      setPhase('idle');
      if (persisted) {
        void apiFetch(`/api/targets/board/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: text }),
        }).catch(() => undefined);
      }
    } catch {
      setPhase('error');
    }
  };

  return (
    <Widget title="Course of action">
      <Btn size="sm" tone="accent" disabled={phase === 'running'} onClick={generate}>
        {phase === 'running' ? 'Generating…' : coa ? '↻ Regenerate COA' : '✎ Generate COA'}
      </Btn>
      {phase === 'error' ? <p className="mono text-[10px] text-alert mt-1">COA model unavailable</p> : null}
      {coa ? <p className="text-[10px] leading-snug text-txt-2 mt-1.5 whitespace-pre-wrap">{coa}</p> : <MicroLabel className="block mt-1.5">no assessment yet</MicroLabel>}
    </Widget>
  );
}

function fmtUsd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return n > 0 ? `$${n}` : '—';
}

function WeaponeerTab({ entry }: { entry: TargetEntry }): JSX.Element {
  const setWeaponeering = useTargetBoard((s) => s.setWeaponeering);
  const sols = useMemo(
    () => weaponeeringSolutions({ kind: entry.kind, entityId: entry.entityId }),
    [entry.kind, entry.entityId],
  );
  const selectedId = entry.weaponeering ?? sols.find((s) => s.recommended)?.system.id;

  if (sols.length === 0) {
    return (
      <Widget title="Weaponeering solutions">
        <MicroLabel className="block">no catalog effector matches this target type</MicroLabel>
      </Widget>
    );
  }
  return (
    <Widget title="Weaponeering solutions" count={String(sols.length)}>
      <MicroLabel className="block mb-1.5">
        notional open-source estimate — single-shot Pk → rounds for 90% effect. NOT a JMEM product.
      </MicroLabel>
      <ul className="space-y-1.5">
        {sols.map((s) => {
          const sel = s.system.id === selectedId;
          return (
            <li key={s.system.id}>
              <button
                onClick={() => setWeaponeering(entry.entityId, s.system.id)}
                className={`w-full text-left rounded-sm border px-2 py-1.5 ${sel ? 'border-accent-line bg-accent-dim/30' : 'border-line hover:bg-bg-2/60'}`}
                title={`Select ${s.system.name} as the weaponeering solution`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="mono text-[10.5px] text-txt-1 flex-1 truncate">{s.system.name}</span>
                  {s.recommended ? <Badge tone="accent">recommended</Badge> : null}
                  {sel ? <Badge tone="ok">selected</Badge> : null}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="mono text-[10px] text-txt-3 shrink-0">Pk {Math.round(s.pk * 100)}%</span>
                  <MeterBar pct={s.pk * 100} tone={s.pk >= 0.75 ? 'ok' : s.pk >= 0.5 ? 'warn' : 'alert'} className="flex-1" />
                  <span className="mono text-[10px] text-txt-2 shrink-0">×{s.count}</span>
                  <span className="mono text-[10px] text-txt-3 shrink-0">{fmtUsd(s.costUsd)}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Widget>
  );
}
