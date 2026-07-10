// Foundry UI vocabulary — a small, consistent set of Workshop-style building
// blocks composed from the shared Cobalt/Ink instrument primitives
// (shell/instruments) and design tokens (theme/tokens.css). Every Foundry view
// draws from THIS module so the surface reads as one dense data-engineering
// workspace: the same header rhythm, the same controls, the same health
// language, in both light and dark themes. No hardcoded hex — tokens only.

import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import { Badge, type BadgeTone } from '../shell/instruments.js';
import type { Build } from '../state/foundry.js';

// ── view header ───────────────────────────────────────────────────────────
// The one chrome every view opens with: an accent tick + title eyebrow, an
// optional subtitle, right-aligned primary actions, and a hairline baseline.
export function ViewHeader({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode | undefined;
  meta?: ReactNode | undefined;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line-2 pb-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="h-3 w-[3px] rounded-sm bg-accent shrink-0" />
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-txt-0">{title}</h2>
        </div>
        {subtitle && <p className="mt-1 pl-[11px] text-[11px] text-txt-2">{subtitle}</p>}
        {meta && <div className="mt-1.5 pl-[11px] flex flex-wrap items-center gap-x-4 gap-y-1">{meta}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// A labelled meta figure for the header ribbon (e.g. "5 datasets", "914 rows").
export function MetaStat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'alert' | 'ok' }): JSX.Element {
  const c = tone === 'alert' ? 'text-alert' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-txt-0';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`mono text-[12px] tabular-nums ${c}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-[0.4px] text-txt-3">{label}</span>
    </span>
  );
}

// ── KPI tile ────────────────────────────────────────────────────────────────
// A large tabular number over a caps label, with an optional status sub-line
// that tints (amber/red) when something needs attention. A left accent hairline
// keys the tile to its status.
export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'alert';
  onClick?: () => void;
}): JSX.Element {
  const edge =
    tone === 'alert' ? 'before:bg-alert' : tone === 'warn' ? 'before:bg-warn' : tone === 'ok' ? 'before:bg-ok' : 'before:bg-line-2';
  const subCls = tone === 'alert' ? 'text-alert' : tone === 'warn' ? 'text-warn' : 'text-txt-3';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={[
        'relative text-left rounded-md border border-line-2 bg-bg-1 pl-4 pr-3 py-3 overflow-hidden transition-colors',
        'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px]',
        edge,
        onClick ? 'hover:border-accent-line hover:bg-bg-2 cursor-pointer' : 'cursor-default',
      ].join(' ')}
    >
      <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3">{label}</div>
      <div className="mono text-[24px] leading-none text-txt-0 tabular-nums mt-1.5">{value}</div>
      {sub && <div className={`text-[10px] mt-1 ${subCls}`}>{sub}</div>}
    </button>
  );
}

// ── form controls ────────────────────────────────────────────────────────────
export const controlCls =
  'bg-bg-0 border border-line rounded-sm px-2 py-[5px] text-[11px] text-txt-0 mono w-full outline-none focus:border-accent-line transition-colors placeholder:text-txt-4';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-[0.4px] text-txt-3">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-txt-4">{hint}</span>}
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  className?: string;
}): JSX.Element {
  return (
    <select value={value} onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)} className={`${controlCls} ${className}`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── segmented tabs ────────────────────────────────────────────────────────────
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number | undefined }>;
  active: T;
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-0.5 border-b border-line-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={[
            'relative px-2.5 py-1.5 text-[11px] tracking-[0.02em] -mb-px border-b-2 transition-colors',
            active === t.id ? 'border-accent text-txt-0' : 'border-transparent text-txt-2 hover:text-txt-0',
          ].join(' ')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 mono text-[10px] text-txt-3 tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ── schema type chip ──────────────────────────────────────────────────────────
// A compact type marker; numeric types read accent-blue, text neutral, bool
// magenta — a stable visual key so a schema scans at a glance.
const TYPE_TONE: Record<string, BadgeTone> = { int: 'accent', float: 'accent', bool: 'mag', str: 'neutral' };
export function TypeChip({ type }: { type: string }): JSX.Element {
  return <Badge tone={TYPE_TONE[type] ?? 'neutral'}>{type}</Badge>;
}

// ── empty / call-to-action state ─────────────────────────────────────────────
export function EmptyState({ icon, title, hint, action }: { icon?: string; title: string; hint?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-2 bg-bg-1/50 px-6 py-10 text-center">
      {icon && <div aria-hidden className="text-[22px] text-txt-4">{icon}</div>}
      <div className="text-[12px] text-txt-1">{title}</div>
      {hint && <div className="text-[11px] text-txt-3 max-w-[380px]">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ── build-log viewer ──────────────────────────────────────────────────────────
// Monospace log with a line-number gutter; lines that read as errors are tinted.
export function LogView({ lines, className = '' }: { lines: string[]; className?: string }): JSX.Element {
  if (lines.length === 0) return <div className="text-[10px] text-txt-3">No log output.</div>;
  return (
    <div className={`rounded-sm border border-line bg-bg-0 overflow-auto ${className}`}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => {
            const err = /error|fail|exceed|reject/i.test(line);
            return (
              <tr key={i}>
                <td className="select-none text-right align-top pr-2 pl-2 py-[1px] mono text-[10px] text-txt-4 tabular-nums w-[1%] whitespace-nowrap border-r border-line">
                  {i + 1}
                </td>
                <td className={`pl-2 pr-2 py-[1px] mono text-[10.5px] whitespace-pre-wrap ${err ? 'text-[#ffb3ae]' : 'text-txt-2'}`}>
                  {line}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── data table shell ──────────────────────────────────────────────────────────
// Consistent dense table chrome: sticky caps header, hairline rows, hover.
export function Th({ children, align = 'left', className = '' }: { children?: ReactNode; align?: 'left' | 'right' | 'center'; className?: string }): JSX.Element {
  const a = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th className={`${a} font-medium px-2.5 py-1.5 sticky top-0 bg-bg-2 z-[1] ${className}`}>{children}</th>
  );
}

export function tableHeadCls(): string {
  return 'text-txt-3 mono text-[10px] uppercase tracking-[0.4px]';
}

export const rowCls = 'border-t border-line hover:bg-bg-2 transition-colors';
export const cellMono = 'px-2.5 py-1.5 mono text-[11px] text-txt-1 tabular-nums';

// small helper: format an ISO stamp compactly (date + HH:MM), tokenized styling
export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

// severity → BadgeTone helper reused across views
export const statusTone: Record<string, BadgeTone> = {
  succeeded: 'ok',
  running: 'accent',
  failed: 'alert',
};

// Build duration from started_at/finished_at stamps (moved here so Home + Builds
// share one implementation).
export function durationOf(b: Build): string {
  if (!b.finished_at) return '—';
  const ms = new Date(b.finished_at).getTime() - new Date(b.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Humanize a schedule interval in seconds: 3600 → "1 h", 90 → "1m 30s".
export function fmtInterval(s: number | null | undefined): string {
  if (!s || s < 1) return '—';
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec && !h) parts.push(`${sec}s`);
  return parts.join(' ') || `${h}h`;
}

// A row of label+count filter chips (all / succeeded / failed / …). `value` is
// the active key; count 0 still renders but is dimmed so the operator sees the
// dimension even when empty.
export function FilterChips<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ key: T; label: string; count?: number; tone?: BadgeTone }>;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {options.map((o) => {
        const on = o.key === value;
        const empty = o.count != null && o.count === 0;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={[
              'mono text-[10px] uppercase tracking-[0.4px] px-2 py-1 rounded-sm border transition-colors',
              on
                ? 'border-accent-line bg-accent-dim text-[#9cc2ff]'
                : empty
                  ? 'border-line text-txt-4'
                  : 'border-line-2 text-txt-2 hover:border-accent-line hover:text-txt-0',
            ].join(' ')}
          >
            {o.label}
            {o.count != null && (
              <span className={`ml-1.5 tabular-nums ${on ? 'text-[#9cc2ff]' : 'text-txt-4'}`}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type { CSSProperties };
