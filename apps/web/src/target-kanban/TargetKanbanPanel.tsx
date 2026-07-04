// Target Lifecycle Kanban (F2T2EA) — the right-rail board that walks a live
// entity through confirm → attach intel → approvals → weaponeer → execute →
// assess → complete. Cards are drag-and-dropped between stage columns with
// NATIVE HTML5 drag events (no dnd library — none is installed). Clicking a card
// selects its entity (and flies the camera when a viewer is present). Backed by
// useTargetBoard, which works fully in-memory and best-effort persists per user.
//
// This panel never touches the Cesium billboard/label owners (styles.ts /
// labelStyle.ts) — it only READS live entity properties to label a card, so the
// icon + label guardrails are untouched.

import { useEffect, useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';
import { flyToPosition } from '../globe/camera.js';
import {
  useTargetBoard,
  TARGET_STAGES,
  isLocked,
  type TargetStage,
  type TargetEntry,
} from '../state/targetBoard.js';
import { apiFetch } from '../transport/http.js';
import { SectionLabel, MeterBar, Caveat, Btn } from '../shell/instruments.js';
import { TargetDetail } from './TargetDetail.js';

interface Props {
  viewer?: Cesium.Viewer | null;
}

// F2T2EA is a strict ordered chain (must match the backend STAGES tuple +
// _MAX_STAGE_STEP gate in apps/api/app/routes/targets.py). A card may be dragged
// only one stage forward (advance) or one stage back (re-attack / pull authority
// back) — never a skip like confirm → execute. The backend rejects an illegal
// move with 409; we block it at the drag layer so it never round-trips.
const MAX_STAGE_STEP = 1;

function stageIndexOf(stage: TargetStage): number {
  return TARGET_STAGES.indexOf(stage);
}

// True when moving `from` → `to` is a legal one-step transition. Same-stage is
// legal (a no-op drop onto the origin column should not be flagged as illegal).
function canTransition(from: TargetStage, to: TargetStage): boolean {
  return Math.abs(stageIndexOf(to) - stageIndexOf(from)) <= MAX_STAGE_STEP;
}

// One stage-transition audit entry (apps/api/app/routes/targets.py → target_audit).
interface StageAudit {
  action: string;
  target_id: string;
  params: { from?: string; to?: string };
  ts: string;
}

// Human-readable stage headers (the store/back-end keep the snake_case keys).
const STAGE_LABEL: Record<TargetStage, string> = {
  confirm: 'Confirm',
  attach_intel: 'Attach intel',
  approvals: 'Approvals',
  weaponeer: 'Weaponeer',
  execute: 'Execute',
  assess: 'Assess',
  complete: 'Complete',
};

// Category glyph for a card, mirroring EntityPanel.glyphFor. Aircraft ✈,
// vessel ⛴, sim ◈, anything else / dark ◆.
function glyphFor(kind: string | undefined, id: string): string {
  if (id.startsWith('aircraft:') || kind === 'aircraft') return '✈';
  if (id.startsWith('vessel:') || kind === 'vessel') return '⛴';
  if (id.startsWith('sim:') || kind === 'sim') return '◈';
  return '◆';
}

// Icon tint by category, aligned with the app's category colours (styles.ts).
function glyphColor(kind: string | undefined, id: string): string {
  if (id.startsWith('aircraft:') || kind === 'aircraft') return '#facc15';
  if (id.startsWith('vessel:') || kind === 'vessel') return '#14b8a6';
  if (id.startsWith('sim:') || kind === 'sim') return '#c084fc';
  return 'var(--txt-2)';
}

// Read a live label for an entity id from whatever data source currently holds
// it, so a card shows a callsign/name rather than a raw icao24/mmsi. Falls back
// to the entry's captured hint, then a trimmed id.
function liveLabel(viewer: Cesium.Viewer | null | undefined, entry: TargetEntry): string {
  if (viewer && !viewer.isDestroyed()) {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const e = viewer.dataSources.get(i).entities.getById(entry.entityId);
      if (e?.name) return e.name;
    }
    const e = viewer.entities.getById(entry.entityId);
    if (e?.name) return e.name;
  }
  if (entry.label) return entry.label;
  // Strip the "aircraft:"/"vessel:"/"sim:" prefix for a tidier fallback.
  const c = entry.entityId.indexOf(':');
  return c >= 0 ? entry.entityId.slice(c + 1) : entry.entityId;
}

function flyTo(viewer: Cesium.Viewer, entityId: string): void {
  // Best-effort: read the entity's current position from the live clock and
  // slew there via the shared camera helper (same path EntityPanel uses). The
  // track/reticle is drawn by the existing selection machinery once the id is
  // set in useSelection — this only moves the camera.
  let ent: Cesium.Entity | undefined;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    ent = viewer.dataSources.get(i).entities.getById(entityId);
    if (ent) break;
  }
  ent = ent ?? viewer.entities.getById(entityId);
  if (!ent?.position) return;
  const cart = ent.position.getValue(viewer.clock.currentTime);
  if (!cart) return;
  const c = Cesium.Cartographic.fromCartesian(cart);
  flyToPosition(
    viewer,
    Cesium.Math.toDegrees(c.longitude),
    Cesium.Math.toDegrees(c.latitude),
    350_000,
    0.8,
  );
}

export function TargetKanbanPanel({ viewer }: Props = {}): JSX.Element {
  const entries = useTargetBoard((s) => s.entries);
  const add = useTargetBoard((s) => s.add);
  const move = useTargetBoard((s) => s.move);
  const load = useTargetBoard((s) => s.load);
  const selectedId = useSelection((s) => s.selectedEntityId);

  // Hydrate the per-user board once on mount. No-op-safe when unauthenticated
  // or Supabase-less (the store stays local).
  useEffect(() => {
    void load();
  }, [load]);

  const byStage = useMemo(() => {
    const m: Record<TargetStage, TargetEntry[]> = {
      confirm: [],
      attach_intel: [],
      approvals: [],
      weaponeer: [],
      execute: [],
      assess: [],
      complete: [],
    };
    for (const e of entries) m[e.stage].push(e);
    // Highest priority (1) first within a column.
    for (const k of TARGET_STAGES) m[k].sort((a, b) => a.priority - b.priority);
    return m;
  }, [entries]);

  // The entity id currently being dragged (set on dragstart, cleared on drop).
  const [dragId, setDragId] = useState<string | null>(null);
  // The stage the dragged card sits in, so columns can show whether they are a
  // LEGAL drop target (±1 stage) and an illegal drop can be refused.
  const [dragFrom, setDragFrom] = useState<TargetStage | null>(null);
  // The stage column under the pointer during a drag, for a drop-target ring.
  const [overStage, setOverStage] = useState<TargetStage | null>(null);
  // A transient note when an illegal drag is refused (cleared on next drag).
  const [blocked, setBlocked] = useState<string | null>(null);

  const startDrag = (entityId: string): void => {
    setDragId(entityId);
    const e = entries.find((x) => x.entityId === entityId);
    setDragFrom(e ? e.stage : null);
    setBlocked(null);
  };

  const endDrag = (): void => {
    setDragId(null);
    setDragFrom(null);
    setOverStage(null);
  };

  const onDrop = (stage: TargetStage): void => {
    if (dragId && dragFrom && stage !== dragFrom && !canTransition(dragFrom, stage)) {
      // Refuse the out-of-order jump (the backend would 409 it anyway). Leave
      // the card where it is and surface why, briefly.
      setBlocked(
        `${STAGE_LABEL[dragFrom]} → ${STAGE_LABEL[stage]} blocked · advance one stage at a time`,
      );
      endDrag();
      return;
    }
    if (dragId) {
      const ok = move(dragId, stage);
      if (!ok) {
        setBlocked(
          `${STAGE_LABEL[stage]} blocked · confirmation checklist incomplete — open Target detail to complete it or force the move`,
        );
        endDrag();
        return;
      }
    }
    endDrag();
  };

  const onSelect = (entityId: string): void => {
    useSelection.getState().select(entityId);
    if (viewer && !viewer.isDestroyed()) flyTo(viewer, entityId);
  };

  const alreadyOnBoard = selectedId
    ? entries.some((e) => e.entityId === selectedId)
    : false;

  return (
    <div className="flex flex-col gap-2 p-3 h-full min-h-0">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel title="Target board" count={entries.length} className="flex-1" />
        <Btn
          size="sm"
          tone="accent"
          disabled={!selectedId || alreadyOnBoard}
          title={
            !selectedId
              ? 'Select an object on the globe first'
              : alreadyOnBoard
                ? 'Already on the board'
                : 'Add the selected object to the board'
          }
          onClick={() => {
            if (!selectedId) return;
            const label = liveLabel(viewer, {
              id: '',
              entityId: selectedId,
              stage: 'confirm',
              priority: 3,
              note: '',
              requirements: {},
              classification: 'UNCLAS//FOUO',
            });
            const kind = selectedId.startsWith('aircraft:')
              ? 'aircraft'
              : selectedId.startsWith('vessel:')
                ? 'vessel'
                : selectedId.startsWith('sim:')
                  ? 'sim'
                  : undefined;
            add(selectedId, { label, ...(kind ? { kind } : {}) });
          }}
        >
          + Add selected
        </Btn>
      </div>

      <Caveat level="UNCLAS//FOUO" note="F2T2EA working board" />

      {blocked ? (
        <p
          role="alert"
          className="mono text-[10px] uppercase tracking-[0.4px] text-alert border border-alert/40 bg-alert/10 rounded-sm px-2 py-1"
        >
          {blocked}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="mt-2 text-[11px] text-txt-3">
          No targets yet. Select an aircraft, vessel, or sim object on the globe and press
          <span className="mono text-txt-2"> + Add selected</span> to start the kill chain.
        </p>
      ) : null}

      {/* Board (scrolls horizontally) beside the focused-target detail panel. */}
      <div className="flex-1 min-h-0 flex gap-2">
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="flex gap-2 h-full min-h-0" style={{ minWidth: 'max-content' }}>
          {TARGET_STAGES.map((stage, idx) => {
            // During a drag, a column is a legal drop target only when it is
            // within ±1 stage of the dragged card's origin (or the origin
            // itself). Illegal columns dim + refuse the drop ring.
            const legal =
              dragFrom == null ? true : stage === dragFrom || canTransition(dragFrom, stage);
            return (
              <StageColumn
                key={stage}
                stage={stage}
                index={idx}
                cards={byStage[stage]}
                over={overStage === stage}
                dragging={dragId != null}
                legalDrop={legal}
                onDragOverCol={() => setOverStage(stage)}
                onDropCol={() => onDrop(stage)}
                onDragStartCard={startDrag}
                onDragEndCard={endDrag}
                onSelectCard={onSelect}
                selectedId={selectedId}
                viewer={viewer}
              />
            );
          })}
        </div>
        </div>
        <TargetDetail viewer={viewer ?? null} />
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  index,
  cards,
  over,
  dragging,
  legalDrop,
  onDragOverCol,
  onDropCol,
  onDragStartCard,
  onDragEndCard,
  onSelectCard,
  selectedId,
  viewer,
}: {
  stage: TargetStage;
  index: number;
  cards: TargetEntry[];
  over: boolean;
  dragging: boolean;
  legalDrop: boolean;
  onDragOverCol: () => void;
  onDropCol: () => void;
  onDragStartCard: (id: string) => void;
  onDragEndCard: () => void;
  onSelectCard: (id: string) => void;
  selectedId: string | null;
  viewer: Cesium.Viewer | null | undefined;
}): JSX.Element {
  // While dragging, an illegal target column is dimmed and shows the
  // "no-drop" cursor; legal columns highlight on hover.
  const illegal = dragging && !legalDrop;
  return (
    <section
      className={[
        'w-[156px] shrink-0 h-full min-h-0 flex flex-col rounded-sm border bg-bg-1/50 transition-colors',
        over && legalDrop ? 'border-accent-line bg-accent-dim/40' : 'border-line',
        illegal ? 'opacity-40' : '',
      ].join(' ')}
      onDragOver={(e) => {
        if (!dragging) return;
        if (!legalDrop) {
          // Refuse the drop: do NOT preventDefault, so the OS shows "no-drop"
          // and onDrop never fires for this column.
          e.dataTransfer.dropEffect = 'none';
          return;
        }
        e.preventDefault(); // allow drop
        e.dataTransfer.dropEffect = 'move';
        onDragOverCol();
      }}
      onDrop={(e) => {
        if (!legalDrop) return;
        e.preventDefault();
        onDropCol();
      }}
    >
      <div className="px-2 pt-2 pb-1.5">
        <SectionLabel title={`${index + 1} · ${STAGE_LABEL[stage]}`} count={cards.length} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
        {cards.map((c) => (
          <TargetCard
            key={c.id}
            entry={c}
            selected={c.entityId === selectedId}
            onDragStart={() => onDragStartCard(c.entityId)}
            onDragEnd={onDragEndCard}
            onSelect={() => onSelectCard(c.entityId)}
            viewer={viewer}
          />
        ))}
        {cards.length === 0 && (
          <p className="mono text-[10px] uppercase tracking-[0.6px] text-txt-4 py-1">
            {dragging ? 'drop here' : 'empty'}
          </p>
        )}
      </div>
    </section>
  );
}

// Compact "x ago" for an ISO timestamp. Tolerant of a missing/garbled stamp.
function relTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function TargetCard({
  entry,
  selected,
  onDragStart,
  onDragEnd,
  onSelect,
  viewer,
}: {
  entry: TargetEntry;
  selected: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSelect: () => void;
  viewer: Cesium.Viewer | null | undefined;
}): JSX.Element {
  const remove = useTargetBoard((s) => s.remove);
  const label = liveLabel(viewer, entry);
  const glyph = glyphFor(entry.kind, entry.entityId);
  const color = glyphColor(entry.kind, entry.entityId);
  const locked = isLocked(entry.stage, entry.requirements);

  // Stage-transition audit + COA are only meaningful for the FOCUSED card, and
  // both need a server-side row (a `tb_` local-only id has nothing persisted),
  // so we lazily fetch/act only when this card is selected AND server-backed.
  const persisted = !entry.id.startsWith('tb_');
  const [audit, setAudit] = useState<StageAudit | null>(null);
  const [coa, setCoa] = useState<string | null>(entry.note || null);
  const [coaPhase, setCoaPhase] = useState<'idle' | 'running' | 'error'>('idle');

  useEffect(() => {
    if (!selected || !persisted) return;
    let alive = true;
    void apiFetch(`/api/targets/board/${encodeURIComponent(entry.id)}/audit`)
      .then((r) => (r.ok ? (r.json() as Promise<StageAudit[]>) : null))
      .then((rows) => {
        const latest = Array.isArray(rows) ? rows[0] : undefined;
        if (alive && latest) setAudit(latest);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // Re-fetch when the card's stage changes (a fresh transition was logged).
  }, [selected, persisted, entry.id, entry.stage]);

  // Generate a course-of-action narrative for this target via the EXISTING
  // /api/sim/reason gateway (fast tier) and persist it to the row's note. We do
  // NOT add a new LLM path — this reuses the war-game reasoner with the target
  // as the "scenario". Best-effort persist (note-only PATCH skips the gate).
  const generateCoa = async (): Promise<void> => {
    setCoaPhase('running');
    try {
      const r = await apiFetch('/api/sim/reason', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fast: true,
          scenario: {
            target: entry.entityId,
            label,
            stage: entry.stage,
            priority: entry.priority,
          },
          outcome: {},
          question:
            'Draft a brief, clearly-estimated course-of-action assessment for tracking ' +
            'this object through the F2T2EA chain. Public, analytical framing only.',
        }),
      });
      const j = (await r.json()) as { ok?: boolean; assessment?: string };
      if (!r.ok || !j.ok || !j.assessment) {
        setCoaPhase('error');
        return;
      }
      const text = j.assessment.slice(0, 2000);
      setCoa(text);
      setCoaPhase('idle');
      // Persist to the note (note-only PATCH is ungated). Local-only rows are
      // skipped — the in-memory display still updates above.
      if (persisted) {
        void apiFetch(`/api/targets/board/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: text }),
        }).catch(() => undefined);
      }
    } catch {
      setCoaPhase('error');
    }
  };

  // Threat border by priority: 1 = alert (highest), 2 = warn, else neutral.
  const borderColor =
    entry.priority <= 1
      ? 'var(--alert)'
      : entry.priority === 2
        ? 'var(--warn)'
        : 'var(--line-2)';

  // Stage progress pips: 7 dots, filled up to and including this entry's stage.
  const stageIndex = TARGET_STAGES.indexOf(entry.stage);
  // Priority meter: invert so priority 1 reads as a full bar.
  const priorityPct = ((6 - entry.priority) / 5) * 100;
  const priorityTone = entry.priority <= 1 ? 'alert' : entry.priority === 2 ? 'warn' : 'accent';

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        // Some browsers require data to be set for a drag to initiate.
        try {
          e.dataTransfer.setData('text/plain', entry.entityId);
        } catch {
          /* ignore */
        }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      title={entry.entityId}
      className={[
        'group cursor-grab active:cursor-grabbing rounded-sm border bg-bg-2/70 px-2 py-1.5 select-none',
        'border-l-2 hover:border-accent-line transition-colors',
        selected ? 'ring-1 ring-accent-line' : '',
      ].join(' ')}
      style={{ borderLeftColor: borderColor }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] leading-none shrink-0" style={{ color }} aria-hidden>
          {glyph}
        </span>
        <span className="mono text-[10px] text-txt-1 truncate flex-1" title={label}>
          {label}
        </span>
        {locked ? (
          <span className="text-[10px] leading-none shrink-0 text-alert" title="confirmation checklist incomplete — gates the next stage">🔒</span>
        ) : null}
        <button
          type="button"
          aria-label="Remove from board"
          title="Remove from board"
          onClick={(e) => {
            e.stopPropagation();
            remove(entry.entityId);
          }}
          className="mono text-[10px] leading-none text-txt-4 opacity-0 group-hover:opacity-100 hover:text-alert px-0.5"
        >
          ✕
        </button>
      </div>

      {/* Stage pips */}
      <div className="flex items-center gap-[3px] mt-1.5" aria-label={`stage ${entry.stage}`}>
        {TARGET_STAGES.map((_, i) => (
          <span
            key={i}
            className="h-[3px] flex-1 rounded-sm"
            style={{
              background:
                i <= stageIndex ? 'var(--accent-line)' : 'var(--bg-3)',
            }}
          />
        ))}
      </div>

      {/* Priority meter + label */}
      <div className="flex items-center gap-1.5 mt-1.5">
        <MeterBar pct={priorityPct} tone={priorityTone} className="flex-1" />
        <span className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 shrink-0">
          P{entry.priority}
        </span>
      </div>

      {/* Per-target classification caveat (image 4). */}
      <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-4 mt-1 truncate" title={entry.classification}>
        {entry.classification}
      </div>

      {/* Last stage move: WHO + WHEN, from the audit log (focused card only). */}
      {selected && audit ? (
        <p
          className="mono text-[10px] text-txt-3 mt-1.5 truncate"
          title={`${audit.params.from ?? '?'} → ${audit.params.to ?? '?'} by ${audit.target_id}`}
        >
          moved {audit.params.from ?? '?'}→{audit.params.to ?? '?'} ·{' '}
          {relTime(audit.ts) || 'logged'}
        </p>
      ) : null}

      {/* Course-of-action: generate via the existing reasoner, persist to note. */}
      {selected ? (
        <div className="mt-1.5 border-t border-line pt-1.5" onClick={(e) => e.stopPropagation()}>
          <Btn
            size="sm"
            tone="accent"
            disabled={coaPhase === 'running'}
            title="Generate a course-of-action assessment (analytical estimate) for this target"
            onClick={generateCoa}
          >
            {coaPhase === 'running' ? 'Generating COA…' : coa ? '↻ Regenerate COA' : '✎ Generate COA'}
          </Btn>
          {coaPhase === 'error' ? (
            <p className="mono text-[10px] text-alert mt-1">COA model unavailable</p>
          ) : null}
          {coa ? (
            <p className="text-[10px] leading-snug text-txt-2 mt-1 whitespace-pre-wrap">{coa}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
