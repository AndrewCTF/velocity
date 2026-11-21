import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../normal/Icon.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { usePhoneSheet } from "./phoneSheet.js";

// The phone's one container for everything that is not the map: a sheet that
// rises from the tab bar, stops at a height, and can be dragged between its
// stops or down to close. The map stays live above it, so a panel never takes
// the thing it describes off screen (the full-screen panel it replaces did).
//
// Stops are fractions of the map well's height, except `peek`, which is a
// fixed strip: enough for a contact's name, kind and action row.

export type Detent = "peek" | "half" | "full";

const PEEK_PX = 188;
const HALF = 0.5;
// Full leaves the top of the map visible, so the sheet still reads as laid over
// the map and the drag back down has somewhere to land.
const FULL = 0.92;
// A release this far below the lowest stop closes the sheet.
const CLOSE_BELOW = 0.65;

function stopPx(d: Detent, wellPx: number): number {
  if (d === "peek") return Math.min(PEEK_PX, wellPx * HALF);
  return Math.round(wellPx * (d === "half" ? HALF : FULL));
}

export function BottomSheet({
  label,
  open,
  onClose,
  detents = ["half", "full"],
  initial,
  keepMounted = false,
  focusInput = false,
  children,
}: {
  label: string;
  open: boolean;
  onClose: () => void;
  /** Lowest first. */
  detents?: readonly Detent[];
  initial?: Detent;
  /** Hide instead of unmounting when closed (the Time dock drives the clock). */
  keepMounted?: boolean;
  /** Put the cursor in the first field on opening (Find: the keyboard is the point). */
  focusInput?: boolean;
  children: ReactNode;
}): JSX.Element | null {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const first: Detent = initial ?? detents[0] ?? "half";
  const [detent, setDetent] = useState<Detent>(first);
  // Live height while a finger is on the handle; null when resting on a stop.
  const [drag, setDrag] = useState<number | null>(null);
  const [well, setWell] = useState(0);
  // Set by a drag that moved, so the click the lift makes on the grab bar does
  // not also step the sheet.
  const dragged = useRef(false);

  // Each opening starts at its initial stop, not wherever the last one ended.
  useEffect(() => {
    if (open) setDetent(first);
  }, [open, first]);

  useEffect(() => {
    if (!open || !focusInput) return;
    const id = requestAnimationFrame(() =>
      sheetRef.current
        ?.querySelector<HTMLInputElement>(
          ".psheet-body input[type='text'], .psheet-body input:not([type])",
        )
        ?.focus(),
    );
    return () => cancelAnimationFrame(id);
  }, [open, focusInput]);

  useEffect(() => {
    const host = sheetRef.current?.parentElement;
    if (!host) return;
    const read = (): void => setWell(host.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(host);
    return () => ro.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // One sheet is open at a time, so Escape closes it wherever focus is: the
    // button that opened it (Menu, a tab) keeps focus, and a sheet that only
    // closed from inside itself ignored the key a keyboard user reached for.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // jsdom and a first paint have no layout yet; a phone's map well is about this.
  const w = well || 600;
  const rest = stopPx(detent, w);
  const height = drag ?? rest;

  // The map's own buttons ride above whichever sheet is up (PhoneMapButtons).
  const setSheetPx = usePhoneSheet((s) => s.setSheetPx);
  useEffect(() => {
    if (!open) return;
    setSheetPx(height);
    return () => setSheetPx(0);
  }, [open, height, setSheetPx]);

  if (!open && !keepMounted) return null;

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // The grab bar starts a drag too; only Close is a plain button here.
    if ((e.target as HTMLElement).closest(".psheet-close")) return;
    const startY = e.clientY;
    const startH = rest;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    dragged.current = false;
    let last = startH;
    const move = (ev: PointerEvent): void => {
      if (Math.abs(ev.clientY - startY) > 6) dragged.current = true;
      if (!dragged.current) return;
      last = Math.max(
        0,
        Math.min(stopPx("full", w), startH + startY - ev.clientY),
      );
      setDrag(last);
    };
    const up = (): void => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(null);
      if (!dragged.current) return;
      // Only the click this lift makes is swallowed, not the next real tap.
      window.setTimeout(() => (dragged.current = false), 0);
      const lowest = stopPx(detents[0] ?? "half", w);
      if (last < lowest * CLOSE_BELOW) {
        onClose();
        return;
      }
      let best = detents[0] ?? "half";
      for (const d of detents)
        if (Math.abs(stopPx(d, w) - last) < Math.abs(stopPx(best, w) - last))
          best = d;
      setDetent(best);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // A tap on the handle steps up a stop, and from the top one back down.
  const step = (): void => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    const i = detents.indexOf(detent);
    setDetent(detents[i + 1] ?? detents[0] ?? "half");
  };

  return (
    <div
      ref={sheetRef}
      role="region"
      aria-label={label}
      hidden={!open}
      className="psheet"
      data-dragging={drag !== null ? "" : undefined}
      data-detent={detent}
      style={{ height }}
    >
      <div className="psheet-handle" onPointerDown={onDown}>
        <button
          type="button"
          className="psheet-grab"
          onClick={step}
          aria-label={
            detent === detents[detents.length - 1]
              ? `Lower ${label}`
              : `Raise ${label}`
          }
        >
          <span aria-hidden />
        </button>
        <div className="psheet-head">
          <span className="psheet-title">{label}</span>
          <button
            type="button"
            className="psheet-close"
            onClick={onClose}
            aria-label={`Close ${label}`}
          >
            <Icon name="x" className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>
      <div className="psheet-body">
        <ErrorBoundary label={label}>{children}</ErrorBoundary>
      </div>
    </div>
  );
}
