// Complete HTML escape for strings interpolated into a hand-built HTML document
// (ASVS V1.2.1). All five of & < > " ' are replaced, so a value is safe in text
// AND inside a quoted attribute. Prefer React rendering; use this only where the
// output is a standalone HTML file or blob (BriefPanel's export and print view).
const MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => MAP[c] ?? c);
}
