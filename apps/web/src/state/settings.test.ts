import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// This env's global `localStorage` is a broken Node webstorage stub (methods
// undefined), so inject a real Map-backed one. Stores read localStorage at
// module init, so reset modules after stubbing and import dynamically.
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('settings store', () => {
  beforeEach(() => {
    stubStorage();
    vi.resetModules();
  });

  it('aircraftDeadReckon is OFF by default', async () => {
    const { useSettings } = await import('./settings.js');
    expect(useSettings.getState().aircraftDeadReckon).toBe(false);
  });

  it('set() updates state and persists only Settings fields as JSON', async () => {
    const { useSettings } = await import('./settings.js');
    useSettings.getState().set('aircraftDeadReckon', true);
    expect(useSettings.getState().aircraftDeadReckon).toBe(true);
    expect(JSON.parse(localStorage.getItem('velocity.settings')!)).toEqual({
      mapQuality: 'high',
      aircraftDeadReckon: true,
      renderPixelCap: 2,
      continuousRenderGovernor: false,
      selectionAiEnabled: false,
      selectionAiModel: null,
      selectionAiPosition: 'top',
      leftRailExpanded: false,
    });
  });

  it('selectionAiEnabled/selectionAiModel mirror the backend selection-brief state, OFF/null by default', async () => {
    const { useSettings } = await import('./settings.js');
    expect(useSettings.getState().selectionAiEnabled).toBe(false);
    expect(useSettings.getState().selectionAiModel).toBeNull();
    useSettings.getState().set('selectionAiEnabled', true);
    useSettings.getState().set('selectionAiModel', 'unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL');
    expect(useSettings.getState().selectionAiEnabled).toBe(true);
    expect(useSettings.getState().selectionAiModel).toBe('unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL');
  });

  it('reads an existing blob on init', async () => {
    localStorage.setItem('velocity.settings', JSON.stringify({ aircraftDeadReckon: true }));
    vi.resetModules();
    const { useSettings } = await import('./settings.js');
    expect(useSettings.getState().aircraftDeadReckon).toBe(true);
  });

  it('falls back to defaults for a corrupt blob', async () => {
    localStorage.setItem('velocity.settings', '{not json');
    vi.resetModules();
    const { useSettings } = await import('./settings.js');
    expect(useSettings.getState().aircraftDeadReckon).toBe(false);
  });
});

describe('dashboardMode store', () => {
  beforeEach(() => {
    stubStorage();
    vi.resetModules();
  });

  it('defaults to professional (pro) when unset', async () => {
    const { useDashboardMode } = await import('./dashboardMode.js');
    expect(useDashboardMode.getState().mode).toBe('professional');
  });

  it('honors an explicit stored "normal" choice', async () => {
    localStorage.setItem('velocity.dashboardMode', 'normal');
    vi.resetModules();
    const { useDashboardMode } = await import('./dashboardMode.js');
    expect(useDashboardMode.getState().mode).toBe('normal');
  });

  it('persists setMode', async () => {
    const { useDashboardMode } = await import('./dashboardMode.js');
    useDashboardMode.getState().setMode('normal');
    expect(localStorage.getItem('velocity.dashboardMode')).toBe('normal');
  });
});
