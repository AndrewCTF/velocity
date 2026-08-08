import { useCallback, useEffect, useState } from 'react';

import { Icon } from '../normal/Icon.js';

// A full-screen deck for briefing off the live picture.
//
// The Brief tab already produced a DOCUMENT (self-contained HTML, and a PPTX
// through /api/report/pptx). What it had no way to do was present: an operator
// briefing a room had a scrolling panel and a downloaded file. This is the
// missing half, and it is deliberately the same content rather than a second
// copy of it — the caller passes the slides it already computed.
//
// Not a second address for the brief: it opens FROM the Brief tab and closes
// back to it, so Reports → Brief stays the one place this content lives
// (shell/panels.ts records why that rule exists).
//
// ponytail: no presentation library. A deck is one slide at a time, arrow keys,
// and a print stylesheet — reveal.js would be 40 kB to replace 60 lines.

export interface Slide {
  readonly title: string;
  readonly body: JSX.Element;
}

export function SlidesDeck({
  slides,
  classification,
  onClose,
}: {
  slides: readonly Slide[];
  classification: string;
  onClose: () => void;
}): JSX.Element | null {
  const [i, setI] = useState(0);
  const last = Math.max(0, slides.length - 1);

  const go = useCallback(
    (delta: number) => setI((n) => Math.min(last, Math.max(0, n + delta))),
    [last],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === 'Home') setI(0);
      else if (e.key === 'End') setI(last);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, last, onClose]);

  if (slides.length === 0) return null;
  const slide = slides[Math.min(i, last)];
  if (!slide) return null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] bg-bg-0 flex flex-col slides-deck"
      role="dialog"
      aria-modal="true"
      aria-label="Briefing deck"
    >
      {/* Print: one slide per landscape page, chrome hidden. The browser's own
          print-to-PDF is the export, so there is no second export path to keep
          in step with the deck. */}
      <style>{`
        @media print {
          @page { size: landscape; margin: 12mm; }
          .slides-deck { position: static; height: auto; }
          .slides-chrome { display: none !important; }
          .slides-print-all { display: block !important; }
          .slides-current { display: none !important; }
          .slides-page { break-after: page; page-break-after: always; }
        }
      `}</style>

      <header className="slides-chrome flex items-center justify-between gap-3 px-6 h-10 border-b border-line-2 shrink-0">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-txt-3">{classification}</span>
        <span className="flex items-center gap-2">
          <span className="mono text-[10px] text-txt-3 tabular-nums">
            {i + 1} / {slides.length}
          </span>
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={i === 0}
            className="mono text-[10px] uppercase tracking-[0.1em] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line disabled:opacity-40"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={i === last}
            className="mono text-[10px] uppercase tracking-[0.1em] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line disabled:opacity-40"
          >
            Next
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="mono text-[10px] uppercase tracking-[0.1em] px-2 py-0.5 rounded-sm border border-accent-line text-accent bg-accent-dim"
          >
            Print / PDF
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the deck"
            className="text-txt-3 hover:text-txt-0"
          >
            <Icon name="x" className="w-4 h-4" />
          </button>
        </span>
      </header>

      <div className="slides-current flex-1 min-h-0 overflow-auto px-10 py-8">
        <SlideBody slide={slide} />
      </div>

      {/* Every slide, laid out for print only. The screen view stays one at a
          time; without this the printed PDF would be a single slide. */}
      <div className="slides-print-all hidden">
        {slides.map((s, n) => (
          <div key={n} className="slides-page px-10 py-8">
            <SlideBody slide={s} />
          </div>
        ))}
      </div>

      <footer className="slides-chrome px-6 h-8 flex items-center border-t border-line-2 shrink-0">
        <span className="mono text-[9.5px] text-txt-4">
          arrows or space to advance · Esc to close
        </span>
      </footer>
    </div>
  );
}

function SlideBody({ slide }: { slide: Slide }): JSX.Element {
  return (
    <>
      <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-txt-0 border-b border-line-2 pb-2">
        {slide.title}
      </h2>
      <div className="mt-5 text-[14px] leading-relaxed text-txt-1">{slide.body}</div>
    </>
  );
}
