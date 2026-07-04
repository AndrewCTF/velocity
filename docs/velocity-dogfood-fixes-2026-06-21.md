# Velocity US–Iran dogfood — fix pass (2026-06-21)

Response to `docs/velocity-dogfood-us-iran-2026-06-21.md`. Every **code-fixable**
finding is fixed and verified locally. Items that are **deploy config** or
**missing data sources** can't be fixed from the repo — they're listed at the
bottom with the exact action required.

Method: discovery → fix (disjoint file owners) → adversarial verify → repair.
The adversarial pass caught one **high-severity regression before it shipped**
(B5, below).

## Verification (local)

- `pytest`: **307 passed** (was 296 — +11 new/updated tests, 0 fail).
- `pnpm -r typecheck`: green. `vitest`: 71 passed.
- Live probes against a booted backend (snapshot ~7k aircraft from this egress):

| Finding | Live evidence after fix |
|---|---|
| B5 adsb bbox | `lamin`(globe) & `min_lat`(api) both → 91 feats, **0 outside Gulf**, not hot-blob; no-bbox world still ships the gzip hot-blob |
| B4 export | `?layer=vessels` differs from `aircraft`; `?bbox=` shrinks 7591→75 (was byte-identical) |
| B14 emitter | no-arg → **422**; with lat/lon → 200 |
| jamming/alerts | scoped→1 in Iran box vs 50 unscoped |
| B9 IODA | **200 + `unavailable:true` @ 8.0s** (was 16.7s→502) |
| B12 search | "Bandar Abbas" → resolves 56.29,27.18 (was `[]`) |
| B11 news | 200 @ 2.3s (no hang) |
| B1 MCP | prod-shape boot (supabase secret, no API_KEY): no-creds→401, MCP self-hop mints JWT→**200, `backend_401` gone** |

## Fixes

| # | Finding | Fix | File(s) |
|---|---|---|---|
| **B1** | Hosted MCP 21/22 tools `backend_401` | When no static `API_KEY` (prod is Supabase-JWT-only), `_headers()` now mints a short-lived HS256 internal JWT (`role=authenticated`) from `supabase_jwt_secret`, cached to ~60s pre-expiry. Self-hop authenticates with **no new secret**. | `mcp_server.py`, `pyproject.toml` (+pyjwt) |
| **B3** | `/api/intel/lod1?bbox=` → 500 | Overpass all-mirrors-fail now → 503 (was unhandled 500); bad bbox → 422 | `routes/sar.py` |
| **B4** | `/api/export` ignored `bbox`+`layer` | Accept `layer=` alias; `kind_set = (layer or kinds)`; bbox filter now actually bites | `routes/export.py` |
| **B5** | `/api/adsb/global` dropped a supplied bbox | Accept **both** bbox vocabularies — `lamin/...` (the live Cesium/MapLibre globe) **and** `min_lat/...` (API/curl) — and coalesce. World-view hot-blob path untouched. *(see regression note)* | `routes/adsb.py` |
| **B6** | Swarm "AIRBORNE 200" looked like an engine cap | Readout now shows `rendered / total` when count > `RENDER_AGENT_CAP` (the combat math always used the true count). Display-only. | `sim/SimulationOverlay.tsx` |
| **B7** | `/ws/alerts` "down" all session | `AlertSubscriber` waits for `useAuth` to settle before connecting (was reading a null token at mount) | `alerts/AlertSubscriber.tsx` |
| **B8** | C-130 dossier @ Mach 1.8 | Peak-speed segment floor 5s→**30s** (kills cross-source ~3km desync artifacts); ceiling 1200→**1000** kn (keeps real supersonic mil peaks, drops teleport jumps) | `intel/dossier.py` |
| **B9** | IODA 16s→502; CF token | IODA: 8s timeout + typed `{unavailable:true}` @200, short-TTL cached. CF token = deploy. | `routes/cyber.py` |
| **B10** | 6 authed calls 401 on first paint | `bearerToken()` awaits a `tokenReady` promise → every apiFetch waits for the token to settle. Central, not per-component. **+watchdog** so a hung session can't stall keyless calls. | `transport/supabase.ts`, `transport/http.ts` |
| **B11** | `/api/news/analysis` 524 | Agent budget 150→80, step 60→25; analysis route `wait_for(88)`→503; **factcheck route `wait_for(90)`→503**; `_single_shot` `wait_for(70)` | `news/analyze.py`, `routes/news.py` |
| **B12** | `/api/search` empty for places | Nominatim forward-geocode fallback (keyless, commercial-mode-guarded, 24h cache) when prior steps miss | `routes/search.py` |
| **B12b** | lat,lon search didn't re-fly camera | Synchronous lat,lon fast-path on Enter → `flyToPosition`; always returns (no fallthrough) | `command-bar/SearchField.tsx` |
| **B13** | `vessel_dossier` rejected integer MMSI | `mmsi: int \| str`, coerce `str()` | `mcp_server.py` |
| **B14** | `/api/intel/emitter` no-arg → nonsense global fix | Require a location → **422** when no lat/lon/bbox | `routes/intel.py` |
| **B15** | Landing "live" counters stuck at 0 | `initLive()` no longer early-returns on empty `VELOCITY_API`; fetches same-origin `/api/intel/situation` | `site/main.js` |
| **F4** | LLM slow/unreliable | MiniMax floor `max(.,150)`→`min(.,90)` so it can't eat the whole budget before DeepSeek; agent synthesis 160→90; `deep_analyze` explicit timeouts; route-level `wait_for` caps bound Cloudflare exposure | `llm.py`, `intel/agent.py`, `mcp_server.py` |
| ext | `/api/intel/aircraft` capped at 50 | honor `limit` param | `routes/intel.py` |
| ext | jamming alerts not geo-scopable | optional bbox + lat/lon/radius_nm filter | `routes/alerts.py` |
| ext | fact-check no time/geo scope | `as_of` + lat/lon/radius_nm params | `routes/news.py` |

### Regression caught by the adversarial pass (B5)

The first B5 attempt added a one-way FastAPI `alias="min_lat"`. In pydantic-v2
an alias **replaces** the field name, so the route would have accepted *only*
`min_lat/...` and **stopped accepting `lamin/...`** — which is exactly what the
live globe sends (`LayerCompositor.viewportQuery`) and what mobile (`alwaysBbox`)
polls every tick. That would have served the full ~13k world blob to a phone on
every zoomed poll. The shipped fix accepts **both** spellings; a parametrized
test (`test_adsb_bbox_alias.py`) now locks in both.

## NOT fixed here — deploy config / data (operator action required)

These are not repo-fixable; the code already degrades gracefully where it can.

1. **CDSE (Copernicus) credentials** → restores B2 (Hormuz SAR dark-vessels) **and**
   B3's LOD1 3D path. Set `CDSE_*` on the backend.
2. **`CLOUDFLARE_TOKEN`** → Cloudflare-Radar outages (B9, second half).
3. **Cesium Ion token** (`cesiumIonToken`) → 3D terrain, without which the sim's
   nap-of-earth / LOS terrain-masking has nothing to mask against (report §5).
4. **A Gulf AIS source** → there is no keyless AIS over Hormuz; AIS coverage is
   Northern Europe only. Needs a paid feed or an own receiver. With CDSE SAR
   (#1) up, the dark-vessel layer is the only Gulf maritime signal.
5. **Multi-day replay** — needs cold storage beyond the ~24h ring buffer (a
   feature, not a bug; deferred).

## Known residual (low, accepted)

- `/api/search` Nominatim fallback has no app-level rate limiter — fine for the
  single-analyst deploy; would need throttling at SaaS scale (Nominatim ToS ≤1/s).
- MCP minted-JWT cache keys on (token, expiry) not the secret — unreachable in
  practice (`get_settings()` is `lru_cache`, secret only changes on restart).
- `intel/agent` SSE synthesis isn't bounded by `_WALL_BUDGET_S`; the Cloudflare-
  facing non-streaming routes (analysis, factcheck) are the ones now capped.
