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

  const allQuotes = story ? story.whats_wrong.map((w) => w.quote) : [];

  return (
    <div className="vnews">
      <div className="vn-wrap">
        <div className="vn-masthead">
          <Link to="/news" className="vn-brand">VELOCITY <b>NEWS</b></Link>
        </div>

        {missing && <p style={{ padding: '40px 0' }}><Link to="/news">← Back</Link> · Story not found.</p>}
        {!story && !missing && <p style={{ padding: '40px 0' }}>Loading…</p>}

        {story && (
          <article className="vn-article">
            <Link to="/news" className="vn-byline">← All stories</Link>
            <span className="vn-chip" style={{ marginLeft: 8 }}>{story.category}</span>
            <h1 style={{ fontSize: 32, margin: '12px 0' }}>{story.title}</h1>
            <div className="vn-byline">
              {story.corroboration?.source_count ?? 0} sources · confidence {(story.confidence ?? 0).toFixed(2)}
            </div>
            {story.image && <img src={story.image} alt="" style={{ width: '100%', borderRadius: 3, margin: '14px 0' }} />}

            {story.neutral_rewrite.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{highlight(para, allQuotes)}</p>
            ))}

            {story.whats_wrong.length > 0 && (
              <div className="vn-callout">
                <h4>What's wrong with the coverage</h4>
                {story.whats_wrong.map((w, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <span className="vn-tag">{w.technique || 'bias'}</span>
                    <strong>{w.source}</strong>: <span className="vn-quote">{w.quote}</span>
                  </div>
                ))}
                {story.propaganda_techniques.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {story.propaganda_techniques.map((t) => <span key={t} className="vn-tag">{t}</span>)}
                  </div>
                )}
              </div>
            )}

            {story.recommended_actions.length > 0 && (
              <div className="vn-actions">
                <h4 style={{ margin: '0 0 8px', color: '#1c6aa8', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em' }}>What you should do</h4>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {story.recommended_actions.map((a, i) => <li key={i} style={{ marginBottom: 4 }}>{a}</li>)}
                </ul>
              </div>
            )}

            {story.verified_facts.length > 0 && (
              <>
                <h3 style={{ marginTop: 24 }}>Verified facts</h3>
                <ul>{story.verified_facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </>
            )}

            {story.proofs.length > 0 && (
              <div className="vn-proofs">
                <h3 style={{ marginTop: 24 }}>Proof &amp; sources</h3>
                {story.proofs.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer">
                    {p.source} ↗ {p.published ? `(${p.published.slice(0, 10)})` : ''}
                  </a>
                ))}
              </div>
            )}

            {story.supporting_docs.length > 0 && (
              <div className="vn-support">
                <h3 style={{ marginTop: 24 }}>Supporting documents (live dashboard signals)</h3>
                {story.supporting_docs.map((d, i) => {
                  if (d.kind === 'satellite' && d.url) {
                    return (
                      <figure key={i} style={{ margin: '12px 0' }}>
                        <img src={backendUrl(d.url)} alt={d.caption ?? ''} />
                        <figcaption className="vn-byline">{d.caption}</figcaption>
                      </figure>
                    );
                  }
                  return (
                    <div key={i} style={{ margin: '10px 0' }}>
                      <span className="vn-tag">{d.threat_level || 'signal'}</span> {d.narrative}
                    </div>
                  );
                })}
                <Link to="/" className="vn-byline">Open the live dashboard →</Link>
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
