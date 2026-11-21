# OSINT user R&D — what people want improved (2026-11-05)

Session osint-85. Method: 6 parallel research slices + synthesis workflow `osint-user-rd` (7 agents, ~247k subagent tokens, 120s). Sources: persona studies (2026-07-22/23/24), World Monitor/ADS-B Exchange/Shodan competitor pages, HN Algolia + Shadowbroker Show HN (312 pts, 2026-03-08), repo ground truth (HEAD 41c455e1, 21 uncommitted files), plan-99 + awesome-osint feed sweep. Peers notified: osint-d8, osint-44 (owns maritime.py+naval_registry), browser-flight-sim-bd/d2. No code touched; R&D doc only, no live browser run (concurrency limit).

Status note: statuses below are from docs + grep this turn, not proven-live. Re-probe upstream before scheduling.

## Ranked top 20

| # | Want | Effort | Type | Why / evidence |
|---|------|--------|------|----------------|
| 1 | Silent feed failures → explicit degraded state per layer (ReliefWeb exemplar: fix v1→v2 + FEEDS drill-down/degraded badge in `layerCatalog.ts`) | M | infra/feed | Clean-empty humanitarian map = dangerous false negative. Persona #1 (sofia-1 BLOCKER); `apps/api/app/routes/hazards.py:289-301` still calls dead v1. |
| 2 | Fix dark-vessel logic: split "no static AIS" vs "went dark", suppress "possible interdiction/shadowing" for missing-name vessels | S | feature | `dark_candidate = name is None and shipType is None` tags ~50% of vessels → unquotable journalist output. Persona #3+#4; `apps/api/app/intel/incidents.py:327-329`. |
| 3 | History honesty: report largest internal gap + per-bucket coverage, not just depth | S | infra | 18h blackout reads "~27h history". `/api/history/coverage` buckets exist; `history.py:851-860`, `intel/dossier.py:103,398` don't use them. Persona #2. |
| 4 | Keyless sanctions-by-tail/MMSI (OFAC/EU/UK/UN/OpenSanctions) + FAA registry + ITU MARS owner chain | M | feed | Closes selected-aircraft/vessel object view; corp connector only has name search. Plan-99 `build` ×4, gap-analysis §5. |
| 5 | Chokepoint layer: vessel counts, week-over-week, disruption score, density-anomaly vs baseline | M | feed/feature | World Monitor's key differentiator; we have AIS but no chokepoint product. https://worldmonitor.app/ |
| 6 | Country dossier + corroboration: click-any-country brief, instability breakdown, cited headlines, 7-day change, 5-origin corroboration counts, /trust page | M | feature | Turns map click into analytical product; World Monitor #1 interaction. |
| 7 | Linked filtering / Object Sets + global Timeline with Events lane | L | UX | Core Palantir analyst loop broken; Slate has single `selectedEntityId`, no brush, no event-first view. `apps/web/src/slate/SlateShell.tsx`, `shell/TimeDock.tsx`. |
| 8 | Live provenance/Lineage per object: feed, ingest `seen_at`, transform chain, sanctions-list version | M | UX | Real-data-only rule requires `n/a` ≠ invented; `Lineage.tsx` copies are plates. |
| 9 | Alert Rules Builder → inbox triage, with email sender + retry/backoff/rate-limit | M | feature | Turns passive ticker into mission workflow; email validated but no sender, no retry. World Monitor scheduled digests to Slack/Telegram/email. |
| 10 | Saved Views / shareable workspaces + Watchlists & bulk actions | M | UX | Handoff today is screenshot; 500-hull anchorage triage needs "add all in bbox to watch". |
| 11 | Command palette v2: operators (`mmsi=`, `sanctioned=true`, `within:10km`) + saved searches | M | UX | Slate `Ctrl+K` is search-only; World Monitor ships 623 commands. |
| 12 | Retention truth: post-restart catch-up prune + visible byte-cap margin | M | infra | "Unlimited" pitch untrustworthy — enforcement overshoots 3× between hourly prunes. Community: FR24 7-day, MarineTraffic 72h paywalls are the grievance. |
| 13 | MCP: expose Foundry/Workflows tools, make `op.llm` async with job-id, set `isError` on failures | M | MCP | Zero `foundry\|workflow` tools, 91s sync block (`workflows/blocks.py:696`), agents act on failures as success (`mcp_server.py:395`). |
| 14 | Ontology hygiene: DELETE objects/links + local audit write-back | M | MCP/infra | Test residue (`ext:organization:tesla`, `domain:github.com`) permanent; actions audit to deleted Supabase `action_log` (decisions.md:377). |
| 15 | Conflict & outage feeds: Cloudflare Radar (traffic/attack/outage) + UAV Radar + Overhead24 + OTX | M | feed | Misses T0 country-off-internet signal and district drone/sat-manoeuvre push; threat feeds cover abuse.ch only. awesome-osint. |
| 16 | Subsea cable + GPS-jamming layers | M | feed | 98 cables + landing/BGP anomalies; daily ADS-B jamming hexagons (2% flagged) vs World Monitor. |
| 17 | Aircraft gap honesty + high-fidelity history/streaming (500ms live, daily datasets, camera-ID) | M | UX/feed | `AisGapCard` vessel-only; `PatternOfLifeCard` shows `gap_count` not `track.gaps[]`. ADS-B Exchange parity. |
| 18 | GDELT stability: monotonic window counts, clamp ≤0.40, inline caveat next to narrative | S | feed | Armed-conflict counts non-monotonic across windows; caveat buried in Sources footnote. Persona #10+#14. |
| 19 | Photo-geolocation + person/company lane as first-class routes (not CLI-only) | M | feature | Highest practitioner need (roadmap P3/P4 Journalists, LE/Trace Labs) undiscoverable; `hibp` key-gated (`config.py:904`), no `edb-geo` route. |
| 20 | Honest-AI + cadence transparency: label every synthetic/inference layer, publish pull-cadence table, keep AI output AI-DRAFTED/UNVERIFIED | S | UX/infra | Community trust collapses on "fake UAV positions", "AI slop dashboards", "hundreds of outbound calls/hour from your IP". Already partially wired; differentiator. Shadowbroker HN thread; `docs/star-campaign-2026-07.md`. |

## Deferred (worthwhile, lower than top 20)

SEC/EU/US filings (EDGAR/TED/Comtrade), IRIS/INTERMAGNET, maritime PSC/Equasis, energy grid (ENTSO-E/GIE), imagery scene index (Sentinel-2/3, Landsat, GOES), Shodan-style stats/export view, compare/split view, shared time-space pins, keyboard-first go-to, Foundry branches, PostGIS/Redis, evidence screenshot render, globe 45-layer batching.

## Repo ground truth this turn

HEAD `41c455e1` (Slate default). Uncommitted: 21 files +640/-80 (maritime military tier, targets gate, selectionTrack, TimeDock, SlateSituations). Deferred/known-weak in `docs/decisions.md`: Actions audited write-back (:377), Foundry branches (:379), PostGIS/Redis (README:680), email no sender (:653, :740), alert retry/rate-limit (:654), Phase-1 501s (:291), evidence screenshot stretch (:688), `evidence_of` inversion (`actions.py:191`, :715), photo-geo CLIP weak (:443), phone/MAC no connector (:2265), ransomware choropleth + CORE 429 (:2428), globe 45-layer batching (:1999).

## Community pain points (mapped)

1. Simulated drone positions presented as real tracking — "UAV data is fake" (Shadowbroker Show HN, 2026-03-08). Our no-synthesis rule already answers; keep labeling inference layers.
2. Secrets shipped in repo (`.env.local` in first commit) — audit `.gitignore`/history before launch; keyless-by-default is table stakes.
3. "Hundreds of API calls/hour from user's IP bypassing Cloudflare" — publish our polite cadence table; it's a differentiator.
4. Wide-open localhost CORS / PUT writes .env — keep loopback-bound compose + auth wrappers shipped.
5. Real-time radar perf: "has to invalidate vector tile cache every few seconds" — surface quality presets + low-end banner.
6. "Everyday we get a new AI slop dashboard" + "slow collapse of critical thinking in OSINT due to AI" (Dutch OSINT Guy, 446 pts) — never "AI-powered" in title, label AI-DRAFTED/UNVERIFIED, human voice + `decisions.md` candor.
7. ADS-B Exchange API fees / "horribly broken" / no support — pitch verbatim: "the thing you're angry about, solved, on your box."
8. History paywalls (FR24 7-day, MarineTraffic 72h→24h, ADS-B X API kill) — unlimited local replay is the moat; keep README claims measured.
9. Keyless breaks at analyst verbs (`/api/osint/investigate` 401, ACLED/UCDP key-gated, GDELT Minnesota→Ethiopia) — wave-2 fixes (keyless standing, word-boundary matcher, clamp ≤0.40) already shipped.

## Feeds already wired (don't re-build)

ADS-B/OpenSky+airplanes.live, ACARS/VDL (`apps/api/app/acars.py`), AIS/ShipXplorer+Baltic, CelesTrak, FIRMS, GDACS/ReliefWeb, USGS/EMSC, news RSS+GDELT (`routes/mega_feeds.py`), full OSINT connector set (`app/osint/sources/`).

## Skipped / not verified

Live probing of the 10 candidate endpoints; r/OSINT + World Monitor-specific Reddit complaints (no result blocks via available search); Palantir/InstaOSINT/FR24 fetches returned 403/DNS errors (competitor items are World Monitor / ADS-B Exchange / Shodan only); no live server run, no browser walkthrough.
