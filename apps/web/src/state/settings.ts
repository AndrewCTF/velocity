// Typed user settings, persisted as ONE JSON blob in localStorage
// (`velocity.settings`). Add a field to `Settings` + `DEFAULTS` and it is
// read/written automatically — unknown/missing keys fall back to the default,
// so the blob is forward/backward compatible across versions.
//
// The dashboard layout choice keeps its own store (state/dashboardMode.ts) for
// back-compat with its existing consumers; every other preference lives here.
import { create } from 'zustand';

export interface Settings {
  // FlightRadar24-style dead-reckoning. OFF by default — the default map shows
  // ONLY real observed ADS-B fixes (see the motion guardrail in CLAUDE.md).
  // When ON, aircraft glide forward along their last reported track at their
  // last reported speed BETWEEN fixes; those positions are ESTIMATED, not
  // observed. Operator-sanctioned opt-in (2026-06-28).
  aircraftDeadReckon: boolean;
  // Globe render sharpness ↔ FPS. The MAX device-pixel multiplier the 3D globe
  // renders at: the drawing buffer is css_pixels × min(window.devicePixelRatio,
  // renderPixelCap). 2.0 = native sharp on a 2× / Retina / 200%-scaled display
  // (matches what Firefox shows); lower it (e.g. 1.0) to render fewer pixels for
  // a higher frame rate at the cost of softness. Resolution and FPS trade off
  // directly — this is that knob. Default 2.0 (sharp). Mobile is always clamped
  // to 1.0 in GlobeCanvas (a 3× phone panel supersamples to a brutal fill rate).
  renderPixelCap: number;
  // Render-on-demand governor (design §5.1). OFF by default = today's behavior:
  // maximumRenderTimeChange stays 0 so the scene renders every animated frame
  // (the CLAUDE.md guardrail's interpolation-smoothness intent). When ON, the
  // governor keeps 0 whenever ANYTHING animates (dead-reckon glide, gliding
  // vessels at low altitude, satellites, sim, follow, FOV/spotlight, emergency
  // pulse) and only relaxes to Infinity + explicit requestRender in the
  // genuinely-idle default case (world view, teleport aircraft, frozen vessels),
  // dropping idle GPU burn. Ships OFF pending on-hardware fps sign-off — flip it
  // on and confirm glide/pulse/scrub stay smooth before it becomes the default.
  continuousRenderGovernor: boolean;
  // Selection-tier local AI (local-llm-design.md, 2026-07-11): mirrors the
  // backend's /api/ai/local selection_enabled/selection_model fields so the
  // EntityPanel "AI assessment" card can gate its fetch without polling the
  // backend on every entity click. SettingsModal's Local AI section is the
  // sole writer — it updates these right after a successful POST that
  // changes either field. Never write these from EntityPanel itself.
  selectionAiEnabled: boolean;
  selectionAiModel: string | null;
}

const DEFAULTS: Settings = {
  aircraftDeadReckon: false,
  renderPixelCap: 2.0,
  continuousRenderGovernor: false,
  selectionAiEnabled: false,
  selectionAiModel: null,
};

const LS_KEY = 'velocity.settings';

function read(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(s: Settings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / storage disabled — in-memory only */
  }
}

interface SettingsState extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...read(),
  set: (key, value) => {
    set({ [key]: value } as Pick<SettingsState, typeof key>);
    // persist() takes Settings; get() returns the state incl. the `set` action,
    // but JSON.stringify drops functions, so only the Settings fields land.
    persist(get());
  },
}));
