import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useReducedMotion } from './useReducedMotion.js';
import { ErrorBoundary } from './ErrorBoundary.js';

// Generic tabbed-panel container — used by both rails (frontend.md §4).
// Tab strip (.tabs/.tab) follows the Cobalt/Ink mockup: a flex row on bg-1 with
// a line-2 bottom hairline; each tab is mono 10px, line-divided, ~30px tall. The
// active tab lifts to txt-0 on bg-2 with a flush 2px accent underline (an
// absolutely-positioned bar at bottom -1px spanning the tab). Inactive tabs sit
// at txt-3 and lift to txt-1 on hover.
//
// Motion: a subtle opacity fade animates panel swaps. Honors
// prefers-reduced-motion — when reduced, the swap is instant (no transition).

export interface TabDef {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
}

interface Props {
  tabs: readonly TabDef[];
  defaultTab?: string;
  ariaLabel?: string;
  // 'tabs' = the classic horizontal strip (good for ≤4 short tabs). 'menu' = a
  // single dropdown chooser that lists every panel by name — scales past the
  // ~6-tab point where the strip clips/horizontally scrolls (the right rail).
  variant?: 'tabs' | 'menu';
}

export function TabbedPanel({ tabs, defaultTab, ariaLabel, variant = 'tabs' }: Props): JSX.Element {
  const initial = defaultTab && tabs.some((t) => t.id === defaultTab) ? defaultTab : tabs[0]?.id ?? '';
  const [activeId, setActiveId] = useState<string>(initial);
  const [menuOpen, setMenuOpen] = useState(false);
  const reduced = useReducedMotion();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === active?.id),
  );

  // Roving tabIndex + keyboard navigation per WAI-ARIA tab pattern.
  const focusTabAt = (index: number) => {
    const len = tabs.length;
    if (len === 0) return;
    const wrapped = ((index % len) + len) % len;
    const next = tabs[wrapped];
    if (!next) return;
    setActiveId(next.id);
    // Defer focus to after state-driven render so the tab is the active one.
    requestAnimationFrame(() => {
      tabRefs.current[next.id]?.focus();
    });
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        focusTabAt(activeIndex + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusTabAt(activeIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusTabAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusTabAt(tabs.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="h-full flex flex-col" role="region" aria-label={ariaLabel ?? 'Tabbed panel'}>
      {variant === 'menu' ? (
        <MenuChooser
          tabs={tabs}
          active={active}
          open={menuOpen}
          setOpen={setMenuOpen}
          onPick={setActiveId}
          ariaLabel={ariaLabel}
        />
      ) : (
        <div
          role="tablist"
          aria-label={ariaLabel ?? 'Panel tabs'}
          // overflow-x-auto + hidden scrollbar: with 7 tabs the strip can exceed the
          // rail width, so it scrolls horizontally instead of CLIPPING the last tabs.
          className="flex items-stretch flex-none border-b border-line-2 bg-bg-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => {
            const isActive = t.id === active?.id;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`tabpanel-${t.id}`}
                id={`tab-${t.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={(e) => {
                  setActiveId(t.id);
                  // Bring a partially-offscreen tab fully into the scrollable strip.
                  e.currentTarget.scrollIntoView({ inline: 'nearest', block: 'nearest' });
                }}
                onKeyDown={onTabKeyDown}
                className={[
                  'relative mono text-[10px] tracking-[0.4px] px-2 py-[9px] border-r border-line',
                  'flex items-center gap-1.5 whitespace-nowrap',
                  isActive ? 'text-txt-0 bg-bg-2' : 'text-txt-3 hover:text-txt-1',
                ].join(' ')}
                style={reduced ? undefined : { transition: 'color 120ms ease, background-color 120ms ease' }}
              >
                {t.icon}
                <span>{t.label}</span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 right-0 bottom-[-1px] h-[2px] bg-accent"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
      {/* Render ALL tabpanels and hide inactive ones — preserves React state
        (scroll position, expand/collapse, filter chips) across tab switches.
        The `hidden` attribute + `aria-hidden` + tabIndex={-1} keep inactive
        panels out of the accessibility tree and the tab order without
        unmounting them. */}
      {tabs.map((t) => {
        const isActive = t.id === active?.id;
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={`tabpanel-${t.id}`}
            {...(variant === 'tabs' ? { 'aria-labelledby': `tab-${t.id}` } : {})}
            aria-hidden={!isActive}
            tabIndex={isActive ? 0 : -1}
            hidden={!isActive}
            className="flex-1 overflow-y-auto"
            style={reduced || !isActive ? undefined : { transition: 'opacity 120ms ease' }}
          >
            <ErrorBoundary label={t.label}>{t.content}</ErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}

// Dropdown panel chooser (the 'menu' variant). One trigger showing the current
// panel name; clicking opens a labelled list of every panel. Scales past the
// point where a horizontal tab strip clips — picking a panel is one click on a
// full-width, readable row instead of hunting in a scroll strip.
function MenuChooser({
  tabs,
  active,
  open,
  setOpen,
  onPick,
  ariaLabel,
}: {
  tabs: readonly TabDef[];
  active: TabDef | undefined;
  open: boolean;
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  onPick: (id: string) => void;
  ariaLabel?: string | undefined;
}): JSX.Element {
  return (
    <div className="relative flex-none border-b border-line-2 bg-bg-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? 'Choose panel'}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-bg-2 transition-colors"
      >
        {active?.icon && <span className="text-accent shrink-0">{active.icon}</span>}
        <span className="mono text-[10px] tracking-[0.7px] uppercase text-txt-2">Panel</span>
        <span className="mono text-[12px] tracking-[0.3px] text-txt-0 flex-1 truncate">
          {active?.label ?? '—'}
        </span>
        <span className="mono text-[10px] text-txt-2" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <>
          {/* click-away scrim */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <ul
            role="listbox"
            aria-label={ariaLabel ?? 'Panels'}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
            className="absolute left-0 right-0 top-full z-50 max-h-[60vh] overflow-y-auto border-b border-x border-line-2 bg-bg-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.8)]"
          >
            {tabs.map((t) => {
              const isActive = t.id === active?.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      onPick(t.id);
                      setOpen(false);
                    }}
                    className={[
                      'w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-l-2 transition-colors',
                      isActive
                        ? 'border-accent bg-accent-dim text-txt-0'
                        : 'border-transparent text-txt-1 hover:bg-bg-2 hover:text-txt-0',
                    ].join(' ')}
                  >
                    <span className="w-4 text-center shrink-0 text-accent">{t.icon ?? '▸'}</span>
                    <span className="mono text-[12px] tracking-[0.3px] flex-1 truncate">{t.label}</span>
                    {isActive && (
                      <span className="text-accent text-[10px]" aria-hidden="true">
                        ●
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
