# Foundry layer vs. Palantir — gap analysis (2026-07-08)

Method: two subagents deep-read the repo's Palantir PDFs page-by-page
(`Palantir_Gotham_Deep_Dive.pdf`, 24 pp; `Palantir_Gotham_OSINT_Report.pdf`,
20 pp), one audited the local foundry implementation file-by-file with
file:line evidence, one swept the internal plan docs. This document is the
synthesis. Every implementation claim below carries a file:line anchor from
that audit; every Palantir claim carries a PDF page number.

## Headline finding about the source documents

Both PDFs are about **Gotham**, not Foundry. Neither document describes
Foundry-specific machinery at all — no datasets-as-versioned-artifacts, no
branches, no builds, no data-health "expectations" framework, no Code
Repositories/Code Workbook. The Deep Dive's closest analogs are: Kinetic
Layer pipelines and bindings (p5), the visual transformation/mapping engine
with versioned, auditable mapping configs (p6-7), transformation-level data
quality rules with quarantine/dead-letter remediation (p7), and entity
resolution (p7). The OSINT Report mentions Foundry only contrastively (p4:
Gotham = defense-specialized, Foundry = industry-agnostic, shared Ontology
foundation). Both PDFs are also third-party analyst reports, not Palantir
primary docs.

So "verify the foundry against Palantir Foundry using the PDFs" resolves to:
compare our foundry layer against the **data-integration + ontology-feeding
capabilities the PDFs attribute to the Palantir platform**. That comparison
follows.

## Scorecard

Legend: ✅ covered (tested), 🟡 partial, ❌ missing. "Palantir" column cites
PDF pages; "ours" cites code.

| # | Palantir capability (PDF) | Ours | Evidence |
|---|---|---|---|
| 1 | Datasets ingested + normalized into a store (p5) | ✅ CSV/JSON/NDJSON upload, schema inference | `foundry/ingest.py:115-148`, tests |
| 2 | Versioned, auditable transformation configs w/ rollback (Deep Dive p7) | ✅ immutable dataset versions + rollback-as-new-version | `store.py:354-434,521-556` |
| 3 | Data quality rules at transform level (p7) | ✅ 5 check types, warn/fail, enforced on every version write | `checks.py:14-82`, `store.py:304-328` |
| 4 | No-code / visual pipeline builder (OSINT p5, Deep Dive p6) | 🟡 step-form editor + JSON fallback + SVG DAG; no drag-wire canvas, no per-step validation at save time | `PipelineView.tsx:1-623`; L10 below |
| 5 | Transform DSL (custom Python/Java code blocks, regex, lookups — p6) | 🟡 9 step types + AST-whitelist expressions; **no regex, no dates, no custom code, 8 functions total** | `transforms.py:22-31,218-352` |
| 6 | Lineage (implied by pipeline/binding architecture) | 🟡 dataset/transform-level DAG + stale flags; **no version-level or column-level lineage** | `builds.py:203-238` |
| 7 | Ontology binding — raw records mapped to ontology objects (Kinetic bindings, p5) | ✅ column→prop map, mint via `upsert`, provenance source `foundry:<id>` | `binding.py:28-65` |
| 8 | Real-time change propagation to ontology objects (p5) | ❌ sync is manual/button-driven; no on-build auto-sync, no streaming | `routes/foundry.py:521-529` |
| 9 | Scheduled/orchestrated pipeline execution | 🟡 interval scheduler exists but is **plumbed-unverified** (never runs in CI, `OSINT_DISABLE_BACKGROUND=1`) and swallows errors at DEBUG | `scheduler.py:26-46`; Q1/Q4/Q12 |
| 10 | Universal connectors — DBs, APIs, streams, WFS/WMS, STIX (p6) | ❌ upload-only; no connectors, no Parquet/Excel | `ingest.py:115-148` |
| 11 | Streaming/CDC ingestion (Kafka/Flink/Debezium, p7-8) | ❌ | — |
| 12 | Entity resolution — deterministic + probabilistic dedup w/ review queue (p7) | ❌ in foundry (exact-key upsert only; separate intel-layer resolution exists but is not wired into binding sync) | `binding.py:38-44` |
| 13 | Quarantine / auto-repair / dead-letter remediation (p7) | ❌ fail-checks block the write wholesale; no quarantine of bad rows | `store.py:304-328` |
| 14 | Data-level security: ABAC/RBAC/MLS, per-user query results (p6, p14-15) | ❌ deliberately: keyless single-operator by design | `routes/foundry.py:7-8`; L2/L3 |
| 15 | Scale: billions of records, sub-second, distributed (p5, p17) | ❌ deliberately: 200k rows/25MB caps, in-memory Python transforms, sync builds | L4/L5/L11/L12 |
| 16 | Branching of data/pipelines | ❌ linear version history only | `store.py:51-57` |
| 17 | NLP/NER auto-extraction into ontology (p20) | ❌ in foundry (exists elsewhere in intel layer, not bound to datasets) | — |
| 18 | Auto connection discovery on new source integration (OSINT p5) | ❌ | — |

Score against the PDFs' data-platform capability set: **5 covered, 4 partial,
9 missing**. Against the *personal, keyless-local* scope the roadmap actually
set (docs/roadmap-ontology-2026-07.md §6 explicitly rejects "out-Palantiring
Palantir"), rows 14-15 and arguably 10-11 are out of scope by operator
decision, which leaves the honest in-scope gap list at rows 4-6, 8-9, 12-13,
16-18.

## Verdict

The user-facing framing "miles behind Palantir Foundry" is correct in
absolute terms and was always going to be — the PDFs describe a
multi-billion-dollar vertically-integrated stack (custom graph DB, Spark,
Kafka/Flink, Apollo, MLS). But the roadmap explicitly renounced that target.
The meaningful verdict is against our own claimed scope:

- **What's genuinely solid:** the core loop (upload → transform → build →
  checks → bind → mint into ontology) is implemented end-to-end with real
  test coverage (immutability, cycle rejection, stale tracking, check
  enforcement on every write path, the upsert-not-assert_props provenance
  fix). This is proven by the audit's test citations, not just claimed.
- **Where "it isn't even good" has teeth — the top gaps that matter at our
  scale:**
  1. **No auto-sync to ontology after builds** (row 8). Palantir's whole
     Kinetic-layer point is that bindings propagate automatically; ours needs
     a button press. Cheap fix: run enabled bindings for a dataset after any
     successful build/upload of it.
  2. **Scheduler is unverified and silent-failing** (Q1/Q4/Q12): malformed
     timestamps make schedules fire every 5 s; failures log at DEBUG. Zero
     live test coverage.
  3. **Transform DSL too thin for OSINT data** (L7): no regex, no date/time
     functions — most real feeds (timestamps, MMSI/ICAO strings) can't be
     usefully derived on. Also "007"→7 lossy CSV coercion with no type
     pinning (L17).
  4. **No save-time step validation** (L10): malformed steps KeyError at
     build time instead of 422 at save.
  5. **No entity resolution in binding sync** (row 12): exact key match
     only, so the same real-world entity from two datasets mints twice.
     The intel layer already has resolution machinery — reuse it (CLAUDE.md
     rule 3).
  6. Silent-wrong-results hazards: join first-match-wins on duplicate keys
     (Q5), lenient `_topo_order` fallback (L16).

## Quality-concern register (from code audit, for fixing)

Blocking-grade: Q1 (schedule fires every tick on bad timestamp), Q4 (DEBUG
swallow), Q5 (join dup-key silent drop), L10 (no step validation), L16
(lenient topo fallback). Perf smells: Q3/Q9/Q2/L18 (N+1s, per-call
executescript, full scans). Unverified plumbing: Q12 (scheduler), Q11 (FE
delete/rollback paths), Q8 (bodyless pipeline build).

## What NOT to build (operator decisions, restated)

Multi-tenant ACLs/MLS, distributed compute, streaming CDC, connector
catalogs — all explicitly rejected in roadmap-ontology-2026-07.md §6 ("wrong
identity"). Do not reopen without an operator decision.
