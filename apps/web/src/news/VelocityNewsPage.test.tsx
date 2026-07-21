// Regression coverage for the BBC/CNN-grade Velocity News front page:
// verification badges per status, graceful degradation with no verification
// field, the daily-brief strip (present + 404-hidden), the latest-headlines
// ticker, and most-covered ordering.

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VelocityNewsPage } from './VelocityNewsPage.js';
import type { Brief, Edition, FeedResponse, Story } from './types.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? 'OK' : 'Not Found', json: async () => body } as unknown as Response;
}

function story(over: Partial<Story>): Story {
  return {
    id: over.id ?? 'a',
    category: 'World',
    title: 'Untitled story',
    image: '',
    neutral_summary: 'summary',
    neutral_rewrite: '',
    corroboration: { source_count: 0, sources: [] },
    verified_facts: [],
    attributed_claims: [],
    whats_wrong: [],
    propaganda_techniques: [],
    rhetoric_flags: [],
    recommended_actions: [],
    proofs: [],
    supporting_docs: [],
    confidence: 0,
    ...over,
  };
}

function edition(stories: Story[]): Edition {
  return {
    generated: new Date().toISOString(),
    categories: [...new Set(stories.map((s) => s.category))],
    lead: stories[0] ?? null,
    stories,
    method: 'agent',
    backend: 'test-backend',
    article_count: stories.length,
    source_count: 3,
  };
}

const emptyBrief: Brief = {
  generated_utc: new Date().toISOString(),
  categories: [],
  top: [],
  synthesis: '',
  synthesis_error: '',
  freshness: {},
};

function routeFetch(routes: Record<string, unknown>): (url: string) => Promise<Response> {
  return async (url: string) => {
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        if (body === '404') return jsonResponse({ error: 'no brief yet' }, false, 404);
        return jsonResponse(body);
      }
    }
    return jsonResponse({}, false, 404);
  };
}

describe('VelocityNewsPage: verification badges', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('renders a tone-specific badge per verification status', async () => {
    const stories = [
      story({ id: 'v1', title: 'Verified story', verification: { status: 'verified-neutral', models: ['a', 'b'], verdicts: 2 } }),
      story({ id: 'v2', title: 'Revised story', category: 'Tech', verification: { status: 'reviewed-revised', models: ['a', 'b'], verdicts: 2 } }),
      story({ id: 'v3', title: 'Contested story', category: 'Politics', verification: { status: 'contested', models: ['a', 'b'], verdicts: 2 } }),
    ];
    mockedFetch.mockImplementation(routeFetch({
      '/api/news/edition': edition(stories),
      '/api/news/brief': '404',
      '/api/news/feed': { count: 0, articles: [] },
    }));

    render(<MemoryRouter><VelocityNewsPage /></MemoryRouter>);

    expect(await screen.findByText('verified')).toBeTruthy();
    expect(screen.getByText('revised')).toBeTruthy();
    expect(screen.getByText('contested')).toBeTruthy();
    expect(screen.getByText('verified').closest('.vn-badge')?.className).toContain('vn-badge-ok');
    expect(screen.getByText('contested').closest('.vn-badge')?.className).toContain('vn-badge-alert');
  });

  it('degrades cleanly when a story has no verification field at all', async () => {
    const stories = [story({ id: 'n1', title: 'Unverified story' })];
    mockedFetch.mockImplementation(routeFetch({
      '/api/news/edition': edition(stories),
      '/api/news/brief': '404',
      '/api/news/feed': { count: 0, articles: [] },
    }));

    render(<MemoryRouter><VelocityNewsPage /></MemoryRouter>);

    expect(await screen.findByText('Unverified story')).toBeTruthy();
    expect(screen.queryByText('verified')).toBeNull();
    expect(screen.queryByText('reviewed')).toBeNull();
  });

  it('degrades cleanly when verification was skipped (no models installed)', async () => {
    const stories = [story({ id: 's1', title: 'Skipped story', verification: { skipped: 'no verifier models installed' } })];
    mockedFetch.mockImplementation(routeFetch({
      '/api/news/edition': edition(stories),
      '/api/news/brief': '404',
      '/api/news/feed': { count: 0, articles: [] },
    }));

    render(<MemoryRouter><VelocityNewsPage /></MemoryRouter>);

    expect(await screen.findByText('Skipped story')).toBeTruthy();
    expect(document.querySelector('.vn-badge')).toBeNull();
  });
});

describe('VelocityNewsPage: daily-brief strip', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('renders the synthesis paragraph and a freshness line', async () => {
    const brief: Brief = {
      ...emptyBrief,
      synthesis: 'The day in brief: everything is fine.',
      freshness: { articles_age_s: 720, feeds_fetched: 98, feeds_total: 101, verified_count: 23 },
    };
    mockedFetch.mockImplementation(routeFetch({
      '/api/news/edition': edition([story({ id: 'a' })]),
      '/api/news/brief': brief,
      '/api/news/feed': { count: 0, articles: [] },
    }));

    render(<MemoryRouter><VelocityNewsPage /></MemoryRouter>);

    expect(await screen.findByText('The day in brief: everything is fine.')).toBeTruthy();
    expect(screen.getByText(/12 min ago/)).toBeTruthy();
    expect(screen.getByText(/98 of 101 feeds/)).toBeTruthy();
    expect(screen.getByText(/23 verified/)).toBeTruthy();
  });

  it('hides cleanly when the brief endpoint 404s (no brief yet)', async () => {
    mockedFetch.mockImplementation(routeFetch({
      '/api/news/edition': edition([story({ id: 'a', title: 'Some story' })]),
      '/api/news/brief': '404',
      '/api/news/feed': { count: 0, articles: [] },
    }));

    render(<MemoryRouter><VelocityNewsPage /></MemoryRouter>);

    expect(await screen.findByText('Some story')).toBeTruthy();
    expect(document.querySelector('.vn-brief')).toBeNull();
  });
});

describe('VelocityNewsPage: latest ticker', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('renders newest raw headlines from /api/news/feed', async () => {
    const feed: FeedResponse = {
      count: 2,
      articles: [
        { title: 'Headline One', summary: '', link: 'https://a.example/1', source: 'Reuters', leaning: null, published: new Date().toISOString() },
        { title: 'Headline Two', summary: '', link: 'https://a.example/2', source: 'AP', leaning: null, published: new Date().toISOString() },
      ],
    };
    mockedFetch.mockImplementation(routeFetch({
      '/api/news/edition': edition([story({ id: 'a', title: 'Lead story' })]),
      '/api/news/brief': '404',
      '/api/news/feed': feed,
    }));

    render(<MemoryRouter><VelocityNewsPage /></MemoryRouter>);

    const rail = await screen.findByText('Latest');
    const container = rail.closest('.vn-rail-latest') as HTMLElement;
    expect(within(container).getByText('Headline One')).toBeTruthy();
    expect(within(container).getByText('Headline Two')).toBeTruthy();
    expect(within(container).getByText('Reuters')).toBeTruthy();
  });
});

describe('VelocityNewsPage: most-covered rail', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('orders stories by corroboration source_count, highest first', async () => {
    const stories = [
      story({ id: 'low', title: 'Low coverage', corroboration: { source_count: 2, sources: [] } }),
      story({ id: 'high', title: 'High coverage', category: 'Tech', corroboration: { source_count: 9, sources: [] } }),
      story({ id: 'mid', title: 'Mid coverage', category: 'Politics', corroboration: { source_count: 5, sources: [] } }),
    ];
    mockedFetch.mockImplementation(routeFetch({
      '/api/news/edition': edition(stories),
      '/api/news/brief': '404',
      '/api/news/feed': { count: 0, articles: [] },
    }));

    render(<MemoryRouter><VelocityNewsPage /></MemoryRouter>);

    const rail = await screen.findByText('Most covered');
    const container = rail.closest('.vn-rail-covered') as HTMLElement;
    await waitFor(() => expect(within(container).getAllByText(/coverage/).length).toBeGreaterThan(0));
    const titles = within(container).getAllByText(/coverage/).map((el) => el.textContent);
    expect(titles).toEqual(['High coverage', 'Mid coverage', 'Low coverage']);
  });
});
