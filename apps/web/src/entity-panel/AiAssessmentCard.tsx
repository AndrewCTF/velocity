// EntityPanel "AI assessment" block (local-llm-design.md, 2026-07-11):
// a short, fast selection-tier AI brief for the entity currently selected on
// the globe. Debounced 500ms after selection settles, cached client-side per
// entity id for 60s, aborted mid-flight on the next selection change, and
// entirely inert when selection AI is OFF (the common case) — no network
// activity at all in that state. Collapsed by default so it doesn't push the
// rest of the panel down on every click; matches the Widget card idiom.
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { useSettings } from '../state/settings.js';
import { Badge } from '../shell/instruments.js';
import type { SelectionBriefResponse } from '../settings/localAi/types.js';

const DEBOUNCE_MS = 500;
const CACHE_TTL_MS = 60_000;
// Never dump the raw entity property bag into the prompt — only these
// well-known fields, first-match-wins across common feed field-name variants.
const CALLSIGN_KEYS = ['callsign', 'callSign', 'name'];
const TYPE_KEYS = ['type', 'shipType', 'ship_type', 'category'];
const SPEED_KEYS = ['velocity_ms', 'gs', 'sog', 'speed'];
const HEADING_KEYS = ['track_deg', 'heading', 'cog'];
const ORIGIN_KEYS = ['icao24', 'mmsi', 'source'];
const MAX_FIELD_LEN = 64;

interface CacheEntry {
  resp: SelectionBriefResponse;
  ts: number;
}
// Module-level so the cache survives across selection changes/remounts within
// a session (a small in-memory brief store, not persisted).
const briefCache = new Map<string, CacheEntry>();

function pick(props: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = props[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function clampStr(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_FIELD_LEN) return v.slice(0, MAX_FIELD_LEN);
  return v;
}

// Compact prop subset — id/callsign/reg/type/speed/alt/heading/origin, capped
// well under any reasonable request-body limit (at most 6 short fields).
export function compactSelectionProps(
  properties: Record<string, unknown>,
  altM?: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const callsign = pick(properties, CALLSIGN_KEYS);
  if (callsign !== undefined) out['callsign'] = clampStr(callsign);
  const type = pick(properties, TYPE_KEYS);
  if (type !== undefined) out['type'] = clampStr(type);
  const speed = pick(properties, SPEED_KEYS);
  if (typeof speed === 'number' && Number.isFinite(speed)) out['speed'] = speed;
  if (typeof altM === 'number' && Number.isFinite(altM)) out['alt'] = altM;
  const heading = pick(properties, HEADING_KEYS);
  if (typeof heading === 'number' && Number.isFinite(heading)) out['heading'] = heading;
  const origin = pick(properties, ORIGIN_KEYS);
  if (origin !== undefined) out['origin'] = clampStr(origin);
  return out;
}

interface Props {
  id: string;
  kind: string;
  properties: Record<string, unknown>;
  altM?: number;
}

export function AiAssessmentCard({ id, kind, properties, altM }: Props): JSX.Element | null {
  const enabled = useSettings((s) => s.selectionAiEnabled);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SelectionBriefResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Latest kind/props available at fetch time without re-triggering the
  // debounce on every feed tick (the effect below depends on `id`, not these).
  // `kind` MUST come from here, not the render closure: on a fresh selection the
  // parent resets its snapshot to null before the scene tick repopulates it, so
  // the render that arms the debounce can carry kind='' (or the prior entity's
  // kind). Sending kind='' fails the backend's min_length=1 check → 422. Reading
  // it from the ref at fire time uses whatever the latest render settled on.
  const propsRef = useRef({ kind, properties, altM });
  propsRef.current = { kind, properties, altM };

  const run = (bypassCache: boolean, signal: AbortSignal): void => {
    if (!bypassCache) {
      const cached = briefCache.get(id);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        setData(cached.resp);
        setErr(null);
        return;
      }
    }
    setLoading(true);
    setErr(null);
    const body = {
      // Backend requires a non-empty kind (min_length=1); fall back so an
      // entity with no 'kind' prop still yields a valid request, not a 422.
      kind: propsRef.current.kind || kind || 'entity',
      id,
      props: compactSelectionProps(propsRef.current.properties, propsRef.current.altM),
    };
    apiFetch('/api/ai/selection/brief', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          setErr(`assessment failed (${r.status})`);
          return;
        }
        const resp = (await r.json()) as SelectionBriefResponse;
        briefCache.set(id, { resp, ts: Date.now() });
        setData(resp);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setErr('network error');
      })
      .finally(() => {
        // An aborted request's `.finally` can still fire AFTER the next
        // selection has already started its own fetch — only clear loading
        // for the request that owns this signal, never for a superseded one.
        if (!signal.aborted) setLoading(false);
      });
  };

  useEffect(() => {
    setData(null);
    setErr(null);
    if (!enabled) return;
    const cached = briefCache.get(id);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      setData(cached.resp);
      return;
    }
    const aborter = new AbortController();
    const timer = window.setTimeout(() => run(false, aborter.signal), DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
    // Deliberately keyed on id + enabled only — see propsRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled]);

  if (!enabled) return null;

  const refresh = (): void => {
    briefCache.delete(id);
    const aborter = new AbortController();
    run(true, aborter.signal);
  };

  return (
    <section className="rounded-md border border-line-2 bg-bg-1/90 p-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2 flex items-center gap-1.5">
          <span aria-hidden>{open ? '▾' : '▸'}</span>
          AI assessment
        </span>
        {loading && <span className="mono text-[10px] text-txt-3">…</span>}
        {!loading && data && (
          <span className="mono text-[10px] text-txt-3 tabular-nums">{data.latency_ms.toFixed(0)}ms</span>
        )}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          {loading && !data && <p className="mono text-[10px] text-txt-3">assessing…</p>}
          {err && <p className="mono text-[10px] text-alert">{err}</p>}
          {data && (
            <>
              <p className="text-[11px] text-txt-1 leading-snug">{data.text}</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="mono text-[10px] text-txt-2 break-all min-w-0">{data.model}</span>
                <span className="mono text-[10px] text-txt-3">{data.backend}</span>
                <span className="mono text-[10px] text-txt-3 tabular-nums">{data.latency_ms.toFixed(0)}ms</span>
                {data.cached && <Badge tone="neutral">cached</Badge>}
                <button
                  type="button"
                  onClick={refresh}
                  disabled={loading}
                  className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent disabled:opacity-50 ml-auto"
                >
                  ↻ refresh
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
