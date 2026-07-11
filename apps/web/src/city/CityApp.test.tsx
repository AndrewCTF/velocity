// Render tests for the City 3D app (docs/dashboard-workflows-plan.md §4).
// apiFetch is mocked at the transport boundary (repo convention, see
// foundry/foundry.test.tsx) so GET /api/recon/jobs never hits a live backend.
// @sparkjsdev/spark, three, and OrbitControls are mocked so jsdom never
// touches a real WebGL context — SplatView's THREE scene setup runs against
// harmless stand-ins instead.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CityApp } from './CityApp.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@sparkjsdev/spark', () => {
  class SplatMesh {
    onLoad: (() => void) | undefined;
    constructor(opts: { url: string; onLoad?: () => void }) {
      this.onLoad = opts.onLoad;
      // Resolve "load" asynchronously but deterministically for tests.
      queueMicrotask(() => this.onLoad?.());
    }
    dispose(): void {}
  }
  class SparkRenderer {
    constructor(_opts: unknown) {
      void _opts;
    }
  }
  return { SplatMesh, SparkRenderer };
});

vi.mock('three', () => {
  class Vec3Stub {
    set = vi.fn();
  }
  class WebGLRenderer {
    domElement = document.createElement('canvas');
    setPixelRatio(): void {}
    setSize(): void {}
    render(): void {}
    dispose(): void {}
  }
  class Scene {
    add(): void {}
  }
  class PerspectiveCamera {
    position = new Vec3Stub();
    up = new Vec3Stub();
    aspect = 1;
    updateProjectionMatrix(): void {}
  }
  return { WebGLRenderer, Scene, PerspectiveCamera };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => {
  class OrbitControls {
    target = { set: vi.fn() };
    update(): void {}
    dispose(): void {}
  }
  return { OrbitControls };
});

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

const DONE_JOB = {
  id: 'abc123def456',
  status: 'done' as const,
  stage: 'done',
  pct: 100,
  error: null,
  n_gaussians: 482_113,
  log_tail: [],
};

describe('CityApp', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('shows the empty state and no-jobs copy when GET /api/recon/jobs returns none', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      if (url.toString().includes('/api/recon/jobs')) return jsonResponse({ jobs: [] });
      return jsonResponse({});
    });

    render(<CityApp />);

    await waitFor(() =>
      expect(screen.getByText(/no finished recon jobs yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/no scene loaded/i)).toBeInTheDocument();
    // Appears twice: the rail header and the empty-state panel.
    expect(screen.getAllByText('CITY 3D').length).toBe(2);
  });

  it('lists finished recon jobs with id + splat count from GET /api/recon/jobs', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      if (url.toString().includes('/api/recon/jobs')) return jsonResponse({ jobs: [DONE_JOB] });
      return jsonResponse({});
    });

    render(<CityApp />);

    await waitFor(() =>
      expect(screen.getByTestId(`city-job-${DONE_JOB.id}`)).toBeInTheDocument(),
    );
    expect(screen.getByText(DONE_JOB.id)).toBeInTheDocument();
    expect(screen.getByText('482,113 pts')).toBeInTheDocument();
    // Still shows the empty viewer state — no job clicked yet.
    expect(screen.getByText(/no scene loaded/i)).toBeInTheDocument();
  });

  it('offers the keyless "Splat this city" satellite→Gaussian action', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      if (url.toString().includes('/api/recon/jobs')) return jsonResponse({ jobs: [] });
      return jsonResponse({});
    });

    render(<CityApp />);

    await waitFor(() =>
      expect(screen.getByText(/no finished recon jobs yet/i)).toBeInTheDocument(),
    );
    // The whole-world keyless splat path (satToSplat.ts) is surfaced as a button.
    expect(screen.getByText(/splat this city/i)).toBeInTheDocument();
  });

  it('loads a recon job into the viewer on click and shows the source chip', async () => {
    mockedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/api/recon/jobs') && !u.includes('result') && !u.includes('camera')) {
        return jsonResponse({ jobs: [DONE_JOB] });
      }
      if (u.includes('result.spz')) return jsonResponse({}, true); // probe: .spz exists
      if (u.includes('camera.json')) {
        return jsonResponse({ position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] });
      }
      void init;
      return jsonResponse({}, false);
    });

    render(<CityApp />);

    await waitFor(() => expect(screen.getByTestId(`city-job-${DONE_JOB.id}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`city-job-${DONE_JOB.id}`));

    await waitFor(() => expect(screen.getByText('recon')).toBeInTheDocument());
    expect(screen.getByTitle(`recon job ${DONE_JOB.id}`)).toBeInTheDocument();
    expect(screen.queryByText(/no scene loaded/i)).toBeNull();
  });
});
