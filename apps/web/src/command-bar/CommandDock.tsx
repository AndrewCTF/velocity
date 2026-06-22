// CommandDock — the resting command strip docked bottom-centre over the globe
// (mockup .dock). Two stacked rows over the live scene:
//   • "Standing" — real status pills sourced from the zustand stores
//     (alerts buffer, active AOI, feed health). No fabricated tasks/counts.
//   • "command line" — a real prompt wired to the existing /api/search,
//     mirroring SearchField.pick (select + flyToPosition). ⌘K / Ctrl+K focuses.
//
// RESKIN + new shell over EXISTING behaviour: every number is live from a
// store, the input runs the same search()/select()/flyToPosition() path the
// SearchField uses. Nothing here is decorative.

import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts, useFeeds, useSelection, type FeedStatus } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { search, type SearchResult } from '../transport/search.js';
import { flyToPosition } from '../globe/camera.js';
import { StatusDot } from '../shell/instruments.js';
import type { AlertSeverity } from '@osint/shared';

// Worst alert severity present in the buffer → dot tone. Order matches the
// store's AlertSeverity union; only critical/high/medium drive a non-neutral
// dot so a quiet buffer reads calm.
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function worstSeverityTone(severities: readonly AlertSeverity[]): string {
  let worst: AlertSeverity = 'info';
  for (const s of severities) {
    if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
  }
  if (worst === 'critical' || worst === 'high') return 'alert';
  if (worst === 'medium' || worst === 'low') return 'warn';
  return 'neutral';
}

// Worst feed status across the registry → a single feeds-ok dot tone.
function worstFeedTone(statuses: readonly FeedStatus[]): string {
  if (statuses.some((s) => s === 'red')) return 'alert';
  if (statuses.some((s) => s === 'amber')) return 'warn';
  if (statuses.some((s) => s === 'green')) return 'ok';
  return 'neutral';
}

export function CommandDock({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const alerts = useAlerts((s) => s.alerts);
  const aoi = useAoi((s) => s.active);
  const feeds = useFeeds((s) => s.feeds);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');

  const feedList = Object.values(feeds);
  const greenFeeds = feedList.filter((f) => f.status === 'green').length;
  const alertTone = worstSeverityTone(alerts.map((a) => a.severity));
  const feedTone = worstFeedTone(feedList.map((f) => f.status));
  const aoiName = aoi ? aoi.name : 'global';

  // ⌘J / Ctrl+J focuses the prompt (⌘K is the global Omnibar palette).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Mirror SearchField.pick: places/chokepoints clear selection, contacts
  // select by id, and we slew to the result when it carries a real position.
  const pick = (r: SearchResult): void => {
    if (r.kind === 'place' || r.kind === 'chokepoint') {
      useSelection.getState().select(null);
    } else {
      useSelection.getState().select(r.id);
    }
    if (viewer && (r.lon !== 0 || r.lat !== 0)) {
      const altKm = r.kind === 'chokepoint' ? 800 : 200;
      flyToPosition(viewer, r.lon, r.lat, altKm * 1000, 1.2);
    }
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      setQ('');
      inputRef.current?.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    search(query)
      .then((results) => {
        const first = results[0];
        if (first) pick(first);
      })
      .catch(() => undefined)
      .finally(() => setQ(''));
  };

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 bottom-4 z-[25] w-[600px] pointer-events-auto border border-line-2 rounded-md overflow-hidden"
      style={{
        background: 'rgba(12,16,23,0.94)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 28px rgba(0,0,0,0.55)',
      }}
    >
      {/* Standing — live status pills, every value sourced from a store. */}
      <div className="flex items-center gap-4 border-b border-line px-3 py-[7px] mono text-[9px] tracking-[0.5px]">
        <span className="text-txt-3 uppercase tracking-[0.9px]">Standing</span>
        <span className="flex items-center gap-[6px] text-txt-2 uppercase">
          <StatusDot tone={alertTone} />
          alerts
          <b className="text-txt-0 tabular-nums">{alerts.length}</b>
        </span>
        <span className="flex items-center gap-[6px] text-txt-2 uppercase">
          <span className="text-txt-3">AOI</span>
          <b className="text-txt-0 normal-case tracking-[0.3px]">{aoiName}</b>
        </span>
        {feedList.length > 0 && (
          <span className="flex items-center gap-[6px] text-txt-2 uppercase">
            <StatusDot tone={feedTone} />
            feeds
            <b className="text-txt-0 tabular-nums">
              {greenFeeds}/{feedList.length}
            </b>
          </span>
        )}
      </div>

      {/* command line — real prompt wired to /api/search + select + flyTo. */}
      <div className="flex items-center gap-[10px] px-3 py-[9px]">
        <span className="mono text-accent text-[13px] leading-none select-none">▸</span>
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="investigate · query the snapshot · search MMSI / ICAO24 / callsign / lat,lon"
          aria-label="Command dock search"
          className="mono flex-1 bg-transparent text-[11px] text-txt-0 placeholder:text-txt-3 focus:outline-none"
        />
        <kbd className="mono text-[9px] tracking-[0.5px] text-txt-3 border border-line rounded-sm px-[6px] py-[2px] bg-bg-2 select-none">
          ⌘J
        </kbd>
      </div>
    </div>
  );
}
