import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useReducedMotion } from './useReducedMotion.js';

// Generic tabbed-panel container — used by both rails (frontend.md §4).
// The tab strip is mono 10px (matches .micro), 28px tall, with the active tab
// underlined in accent. Hover affordance is a soft text lift.
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
        className="flex items-stretch border-b border-line bg-bg-2/60"
        style={{ height: 28, minHeight: 28 }}
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
              onClick={() => setActiveId(t.id)}
              onKeyDown={onTabKeyDown}
              className={[
                'micro px-3 flex items-center gap-1.5 border-b-2 -mb-px',
                isActive
                  ? 'border-accent text-accent'
                  : 'border-transparent text-txt-2 hover:text-txt-0',
              ].join(' ')}
              style={reduced ? undefined : { transition: 'color 120ms ease, border-color 120ms ease' }}
            >
              {t.icon}
              <span>{t.label}</span>
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
            {t.content}
          </div>
        );
      })}
    </div>
  );
}
