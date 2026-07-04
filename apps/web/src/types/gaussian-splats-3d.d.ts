// Minimal ambient types for @mkkellogg/gaussian-splats-3d (ships no .d.ts).
// Only the surface the Studio viewer uses. Options are loose on purpose — the
// upstream API is a plain options bag.
declare module '@mkkellogg/gaussian-splats-3d' {
  export const SceneFormat: { Ply: number; Splat: number; KSplat: number; Spz: number };
  export const RenderMode: { Always: number; OnChange: number; Never: number };

  export class Viewer {
    constructor(options?: Record<string, unknown>);
    addSplatScene(path: string, options?: Record<string, unknown>): Promise<void>;
    start(): void;
    stop(): void;
    dispose(): Promise<void> | void;
    setRenderMode?(mode: number): void;
  }

  export class DropInViewer {
    constructor(options?: Record<string, unknown>);
  }
}
