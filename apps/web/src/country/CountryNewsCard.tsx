// Country news card — /api/news/feed?iso3=<iso3>, filtered server-side to
// headlines whose title/summary names this country (see app/routes/news.py).
// Hides entirely when the feed is disabled or empty for this country, rather
// than rendering a permanent empty shell. All backend calls go through
// useCachedFetch (apiFetch, transport invariant); the URL embeds iso3, so
// switching countries is its own cache entry the same way the other
// per-country cards work.

import { Card, Skeleton, useCachedFetch } from './shared.js';

interface NewsArticle {
  title: string;
  summary: string;
  link: string;
  source: string;
  leaning: string;
  published: string | null;
}

interface NewsFeedResponse {
  enabled?: boolean;
  count: number;
  articles: NewsArticle[];
}

const MAX_ROWS = 8;

function NewsRow({ a }: { a: NewsArticle }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-1 border-b border-line last:border-b-0 min-w-0">
      <div className="min-w-0 flex-1">
        {a.link ? (
          <a
            href={a.link}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-txt-1 hover:text-txt-0 hover:underline"
          >
            {a.title}
          </a>
        ) : (
          <span className="text-[11px] text-txt-1">{a.title}</span>
        )}
        <span className="text-[10px] text-txt-3"> · {a.source}</span>
      </div>
      {a.published && (
        <span className="mono text-[9.5px] text-txt-4 shrink-0">{a.published.slice(0, 10)}</span>
      )}
    </div>
  );
}

export function CountryNewsCard({ iso3 }: { iso3: string }): JSX.Element | null {
  const { loading, error, data } = useCachedFetch<NewsFeedResponse>(
    iso3 ? `/api/news/feed?iso3=${encodeURIComponent(iso3)}` : null,
  );

  if (loading) {
    return (
      <Card title="News">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </Card>
    );
  }

  // Disabled feed, a failed fetch, or zero matching headlines: hide the card
  // rather than showing a permanently empty shell.
  if (error || !data || data.enabled === false) return null;
  const articles = data.articles ?? [];
  if (articles.length === 0) return null;

  const rows = articles.slice(0, MAX_ROWS);
  return (
    <Card title="News" meta={`${articles.length} headline${articles.length === 1 ? '' : 's'}`}>
      <div className="flex flex-col">
        {rows.map((a, i) => (
          <NewsRow key={`${a.link || a.title}-${i}`} a={a} />
        ))}
      </div>
    </Card>
  );
}
