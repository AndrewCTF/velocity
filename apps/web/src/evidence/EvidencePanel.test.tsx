import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

// ASVS V1.3.4: evidence bytes are never rewritten (chain of custody), so an
// uploaded SVG stays an SVG. The panel must not turn it into a same-origin
// image/svg+xml blob URL, and a thumbnail's blob is typed by the allowlist,
// not by whatever the uploader declared.

// A plain object, not a Response: jsdom's Blob cannot seed Node's Response.
const apiFetch = vi.fn(async () => ({
  ok: true,
  blob: async () => new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }),
}));
vi.mock('../transport/http.js', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [])) }));

import { EvidencePanel, thumbnailType } from './EvidencePanel.js';
import { useEvidence, type EvidenceObject } from './evidenceStore.js';
import { useSituations } from '../situations/situationStore.js';

function exhibit(sha: string, media_type: string): EvidenceObject {
  return {
    id: sha,
    kind: 'Evidence',
    props: { sha256: sha, media_type, title: `ex-${sha}` },
  } as unknown as EvidenceObject;
}

describe('evidence thumbnails (ASVS V1.3.4)', () => {
  const created: Blob[] = [];
  beforeEach(() => {
    created.length = 0;
    apiFetch.mockClear();
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        created.push(b);
        return `blob:test/${created.length}`;
      },
      revokeObjectURL: () => undefined,
    }));
    useSituations.setState({ load: async () => undefined } as never);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('allowlists raster types only', () => {
    expect(thumbnailType('image/png')).toBe('image/png');
    expect(thumbnailType('IMAGE/JPEG; charset=binary')).toBe('image/jpeg');
    expect(thumbnailType('image/svg+xml')).toBeNull();
    expect(thumbnailType('text/html')).toBeNull();
    expect(thumbnailType(undefined)).toBeNull();
  });

  it('renders no image for an SVG exhibit and re-types a raster one', async () => {
    useEvidence.setState({
      items: [exhibit('aaa', 'image/svg+xml'), exhibit('bbb', 'image/png')],
      loading: false,
      load: async () => undefined,
    } as never);
    render(<EvidencePanel />);
    await waitFor(() => expect(screen.getByAltText('ex-bbb')).toBeTruthy());
    expect(screen.queryByAltText('ex-aaa')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(created.map((b) => b.type)).toEqual(['image/png']);
  });
});
