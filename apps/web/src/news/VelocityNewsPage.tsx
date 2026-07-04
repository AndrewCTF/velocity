// apps/web/src/news/VelocityNewsPage.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../transport/http.js';
import type { Edition, Story } from './types.js';
import './news.css';

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
    </div>
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
  const side = stories.filter((s) => s.id !== lead?.id).slice(0, 3);
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
          <div className="vn-tagline">Every story, de-spun — bias &amp; propaganda flagged, sources shown</div>
        </div>

        <nav className="vn-nav">
          {cats.map((c) => <a key={c} href={`#cat-${c}`}>{c}</a>)}
        </nav>

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
        {ed && stories.length === 0 && <div className="vn-state">Today’s edition is being assembled — check back in a moment.</div>}

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

        {cats.map((c) => {
          const inCat = stories.filter((s) => s.category === c && !heroIds.has(s.id));
          if (inCat.length === 0) return null;
          return (
            <section key={c} id={`cat-${c}`} className="vn-section">
              <div className="vn-section-head">
                <span className="vn-section-title"><span>/</span> {c}</span>
                <span className="vn-section-count">{inCat.length} stories</span>
              </div>
              <div className="vn-grid">
                {inCat.map((s, i) => <Card key={s.id} s={s} lead={i === 0 && inCat.length > 2} />)}
              </div>
            </section>
          );
        })}

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
