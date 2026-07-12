import { useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts, useSelection } from '../state/stores.js';
import { useInbox } from '../state/inbox.js';
import { useSavedSearches } from '../state/savedSearches.js';
import { useWatchOfficerBriefs, type WatchOfficerBrief } from '../state/watchOfficer.js';
import { flyToPosition } from '../globe/camera.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import { Badge, Btn, type BadgeTone } from '../shell/instruments.js';
import type { Alert, AlertSeverity } from '@osint/shared';

const SEV_BADGE: Record<string, BadgeTone> = {
  critical: 'alert',
  high: 'alert',
  medium: 'warn',
  low: 'neutral',
  info: 'neutral',
};
const SEV_BAR: Record<string, string> = {
  critical: 'var(--alert)',
  high: 'var(--alert)',
  medium: 'var(--warn)',
  low: 'var(--sev-low)',
  info: 'var(--txt-2)',
};
const SEVERITIES: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Coarse channel from a rule id — the family before the first underscore group. */
function channelOf(ruleId: string): string {
  return ruleId.split('_').slice(0, 2).join('_') || ruleId;
}

// Inbox (design §6.5) — the single triage surface consolidating the old rail list,
// slide-over, and ticker. Every alert deep-links to the map (slew-to) and can be
// read/archived; state persists across reloads. Alerts come from the real
// geofence / correlation / pattern pipeline via useAlerts.
export function InboxPanel({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const alerts = useAlerts((s) => s.alerts);
  const archived = useInbox((s) => s.archived);
  const read = useInbox((s) => s.read);
  const markRead = useInbox((s) => s.markRead);
  const markManyRead = useInbox((s) => s.markManyRead);
  const archive = useInbox((s) => s.archive);
  const savedSearches = useSavedSearches((s) => s.searches);
  const removeSaved = useSavedSearches((s) => s.remove);
  const { briefs: woBriefs, dismiss: woDismiss, ack: woAck } = useWatchOfficerBriefs();
  const reduced = useReducedMotion();
  const [sev, setSev] = useState<AlertSeverity | null>(null);
  const [channel, setChannel] = useState<string | null>(null);

  const active = useMemo(() => alerts.filter((a) => !archived.has(a.id)), [alerts, archived]);
  const unread = useMemo(() => active.filter((a) => !read.has(a.id)).length, [active, read]);
  const channels = useMemo(() => {
    const set = new Set<string>();
    for (const a of active) set.add(channelOf(a.ruleId));
    return [...set].sort();
  }, [active]);
  const filtered = useMemo(
    () => active.filter((a) => (!sev || a.severity === sev) && (!channel || channelOf(a.ruleId) === channel)),
    [active, sev, channel],
  );

  const open = (a: Alert): void => {
    markRead(a.id);
    const first = a.contributingObservations?.[0];
    if (first) useSelection.getState().select(first);
    if (viewer && a.geom?.type === 'Point') {
      const [lon, lat] = a.geom.coordinates as [number, number];
      flyToPosition(viewer, lon, lat, 250_000, reduced ? 0 : 1.0);
    }
  };

  const slewToBrief = (b: WatchOfficerBrief): void => {
    const { lon, lat } = b.centroid;
    if (viewer && lon != null && lat != null) {
      flyToPosition(viewer, lon, lat, 250_000, reduced ? 0 : 1.0);
    }
  };

  return (
    <div className="p-3 flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="font-label uppercase tracking-[0.8px] text-[11px] text-txt-1">
          Inbox{' '}
          {unread > 0 && (
            <span className="ml-1 mono text-[10px] px-1.5 py-0.5 rounded-sm bg-alert text-white font-semibold">
              {unread}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => markManyRead(active.map((a) => a.id))}
          disabled={unread === 0}
          className="mono text-[10px] uppercase tracking-[0.4px] text-txt-3 hover:text-txt-1 disabled:opacity-40"
        >
          Mark all read
        </button>
      </div>

      {/* Watch-officer draft briefs — finished, cited convergences filed by the
          standing loop for triage. Ack = keep the finding, dismiss = noise. */}
      {woBriefs.length > 0 && (
        <div className="border border-accent-line rounded-sm">
          <div className="px-2 py-1 mono text-[10px] uppercase tracking-[0.5px] text-accent border-b border-accent-line/60">
            Watch Officer · {woBriefs.length}
          </div>
          <ul className="divide-y divide-line">
            {woBriefs.slice(0, 20).map((b) => (
              <li key={b.id} className="px-2 py-2">
                <div className="flex items-center gap-2">
                  <Badge tone={b.threat_level === 'high' ? 'alert' : b.threat_level === 'elevated' ? 'warn' : 'neutral'}>
                    {b.threat_level}
                  </Badge>
                  <span className="mono text-[10px] uppercase tracking-[0.4px] text-txt-3 truncate">
                    {b.domains.join(' · ')}
                  </span>
                </div>
                {b.narrative && (
                  <p className="text-[11px] leading-snug mt-1.5 text-txt-1 line-clamp-3">{b.narrative}</p>
                )}
                {b.evidence.slice(0, 2).map((e, i) => (
                  <div key={i} className="mono text-[10px] text-txt-3 mt-1 truncate">
                    <span className={e.kind === 'inferred' ? 'text-warn' : 'text-txt-2'}>
                      [{e.kind ?? 'measured'}]
                    </span>{' '}
                    {e.summary}
                  </div>
                ))}
                {b.follow_up.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {b.follow_up.slice(0, 3).map((f, i) => (
                      <span key={i} className="mono text-[9px] px-1 py-0.5 rounded-sm border border-line text-txt-3">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1.5">
                  <Btn size="sm" onClick={() => slewToBrief(b)}>slew to</Btn>
                  <button
                    type="button"
                    onClick={() => woAck(b.id)}
                    className="mono text-[10px] uppercase tracking-[0.4px] text-accent hover:text-txt-0"
                  >
                    ack
                  </button>
                  <button
                    type="button"
                    onClick={() => woDismiss(b.id)}
                    className="mono text-[10px] uppercase tracking-[0.4px] text-txt-3 hover:text-alert"
                  >
                    dismiss
                  </button>
                  <span className="mono text-[10px] tabular-nums text-txt-3 ml-auto">
                    {new Date(b.created * 1000).toISOString().slice(11, 19)}Z
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* severity filter */}
      <div className="flex flex-wrap items-center gap-1">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSev((c) => (c === s ? null : s))}
            aria-pressed={sev === s}
            className={`mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-0.5 border rounded-sm ${
              sev === s ? 'border-accent-line bg-accent-dim text-accent' : 'border-line text-txt-3 hover:text-txt-1'
            }`}
          >
            {s} <span className="tabular-nums text-txt-2">{active.filter((a) => a.severity === s).length}</span>
          </button>
        ))}
      </div>

      {/* saved-search subscriptions (§6.5) — standing queries that notify on growth */}
      {savedSearches.length > 0 && (
        <div className="border border-line rounded-sm">
          <div className="px-2 py-1 mono text-[10px] uppercase tracking-[0.5px] text-txt-3 border-b border-line">
            Subscriptions · {savedSearches.length}
          </div>
          {savedSearches.map((s) => (
            <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 border-b border-line/50 last:border-0">
              <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
              <span className="text-[11px] text-txt-1 flex-1 truncate" title={s.label}>{s.label}</span>
              <span className="mono text-[10px] tabular-nums text-txt-3">
                {s.lastCount >= 0 ? s.lastCount.toLocaleString() : '…'}
              </span>
              <button
                type="button"
                onClick={() => removeSaved(s.id)}
                aria-label="Remove subscription"
                className="mono text-[10px] text-txt-3 hover:text-alert"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* channel filter (subscription families) */}
      {channels.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          {channels.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel((cur) => (cur === c ? null : c))}
              aria-pressed={channel === c}
              className={`mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
                channel === c ? 'border-accent-line text-accent bg-accent-dim' : 'border-line text-txt-3 hover:text-txt-1'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-[11px] leading-snug text-txt-3">
          {active.length === 0
            ? 'Inbox clear. Geofence, watch, and correlation subscriptions post here when they fire.'
            : 'Nothing matches this filter.'}
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {filtered.slice(0, 80).map((a) => {
            const isUnread = !read.has(a.id);
            return (
              <li key={a.id} className="relative">
                <span className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: SEV_BAR[a.severity] }} />
                <div className={`pl-3 pr-1 py-2 ${isUnread ? '' : 'opacity-60'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone={SEV_BADGE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
                    <span className="mono text-[10px] tracking-[0.4px] uppercase text-txt-3 truncate">{channelOf(a.ruleId)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => open(a)}
                    className={`text-left text-[11px] leading-snug mt-1.5 line-clamp-2 hover:text-txt-0 ${
                      isUnread ? 'text-txt-0 font-medium' : 'text-txt-2'
                    }`}
                  >
                    {a.message}
                  </button>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Btn size="sm" onClick={() => open(a)}>
                      slew to
                    </Btn>
                    <button
                      type="button"
                      onClick={() => archive(a.id)}
                      className="mono text-[10px] uppercase tracking-[0.4px] text-txt-3 hover:text-txt-1"
                    >
                      archive
                    </button>
                    <span className="mono text-[10px] tabular-nums text-txt-3 ml-auto">
                      {new Date(a.t).toISOString().slice(11, 19)}Z
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
