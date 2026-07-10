# Country-OSINT catalog — implementation spec

Harvests every country in the **OSINT World Series** (unishka.com/osint-world-series,
53 country/territory toolkits) into a single normalised catalog, serves it behind
**one generic parameterized endpoint set**, and links it into the shared ontology
graph so a national registry (`asic.gov.au`) is the *same* `domain:` node the
existing `investigate()` fan-out expands. No per-country code — the per-country
variance lives entirely in data.

## Ground truth

- Index page: `https://unishka.com/osint-world-series/` — 53 unique `osint-of-<slug>`
  links (deterministically extracted; the page groups them by region).
- Every article lives at `https://unishka.substack.com/p/osint-of-<slug>`
  (`open.substack.com/pub/unishka/p/<slug>` 302-redirects here). Articles are fully
  readable, structured by category heading, ~50–170 resources each.

## Data layer — `apps/api/app/osint/country_data/<code>.json`

One self-contained file per country (one file, one owner — parallel-safe). Written
by 53 haiku subagents via the shared prompt `scratchpad/country-extract-prompt.md`.
Schema:

```json
{
  "code": "au", "name": "Australia", "region": "Oceania", "iso2": "AU",
  "source_url": "https://unishka.substack.com/p/osint-of-australia",
  "note": "truncated to 35 of 170",           // optional, top level
  "resources": [
    {"name": "ABN Lookup", "url": "https://abr.business.gov.au",
     "category": "business-registry", "note": "official company register",
     "keyless": true}
  ]
}
```

**Controlled category vocabulary** (a resource's `category` is exactly one):
`open-data`, `business-registry`, `land-property`, `people-search`, `vehicle`,
`transport-tracking`, `court-legal`, `government`, `maps-geo`, `phone`,
`social-media`, `news-media`, `sanctions-pep`, `finance-tax`, `archives`,
`tenders`, `telecom-infra`, `other`.

## Catalog loader — `apps/api/app/osint/country_catalog.py`

Loads all `country_data/*.json` once at import (module-level, cached), validates the
schema + category vocab (bad category → coerced to `other` + logged, never raises),
and exposes:

- `CATALOG: list[CountryRecord]` — sorted by name.
- `CATEGORIES: tuple[str, ...]` — the vocab above.
- `by_code(code) -> CountryRecord | None`.
- `list_summary() -> dict` — `{count, regions, categories, countries:[{code,name,region,
  iso2,source_url,resource_count,category_counts}]}`.
- `build_graph(code) -> {nodes, links}` — **the single mint function**, reused by both
  the graph-preview GET and the persist POST so the linking logic exists once.

### `build_graph` linking (the "everything linked together" bridge)

For country `code`:
- `country:<code>` — props `{name, region, iso2, source_url, resource_count}`.
- Per resource → `resource:<code>:<slug(name)>` — props `{name, url, category, note,
  keyless}`; link `country:<code> -has_resource-> resource:…`.
- If the resource URL's host is a real FQDN (`normalise_domain` from
  `app/osint/fetch.py`) → mint/reuse `domain:<host>` and link
  `resource:… -hosted_at-> domain:<host>`. **This is the bridge**: the same
  `domain:asic.gov.au` node that `_investigate_domain` enriches. Dedup domains.

Node shape matches `routes/osint.py::_Graph.obj` output (`{id, props:{entity_type,
source, ...}}`) so the Investigation canvas renders country nodes with no FE change.

## Ontology additions — `apps/api/app/intel/ontology.py`

- `ObjectKind` Literal + `_KNOWN_KINDS` frozenset: add `"country"`, `"resource"`.
- `KNOWN_RELS` doc comment: add `has_resource` (country → resource) and `hosted_at`
  (resource → domain).
- `tests/test_ontology_local.py` stays green.

## Endpoints — `apps/api/app/routes/countries.py` (prefix `/api/osint/countries`)

Generic, parameterized by `{code}` — the SAME shape for all 53 countries.

| method | path | auth | returns |
|--------|------|------|---------|
| GET | `/api/osint/countries` | keyless | `list_summary()` (+ optional `?region=` `?category=` filter) |
| GET | `/api/osint/countries/categories` | keyless | `{categories:[…], counts:{cat:total}}` cross-country |
| GET | `/api/osint/countries/{code}` | keyless | full `CountryRecord` (404 if unknown) |
| GET | `/api/osint/countries/{code}/graph` | keyless | `build_graph(code)` (`{nodes,links}`) — canvas preview, NOT persisted |
| POST | `/api/osint/countries/{code}/ingest` | `current_user` | persist `build_graph(code)` into the caller's ontology (reuse `_Graph`/`reg.upsert`/`reg.link` from `routes/osint.py`); returns `{root:"country:<code>", objects, links}` + one audit row |

Register the router in `app/main.py` alongside the other routers. Keyless GETs keep
the "keyless layers keep working" invariant.

Tests `tests/test_countries.py`: monkeypatch nothing (catalog is static) — assert the
list endpoint counts, a `{code}` detail round-trips, `graph` mints `country:`/
`resource:`/`domain:` nodes with `has_resource`/`hosted_at`, unknown code → 404, and
`build_graph` domain-bridging picks the same `domain:<host>` id `classify_target`
would. Ingest test uses the local-registry fixture pattern from
`tests/test_osint_investigate_v2.py` / `test_ontology_local.py`.

## Frontend — `apps/web/src/osint/CountriesPanel.tsx`

One rail tab (add to `App.tsx` `railItems`, `group:'more'`, id `countries`, icon
`globe`, next to `investigate`). All calls via `apiFetch`. Behaviour:

1. On mount `GET /api/osint/countries` → list grouped by region (collapsible), each
   row `flag(iso2) name · resource_count`.
2. Select a country → `GET /api/osint/countries/{code}` → resources grouped by
   category; each resource is an external link (`target=_blank rel=noopener`) + a
   small **Map** button that calls `useInvestigation.getState().searchAround` after a
   keyless `GET /{code}/graph`… simplest: an **Ingest** button that
   `POST /{code}/ingest` then `searchAround("country:<code>")` (mirrors
   `InvestigatePanel`'s post→select→searchAround), so the country's linked graph lands
   in the Investigation canvas. 401 → "Sign in to persist".
3. Filter box (client-side) by category + free-text over resource names.

Typecheck green; a unit test `CountriesPanel.test.tsx` mounting with a mocked
`apiFetch` (pattern = `OsintEntityPanel.test.tsx`).

## Country metadata (53) — code · name · region · iso2 · slug

Passed to the extraction agents; also the authoritative set the loader expects.

Africa: algeria(dz), morocco(ma), egypt(eg), nigeria(ng), sudan(sd), tanzania(tz),
zanzibar(zanzibar, iso2=TZ), south-africa(za), democratic-republic-of-the(cd, "Democratic
Republic of the Congo"). South America: venezuela(ve), ecuador(ec), colombia(co),
argentina(ar), peru(pe), brazil(br). Asia: nepal(np), the-philippines(ph,
"Philippines"), indonesia(id), mongolia(mn), israel(il), bangladesh(bd), pakistan(pk),
lebanon(lb), india(in), iraq(iq), qatar(qa), uae(ae, "United Arab Emirates"),
syria(sy), north-korea(kp), russia(ru), armenia(am), uzbekistan(uz), azerbaijan(az),
georgia(ge), malaysia(my). Europe: italy(it), albania(al), bulgaria(bg), spain(es),
romania(ro), belarus(by), austria(at), latvia(lv), lithuania(lt), united-kingdom(gb,
"United Kingdom"), greece(gr), ukraine(ua). North America: mexico(mx),
el-salvador(sv, "El Salvador"), cuba(cu), nicaragua(ni), panama(pa). Oceania:
australia(au).

## Build order

0. (Opus) spec + prompt + ontology kinds/rels — this doc.
1. (53 haiku, workflow) extract → `country_data/<code>.json`.
2. (Python) assemble/validate → counts.
3. (sonnet ×2) backend loader+endpoints+tests · frontend panel+test. (Opus) review.
4. Verify: `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` ≥ baseline
   + new tests; `pnpm -r typecheck`; `bash scripts/verify.sh` green.
