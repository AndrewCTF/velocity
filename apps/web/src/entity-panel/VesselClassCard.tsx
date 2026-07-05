import { useMemo, useState } from 'react';
import { Widget, Badge, Caveat, Btn, MicroLabel, StatusDot, type BadgeTone } from '../shell/instruments.js';
import {
  FEATURE_DEFS,
  matchByFeatures,
  matchVesselClass,
  verifyAgainstAis,
  type FeatureTag,
  type AisVerdictLevel,
} from '../intel/vesselClasses.js';

// Imagery recognition: the analyst ticks the WEAPONS / SENSOR / DECK features they
// can see in the detailed chip, and candidate classes rank by weighted feature
// overlap. Length is shown only as a coarse secondary cue. A heuristic shortlist,
// never a positive ID — there is no CV auto-detector; the operator supplies what
// they observe.

interface Props {
  lengthM?: number | null;
  shipType?: string | null;
  sogKn?: number | null; // speed over ground — moored (≈0) ⇒ AIS position stable for the cross-check
}

const VERDICT_TONE: Record<AisVerdictLevel, BadgeTone> = {
  confirmed: 'ok',
  plausible: 'accent',
  mismatch: 'alert',
  no_ais: 'neutral',
};
const VERDICT_DOT: Record<AisVerdictLevel, string> = {
  confirmed: 'ok',
  plausible: 'accent',
  mismatch: 'alert',
  no_ais: 'neutral',
};

const GROUPS: FeatureTag[][] = (() => {
  const byGroup: Record<string, FeatureTag[]> = {};
  (Object.keys(FEATURE_DEFS) as FeatureTag[]).forEach((t) => {
    (byGroup[FEATURE_DEFS[t].group] ??= []).push(t);
  });
  return Object.values(byGroup);
})();

export function VesselClassCard({ lengthM, shipType: _shipType, sogKn }: Props): JSX.Element {
  const [observed, setObserved] = useState<Set<FeatureTag>>(new Set());
  const toggle = (t: FeatureTag): void =>
    setObserved((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  const matches = useMemo(
    () =>
      observed.size > 0
        ? matchByFeatures([...observed], lengthM ? { lengthM } : {})
        : lengthM
          ? matchVesselClass(lengthM)
          : [],
    [observed, lengthM],
  );
  const byLengthOnly = observed.size === 0;

  return (
    <Widget title="Recognize class">
      <div className="space-y-2">
        <Caveat
          level="HEURISTIC"
          note="match by observed weapon/sensor fit — shortlist, not a positive ID"
          tone="warn"
        />
        {lengthM ? (
          <p className="mono text-[10px] text-txt-3">
            AIS length {Math.round(lengthM)} m
            {typeof sogKn === 'number' && (
              <span className={sogKn < 1 ? 'text-ok' : 'text-txt-3'}>
                {' '}· {sogKn < 1 ? 'moored — AIS position stable for cross-check' : `underway ${sogKn.toFixed(0)} kn`}
              </span>
            )}
          </p>
        ) : (
          <p className="mono text-[10px] text-warn">
            AIS length not broadcast — verify visually (measure hull off the chip), or dark contact
          </p>
        )}

        {/* Feature checklist — tick what is visible in the chip. */}
        <div className="space-y-1.5">
          {GROUPS.map((group, gi) => (
            <div key={gi}>
              <MicroLabel>{FEATURE_DEFS[group[0]!].group}</MicroLabel>
              <div className="mt-1 flex flex-wrap gap-1">
                {group.map((t) => {
                  const on = observed.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggle(t)}
                      title={FEATURE_DEFS[t].label}
                      className={[
                        'mono text-[10px] tracking-[0.2px] px-1.5 py-[3px] rounded-sm border transition-colors',
                        on
                          ? 'border-accent-line bg-accent-dim text-accent'
                          : 'border-line bg-bg-2 text-txt-3 hover:text-txt-1 hover:border-accent-line',
                      ].join(' ')}
                    >
                      {FEATURE_DEFS[t].label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {observed.size > 0 && (
          <Btn size="sm" onClick={() => setObserved(new Set())}>
            Clear ({observed.size})
          </Btn>
        )}

        {/* Top verdict — AIS ground truth cross-checked against the visual top pick. */}
        {!byLengthOnly && matches.length > 0 && lengthM ? (
          (() => {
            const v = verifyAgainstAis(matches[0]!.cls, lengthM);
            const headline =
              v.level === 'confirmed'
                ? `CONFIRMED — ${matches[0]!.cls.name}: visual fit + AIS length agree`
                : v.level === 'plausible'
                  ? `LIKELY — ${matches[0]!.cls.name}: visual fit, AIS length close`
                  : `⚠ MISMATCH — visual class ≠ AIS length (${v.lenDeltaPct}% off): spoof / mis-ID / decoy?`;
            return (
              <div className="flex items-center gap-1.5 rounded-sm border border-line bg-bg-1/70 px-2 py-1.5">
                <StatusDot tone={VERDICT_DOT[v.level]} />
                <span className="text-[10px] text-txt-1 leading-snug">{headline}</span>
              </div>
            );
          })()
        ) : null}

        {/* Ranked candidates. */}
        {matches.length > 0 ? (
          <ul className="space-y-1.5 pt-1">
            {matches.map((m) => {
              const v = lengthM ? verifyAgainstAis(m.cls, lengthM) : null;
              return (
                <li
                  key={m.cls.id}
                  className="relative rounded-sm border border-line bg-bg-2/60 pl-3 pr-2.5 py-1.5 overflow-hidden"
                >
                  <span
                    className="absolute left-0 top-0 bottom-0 w-[2px]"
                    style={{ background: byLengthOnly ? 'var(--warn)' : 'var(--accent-line)' }}
                  />
                  <div className="flex items-center gap-1.5">
                    <Badge tone="neutral">{m.cls.vesselType}</Badge>
                    <span className="text-[11px] text-txt-0 flex-1 truncate" title={m.cls.name}>
                      {m.cls.name}
                    </span>
                    {v && v.level !== 'no_ais' && (
                      <Badge tone={VERDICT_TONE[v.level]}>
                        {v.level === 'mismatch' ? `AIS ✗ ${v.lenDeltaPct}%` : `AIS ✓ ${v.lenDeltaPct}%`}
                      </Badge>
                    )}
                    <span className="mono text-[10px] text-txt-3 tabular-nums">
                      {byLengthOnly ? `Δ${Math.round(m.lenDeltaM ?? 0)} m` : `${m.matched.length}✓`}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 mono text-[10px] text-txt-3 tabular-nums">
                    <span>{m.cls.country}</span>
                    <span>{m.cls.lengthM} m</span>
                    {m.cls.sources[0] && (
                      <a href={m.cls.sources[0]} target="_blank" rel="noreferrer" className="text-accent hover:underline ml-auto">
                        src
                      </a>
                    )}
                  </div>
                  {!byLengthOnly && m.matched.length > 0 && (
                    <p className="mt-1 text-[10px] text-ok/90 leading-snug">
                      ✓ {m.matched.map((f) => FEATURE_DEFS[f].label).join(' · ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[10px] text-txt-3">
            Tick the features visible in the imagery to shortlist classes.
          </p>
        )}
      </div>
    </Widget>
  );
}
