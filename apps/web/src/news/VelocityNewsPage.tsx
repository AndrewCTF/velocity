// apps/web/src/news/VelocityNewsPage.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../transport/http.js';
import type { Edition, Story } from './types.js';
import './news.css';

function Card({ s }: { s: Story }): JSX.Element {
  return (
    <Link to={`/news/${s.id}`} className="vn-card">
      {s.image ? <img src={s.image} alt="" loading="lazy" /> : <div className="vn-card-ph" style={{ aspectRatio: '16/9', background: '#e2e2dd', borderRadius: 3 }} />}
      <h3>{s.title}</h3>
      <p>{s.neutral_summary}</p>
      <div className="vn-byline">
        {s.category} · {s.corroboration?.source_count ?? 0} sources
        {s.whats_wrong?.length ? ` · ${s.whats_wrong.length} bias flags` : ''}
      </div>
    </Link>
  );
}

export function VelocityNewsPage(): JSX.Element {
  const [ed, setEd] = useState<Edition | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/news/edition')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: Edition) => { if (alive) setEd(j); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, []);

  const cats = ed?.categories ?? [];
  const lead = ed?.lead ?? null;
  const rest = (ed?.stories ?? []).filter((s) => s.id !== lead?.id);

  return (
    <div className="vnews">
      <div className="vn-wrap">
        <div className="vn-masthead">
          <Link to="/news" className="vn-brand">VELOCITY <b>NEWS</b></Link>
        </div>
        <nav className="vn-nav">
          {cats.map((c) => <a key={c} href={`#${c}`}>{c}</a>)}
        </nav>

        {!ed && !err && <p style={{ padding: '40px 0' }}>Loading the edition…</p>}
        {err && <p style={{ padding: '40px 0' }}>News is unavailable right now.</p>}
        {ed && ed.stories.length === 0 && (
          <p style={{ padding: '40px 0' }}>The edition is being assembled — check back shortly.</p>
        )}

        {lead && (
          <Link to={`/news/${lead.id}`} className="vn-hero">
            <div>
              {lead.image && <img src={lead.image} alt="" />}
            </div>
            <div>
              <span className="vn-chip">{lead.category}</span>
              <h1>{lead.title}</h1>
              <p>{lead.neutral_summary}</p>
              <div className="vn-byline">{lead.corroboration?.source_count ?? 0} sources corroborating</div>
            </div>
          </Link>
        )}

        {cats.map((c) => {
          const inCat = rest.filter((s) => s.category === c);
          if (inCat.length === 0) return null;
          return (
            <section key={c} id={c}>
              <div className="vn-sec-title">{c}</div>
              <div className="vn-grid">
                {inCat.map((s) => <Card key={s.id} s={s} />)}
              </div>
            </section>
          );
        })}

        {ed && (
          <p className="vn-byline" style={{ marginTop: 40 }}>
            {ed.article_count} articles · {ed.source_count} sources · model {ed.backend ?? 'n/a'}
          </p>
        )}
      </div>
    </div>
  );
}
