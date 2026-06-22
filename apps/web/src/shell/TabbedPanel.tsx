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
}

export function TabbedPanel({ tabs, defaultTab, ariaLabel }: Props): JSX.Element {
  const initial = defaultTab && tabs.some((t) => t.id === defaultTab) ? defaultTab : tabs[0]?.id ?? '';
  const [activeId, setActiveId] = useState<string>(initial);
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
            aria-labelledby={`tab-${t.id}`}
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
