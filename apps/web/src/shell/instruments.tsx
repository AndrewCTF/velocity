// Instrument primitives — the shared vocabulary of the "Cobalt/Ink" console.
// Every rail/panel composes these so the dense, instrument-grade look stays
// pixel-consistent across components. Faithful port of the mockup's component
// CSS (tmp/mock.css, tmp/power.css) onto our design tokens, expressed in
// Tailwind so the codebase stays utility-first (no global semantic CSS).
//
// Measurements mirror the mockup exactly. Colours come from tokens.css.

import type { CSSProperties, ReactNode } from 'react';

// ── section divider label (.seclbl) ────────────────────────────────────────
// Mono 9px uppercase title, a hairline that fills the row, optional count.
export function SectionLabel({
  title,
  count,
  className = '',
  style,
}: {
  title: string;
  count?: string | number;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-2 ${className}`} style={style}>
      <span className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">{title}</span>
      {count !== undefined && count !== '' && (
        <span className="mono text-[11px] text-txt-3 tabular-nums">{count}</span>
      )}
    </div>
  );
}

// ── micro caps label (.lbl) ─────────────────────────────────────────────────
export function MicroLabel({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <span className={`text-[10px] font-medium tracking-[0.08em] uppercase text-txt-3 ${className}`}>{children}</span>
  );
}

// ── toggle switch (.tg) ─────────────────────────────────────────────────────
// 22×12 hard-cornered switch; knob slides left→right; accent when on.
export function Toggle({
  on,
  onChange,
  label,
  className = '',
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={[
        'relative w-[22px] h-[12px] rounded-sm border transition-colors shrink-0',
        on ? 'bg-accent-dim border-accent-line' : 'bg-bg-3 border-line',
        className,
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-px h-[8px] w-[8px] transition-all',
          on ? 'left-[11px] bg-accent' : 'left-px bg-txt-3',
        ].join(' ')}
      />
    </button>
  );
}

// ── thin progress / density meter (.bar) ────────────────────────────────────
export function MeterBar({
  pct,
  tone = 'accent',
  className = '',
}: {
  pct: number;
  tone?: 'accent' | 'alert' | 'warn' | 'ok';
  className?: string;
}): JSX.Element {
  const fill =
    tone === 'alert'
      ? 'var(--alert)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'ok'
          ? 'var(--ok)'
          : 'var(--accent-line)';
  return (
    <span className={`relative block h-[3px] bg-bg-3 rounded-sm overflow-hidden ${className}`}>
      <span
        className="absolute left-0 top-0 bottom-0 rounded-sm"
        style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: fill }}
      />
    </span>
  );
}

// ── score bar (.score) — inline, fixed 34px, alert-red fill ─────────────────
export function ScoreBar({ pct }: { pct: number }): JSX.Element {
  return (
    <span className="relative inline-block w-[34px] h-[4px] bg-bg-3 rounded-sm align-middle overflow-hidden">
      <span
        className="absolute left-0 top-0 bottom-0 bg-alert rounded-sm"
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </span>
  );
}

// ── status badge (.badge) ───────────────────────────────────────────────────
export type BadgeTone = 'alert' | 'warn' | 'accent' | 'mag' | 'ok' | 'neutral';
const BADGE_TONE: Record<BadgeTone, string> = {
  alert: 'text-[#ffc9c5] bg-alert-bg border border-[rgba(255,90,82,0.38)]',
  warn: 'text-[#fcd9a0] bg-warn-bg border border-[rgba(245,165,36,0.38)]',
  accent: 'text-[#9cc2ff] bg-accent-dim border border-accent-line',
  mag: 'text-[#f0a8f8] bg-mag-dim border border-mag-line',
  ok: 'text-ok bg-[rgba(54,211,153,0.1)] border border-[rgba(54,211,153,0.32)]',
  neutral: 'text-txt-3 border border-line',
};
export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`mono text-[8.5px] tracking-[0.6px] uppercase px-[7px] py-[3px] rounded-sm whitespace-nowrap ${BADGE_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

// ── key/value grid (.kv) ────────────────────────────────────────────────────
export function KV({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div
      className={`grid items-baseline gap-x-3 gap-y-[5px] text-[10.5px] ${className}`}
      style={{ gridTemplateColumns: 'auto 1fr' }}
    >
      {children}
    </div>
  );
}
export function KVRow({ k, v, warn = false }: { k: string; v: ReactNode; warn?: boolean }): JSX.Element {
  return (
    <>
      <span className="mono text-[9px] tracking-[0.4px] uppercase text-txt-3">{k}</span>
      <span className={`mono text-right ${warn ? 'text-[#ffb3ae]' : 'text-txt-1'}`}>{v}</span>
    </>
  );
}

// ── action button (.btn) ────────────────────────────────────────────────────
export function Btn({
  children,
  onClick,
  tone = 'neutral',
  size = 'md',
  disabled = false,
  title,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'neutral' | 'accent';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'mono tracking-[0.3px] rounded-sm border transition-colors disabled:opacity-40',
        size === 'sm' ? 'text-[9px] px-2 py-1' : 'text-[10px] px-[10px] py-[6px]',
        tone === 'accent'
          ? 'border-accent-line bg-accent-dim text-[#9cc2ff] hover:text-accent'
          : 'border-line-2 bg-bg-2 text-txt-1 hover:border-accent-line',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// ── correlation / threat hero (.hero) ───────────────────────────────────────
// Left accent bar + tinted gradient. tone drives the colour family.
export function Hero({
  tone = 'alert',
  title,
  children,
  className = '',
}: {
  tone?: 'alert' | 'warn';
  title: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const c =
    tone === 'warn'
      ? { border: 'rgba(245,165,36,0.32)', g0: 'rgba(245,165,36,0.06)', bar: 'var(--warn)', t: '#fcd9a0' }
      : { border: 'rgba(255,90,82,0.32)', g0: 'rgba(255,90,82,0.06)', bar: 'var(--alert)', t: '#ffb3ae' };
  return (
    <div
      className={`relative rounded-sm overflow-hidden ${className}`}
      style={{
        border: `1px solid ${c.border}`,
        background: `linear-gradient(180deg, ${c.g0}, transparent)`,
        padding: '11px 12px 12px 14px',
      }}
    >
      <span className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: c.bar }} />
      <div className="flex items-center gap-2 mb-2">
        <span className="mono text-[9px] tracking-[0.8px] uppercase" style={{ color: c.t }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

// ── COV widget (.widget) — titled, bordered, elevated section ────────────────
// Gotham "Custom Object View" idiom: each dossier fact is its own stacked
// widget with an elevation border. `elevation` mirrors Gotham's section border
// styles (bordered / outer drop shadow / inner shadow).
export function Widget({
  title,
  count,
  elevation = 'raised',
  action,
  children,
  className = '',
}: {
  title?: string;
  count?: string | number;
  elevation?: 'flat' | 'raised' | 'inset';
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const shadow =
    elevation === 'raised'
      ? '0 1px 0 rgba(0,0,0,0.35), 0 6px 16px -10px rgba(0,0,0,0.7)'
      : elevation === 'inset'
        ? 'inset 0 1px 3px rgba(0,0,0,0.45)'
        : 'none';
  return (
    <section
      className={`rounded-md border border-line bg-bg-1/70 p-2.5 ${className}`}
      style={{ boxShadow: shadow }}
    >
      {title && (
        <div className="flex items-center gap-2">
          <SectionLabel title={title} {...(count !== undefined ? { count } : {})} className="flex-1" />
          {action}
        </div>
      )}
      <div className={title ? 'mt-1.5' : ''}>{children}</div>
    </section>
  );
}

// ── icon tile (.selhead .ico) — 34×34 framed glyph ──────────────────────────
export function IconTile({ children, color }: { children: ReactNode; color?: string }): JSX.Element {
  return (
    <div
      className="w-[34px] h-[34px] border border-line-2 bg-bg-2 flex items-center justify-center text-[15px] rounded-sm shrink-0"
      style={color ? { color } : undefined}
    >
      {children}
    </div>
  );
}

// ── status dot ──────────────────────────────────────────────────────────────
export function StatusDot({ tone, className = '' }: { tone: string; className?: string }): JSX.Element {
  const bg =
    tone === 'green' || tone === 'ok'
      ? 'bg-ok'
      : tone === 'amber' || tone === 'warn'
        ? 'bg-warn'
        : tone === 'red' || tone === 'alert'
          ? 'bg-alert'
          : 'bg-txt-4';
  return <span className={`inline-block h-[6px] w-[6px] rounded-full ${bg} ${className}`} />;
}

// ── brand mark (.brand) — diamond + wordmark ────────────────────────────────
export function Brand({ name = 'VELOCITY', version }: { name?: string; version?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 mono font-semibold tracking-[1.5px] text-[12px] text-txt-0">
      <span className="w-2 h-2 bg-accent rotate-45 shrink-0" />
      {name}
      {version && <span className="font-normal tracking-[0.5px] text-[9px] text-txt-3">{version}</span>}
    </div>
  );
}

// ── classification caveat strip (.caveat) ────────────────────────────────────
// Dense uppercase mono strip for classification markings (e.g. "UNCLAS//FOUO",
// "NOTIONAL // SIMULATED"). Rendered as a hairline-bordered pill — always tiny,
// never decorative. tone drives the colour family; neutral is default (most data
// is unclassified); warn = exercise/notional; alert = handling warning.
const CAVEAT_TONE: Record<'neutral' | 'warn' | 'alert', string> = {
  neutral: 'text-txt-2 border-line-2',
  warn:    'text-[#fcd9a0] border-[rgba(245,165,36,0.38)] bg-warn-bg',
  alert:   'text-[#ffc9c5] border-[rgba(255,90,82,0.38)] bg-alert-bg',
};
export function Caveat({
  level = 'UNCLAS//FOUO',
  note,
  tone = 'neutral',
}: {
  level?: string;
  note?: string;
  tone?: 'neutral' | 'warn' | 'alert';
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-[5px] mono text-[8px] tracking-[0.7px] uppercase px-[6px] py-[2px] rounded-sm border whitespace-nowrap ${CAVEAT_TONE[tone]}`}
    >
      {level}
      {note && (
        <>
          <span className="opacity-40">·</span>
          <span className="opacity-70">{note}</span>
        </>
      )}
    </span>
  );
}
