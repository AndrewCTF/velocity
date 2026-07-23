import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, PanelRightOpen, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Icon, type IconName } from '../normal/Icon.js';
import { useFloatingPanels } from '../state/floatingPanels.js';
import { useSettings } from '../state/settings.js';
import { FloatingPanel } from './FloatingPanel.js';

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
  const expanded = useSettings((s) => s.leftRailExpanded);
  const setSetting = useSettings((s) => s.set);
  const floating = useFloatingPanels((s) => s.panels);
  const detach = useFloatingPanels((s) => s.detach);
  const redock = useFloatingPanels((s) => s.redock);
  // The docked flyout shows the open item ONLY when it isn't floating; a detached
  // panel lives in its own window instead (no content duplication).
  const active = items.find((i) => i.id === open && !floating[i.id]) ?? null;
  const primary = items.filter((i) => (i.group ?? 'primary') === 'primary');
  const more = items.filter((i) => i.group === 'more');
  const detachedItems = items.filter((i) => floating[i.id]);

  const btn = (it: RailItem): JSX.Element => {
    const isFloating = Boolean(floating[it.id]);
    const on = it.id === open && !isFloating;
    return (
      <button
        key={it.id}
        type="button"
        title={isFloating ? `${it.label} (floating; click to dock)` : it.label}
        aria-pressed={on}
        onClick={() => (isFloating ? (redock(it.id), setOpen(it.id)) : setOpen(on ? null : it.id))}
        className={`relative h-11 flex items-center shrink-0 transition-colors ${
          expanded ? 'w-full justify-start gap-2.5 px-3' : 'w-11 justify-center'
        } ${
          on ? 'text-accent bg-accent-dim' : isFloating ? 'text-accent/70 hover:text-accent' : 'text-txt-3 hover:text-txt-1 hover:bg-bg-2'
        }`}
      >
        <Icon name={it.icon} className="w-[18px] h-[18px] shrink-0" />
        {expanded && <span className="text-[12px] tracking-[0.2px] truncate">{it.label}</span>}
        {on && <span className="absolute left-0 top-1 bottom-1 w-[2px] bg-accent rounded-r-sm" />}
        {isFloating && <span className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-accent" />}
        {it.badge != null && it.badge > 0 && (
          <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-[3px] rounded-sm bg-alert text-white text-[10px] leading-[14px] text-center font-semibold">
            {it.badge > 99 ? '99+' : it.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="relative h-full" role="toolbar" aria-label={ariaLabel}>
      {/* 44px icon column (in flow). Scrolls internally when the item list is
          taller than the viewport (short screens) so no icon is clipped. */}
      <div
        className={`${expanded ? 'w-44' : 'w-11'} h-full min-h-0 overflow-y-auto overflow-x-hidden flex flex-col ${
          expanded ? 'items-stretch' : 'items-center'
        } bg-[var(--panel-bg)] py-1`}
      >
        {primary.map(btn)}
        {more.length > 0 && <div className={`my-1 h-px ${expanded ? 'w-full' : 'w-6'} bg-line-2`} />}
        {more.map(btn)}
        {/* Expand/collapse: show or hide the text labels. Persisted in settings. */}
        <button
          type="button"
          onClick={() => setSetting('leftRailExpanded', !expanded)}
          title={expanded ? 'Collapse toolbar' : 'Expand toolbar (show labels)'}
          aria-label={expanded ? 'Collapse toolbar' : 'Expand toolbar'}
          className={`relative mt-auto h-9 flex items-center shrink-0 text-txt-3 hover:text-txt-1 hover:bg-bg-2 transition-colors ${
            expanded ? 'w-full justify-start gap-2.5 px-3' : 'w-11 justify-center'
          }`}
        >
          {expanded ? (
            <ChevronsLeft size={18} strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronsRight size={18} strokeWidth={1.75} aria-hidden />
          )}
          {expanded && <span className="text-[12px]">Collapse</span>}
        </button>
      </div>
      {/* flyout floats over the map to the right of the rail (design §6.1) */}
      {active && (
        <div
          className="absolute left-full top-0 h-full w-[300px] bg-[var(--panel-bg)] border-r border-line-2 flex flex-col z-[var(--z-rail)] shadow-[6px_0_22px_-12px_rgba(0,0,0,0.6)]"
        >
          <div className="flex items-center justify-between px-3 h-8 shrink-0 border-b border-line-2">
            <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-0 flex items-center gap-1.5">
              <Icon name={active.icon} className="w-3.5 h-3.5" />
              {active.label}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => {
                  detach(active.id);
                  setOpen(null);
                }}
                aria-label="Detach panel into a floating window"
                title="Detach into a movable window"
                className="text-txt-3 hover:text-accent px-1 flex items-center"
              >
                <PanelRightOpen size={13} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setOpen(null)}
                aria-label="Close panel"
                title="Close"
                className="text-txt-3 hover:text-txt-0 text-[13px] leading-none px-1 flex items-center"
              >
                <X size={13} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">{active.content}</div>
        </div>
      )}

      {/* Detached flyouts float free over the globe as draggable windows —
          portalled to <body> so the rail's z-100 stacking context can't trap or
          clip them. They own the same content node the docked flyout would. */}
      {detachedItems.length > 0 &&
        createPortal(
          <>
            {detachedItems.map((it) => (
              <FloatingPanel key={it.id} id={it.id} title={it.label} icon={it.icon} onClose={() => redock(it.id)}>
                {it.content}
              </FloatingPanel>
            ))}
          </>,
          document.body,
        )}
    </div>
  );
}
