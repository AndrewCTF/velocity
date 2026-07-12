// Minimal global toast system — dependency-free (zustand, already in the tree).
// Fire-and-forget from anywhere: `toast.ok('Saved')`, `toast.error('Failed')`.
// A single <ToastHost/> (mounted once in AppRouter) renders the stack, sits at
// the --z-toast layer (above every modal/wizard), and announces politely for
// screen readers. Toasts auto-dismiss; click to dismiss early.
import { useEffect } from 'react';
import { create } from 'zustand';
import { InlineAlert, type AlertTone } from './InlineAlert.js';

export interface ToastItem {
  id: number;
  tone: AlertTone;
  msg: string;
  ttl: number; // ms before auto-dismiss
}

interface ToastState {
  items: ToastItem[];
  push: (tone: AlertTone, msg: string, ttl?: number) => number;
  dismiss: (id: number) => void;
}

let seq = 0;

const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (tone, msg, ttl = 4000) => {
    const id = ++seq;
    set((s) => ({ items: [...s.items, { id, tone, msg, ttl }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

// Imperative API — the ergonomic surface later code should adopt.
export const toast = {
  info: (msg: string, ttl?: number) => useToastStore.getState().push('info', msg, ttl),
  ok: (msg: string, ttl?: number) => useToastStore.getState().push('ok', msg, ttl),
  warn: (msg: string, ttl?: number) => useToastStore.getState().push('warn', msg, ttl),
  error: (msg: string, ttl?: number) => useToastStore.getState().push('alert', msg, ttl),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};

function ToastRow({ item }: { item: ToastItem }): JSX.Element {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    const t = window.setTimeout(() => dismiss(item.id), item.ttl);
    return () => window.clearTimeout(t);
  }, [item.id, item.ttl, dismiss]);
  return (
    <button
      type="button"
      onClick={() => dismiss(item.id)}
      className="pointer-events-auto text-left w-[300px] rounded-sm bg-bg-1"
      style={{ boxShadow: 'var(--sh-2)' }}
      title="Dismiss"
    >
      <InlineAlert tone={item.tone}>{item.msg}</InlineAlert>
    </button>
  );
}

export function ToastHost(): JSX.Element {
  const items = useToastStore((s) => s.items);
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-3 right-3 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none"
    >
      {items.map((it) => (
        <ToastRow key={it.id} item={it} />
      ))}
    </div>
  );
}
