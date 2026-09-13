// Scheme allowlist for URLs that arrive from the network (ASVS V1.2.2 / V3.2.1).
//
// Feed items, enrichment payloads, OSINT connectors and model prose all hand us
// strings we then put in an href or a src. React 19 blocks a literal
// `javascript:` href, but not `data:text/html`, `vbscript:`, or a scheme hidden
// behind whitespace, and it does nothing for src. So every data-derived link
// passes through here: http: and https: survive, and a relative path survives
// because it resolves against this page's own http(s) origin. Anything else
// becomes undefined, which renders as no attribute at all.
//
// Not for URLs this app mints itself (blob: object URLs, symbol data: URIs);
// those are not network data and would be dropped.

const ALLOWED = new Set(['http:', 'https:']);

export function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  let parsed: URL;
  try {
    const base =
      typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
        ? window.location.href
        : 'http://localhost/';
    parsed = new URL(s, base);
  } catch {
    return undefined;
  }
  return ALLOWED.has(parsed.protocol) ? s : undefined;
}
