import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Cesium from "cesium";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearchTarget, useSelection } from "../state/stores.js";
import { useInvestigation } from "../graph/investigationStore.js";
import { useContextMenu } from "./contextMenuStore.js";
import { setDrawController, type DrawController } from "./draw.js";
import { installLongPress } from "./longPress.js";

// On touch the globe's context menu used to need an unmentioned 1.5 s hold
// (Cesium's own touch-hold, which is what raises RIGHT_CLICK). installLongPress
// times a resting finger itself and does the right-click's job after 500 ms.
// The viewer here is a stub with a real Cesium underneath it: the code under
// test only needs a canvas, scene.pick, camera.pickEllipsoid and the ellipsoid.

const GROUND = { lat: 48.8566, lon: 2.3522 };
// The canvas sits at (10, 20): a pointer at client (110, 220) is at (100, 200)
// in the canvas frame Cesium reports clicks in.
const RECT = { left: 10, top: 20, width: 400, height: 800 };

interface Rig {
  viewer: Cesium.Viewer;
  canvas: HTMLCanvasElement;
  picks: Cesium.Cartesian2[];
  destroy: () => void;
}

function rig(
  opts: {
    pick?: (p: Cesium.Cartesian2) => unknown;
    ground?: { lat: number; lon: number } | null;
  } = {},
): Rig {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () =>
    ({
      ...RECT,
      x: RECT.left,
      y: RECT.top,
      right: RECT.left + RECT.width,
      bottom: RECT.top + RECT.height,
      toJSON: () => ({}),
    }) as DOMRect;
  const picks: Cesium.Cartesian2[] = [];
  let destroyed = false;
  const ground = opts.ground === undefined ? GROUND : opts.ground;
  const viewer = {
    canvas,
    scene: {
      pick: (p: Cesium.Cartesian2) => {
        picks.push(p);
        return opts.pick?.(p);
      },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      pickEllipsoid: () =>
        ground
          ? Cesium.Cartesian3.fromDegrees(ground.lon, ground.lat)
          : undefined,
    },
    isDestroyed: () => destroyed,
  } as unknown as Cesium.Viewer;
  return { viewer, canvas, picks, destroy: () => (destroyed = true) };
}

type Kind = "pointerdown" | "pointermove" | "pointerup" | "pointercancel";

function pointer(
  target: Element,
  type: Kind,
  init: {
    id?: number;
    x?: number;
    y?: number;
    primary?: boolean;
    kind?: string;
  } = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: init.id ?? 1,
      pointerType: init.kind ?? "touch",
      isPrimary: init.primary ?? true,
      clientX: init.x ?? 110,
      clientY: init.y ?? 220,
    }),
  );
}

const menu = () => useContextMenu.getState();

let detach: () => void = () => undefined;
let canvasToRemove: HTMLCanvasElement | null = null;

function mount(opts?: Parameters<typeof rig>[0]): Rig {
  const r = rig(opts);
  canvasToRemove = r.canvas;
  detach = installLongPress(r.viewer);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  useContextMenu.setState({ open: false, x: 0, y: 0, lat: 0, lon: 0 });
  useSelection.setState({ selectedEntityId: null });
  useSearchTarget.setState({ target: null });
  useInvestigation.setState({ rootId: null, openSeq: 0 });
  setDrawController(null);
});

afterEach(() => {
  detach();
  detach = () => undefined;
  canvasToRemove?.remove();
  canvasToRemove = null;
  setDrawController(null);
  vi.useRealTimers();
});

describe("installLongPress: what a hold does", () => {
  it("opens the map menu where the finger rests, after 500 ms", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(499);
    expect(menu().open).toBe(false);
    vi.advanceTimersByTime(1);
    expect(menu().open).toBe(true);
    expect(menu().x).toBe(110);
    expect(menu().y).toBe(220);
    expect(menu().lat).toBeCloseTo(GROUND.lat, 6);
    expect(menu().lon).toBeCloseTo(GROUND.lon, 6);
    // Picked in the canvas frame, as Cesium reports a click.
    expect(r.picks).toHaveLength(1);
    expect(r.picks[0]!.x).toBe(100);
    expect(r.picks[0]!.y).toBe(200);
  });

  it("opens where the finger is now, when it has drifted under 10 px", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    pointer(r.canvas, "pointermove", { x: 119, y: 224 }); // hypot 9.85
    vi.advanceTimersByTime(500);
    expect(menu().open).toBe(true);
    expect(menu().x).toBe(119);
    expect(menu().y).toBe(224);
  });

  it.each(["aircraft", "vessel", "sim", "incident"])(
    "selects and expands a %s it lands on, and leaves the menu shut",
    (kind) => {
      const id = `${kind}:abc123`;
      const r = mount({ pick: () => ({ id: { id } }) });
      pointer(r.canvas, "pointerdown");
      vi.advanceTimersByTime(500);
      expect(useSelection.getState().selectedEntityId).toBe(id);
      expect(useInvestigation.getState().rootId).toBe(id);
      expect(useInvestigation.getState().openSeq).toBe(1);
      expect(menu().open).toBe(false);
    },
  );

  it("takes the first entity of a cluster pick", () => {
    const r = mount({
      pick: () => ({ id: [{ id: "vessel:1" }, { id: "vessel:2" }] }),
    });
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    expect(useSelection.getState().selectedEntityId).toBe("vessel:1");
  });

  it("treats any other pick as ground, like the right-click does", () => {
    const r = mount({ pick: () => ({ id: { id: "airport:KJFK" } }) });
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    expect(menu().open).toBe(true);
    expect(useSelection.getState().selectedEntityId).toBeNull();
    expect(useInvestigation.getState().openSeq).toBe(0);
  });

  it("does nothing over the sky", () => {
    const r = mount({ ground: null });
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    expect(menu().open).toBe(false);
  });
});

describe("installLongPress: what cancels a hold", () => {
  it("a drag of 10 px or more", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    pointer(r.canvas, "pointermove", { x: 120, y: 220 });
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("drift that adds up past 10 px from where the finger landed", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    pointer(r.canvas, "pointermove", { x: 116, y: 220 }); // 6 px from the start
    pointer(r.canvas, "pointermove", { x: 116, y: 227 }); // 9.2 px
    pointer(r.canvas, "pointermove", { x: 118, y: 228 }); // 11.3 px
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("a drag that comes back does not re-arm", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    pointer(r.canvas, "pointermove", { x: 150, y: 220 });
    pointer(r.canvas, "pointermove", { x: 110, y: 220 });
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("a second finger (pinch), and it stays cancelled after that finger lifts", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown", { id: 1, primary: true });
    vi.advanceTimersByTime(100);
    pointer(r.canvas, "pointerdown", {
      id: 2,
      primary: false,
      x: 200,
      y: 300,
    });
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
    pointer(r.canvas, "pointerup", { id: 2, primary: false });
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("a finger left resting after a pinch does not become a hold", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown", { id: 1, primary: true });
    pointer(r.canvas, "pointerdown", {
      id: 2,
      primary: false,
      x: 200,
      y: 300,
    });
    vi.advanceTimersByTime(100);
    pointer(r.canvas, "pointerup", { id: 1, primary: true });
    // Finger 2 rests alone from here on, long past 500 ms.
    vi.advanceTimersByTime(1000);
    expect(menu().open).toBe(false);
  });

  it("lifting early, which is a tap", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(300);
    pointer(r.canvas, "pointerup");
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("pointercancel", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(300);
    pointer(r.canvas, "pointercancel");
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("a mouse or a pen: those have a real right-click", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown", { kind: "mouse" });
    vi.advanceTimersByTime(600);
    pointer(r.canvas, "pointerup", { kind: "mouse" });
    pointer(r.canvas, "pointerdown", { kind: "pen" });
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("an armed draw owns the touch, so no menu opens", () => {
    const r = mount();
    setDrawController({ active: true } as DrawController);
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("a touch that began inside a draw stays the draw's, even if the draw ends first", () => {
    const r = mount();
    setDrawController({ active: true } as DrawController);
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(100);
    setDrawController({ active: false } as DrawController);
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("a draw armed during the hold stops it, and that includes selecting a contact", () => {
    const r = mount({ pick: () => ({ id: { id: "aircraft:ab1234" } }) });
    setDrawController({ active: false } as DrawController);
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(100);
    setDrawController({ active: true } as DrawController);
    vi.advanceTimersByTime(500);
    expect(menu().open).toBe(false);
    expect(useSelection.getState().selectedEntityId).toBeNull();
    expect(useInvestigation.getState().openSeq).toBe(0);
  });

  it("a viewer destroyed during the hold", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    r.destroy();
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    expect(menu().open).toBe(false);
    expect(r.picks).toHaveLength(0);
  });

  it("a stale pointer whose end never arrived does not block the next touch", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown", { id: 7 });
    pointer(r.canvas, "pointermove", { id: 7, x: 300, y: 300 });
    // pointerup for 7 was lost. A new first finger is a new gesture.
    pointer(r.canvas, "pointerdown", { id: 8, primary: true });
    vi.advanceTimersByTime(500);
    expect(menu().open).toBe(true);
  });
});

describe("installLongPress: what the lift leaves behind", () => {
  // Cesium raises LEFT_CLICK from the pointer events when a lift comes sooner
  // than its own 1.5 s hold, and GlobeCanvas answers a click on empty ground by
  // clearing the selection and the search pin. This listener stands in for the
  // pair; it is registered BEFORE installLongPress, like Cesium's handler.
  function standInForCesiumClick(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("pointerup", () => {
      useSelection.getState().select(null);
      useSearchTarget.getState().setTarget(null);
    });
  }

  function install(opts?: Parameters<typeof rig>[0], withStandIn = true): Rig {
    const r = rig(opts);
    canvasToRemove = r.canvas;
    if (withStandIn) standInForCesiumClick(r.canvas);
    detach = installLongPress(r.viewer);
    return r;
  }

  const PIN = { lon: 1, lat: 2, label: "KJFK", kind: "airport" };

  it("swallows the one click that follows a hold, so the menu is not shut by its own lift", () => {
    const r = install();
    const seen = vi.fn();
    window.addEventListener("click", seen);
    try {
      pointer(r.canvas, "pointerdown");
      vi.advanceTimersByTime(500);
      pointer(r.canvas, "pointerup");

      const first = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      r.canvas.dispatchEvent(first);
      expect(seen).not.toHaveBeenCalled();
      expect(first.defaultPrevented).toBe(true);

      // Only the one: the next click is somebody's real tap.
      r.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", seen);
    }
  });

  it("stops swallowing once 400 ms have passed with no click", () => {
    const r = install();
    const seen = vi.fn();
    window.addEventListener("click", seen);
    try {
      pointer(r.canvas, "pointerdown");
      vi.advanceTimersByTime(500);
      pointer(r.canvas, "pointerup");
      vi.advanceTimersByTime(400);
      r.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", seen);
    }
  });

  it("lets a new tap's own click through, even inside that window", () => {
    const r = install();
    const seen = vi.fn();
    window.addEventListener("click", seen);
    try {
      pointer(r.canvas, "pointerdown");
      vi.advanceTimersByTime(500);
      pointer(r.canvas, "pointerup");
      vi.advanceTimersByTime(100);
      pointer(r.canvas, "pointerdown", { id: 2 });
      pointer(r.canvas, "pointerup", { id: 2 });
      r.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", seen);
    }
  });

  it("lets a tap on a menu item through, though it never touches the canvas", () => {
    const r = install();
    const item = document.createElement("button");
    document.body.appendChild(item);
    const seen = vi.fn();
    window.addEventListener("click", seen);
    try {
      pointer(r.canvas, "pointerdown");
      vi.advanceTimersByTime(500);
      pointer(r.canvas, "pointerup");
      vi.advanceTimersByTime(100);
      // The finger has come off the globe and goes down on the opened menu.
      pointer(item, "pointerdown", { id: 2 });
      pointer(item, "pointerup", { id: 2 });
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", seen);
      item.remove();
    }
  });

  it("leaves a plain tap's click alone", () => {
    const r = install();
    const seen = vi.fn();
    window.addEventListener("click", seen);
    try {
      pointer(r.canvas, "pointerdown");
      vi.advanceTimersByTime(120);
      pointer(r.canvas, "pointerup");
      r.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", seen);
    }
  });

  it("cancels a contextmenu raised inside the gesture, and no other", () => {
    const r = install();
    const seen = vi.fn();
    window.addEventListener("contextmenu", seen);
    try {
      pointer(r.canvas, "pointerdown");
      const during = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      r.canvas.dispatchEvent(during);
      expect(during.defaultPrevented).toBe(true);
      expect(seen).not.toHaveBeenCalled();

      pointer(r.canvas, "pointerup");
      // A desktop right-click, with no touch in play, passes straight through.
      const mouse = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      r.canvas.dispatchEvent(mouse);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("contextmenu", seen);
    }
  });

  it("keeps the selection and the search pin that Cesium's click would clear", () => {
    const r = install();
    useSelection.getState().select("vessel:7");
    useSearchTarget.getState().setTarget(PIN);
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    expect(menu().open).toBe(true);
    pointer(r.canvas, "pointerup");
    expect(useSelection.getState().selectedEntityId).toBe("vessel:7");
    expect(useSearchTarget.getState().target).toBe(PIN);
  });

  it("keeps the contact it just selected when the lift misses it", () => {
    const r = install({ pick: () => ({ id: { id: "aircraft:ab1234" } }) });
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    pointer(r.canvas, "pointerup");
    expect(useSelection.getState().selectedEntityId).toBe("aircraft:ab1234");
  });

  it("restores what stood just before the lift, not what stood before the hold", () => {
    const r = install();
    useSelection.getState().select("vessel:7");
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    // Something else (an alert, say) moves the selection while the finger rests.
    useSelection.getState().select("sim:2");
    pointer(r.canvas, "pointerup");
    expect(useSelection.getState().selectedEntityId).toBe("sim:2");
  });

  it("touches nothing when the lift took nothing", () => {
    const r = install(undefined, false);
    useSelection.getState().select("vessel:7");
    const seen = vi.fn();
    const off = useSelection.subscribe(seen);
    try {
      pointer(r.canvas, "pointerdown");
      vi.advanceTimersByTime(500);
      pointer(r.canvas, "pointerup");
      expect(seen).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("does not interfere with a tap, whose click deselects as it always did", () => {
    const r = install();
    useSelection.getState().select("vessel:7");
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(120);
    pointer(r.canvas, "pointerup");
    expect(useSelection.getState().selectedEntityId).toBeNull();
  });

  it("does not interfere when the hold found nothing to act on", () => {
    const r = install({ ground: null });
    useSelection.getState().select("vessel:7");
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    pointer(r.canvas, "pointerup");
    // Over the sky the hold is just a slow tap.
    expect(useSelection.getState().selectedEntityId).toBeNull();
  });
});

describe("installLongPress: cleanup", () => {
  it("stops listening and leaves no timer behind", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    expect(vi.getTimerCount()).toBe(1);
    detach();
    expect(vi.getTimerCount()).toBe(0);

    pointer(r.canvas, "pointerup");
    pointer(r.canvas, "pointerdown", { id: 2 });
    vi.advanceTimersByTime(600);
    expect(menu().open).toBe(false);
  });

  it("stops swallowing clicks", () => {
    const r = mount();
    pointer(r.canvas, "pointerdown");
    vi.advanceTimersByTime(500);
    pointer(r.canvas, "pointerup");
    detach();
    expect(vi.getTimerCount()).toBe(0);
    const seen = vi.fn();
    window.addEventListener("click", seen);
    try {
      r.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", seen);
    }
  });
});

// "Right-click or long-press" is printed in several panels. Something has to be
// listening for it (apps/web/CLAUDE.md, Controls state what they do), and this
// is the something: the printed hint is only true while GlobeCanvas installs it.
describe("the printed hint stays true", () => {
  it("GlobeCanvas installs long-press and removes it with the viewer", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "GlobeCanvas.tsx"),
      "utf8",
    );
    expect(src).toContain("installLongPress(viewer)");
    expect(src).toContain("detachLongPress()");
  });

  // While a draw is armed a long-press is left to Cesium's own touch-hold, which
  // raises RIGHT_CLICK after 1.5 s and finishes the shape cleanly. Finishing it
  // at the 500 ms hold instead lets the lift's LEFT_CLICK land in the tool the
  // finish just re-armed, and the measure readout went from "2 pts · done" to
  // "1 pt" (measured live, 2026-10-17). The draw hints therefore say 1.5 s, and
  // that number is only true while nobody changes Cesium's default.
  it("the 1.5 s in the draw hints is Cesium's touch-hold delay, and nothing here changes it", () => {
    expect(Cesium.ScreenSpaceEventHandler.touchHoldDelayMilliseconds).toBe(
      1500,
    );
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(path);
      }
      return out;
    };
    for (const file of walk(src))
      expect(
        readFileSync(file, "utf8"),
        `${file} sets the touch-hold delay`,
      ).not.toMatch(/touchHoldDelayMilliseconds\s*=[^=]/);
  });
});
