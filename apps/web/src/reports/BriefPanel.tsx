import { useEffect, useState } from 'react';
import { useFeeds, useAlerts } from '../state/stores.js';
import { useEntityStats, acquireStats } from '../globe/entityStats.js';
import { apiFetch } from '../transport/http.js';
import type { AlertSeverity } from '@osint/shared';
import { SlidesDeck, type Slide } from '../slides/SlidesDeck.js';

// Live-data brief (design §8 "Slides/Stencil live-data briefs") — a print-ready
// situation brief generated from the SAME live stores the map reads (no fabricated
// history; this is the current picture). Four ways out of one derivation: rendered
// inline, presented full screen (SlidesDeck), exported as a self-contained HTML
// document, and exported as PPTX via /api/report/pptx. Collaborative broadcast
// stays out of scope for a single-operator build.

const SEVERITIES: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function BriefPanel(): JSX.Element {
  useEffect(() => acquireStats(), []);
  const [presenting, setPresenting] = useState(false);
  const stats = useEntityStats();
  const feeds = useFeeds((s) => s.feeds);
  const alerts = useAlerts((s) => s.alerts);

  const feedList = Object.values(feeds);
  const feedLive = feedList.filter((f) => f.status === 'green').length;
  const sevCount: Record<string, number> = {};
  for (const a of alerts) sevCount[a.severity] = (sevCount[a.severity] ?? 0) + 1;
  const topAlerts = alerts.slice(0, 8);

  const buildHtml = (): string => {
    const now = new Date().toISOString();
    const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
    const feedRows = feedList
      .map((f) => `<tr><td>${esc(f.label)}</td><td style="text-align:right">${f.status}</td></tr>`)
      .join('');
    const alertRows = topAlerts
      .map((a) => `<tr><td>${esc(a.severity)}</td><td>${esc(a.message)}</td><td>${esc(new Date(a.t).toISOString().slice(11, 19))}Z</td></tr>`)
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Situation brief ${now}</title>
<style>body{font:13px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 16px}
h1{font-size:16px;border-bottom:2px solid #111;padding-bottom:6px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-top:22px}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}
.cls{background:#0c3b1f;color:#86e0a6;text-align:center;font-weight:700;letter-spacing:.1em;padding:4px;text-transform:uppercase;font-size:11px}
.kpi{display:flex;gap:20px;margin:10px 0}.kpi div{border:1px solid #ccc;padding:8px 12px;border-radius:3px}.kpi b{font-size:20px;display:block}</style></head>
<body><div class="cls">Unclassified // Open-source intelligence</div>
<h1>Situation brief</h1><p>Generated ${now} · keyless OSINT picture</p>
<div class="kpi"><div><b>${stats.counted.toLocaleString()}</b>tracked contacts</div><div><b>${feedLive}/${feedList.length}</b>feeds live</div><div><b>${alerts.length}</b>alerts</div></div>
<h2>Alerts by severity</h2><p>${SEVERITIES.map((s) => `${s}: ${sevCount[s] ?? 0}`).join(' · ')}</p>
${topAlerts.length ? `<h2>Recent alerts</h2><table><tr><th>Sev</th><th>Message</th><th>Time</th></tr>${alertRows}</table>` : ''}
<h2>Sources</h2><table>${feedRows}</table>
</body></html>`;
  };

  const exportHtml = (): void => {
    const blob = new Blob([buildHtml()], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `situation-brief-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPptx = async (): Promise<void> => {
    const payload = {
      title: 'Situation brief',
      classification: 'Unclassified // Open-source intelligence',
      kpis: { contacts: stats.counted, feeds_live: feedLive, feeds_total: feedList.length, alerts: alerts.length },
      severity: Object.fromEntries(SEVERITIES.map((s) => [s, sevCount[s] ?? 0])),
      alerts: topAlerts.map((a) => `${a.severity.toUpperCase()}: ${a.message}`),
      sources: feedList.map((f) => `${f.label}: ${f.status}`),
    };
    try {
      const r = await apiFetch('/api/report/pptx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `situation-brief-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* transient — leave it to the operator to retry */
    }
  };

  const printBrief = (): void => {
    // Open the self-contained brief in a new tab via a blob URL (no document.write);
    // the operator prints it with Ctrl/Cmd-P. Content is esc()-escaped in buildHtml.
    const blob = new Blob([buildHtml()], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    // Revoke after the tab has had time to load.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  // The deck is the same content, one slide at a time, for briefing a room.
  // Built here rather than in the deck so there is one derivation of the
  // picture, not two that can disagree.
  const deckSlides: Slide[] = [
    {
      title: 'Situation brief',
      body: (
        <div className="space-y-4">
          <p className="mono text-[12px] text-txt-3">{new Date().toISOString()}</p>
          <div className="flex gap-8">
            {[
              ['Contacts', stats.counted.toLocaleString()],
              ['Feeds live', `${feedLive}/${feedList.length}`],
              ['Alerts', alerts.length.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="mono text-[32px] text-txt-0 tabular-nums leading-none">{value}</div>
                <div className="mono text-[11px] uppercase tracking-[0.5px] text-txt-3 mt-1">{label}</div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      title: 'Alerts by severity',
      body: (
        <ul className="space-y-1.5">
          {SEVERITIES.map((s) => (
            <li key={s} className="flex items-baseline gap-4">
              <span className="mono text-[12px] uppercase tracking-[0.4px] text-txt-3 w-24">{s}</span>
              <span className="mono text-[20px] text-txt-0 tabular-nums">{sevCount[s] ?? 0}</span>
            </li>
          ))}
        </ul>
      ),
    },
    ...(topAlerts.length > 0
      ? [
          {
            title: 'Recent alerts',
            body: (
              <ul className="divide-y divide-line border-y border-line">
                {topAlerts.map((a) => (
                  <li key={a.id} className="py-2 flex items-start gap-3">
                    <span className="mono text-[11px] uppercase text-txt-3 w-20 shrink-0">{a.severity}</span>
                    <span className="text-[13px] text-txt-1 flex-1 leading-snug">{a.message}</span>
                    <span className="mono text-[11px] text-txt-4 shrink-0">
                      {new Date(a.t).toISOString().slice(11, 19)}Z
                    </span>
                  </li>
                ))}
              </ul>
            ),
          },
        ]
      : []),
    {
      title: 'Sources',
      body: (
        <ul className="grid grid-cols-2 gap-x-8 gap-y-1">
          {feedList.map((f) => (
            <li key={f.label} className="flex items-baseline justify-between gap-3 border-b border-line py-1">
              <span className="text-[12px] text-txt-1 truncate">{f.label}</span>
              <span className="mono text-[11px] text-txt-3">{f.status}</span>
            </li>
          ))}
        </ul>
      ),
    },
  ];

  return (
    <div className="p-3 flex flex-col gap-3 text-txt-1">
      <div className="flex items-center justify-between">
        <span className="font-label uppercase tracking-[0.8px] text-[11px] text-txt-1">Situation brief</span>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setPresenting(true)} className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line">
            Present
          </button>
          <button type="button" onClick={printBrief} className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line">
            Open / print
          </button>
          <button type="button" onClick={exportHtml} className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line">
            HTML
          </button>
          <button type="button" onClick={() => void exportPptx()} className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-0.5 rounded-sm border border-accent-line text-accent bg-accent-dim">
            Export PPTX
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          ['Contacts', stats.counted.toLocaleString()],
          ['Feeds live', `${feedLive}/${feedList.length}`],
          ['Alerts', alerts.length.toLocaleString()],
        ].map(([label, value]) => (
          <div key={label} className="border border-line rounded-sm bg-bg-1 px-3 py-2">
            <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3">{label}</div>
            <div className="mono text-[18px] text-txt-0 tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1">Alerts by severity</div>
        <div className="mono text-[11px] text-txt-2">
          {SEVERITIES.map((s) => `${s} ${sevCount[s] ?? 0}`).join('  ·  ')}
        </div>
      </div>

      {topAlerts.length > 0 && (
        <div>
          <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1">Recent alerts</div>
          <ul className="divide-y divide-line border-y border-line">
            {topAlerts.map((a) => (
              <li key={a.id} className="py-1.5 flex items-start gap-2">
                <span className="mono text-[10px] uppercase text-txt-3 w-14 shrink-0">{a.severity}</span>
                <span className="text-[11px] text-txt-1 flex-1 leading-snug line-clamp-2">{a.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mono text-[10px] text-txt-4 leading-snug">
        Live picture from keyless sources. Present opens a full-screen deck of this same brief; Export
        produces a self-contained HTML brief; Print opens the print dialog. (Collaborative broadcast is out
        of scope for a single-operator build.)
      </p>

      {presenting && (
        <SlidesDeck
          slides={deckSlides}
          classification="Unclassified // Open-source intelligence"
          onClose={() => setPresenting(false)}
        />
      )}
    </div>
  );
}
