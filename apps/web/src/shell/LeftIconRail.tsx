import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../normal/Icon.js';

// Left icon rail (design §6.1 grammar #3/#4). A 44px column of icons; clicking one
// opens its flyout (a single ~300px panel over the map). One flyout at a time; the
// map never shrinks below ~70%. Replaces the old hidden "Panel ▾" dropdown chooser
// — every affordance is now a visible icon.
//
// ponytail: generic (items in, one flyout out), mirroring TabbedPanel. App.tsx wires
// the actual panels. Group separators via `group: 'primary' | 'more'`.

export interface RailItem {
  id: string;
  icon: IconName;
  label: string;
  content: ReactNode;
  group?: 'primary' | 'more';
  /** Optional live badge count (e.g. unread inbox). */
  badge?: number;
}

export function LeftIconRail({
  items,
  defaultOpen = null,
  ariaLabel = 'Tools',
}: {
  items: RailItem[];
  defaultOpen?: string | null;
  ariaLabel?: string;
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(defaultOpen);
  const active = items.find((i) => i.id === open) ?? null;
  const primary = items.filter((i) => (i.group ?? 'primary') === 'primary');
  const more = items.filter((i) => i.group === 'more');

  const btn = (it: RailItem): JSX.Element => {
    const on = it.id === open;
    return (
      <button
        key={it.id}
        type="button"
        title={it.label}
        aria-pressed={on}
        onClick={() => setOpen(on ? null : it.id)}
        className={`relative w-11 h-11 flex items-center justify-center shrink-0 transition-colors ${
          on ? 'text-accent bg-accent-dim' : 'text-txt-3 hover:text-txt-1 hover:bg-bg-2'
        }`}
      >
        <Icon name={it.icon} className="w-[18px] h-[18px]" />
        {on && <span className="absolute left-0 top-1 bottom-1 w-[2px] bg-accent rounded-r-sm" />}
        {it.badge != null && it.badge > 0 && (
          <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-[3px] rounded-full bg-alert text-white text-[10px] leading-[14px] text-center font-semibold">
            {it.badge > 99 ? '99+' : it.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="relative h-full" role="toolbar" aria-label={ariaLabel}>
      {/* 44px icon column (in flow) */}
      <div className="w-11 h-full flex flex-col items-center bg-bg-1 py-1">
        {primary.map(btn)}
        {more.length > 0 && <div className="my-1 h-px w-6 bg-line-2" />}
        {more.map(btn)}
      </div>
      {/* flyout floats over the map to the right of the rail (design §6.1) */}
      {active && (
        <div
          className="absolute left-full top-0 h-full w-[300px] bg-bg-1 border-l border-r border-line-2 flex flex-col z-[var(--z-rail)] shadow-[6px_0_22px_-12px_rgba(0,0,0,0.6)]"
        >
          <div className="flex items-center justify-between px-3 h-8 shrink-0 border-b border-line-2">
            <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-1 flex items-center gap-1.5">
              <Icon name={active.icon} className="w-3.5 h-3.5" />
              {active.label}
            </span>
            <button
              type="button"
              onClick={() => setOpen(null)}
              aria-label="Close panel"
              className="text-txt-3 hover:text-txt-0 text-[13px] leading-none px-1"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">{active.content}</div>
        </div>
      )}
    </div>
  );
}
