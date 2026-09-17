import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import * as Cesium from 'cesium';
import { Trace, ArchiveSeriesCard } from './ArchiveSeriesCard.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

// The one rule worth pinning: a gap in the archive is drawn as a gap.
// Bridging it with a straight segment would assert a position between two fixes
// that nobody observed, which is the same class of invention the no-synthesis
// motion guardrail exists to prevent.

function pathOf(el: HTMLElement): string {
  return el.querySelector('path')?.getAttribute('d') ?? '';
}

describe('Trace', () => {
  it('breaks the line across a missing sample instead of interpolating', () => {
    const { container } = render(<Trace values={[10, null, 30]} />);
    const d = pathOf(container);
    // Two move commands: the pen lifts at the gap and starts a new segment.
    expect((d.match(/M/g) ?? []).length).toBe(2);
  });

  it('draws one continuous segment when there are no gaps', () => {
    const { container } = render(<Trace values={[10, 20, 30]} />);
    const d = pathOf(container);
    expect((d.match(/M/g) ?? []).length).toBe(1);
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });

  it('renders nothing rather than a misleading flat line for one sample', () => {
    const { container } = render(<Trace values={[10, null, null]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('survives an all-null series', () => {
    const { container } = render(<Trace values={[null, null]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('handles a flat series without dividing by zero', () => {
    const { container } = render(<Trace values={[5, 5, 5]} />);
    expect(pathOf(container)).not.toContain('NaN');
  });
});

// ── ArchiveSeriesCard: the "Project 1 h" toggle ─────────────────────────────
//
// apiFetch is mocked at the transport boundary (repo convention, see
// AisGapCard.test.tsx). The viewer is a hand-rolled stub around a REAL
// Cesium.CustomDataSource (the same technique TimeDock.test.tsx uses) so the
// cone entity can be asserted present, then absent, without booting a WebGL
// context.

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => body } as unknown as Response;
}

const EMPTY_SERIES = { series: [] };
const PROJECTION_OK = {
  status: 'ok',
  mean_kn: 12.3,
  mean_hdg: 90,
  cone: {
    type: 'Polygon',
    coordinates: [
      [
        [10.0, 50.0],
        [10.1, 50.05],
        [10.2, 50.0],
        [10.1, 49.95],
        [10.0, 50.0],
      ],
    ],
  },
  eta: [{ name: 'Strait of Hormuz', eta_s: 7800, bearing_deg: 91, in_cone: true }],
};

function fakeViewer(): { viewer: Cesium.Viewer; ds: () => Cesium.CustomDataSource | undefined } {
  const sources: Cesium.DataSource[] = [];
  const dataSources = {
    add: (d: Cesium.DataSource) => {
      sources.push(d);
      return d;
    },
    getByName: (name: string) => sources.filter((s) => s.name === name),
  };
  const viewer = {
    dataSources,
    scene: { requestRender: () => {} },
    isDestroyed: () => false,
  } as unknown as Cesium.Viewer;
  return { viewer, ds: () => sources.find((s) => s.name === 'projection') as Cesium.CustomDataSource | undefined };
}

function mockRoutes(projectionBody: unknown = PROJECTION_OK, projectionOk = true): void {
  mockedFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u.startsWith('/api/history/project')) return jsonResponse(projectionBody, projectionOk ? 200 : 503);
    if (u.startsWith('/api/history/track')) return jsonResponse(EMPTY_SERIES);
    return jsonResponse({}, 404);
  });
}

describe('ArchiveSeriesCard — Project 1 h toggle', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('fetches /api/history/project for the selected id when toggled on', async () => {
    mockRoutes();
    const { viewer } = fakeViewer();
    render(<ArchiveSeriesCard id="vessel:244770688" kind="vessel" viewer={viewer} />);

    fireEvent.click(screen.getByText('Project 1 h'));

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith(expect.stringContaining('/api/history/project?id=vessel%3A244770688')),
    );
  });

  it('renders ETA rows once the projection resolves', async () => {
    mockRoutes();
    const { viewer } = fakeViewer();
    render(<ArchiveSeriesCard id="vessel:244770688" kind="vessel" viewer={viewer} />);

    fireEvent.click(screen.getByText('Project 1 h'));

    expect(await screen.findByText(/Strait of Hormuz/)).toBeTruthy();
    expect(screen.getByText(/in cone/)).toBeTruthy();
  });

  it('draws the cone as its own proj:<id> entity in a dedicated projection data source', async () => {
    mockRoutes();
    const { viewer, ds } = fakeViewer();
    render(<ArchiveSeriesCard id="vessel:244770688" kind="vessel" viewer={viewer} />);

    fireEvent.click(screen.getByText('Project 1 h'));

    await waitFor(() => expect(ds()?.entities.getById('proj:vessel:244770688')).toBeDefined());
  });

  it('removes the projection entity when toggled off', async () => {
    mockRoutes();
    const { viewer, ds } = fakeViewer();
    render(<ArchiveSeriesCard id="vessel:244770688" kind="vessel" viewer={viewer} />);

    const toggle = screen.getByText('Project 1 h');
    fireEvent.click(toggle);
    await waitFor(() => expect(ds()?.entities.getById('proj:vessel:244770688')).toBeDefined());

    fireEvent.click(toggle);
    await waitFor(() => expect(ds()?.entities.getById('proj:vessel:244770688')).toBeUndefined());
  });

  it('reports an insufficient projection as a sentence, not a crash', async () => {
    mockRoutes({ status: 'insufficient', reason: 'only 2 fix(es); need >=3' });
    const { viewer } = fakeViewer();
    render(<ArchiveSeriesCard id="vessel:244770688" kind="vessel" viewer={viewer} />);

    fireEvent.click(screen.getByText('Project 1 h'));

    expect(await screen.findByText(/Not enough recorded history to project this contact forward/)).toBeTruthy();
  });

  it('reports an HTTP error from the projection route as a sentence', async () => {
    mockRoutes({ detail: 'no fixes' }, false);
    const { viewer } = fakeViewer();
    render(<ArchiveSeriesCard id="vessel:244770688" kind="vessel" viewer={viewer} />);

    fireEvent.click(screen.getByText('Project 1 h'));

    expect(await screen.findByText(/Projection unavailable \(HTTP 503\)\./)).toBeTruthy();
  });
});
