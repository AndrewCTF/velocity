import { useCallback, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { X, GripVertical } from 'lucide-react';
import { Icon, type IconName } from '../normal/Icon.js';
import { useFloatingPanels, type FloatingRect } from '../state/floatingPanels.js';

// A free-floating, draggable + resizable window over the globe. Position/size
// live in the floatingPanels store (keyed by id) so a detach → drag → redock →
// re-detach round-trips to the same spot within a session. The title bar drags
// the window; a bottom-right grip resizes it. Header carries a re-dock (⤡) and a
// close/redock (✕) — both call onClose, which the owner uses to re-dock.

const MIN_W = 240;
const MIN_H = 180;
const DEFAULT_RECT: FloatingRect = { x: 120, y: 96, w: 320, h: 460 };
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function FloatingPanel({
  id,
  title,
  icon,
  children,
  onClose,
}: {
  id: string;
  title: string;
  icon?: IconName;
  children: ReactNode;
  onClose: () => void;
}): JSX.Element {
  const rect = useFloatingPanels((s) => s.panels[id]) ?? DEFAULT_RECT;
  const setRect = useFloatingPanels((s) => s.setRect);

  const onDragDown = useCallback(
    (e: ReactPointerEvent): void => {
      // Ignore drags that start on a header button (close/redock).
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const cur = useFloatingPanels.getState().panels[id] ?? DEFAULT_RECT;
      const start = { px: e.clientX, py: e.clientY, rect: { ...cur } };
      // Capture the pointer on the grabbed element: every pointermove and the
      // terminating pointerup/pointercancel are then guaranteed to land here,
      // even if the pointer leaves the window or the gesture is cancelled
      // (touch/pen/browser-gesture takeover). Listening on window without
      // capture missed those and left the panel stuck to the cursor with
      // body.userSelect permanently 'none'.
      const el = e.currentTarget as HTMLElement;
      const pid = e.pointerId;
      const move = (ev: PointerEvent): void => {
        const maxX = window.innerWidth - 80;
        const maxY = window.innerHeight - 40;
        setRect(id, {
          x: clamp(start.rect.x + (ev.clientX - start.px), -start.rect.w + 120, maxX),
          y: clamp(start.rect.y + (ev.clientY - start.py), 28, maxY),
        });
      };
      const up = (): void => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(pid); } catch { /* already released */ }
        document.body.style.userSelect = '';
      };
      try { el.setPointerCapture(pid); } catch { /* jsdom/no-capture env */ }
      document.body.style.userSelect = 'none';
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    [id, setRect],
  );

  const onResizeDown = useCallback(
    (e: ReactPointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const cur = useFloatingPanels.getState().panels[id] ?? DEFAULT_RECT;
      const start = { px: e.clientX, py: e.clientY, rect: { ...cur } };
      const el = e.currentTarget as HTMLElement;
      const pid = e.pointerId;
      const move = (ev: PointerEvent): void => {
        setRect(id, {
          w: clamp(start.rect.w + (ev.clientX - start.px), MIN_W, window.innerWidth - start.rect.x - 8),
          h: clamp(start.rect.h + (ev.clientY - start.py), MIN_H, window.innerHeight - start.rect.y - 8),
        });
      };
      const up = (): void => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(pid); } catch { /* already released */ }
        document.body.style.userSelect = '';
      };
      try { el.setPointerCapture(pid); } catch { /* jsdom/no-capture env */ }
      document.body.style.userSelect = 'none';
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    [id, setRect],
  );

  return (
    <div
      className="absolute z-[var(--z-overlay)] pointer-events-auto flex flex-col rounded-md border border-line-2 overflow-hidden shadow-2xl"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, background: 'rgba(9,12,18,0.97)' }}
      role="dialog"
      aria-label={title}
    >
      <div
        onPointerDown={onDragDown}
        className="flex items-center gap-1.5 px-2 h-8 shrink-0 border-b border-line-2 bg-bg-1 cursor-grab active:cursor-grabbing select-none"
      >
        <GripVertical size={13} strokeWidth={1.75} className="text-txt-3" aria-hidden />
        {icon && <Icon name={icon} className="w-3.5 h-3.5 text-txt-2" />}
        <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-1 flex-1 truncate">{title}</span>
        <button
          type="button"
          onClick={onClose}
          title="Dock back to the rail"
          aria-label="Dock panel"
          className="text-txt-3 hover:text-txt-0 px-1 flex items-center"
        >
          <X size={13} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      {/* resize grip */}
      <div
        onPointerDown={onResizeDown}
        className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 50%, var(--line, #2a3140) 50% 60%, transparent 60% 70%, var(--line, #2a3140) 70% 80%, transparent 80%)',
        }}
        aria-hidden
      />
    </div>
  );
}
