import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';
import { useFeeds, useAlerts, useImagery, useConnection, type WsStatus } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { AoiSelector } from './AoiSelector.js';
import { SearchField } from './SearchField.js';
import { flyToChokepoint, flyToGlobal } from '../globe/camera.js';
import type { Chokepoint } from '../registry/chokepoints.js';

interface Props {
  viewer: Cesium.Viewer | null;
  classification?: string;
  /** Cesium ion token from runtime config — empty string disables the 3D-sat toggle. */
  ionToken?: string;
  onOpenAlerts?: () => void;
}

const STATUS_DOT: Record<string, string> = {
  green: 'bg-ok',
  amber: 'bg-warn',
  red: 'bg-alert',
  unknown: 'bg-txt-4',
};

export function CommandBar({
  viewer,
  classification = 'UNCLAS',
  ionToken = '',
  onOpenAlerts,
}: Props): JSX.Element {
  const feeds = useFeeds((s) => s.feeds);
  const feedList = Object.values(feeds);
  const setActiveAoi = useAoi((s) => s.setActive);
  const imageryMode = useImagery((s) => s.mode);
  const setImageryMode = useImagery((s) => s.setMode);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const onPickAoi = (c: Chokepoint | null) => {
    setActiveAoi(c);
    if (!viewer) return;
    if (c) flyToChokepoint(viewer, c);
    else flyToGlobal(viewer);
  };

  return (
    <div className="flex h-full items-center gap-3 px-3">
      <SearchField viewer={viewer} />
      <AoiSelector onPick={onPickAoi} />

      {/* 3D satellite imagery + buildings toggle. Off by default; ion token gated. */}
      <ImageryToggle
        mode={imageryMode}
        onToggle={() => setImageryMode(imageryMode === '3d-sat' ? '2d-dark' : '3d-sat')}
        disabled={!ionToken}
      />

      {/* alert ticker — top alert in newest-first buffer; click opens panel */}
      <AlertTicker {...(onOpenAlerts ? { onOpen: onOpenAlerts } : {})} />

      {/* WS connection state — live/down pill so silence is unambiguous */}
      <WsPill />

      {/* UTC clock — operator orientation */}
      <div className="mono text-[11px] text-txt-2" title="UTC">
        {now.toISOString().slice(11, 19)}Z
      </div>

      {/* classification banner */}
      <div className="mono text-[10px] tracking-[0.5px] uppercase px-2 py-0.5 border border-line rounded-sm text-txt-1">
        {classification}
      </div>

      {/* feed-health cluster */}
      <div className="flex items-center gap-2" role="status" aria-label="Feed health">
        {feedList.length === 0 && <span className="micro">no feeds</span>}
        {feedList.map((f) => (
          <span
            key={f.id}
            className="flex items-center gap-1 micro"
            title={`${f.label}\nstatus: ${f.status}${f.lastSeen ? `\nlast: ${new Date(f.lastSeen).toISOString().slice(11, 19)}Z` : ''}`}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[f.status] ?? 'bg-txt-4'}`} />
            <span className="hidden xl:inline text-txt-2">{shortLabel(f.label)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function shortLabel(s: string): string {
  return s.split(' ')[0] ?? s;
}

// "low" severity uses --sev-low (≡ txt-1) so it doesn't collide with the
// teal selection accent. See tokens.css.
const SEV_COLOR: Record<string, string> = {
  info: 'text-txt-2',
  low: 'text-[var(--sev-low)]',
  medium: 'text-warn',
  high: 'text-alert',
  critical: 'text-alert',
};

/**
 * Compact mono pill that flips Cesium between the dark 2D basemap and the
 * Cesium World Imagery + 3D buildings stack. Disabled (with a hint tooltip)
 * when no ion token is configured.
 */
function ImageryToggle({
  mode,
  onToggle,
  disabled,
}: {
  mode: '2d-dark' | '3d-sat';
  onToggle: () => void;
  disabled: boolean;
}): JSX.Element {
  const on = mode === '3d-sat';
  const title = disabled
    ? 'Set CESIUM_ION_TOKEN to enable'
    : 'Enable Cesium World Imagery + 3D buildings (requires CESIUM_ION_TOKEN)';
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={title}
      aria-pressed={on}
      aria-label="Toggle 3D satellite imagery and buildings"
      data-testid="imagery-toggle"
      className={[
        'mono text-[10px] tracking-[0.5px] uppercase px-2 py-0.5 border rounded-sm transition-colors',
        on
          ? 'border-accent-line text-accent bg-accent-dim'
          : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1',
        disabled ? 'opacity-40 cursor-not-allowed hover:border-line hover:text-txt-2' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span aria-hidden="true">{on ? '●' : '🛰'}</span>
      <span className="ml-1">3D sat</span>
    </button>
  );
}

/**
 * Compact mono pill that reflects the /ws/alerts socket state. Operators
 * need to distinguish "no alerts firing" (live + quiet) from "we lost the
 * stream" (down). Reads from useConnection, written by AlertSubscriber.
 */
function WsPill(): JSX.Element {
  const ws = useConnection((s) => s.ws);
  const label = wsLabel(ws);
  const cls = wsClass(ws);
  const title =
    ws === 'open'
      ? 'WebSocket connection to /ws/alerts is live'
      : ws === 'connecting'
        ? 'Connecting to /ws/alerts…'
        : 'WebSocket to /ws/alerts is down — alerts may be stale';
  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      data-testid="ws-pill"
      data-ws={ws}
      className={`mono text-[10px] tracking-[0.5px] uppercase px-2 py-0.5 border rounded-sm ${cls}`}
    >
      <span aria-hidden="true" className="mr-1">·</span>WS · {label}
    </span>
  );
}

function wsLabel(s: WsStatus): string {
  switch (s) {
    case 'open':
      return 'live';
    case 'connecting':
      return '…';
    case 'closed':
      return 'down';
  }
}

function wsClass(s: WsStatus): string {
  switch (s) {
    case 'open':
      return 'border-line text-ok';
    case 'connecting':
      return 'border-line text-txt-2';
    case 'closed':
      return 'border-alert/40 text-alert';
  }
}

function AlertTicker({ onOpen }: { onOpen?: () => void }): JSX.Element {
  const alerts = useAlerts((s) => s.alerts);
  const total = alerts.length;
  const top = alerts[0];
  const label = (
    <>
      <span className="micro">alerts</span>
      <span className="mono text-[10px] text-txt-3 tabular-nums">{total}</span>
      {top ? (
        <span className={`mono text-[11px] truncate ${SEV_COLOR[top.severity] ?? 'text-txt-1'}`}>
          ▸ [{top.severity}] {top.message}
        </span>
      ) : (
        <span className="ml-1 text-txt-2 mono text-[11px]">— quiet</span>
      )}
    </>
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex-1 flex items-center gap-2 truncate text-left hover:text-accent focus:outline-none"
      aria-live="polite"
      aria-label={total > 0 ? `Open alerts panel (${total} alerts)` : 'Open alerts panel'}
      title="Open alerts panel (press A)"
    >
      {label}
    </button>
  );
}
