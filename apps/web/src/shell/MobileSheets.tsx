import { X } from "lucide-react";
import type { TabDef } from "./TabbedPanel.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

// The phone's panel chooser and the sheet a chosen panel opens in, lifted out of
// ConsoleShell so the console's phone layout (Console.tsx) and the 2D map's
// (ConsoleShell, via App2D) are one piece of chrome rather than two that drift.
//
// Both ask the same question of a 412px screen: nothing fits beside the map, so
// the map stays whole and a panel is a sheet laid over it. The caller owns the
// state (which panel, whether the chooser is up) because each has its own
// trigger: ConsoleShell floats a button over the map, Console puts one in its
// nav bar, and the console opens the Selection sheet by itself when a contact is
// picked. Rendered exclusively with the desktop rails (never alongside them), so
// a panel still mounts once.
//
// Sizes are px on purpose. The root font is 13px, so a rem class like `h-11`
// lands at 36px and quietly misses the 44px touch target.

export interface SheetPanel extends TabDef {
  /** Rises from the bottom over part of the map instead of covering all of it,
   *  so the contact it describes stays in view above it. */
  bottom?: boolean;
}

/** The sheet's title row. Exported because the console's Time sheet is the dock
 *  itself, restyled in place (it has to stay mounted), and wears the same bar. */
export function SheetHeader({
  label,
  onClose,
}: {
  label: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="flex h-[44px] flex-none items-center justify-between border-b border-line-2 px-3">
      <span className="mono text-[12px] text-txt-0">{label}</span>
      <button
        type="button"
        onClick={onClose}
        className="mono flex min-h-[44px] items-center gap-1 px-2 text-[12px] text-txt-2"
        aria-label={`Close ${label}`}
      >
        <X size={13} strokeWidth={1.75} aria-hidden /> Close
      </button>
    </div>
  );
}

export function MobileSheets({
  panels,
  activeId,
  onActive,
  menuOpen,
  onMenuOpen,
}: {
  panels: readonly SheetPanel[];
  activeId: string | null;
  onActive: (id: string | null) => void;
  menuOpen: boolean;
  onMenuOpen: (open: boolean) => void;
}): JSX.Element {
  const active = panels.find((p) => p.id === activeId) ?? null;
  return (
    <>
      {/* active panel, over the map. --z-overlay clears the furniture that
          floats at --z-dock and sits with the full-surface apps. */}
      {active && (
        <div
          role="region"
          aria-label={active.label}
          className={`absolute z-(--z-overlay) flex flex-col bg-(--panel-bg) ${
            active.bottom
              ? "inset-x-0 bottom-0 max-h-[65%] rounded-t-xl border-t border-line-2 shadow-(--sh-pop)"
              : "inset-0"
          }`}
        >
          <SheetHeader label={active.label} onClose={() => onActive(null)} />
          <div className="flex-1 overflow-y-auto">
            <ErrorBoundary label={active.label}>{active.content}</ErrorBoundary>
          </div>
        </div>
      )}

      {/* panel chooser sheet */}
      {menuOpen && !active && (
        <div className="absolute inset-0 z-(--z-overlay)">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => onMenuOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[80%] overflow-y-auto rounded-t-2xl border-t border-line-2 bg-(--panel-bg) p-2">
            <div className="mono px-2 pb-1 pt-2 text-[11px] text-txt-2">
              PANELS
            </div>
            <nav
              aria-label="Panels"
              data-primary-nav
              className="grid grid-cols-2 gap-2 p-1"
            >
              {panels.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onActive(p.id);
                    onMenuOpen(false);
                  }}
                  className="mono flex min-h-[44px] items-center gap-2 rounded-md border border-line-2 px-3 py-3 text-left text-[12px] text-txt-0 hover:border-accent-line"
                >
                  {p.icon}
                  <span>{p.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
