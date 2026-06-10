import type { ReactNode } from 'react';

// Five-zone layout from frontend.md §4.
//   ┌─ top: 44px command bar ──────────────────────────────────┐
//   │                                                          │
//   │ left  │           globe (truth surface)        │  right  │
//   │ 300px │       never covered by chrome          │  340px  │
//   │                                                          │
//   ├─ bottom: timeline ───────────────────────────────────────┤
//   └──────────────────────────────────────────────────────────┘
// Rails are absolute over the globe and translucent. Depth comes from
// border-opacity + a faint top-edge highlight (frontend.md §2 — no shadows).

interface Props {
  top: ReactNode;
  left: ReactNode;
  globe: ReactNode;
  right: ReactNode;
  bottom: ReactNode;
}

export function ConsoleShell({ top, left, globe, right, bottom }: Props): JSX.Element {
  return (
    <div
      className="h-screen w-screen overflow-hidden bg-bg-0 text-txt-0 grid"
      style={{ gridTemplateRows: '46px 1fr 170px' }}
    >
      <header
        className="row-start-1 border-b border-line bg-bg-1/85 backdrop-blur-sm relative"
        style={{
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
        }}
      >
        {top}
      </header>

      <main className="row-start-2 relative">
        {/* globe fills the row */}
        <div className="absolute inset-0">{globe}</div>

        {/* left rail */}
        <aside
          className="absolute left-0 top-0 bottom-0 w-[300px] border-r border-line bg-bg-1/85 backdrop-blur-sm overflow-y-auto"
          aria-label="Layers"
          style={{
            boxShadow: 'inset -1px 0 0 rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.04)',
          }}
        >
          {left}
        </aside>

        {/* right rail */}
        <aside
          className="absolute right-0 top-0 bottom-0 w-[340px] border-l border-line bg-bg-1/85 backdrop-blur-sm overflow-y-auto"
          aria-label="Selection"
          style={{
            boxShadow: 'inset 1px 0 0 rgba(0,0,0,0.5), inset -1px 0 0 rgba(255,255,255,0.04)',
          }}
        >
          {right}
        </aside>
      </main>

      <footer
        className="row-start-3 border-t border-line bg-bg-1/92"
        style={{
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
        }}
      >
        {bottom}
      </footer>
    </div>
  );
}
