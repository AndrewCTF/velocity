// Modal / Drawer / useConfirm — the shell's behavioral dialog primitives.
// instruments.tsx stays hook-free presentational vocabulary; anything that
// portals, traps focus, or owns open-state lives here. Token-driven chrome
// only; z-[var(--z-modal)] (600) stacks above the AppSurface (--z-overlay 400)
// so a dialog opened from a full-surface app is never buried.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from './instruments.js';
import { useReducedMotion } from './useReducedMotion.js';

// Shared portal chrome: backdrop (click closes), Escape closes, dialog a11y
// contract, focus moves into the panel on open and back to the opener on close.
function DialogShell({
  onClose,
  label,
  children,
  panelClass,
  panelStyle,
}: {
  onClose: () => void;
  label: string;
  children: ReactNode;
  panelClass: string;
  panelStyle?: React.CSSProperties;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)]">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 cursor-default"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={panelClass}
        style={panelStyle}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function DialogHeader({ title, onClose }: { title: ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 h-9 shrink-0 border-b border-line-2 bg-bg-1">
      <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-0 truncate">
        {title}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="mono text-[13px] text-txt-2 hover:text-txt-0 px-1.5 py-0.5"
      >
        ✕
      </button>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  width = 520,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <DialogShell
      onClose={onClose}
      label={typeof title === 'string' ? title : 'Dialog'}
      panelClass="absolute left-1/2 top-[12vh] -translate-x-1/2 max-w-[calc(100vw-32px)] max-h-[76vh] flex flex-col rounded-md border border-line-2 bg-bg-1 shadow-2xl outline-none"
      panelStyle={{ width }}
    >
      <DialogHeader title={title} onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto p-3.5">{children}</div>
      {footer && (
        <div className="flex items-center justify-end gap-2 px-3.5 py-2.5 border-t border-line-2 shrink-0">
          {footer}
        </div>
      )}
    </DialogShell>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  size = 480,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  side?: 'right';
  size?: number;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element | null {
  const reduced = useReducedMotion();
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);
  if (!open) return null;
  return (
    <DialogShell
      onClose={onClose}
      label={typeof title === 'string' ? title : 'Drawer'}
      panelClass={`absolute right-0 top-[68px] bottom-0 max-w-[calc(100vw-44px)] flex flex-col border-l border-line-2 bg-bg-1 shadow-2xl outline-none ${
        reduced ? '' : 'transition-transform duration-200 ease-out'
      } ${entered || reduced ? 'translate-x-0' : 'translate-x-full'}`}
      panelStyle={{ width: size }}
    >
      <DialogHeader title={title} onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto p-3.5">{children}</div>
      {footer && (
        <div className="flex items-center justify-end gap-2 px-3.5 py-2.5 border-t border-line-2 shrink-0">
          {footer}
        </div>
      )}
    </DialogShell>
  );
}

// Promise-based replacement for window.confirm:
//   const { confirm, confirmElement } = useConfirm();
//   ... if (await confirm({ title: 'Delete dataset "x"?', tone: 'danger' })) { ... }
// The caller renders `confirmElement` once anywhere in its tree.
interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'neutral';
}

export function useConfirm(): {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  confirmElement: JSX.Element | null;
} {
  const [pending, setPending] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(
    null,
  );
  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...opts, resolve });
      }),
    [],
  );
  const settle = (v: boolean): void => {
    pending?.resolve(v);
    setPending(null);
  };
  const confirmElement = pending ? (
    <Modal
      open
      onClose={() => settle(false)}
      title={pending.title}
      width={420}
      footer={
        <>
          <Btn onClick={() => settle(false)}>Cancel</Btn>
          <Btn
            onClick={() => settle(true)}
            tone={pending.tone === 'danger' ? 'neutral' : 'accent'}
            className={
              pending.tone === 'danger'
                ? 'border-[rgba(255,90,82,0.38)] bg-alert-bg text-[#ffc9c5] hover:border-alert'
                : ''
            }
          >
            {pending.confirmLabel ?? 'Confirm'}
          </Btn>
        </>
      }
    >
      <div className="mono text-[11px] text-txt-1 leading-relaxed">
        {pending.body ?? 'This action cannot be undone.'}
      </div>
    </Modal>
  ) : null;
  return { confirm, confirmElement };
}
