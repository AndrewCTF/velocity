import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-wide version of the guard in SourcesPanel.test.ts.
//
// That one holds a hand-maintained list of one wave's routes. This one walks
// EVERY @router decorator under apps/api/app/routes and demands each route be
// reachable: called from somewhere in apps/web/src (a panel, a layer registry,
// an adapter), or listed below with the reason it is not.
//
// The failure it exists to catch is the one the operator reported on
// 2026-08-08: a backend that had grown ~90 routes no surface in the product
// could reach. A route with no caller and no stated exception is a feature
// nobody can find.

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, '..');
const API_ROUTES = join(HERE, '../../../api/app/routes');

/** Routes with no frontend caller ON PURPOSE, and why.
 *  Adding a line here is a decision, not a formality: it says an operator
 *  cannot reach this and does not need to. */
const EXEMPT: Record<string, string> = {
  // Infrastructure the browser reaches without naming the path.
  '/api/health': 'liveness probe for the process supervisor, not the UI',
  // Write/side-effect routes driven by an agent or a server-side caller.
  '/api/evidence/manifest': 'POST: written by the case exporter server-side',
  '/api/imagery/task': 'POST: commercial tasking, gated off in the keyless build',
  '/api/ai/batch': 'POST: batch runner for the MCP layer, no interactive surface',
  '/api/recon/sat': 'POST: RPC satellite job needs a local dataset tree, lab-only',
  '/api/intel/investigate': 'served through the AI app agent path, not called directly',
  '/api/intel/watch': 'drives the watch-officer loop server-side',
  '/api/intel/agent': 'MCP/agent entry point, not an operator control',
  // Redirect/proxy responses the browser consumes as a URL, never as JSON.
  '/api/ground/photo': 'image proxy: the URL is put in an <img src>, not fetched',
  // Reached through a path the search cannot see literally.
  '/api/intel/dossier/aircraft':
    'ObjectInspector builds /api/intel/dossier/${kind}/${ident} from the selection',
  // Aliases of a route that IS wired.
  '/api/adsb/lol/global': 'backwards-compatible alias of /api/adsb/global',
  // The one route whose caller is deliberately NOT the browser.
  '/api/ingest':
    'inbound push: an external sender calls it with a per-dataset token. ' +
    'The operator arms and revokes it from Foundry → Connections, which does ' +
    'have a UI address (POST/DELETE /api/foundry/datasets/{id}/ingest-token).',
};

interface Route {
  readonly file: string;
  readonly path: string;
}

function pyFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.py') && f !== '__init__.py')
    .map((f) => join(dir, f));
}

function extractRoutes(file: string): Route[] {
  const src = readFileSync(file, 'utf8');
  const routerArgs = /APIRouter\(([\s\S]*?)\)/.exec(src);
  const prefix = /prefix\s*=\s*"([^"]*)"/.exec(routerArgs?.[1] ?? '')?.[1] ?? '';
  const out: Route[] = [];
  const re = /@router\.(?:get|post|put|delete|patch)\(\s*\n?\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ file, path: prefix + (m[1] ?? '') });
  return out;
}

function webSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...webSources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** The literal prefix of a route, up to its first path parameter. A caller
 *  building `/api/entity/${id}/imagery` still contains `/api/entity/`, so the
 *  stem is what can honestly be searched for. */
function stem(path: string): string {
  return (path.split('{')[0] ?? '').replace(/\/$/, '');
}

const WEB_BLOB = webSources(WEB_SRC)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('every backend route is reachable from the frontend', () => {
  const routes = pyFiles(API_ROUTES).flatMap(extractRoutes);

  it('found the route files', () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it('has a caller in apps/web/src, or a stated exception', () => {
    const unreachable = routes
      .filter((r) => {
        const s = stem(r.path);
        if (s === '') return false;
        if (EXEMPT[s] !== undefined || EXEMPT[r.path] !== undefined) return false;
        return !WEB_BLOB.includes(s);
      })
      .map((r) => `${r.path}  (${r.file.split('/').pop()})`);
    expect(unreachable, 'backend routes with no UI address').toEqual([]);
  });

  it('states no exception for a route that no longer exists', () => {
    const stems = new Set(routes.flatMap((r) => [r.path, stem(r.path)]));
    const stale = Object.keys(EXEMPT).filter((k) => !stems.has(k));
    expect(stale, 'EXEMPT entries for routes that are gone').toEqual([]);
  });
});
