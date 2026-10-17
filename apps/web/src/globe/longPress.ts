import * as Cesium from "cesium";
import {
  useSearchTarget,
  useSelection,
  type SearchTarget,
} from "../state/stores.js";
import { useInvestigation } from "../graph/investigationStore.js";
import { useContextMenu } from "./contextMenuStore.js";
import { getDrawController } from "./draw.js";

// Touch long-press = right-click.
//
// The globe's context menu and its "search around" shortcut hang off Cesium's
// RIGHT_CLICK (GlobeCanvas.tsx). On touch Cesium only raises that after the
// finger has rested for ScreenSpaceEventHandler.touchHoldDelayMilliseconds,
// 1.5 s, which nothing on screen says, so a phone had no way to reach either.
// This times a resting finger itself and does what the right-click does after
// half a second.
//
// Why not lower Cesium's delay: it is one number shared by every handler
// (including the draw toolbox, where a slow tap would then commit the shape
// instead of adding a vertex), and Cesium forgives 25 px of drift, where 10 px
// is already a drag.

const HOLD_MS = 500;
// A finger that has drifted this far (CSS px) is dragging, not holding.
const SLOP_PX = 10;
// How long after the lift the click the browser may still send is swallowed.
const CLICK_GUARD_MS = 400;

/**
 * What a right-click does at a screen point: a contact (aircraft, vessel, sim,
 * incident) is selected and expanded in the investigation graph, empty ground
 * opens the map menu. Mirrors the RIGHT_CLICK handler in GlobeCanvas.tsx; keep
 * the two in step, or let that handler call this. `position` is in CSS px,
 * relative to the canvas, the same frame Cesium reports clicks in.
 *
 * Returns true when something happened (a contact was picked or the menu
 * opened), false when the point is sky or a draw owns the gesture.
 */
export function contextActionAt(
  viewer: Cesium.Viewer,
  position: Cesium.Cartesian2,
): boolean {
  const scene = viewer.scene;
  const picked = scene.pick(position);
  const pid = (picked as { id?: unknown } | undefined)?.id;
  // A cluster pick carries the merged entities; the first stands for it.
  const ent = Array.isArray(pid) ? pid[0] : pid;
  const id = (ent as { id?: string } | undefined)?.id;
  if (id && /^(aircraft|vessel|sim|incident):/.test(id)) {
    useSelection.getState().select(id);
    useInvestigation.getState().searchAround(id);
    return true;
  }
  // Empty ground, and not mid-draw: the draw toolbox owns the gesture then.
  if (getDrawController()?.active) return false;
  const cart = viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid);
  if (!cart) return false;
  const c = Cesium.Cartographic.fromCartesian(cart);
  const rect = viewer.canvas.getBoundingClientRect();
  useContextMenu
    .getState()
    .openAt(
      rect.left + position.x,
      rect.top + position.y,
      Cesium.Math.toDegrees(c.latitude),
      Cesium.Math.toDegrees(c.longitude),
    );
  return true;
}

interface Held {
  sel: string | null;
  pin: SearchTarget | null;
}

/**
 * Listens on the globe canvas for a touch that rests for 500 ms (under 10 px
 * of drift, one finger, no draw armed) and runs the right-click action there.
 * Mouse and pen pointers are left to Cesium's real right-click. Returns the
 * cleanup.
 */
export function installLongPress(viewer: Cesium.Viewer): () => void {
  const canvas = viewer.canvas;

  // Touch pointers currently down on the canvas, so a second finger (a pinch,
  // a two-finger tilt) is recognised as one.
  const down = new Set<number>();
  // The one finger being timed, from where it landed to where it is now.
  let pending: {
    id: number;
    x0: number;
    y0: number;
    x: number;
    y: number;
  } | null = null;
  let holdTimer: number | undefined;
  // The finger whose hold has acted, until its lift has been dealt with.
  let fired: { id: number } | null = null;
  // Selection and search pin as they were just before that lift reached Cesium.
  let before: Held | null = null;
  let clickGuard = false;
  let guardTimer: number | undefined;

  const cancelHold = (): void => {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    holdTimer = undefined;
    pending = null;
  };

  const disarmClickGuard = (): void => {
    if (guardTimer !== undefined) window.clearTimeout(guardTimer);
    guardTimer = undefined;
    clickGuard = false;
  };

  const armClickGuard = (): void => {
    disarmClickGuard();
    clickGuard = true;
    guardTimer = window.setTimeout(disarmClickGuard, CLICK_GUARD_MS);
  };

  const onHold = (): void => {
    holdTimer = undefined;
    const p = pending;
    pending = null;
    if (!p || !down.has(p.id) || down.size !== 1) return;
    if (viewer.isDestroyed() || getDrawController()?.active) return;
    const rect = canvas.getBoundingClientRect();
    const handled = contextActionAt(
      viewer,
      new Cesium.Cartesian2(p.x - rect.left, p.y - rect.top),
    );
    if (handled) fired = { id: p.id };
  };

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    // The first finger of a gesture is the primary pointer. Seeing one means
    // every earlier pointer has ended, whether or not its end reached us.
    if (e.isPrimary) {
      down.clear();
      cancelHold();
      fired = null;
      before = null;
    }
    down.add(e.pointerId);
    if (down.size > 1) {
      cancelHold();
      return;
    }
    if (getDrawController()?.active) return;
    pending = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
    };
    holdTimer = window.setTimeout(onHold, HOLD_MS);
  };

  const onMove = (e: PointerEvent): void => {
    const p = pending;
    if (!p || e.pointerId !== p.id) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(p.x - p.x0, p.y - p.y0) >= SLOP_PX) cancelHold();
  };

  // Cesium turns a lift that comes before ITS 1.5 s hold into a LEFT_CLICK, and
  // GlobeCanvas answers a LEFT_CLICK on empty ground by clearing the selection
  // and the search pin. That click is made from pointer events, not from the
  // DOM `click`, so nothing here can stop it; instead the selection is read
  // just before the lift reaches Cesium (window capture runs ahead of every
  // listener on the canvas) and put back just after (window bubble runs behind
  // them). A hold that outlasts Cesium's own 1.5 s raises its RIGHT_CLICK
  // instead and sends no LEFT_CLICK, so that case finds nothing to restore.
  const onEndCapture = (e: PointerEvent): void => {
    if (!fired || e.pointerId !== fired.id) return;
    before = {
      sel: useSelection.getState().selectedEntityId,
      pin: useSearchTarget.getState().target,
    };
  };

  const onEnd = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    down.delete(e.pointerId);
    if (pending && pending.id === e.pointerId) cancelHold();
    if (!fired || e.pointerId !== fired.id) return;
    const held = before;
    fired = null;
    before = null;
    if (held) {
      if (useSelection.getState().selectedEntityId !== held.sel)
        useSelection.getState().select(held.sel);
      if (useSearchTarget.getState().target !== held.pin)
        useSearchTarget.getState().setTarget(held.pin);
    }
    armClickGuard();
  };

  // Browsers differ on what a long press leaves behind: a `click` on the lift,
  // a `contextmenu` during the hold, both, or neither. A click would reach
  // ContextMenu's close-on-any-click listener and shut the menu the moment the
  // finger lifts, so the one click the lift can produce is swallowed here,
  // ahead of every other listener. A contextmenu raised inside the gesture is
  // cancelled and kept from every other listener too.
  const onClick = (e: Event): void => {
    if (!clickGuard) return;
    disarmClickGuard();
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  const onContextMenu = (e: Event): void => {
    if (!pending && !fired && !clickGuard) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  // A press on anything at all (a menu item, say) is a new interaction, and the
  // click it makes is its own, never the one the last lift left behind.
  window.addEventListener("pointerdown", disarmClickGuard, true);
  window.addEventListener("pointerup", onEndCapture, true);
  window.addEventListener("pointercancel", onEndCapture, true);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  window.addEventListener("click", onClick, true);
  window.addEventListener("contextmenu", onContextMenu, true);

  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerdown", disarmClickGuard, true);
    window.removeEventListener("pointerup", onEndCapture, true);
    window.removeEventListener("pointercancel", onEndCapture, true);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("contextmenu", onContextMenu, true);
    cancelHold();
    disarmClickGuard();
    down.clear();
    fired = null;
    before = null;
  };
}
