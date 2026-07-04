// apps/web/src/news/StoryView.tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiFetch, backendUrl } from '../transport/http.js';
import type { Edition, Story } from './types.js';
import './news.css';

function highlight(text: string, quotes: string[]): (string | JSX.Element)[] {
  // Wrap each loaded quote found in the rewrite with a highlight span.
  let parts: (string | JSX.Element)[] = [text];
  quotes.filter(Boolean).forEach((q, qi) => {
    const next: (string | JSX.Element)[] = [];
    parts.forEach((p) => {
      if (typeof p !== 'string' || !p.includes(q)) { next.push(p); return; }
      const segs = p.split(q);
      segs.forEach((seg, i) => {
        if (seg) next.push(seg);
        if (i < segs.length - 1) next.push(<span key={`${qi}-${i}`} className="vn-quote">{q}</span>);
      });
    });
    parts = next;
  });
  return parts;
}

export function StoryView(): JSX.Element {
  const { id } = useParams();
  const [story, setStory] = useState<Story | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/news/edition')
      .then((r) => r.json())
      .then((j: Edition) => {
        if (!alive) return;
        const s = j.stories.find((x) => x.id === id) ?? null;
        if (s) setStory(s); else setMissing(true);
      })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [id]);

  const quotes = story ? story.whats_wrong.map((w) => w.quote) : [];
  const n = story?.corroboration?.source_count ?? 0;

  return (
    <div className="vnews">
      <div className="vn-wrap">
        <div className="vn-masthead">
          <Link to="/news" className="vn-brand">VELOCITY <mark>NEWS</mark></Link>
        </div>

        {missing && (
          <div className="vn-state"><Link to="/news" className="vn-back">← Back to the edition</Link><br /><br />Story not found.</div>
        )}
        {!story && !missing && <div className="vn-state">Loading…</div>}

        {story && (
          <article className="vn-article">
            <Link to="/news" className="vn-back">← All stories</Link>
            <div className="vn-kicker" style={{ marginTop: 14 }}>{story.category}</div>
            <h1>{story.title}</h1>
            <div className="vn-trust" style={{ marginBottom: 4 }}>
              <span className="vn-dots">
                {Array.from({ length: 5 }, (_, i) => (
                  <span key={i} className={`vn-dot${i < Math.min(n, 5) ? '' : ' off'}`} />
                ))}
              </span>
              <span className="vn-corr">{n} {n === 1 ? 'source corroborating' : 'sources corroborating'}</span>
              {story.confidence > 0 && <span>confidence {story.confidence.toFixed(2)}</span>}
            </div>

            {story.image && (
              <div className="vn-media vn-lead-media"><img src={story.image} alt="" /></div>
            )}
            {story.image && <div className="vn-cap">Lead image via source outlet</div>}

            <div className="vn-body">
              {(story.neutral_rewrite || story.neutral_summary).split(/\n{2,}/).map((para, i) => (
                <p key={i}>{highlight(para, quotes)}</p>
              ))}
              {!story.neutral_rewrite && (
                <p className="vn-cap" style={{ fontFamily: 'var(--mono)' }}>
                  Full neutral rewrite + bias analysis pending for this story.
                </p>
              )}
            </div>

            {story.whats_wrong.length > 0 && (
              <div className="vn-box wrong">
                <h4>⚠ What’s wrong with the coverage</h4>
                {story.whats_wrong.map((w, i) => (
                  <div key={i} className="vn-wrong-item">
                    {w.technique && <span className="vn-tech">{w.technique}</span>}
                    <span className="vn-src">{w.source}</span>
                    {w.quote && <> — <span className="vn-quote">{w.quote}</span></>}
                  </div>
                ))}
                {story.propaganda_techniques.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {story.propaganda_techniques.map((t) => <span key={t} className="vn-tech">{t}</span>)}
                  </div>
                )}
              </div>
            )}

            {story.recommended_actions.length > 0 && (
              <div className="vn-box act">
                <h4>What you should do</h4>
                <ul>{story.recommended_actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}

            {story.verified_facts.length > 0 && (
              <div className="vn-box facts">
                <h4>Corroborated facts</h4>
                <ul>{story.verified_facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </div>
            )}

            {story.proofs.length > 0 && (
              <div className="vn-box facts vn-proofs">
                <h4>Proof &amp; sources ({story.proofs.length})</h4>
                {story.proofs.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer">
                    <span>{p.source} ↗</span>
                    {p.published && <span className="vn-when">{p.published.slice(0, 10)}</span>}
                  </a>
                ))}
              </div>
            )}

            {story.supporting_docs.length > 0 && (
              <div className="vn-box facts vn-support">
                <h4>Supporting documents — live dashboard signals</h4>
                {story.supporting_docs.map((d, i) => (
                  d.kind === 'satellite' && d.url ? (
                    <figure key={i} style={{ margin: '8px 0' }}>
                      <img src={backendUrl(d.url)} alt={d.caption ?? ''} />
                      <figcaption className="vn-cap">{d.caption}</figcaption>
                    </figure>
                  ) : (
                    <div key={i} className="vn-wrong-item">
                      {d.threat_level && <span className="vn-tech" style={{ background: 'var(--ink)' }}>{d.threat_level}</span>}
                      {d.narrative}
                    </div>
                  )
                ))}
                <Link to="/" className="vn-back" style={{ display: 'inline-block', marginTop: 8 }}>Open the live dashboard →</Link>
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
