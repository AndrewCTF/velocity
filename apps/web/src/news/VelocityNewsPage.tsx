// apps/web/src/news/VelocityNewsPage.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../transport/http.js';
import type { Brief, Edition, FeedArticle, FeedResponse, Story, Verification } from './types.js';
import './news.css';

const TICKER_REFRESH_MS = 60_000;

function Media({ src, title }: { src: string; title: string }): JSX.Element {
  return (
    <div className="vn-media">
      {src
        ? <img src={src} alt="" loading="lazy" />
        : <div className="vn-media-ph">{(title[0] || 'V').toUpperCase()}</div>}
    </div>
  );
}

function TrustRow({ s }: { s: Story }): JSX.Element {
  const n = s.corroboration?.source_count ?? 0;
  const filled = Math.min(n, 5);
  return (
    <div className="vn-trust">
      <span className="vn-dots" title={`${n} corroborating sources`}>
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={`vn-dot${i < filled ? '' : ' off'}`} />
        ))}
      </span>
      <span className="vn-corr">{n} {n === 1 ? 'source' : 'sources'}</span>
      {s.whats_wrong?.length > 0 && (
        <span className="vn-flag">{s.whats_wrong.length} bias {s.whats_wrong.length === 1 ? 'flag' : 'flags'}</span>
      )}
      <StatusBadge s={s} />
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  'verified-neutral': 'verified',
  'reviewed-revised': 'revised',
  contested: 'contested',
  reviewed: 'reviewed',
  unverified: 'unverified',
};
export const STATUS_TONE: Record<string, 'ok' | 'warn' | 'alert' | 'neutral'> = {
  'verified-neutral': 'ok',
  'reviewed-revised': 'warn',
  contested: 'alert',
  reviewed: 'neutral',
  unverified: 'neutral',
};

/** Verification badge with a click-to-open evidence popover. Degrades to
 * nothing when a story has no verification (skipped, or field absent). */
function StatusBadge({ s }: { s: Story }): JSX.Element | null {
  const v: Verification | undefined = s.verification;
  const status = v?.status;
  if (!status) return null;
  const tone = STATUS_TONE[status] ?? 'neutral';
  const label = STATUS_LABEL[status] ?? status;
  const outlets = v.diversity?.buckets ?? [];
  const sources = s.corroboration?.sources ?? [];
  return (
    <details className={`vn-badge vn-badge-${tone}`} onClick={(e) => e.stopPropagation()}>
      <summary>{label}</summary>
      <div className="vn-evidence">
        {v.models?.length ? <div>Reviewed by {v.verdicts ?? v.models.length} model{(v.verdicts ?? v.models.length) === 1 ? '' : 's'}</div> : null}
        {outlets.length > 0 && <div>Leanings seen: {outlets.join(' · ')}</div>}
        {sources.length > 0 && <div>Outlets: {sources.join(' · ')}</div>}
        {!outlets.length && !sources.length && <div>No outlet evidence recorded.</div>}
      </div>
    </details>
  );
}

function Card({ s, lead = false }: { s: Story; lead?: boolean }): JSX.Element {
  return (
    <Link to={`/news/${s.id}`} className={`vn-card${lead ? ' lead' : ''}`}>
      <Media src={s.image} title={s.title} />
      <div className="vn-kicker">{s.category}</div>
      <h3 className="vn-h">{s.title}</h3>
      {(lead || s.neutral_summary) && <p className="vn-dek">{s.neutral_summary}</p>}
      <TrustRow s={s} />
    </Link>
  );
}

/** BBC-style category block: lead card (image) on the left, a headline-only
 * list of the next few stories on the right. */
function CategoryBlock({ category, stories }: { category: string; stories: Story[] }): JSX.Element | null {
  if (stories.length === 0) return null;
  const lead = stories[0] as Story;
  const list = stories.slice(1, 5);
  return (
    <section id={`cat-${category}`} className="vn-section">
      <div className="vn-section-head">
        <span className="vn-section-title"><span>/</span> {category}</span>
        <span className="vn-section-count">{stories.length} stories</span>
      </div>
      <div className="vn-catblock">
        <Card s={lead} lead />
        {list.length > 0 && (
          <ul className="vn-headlist">
            {list.map((s) => (
              <li key={s.id}>
                <Link to={`/news/${s.id}`}>
                  <span className="vn-kicker">{s.category}</span>
                  <h4 className="vn-h">{s.title}</h4>
                  <TrustRow s={s} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function ageLabel(secs?: number | null): string {
  if (secs == null) return '';
  if (secs < 90) return `${Math.round(secs)}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/** Daily-brief strip: one synthesis paragraph + a freshness line. Hides
 * cleanly when no brief exists yet (404) or the brief has no synthesis. */
function BriefStrip(): JSX.Element | null {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/news/brief')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Brief | null) => { if (alive) { setBrief(j); setChecked(true); } })
      .catch(() => { if (alive) setChecked(true); });
    return () => { alive = false; };
  }, []);

  if (!checked || !brief || !brief.synthesis) return null;
  const f = brief.freshness ?? {};
  const parts: string[] = [];
  const age = ageLabel(f.articles_age_s);
  if (age) parts.push(`updated ${age}`);
  if (f.feeds_fetched != null && f.feeds_total != null) parts.push(`${f.feeds_fetched} of ${f.feeds_total} feeds`);
  if (f.verified_count != null) parts.push(`${f.verified_count} verified`);

  return (
    <section className="vn-brief">
      <span className="vn-kicker">Today’s brief</span>
      <p className="vn-brief-text">{brief.synthesis}</p>
      {parts.length > 0 && <div className="vn-brief-meta">{parts.join(' · ')}</div>}
    </section>
  );
}

/** Top-6 rail ranked by corroboration source count — "most covered". */
function MostCoveredRail({ stories }: { stories: Story[] }): JSX.Element | null {
  const top = [...stories]
    .filter((s) => (s.corroboration?.source_count ?? 0) > 0)
    .sort((a, b) => (b.corroboration?.source_count ?? 0) - (a.corroboration?.source_count ?? 0))
    .slice(0, 6);
  if (top.length === 0) return null;
  return (
    <aside className="vn-rail vn-rail-covered">
      <div className="vn-rail-head">Most covered</div>
      <ol>
        {top.map((s) => (
          <li key={s.id}>
            <Link to={`/news/${s.id}`}>
              <span className="vn-rail-count">{s.corroboration?.source_count ?? 0}</span>
              <span className="vn-rail-title">{s.title}</span>
            </Link>
          </li>
        ))}
      </ol>
    </aside>
  );
}

/** Latest raw headlines, newest first — polls /api/news/feed on the same
 * setInterval pattern NewsPanel uses. Static list (marquee-free). */
function LatestTicker(): JSX.Element | null {
  const [items, setItems] = useState<FeedArticle[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/news/feed');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as FeedResponse;
        if (!cancelled && Array.isArray(j.articles)) setItems(j.articles.slice(0, 12));
      } catch {
        /* swallow — keep the last good list */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), TICKER_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (items.length === 0) return null;
  return (
    <aside className="vn-rail vn-rail-latest">
      <div className="vn-rail-head">Latest</div>
      <ul>
        {items.map((a, i) => (
          <li key={`${a.link}-${i}`}>
            <a href={a.link} target="_blank" rel="noreferrer">
              <span className="vn-rail-title">{a.title}</span>
              <span className="vn-rail-meta">
                <span className="vn-src-chip">{a.source}</span>
                {a.published && <span>{relativeTime(a.published)}</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function VelocityNewsPage(): JSX.Element {
  const [ed, setEd] = useState<Edition | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/news/edition')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad status'))))
      .then((j: Edition) => { if (alive) setEd(j); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, []);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const stories = ed?.stories ?? [];
  const lead = ed?.lead ?? stories[0] ?? null;
  const side = stories.filter((s) => s.id !== lead?.id).slice(0, 5);
  const heroIds = new Set([lead?.id, ...side.map((s) => s.id)].filter(Boolean));
  const cats = ed?.categories ?? [];

  return (
    <div className="vnews">
      <div className="vn-wrap">
        <div className="vn-strip">
          <span className="vn-live">Live</span>
          <span>Debiased · fact-checked</span>
          <span className="vn-grow">{today}</span>
          {ed && <span>{ed.source_count} sources</span>}
        </div>

        <div className="vn-masthead">
          <Link to="/news" className="vn-brand">VELOCITY <mark>NEWS</mark></Link>
          <div className="vn-tagline">Every story, de-spun: bias &amp; propaganda flagged, sources shown</div>
        </div>

        <nav className="vn-nav">
          {cats.map((c) => <a key={c} href={`#cat-${c}`}>{c}</a>)}
        </nav>

        <BriefStrip />

        {!ed && !err && (
          <>
            <div className="vn-hero">
              <div><div className="vn-media vn-skel" style={{ aspectRatio: '16/9' }} /></div>
              <div className="vn-hero-side">
                {[0, 1, 2].map((i) => <div key={i} className="vn-skel" style={{ height: 88 }} />)}
              </div>
            </div>
          </>
        )}
        {err && <div className="vn-state">News is unavailable right now. Please try again shortly.</div>}
        {ed && stories.length === 0 && <div className="vn-state">Today’s edition is still being assembled.</div>}

        {lead && (
          <section className="vn-hero">
            <Link to={`/news/${lead.id}`} className="vn-hero-lead">
              <Media src={lead.image} title={lead.title} />
              <div className="vn-kicker">{lead.category}</div>
              <h1 className="vn-h">{lead.title}</h1>
              <p className="vn-dek">{lead.neutral_summary}</p>
              <TrustRow s={lead} />
            </Link>
            <div className="vn-hero-side">
              {side.map((s) => (
                <Link key={s.id} to={`/news/${s.id}`} className="vn-side-item">
                  <div>
                    <div className="vn-kicker">{s.category}</div>
                    <h3 className="vn-h">{s.title}</h3>
                    <TrustRow s={s} />
                  </div>
                  <Media src={s.image} title={s.title} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {stories.length > 0 && (
          <div className="vn-rails">
            <MostCoveredRail stories={stories} />
            <LatestTicker />
          </div>
        )}

        {cats.map((c) => (
          <CategoryBlock key={c} category={c} stories={stories.filter((s) => s.category === c && !heroIds.has(s.id))} />
        ))}

        {ed && stories.length > 0 && (
          <div className="vn-foot">
            <span>{stories.length} stories</span>
            <span>{ed.article_count} articles · {ed.source_count} sources</span>
            <span>Analysis: {ed.backend ?? 'pending'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
