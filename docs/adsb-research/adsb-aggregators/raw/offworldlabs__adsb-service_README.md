# RETINA ADS-B Data Plane

A RETINA-owned ADS-B fusion and serving system: it ingests the worldwide ADSBHub SBS feed and ADS-B contributed by RETINA nodes with local receivers, and serves low-latency, geographically filtered aircraft state back to those nodes. Each node prefers its own fresh receiver data and falls back automatically to the central feed, behind one stable node-local API that the RETINA radar/solver consumes.

**Status:** Phase A (server-side v1) implemented — see [Phase A implementation](#phase-a-implementation) below. Specifications at version 1.3, dated 2026-08-26.

**Implementation direction (2026-08-26):** implementation starts server-side only, building on the [ADSB.lol](https://github.com/adsblol/infra) codebase and infrastructure patterns, deployed on a single host initially (its logical ingest → hub → serving boundaries kept separable per §20.1): ingest the ADSBHub feed and stand the service up to serve nodes in the adsb.lol format first (the REST v2 `/v2/lat/{lat}/lon/{lon}/dist/{radius}` query the current node stack already consumes). The canonical gRPC distribution contract, the node-side components (sidecar, agent, forwarder), and fleet rollout (via the Mender OTA pipeline) follow in later stages. The specifications below remain the target architecture; the interim serving format is a bootstrap step, not a replacement for the §11 contract.

## Phase A implementation

Phase A per `plan.md` (server-side only, single host): ADSBHub SBS ingest and
adsb.lol-format serving, built on the adsb.lol lineage. Design decisions and
rationale: [docs/DESIGN.md](docs/DESIGN.md). Requirement traceability:
[docs/conformance-ledger.md](docs/conformance-ledger.md).

```
data.adsbhub.org:5002 → adsbhub-adapter (validate SBS, loopback relay :31003)
                      → readsb-hub (pinned v3.16.16, decode/state, re-api :30152)
                      → serving-api (FastAPI)  GET /v2/lat/{lat}/lon/{lon}/dist/{radius}
```

| Piece                                                    | Where                                         |
| -------------------------------------------------------- | --------------------------------------------- |
| ADSBHub adapter (S1)                                     | `services/adsbhub_adapter/`                   |
| Serving tier (adsb.lol v2 REST)                          | `services/serving_api/`                       |
| Single-host deployment (systemd)                         | `deploy/` (`install.sh`, pinned readsb build) |
| Example configs (§18.1 strict)                           | `config/`                                     |
| Dashboards, alerts, runbooks                             | `dashboards/`, `observability/`, `runbooks/`  |
| ADRs, conformance ledger, spec amendment draft           | `docs/`                                       |
| Unit + fuzz tests / live end-to-end tests                | `test/unit/`, `test/integration/`             |
| Vendored references (adsblol/api, adsblol/infra, readsb) | `vendor/` (`VENDOR.md`)                       |

Run tests: `.venv/bin/pytest -q` (unit + fuzz, ~5 s);
`.venv/bin/pytest -m integration -q` (live pipeline against the built readsb, ~60 s).

## Documents

| Document                                                                 | Role                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RETINA_ADSB_NORMATIVE_CORE.md](RETINA_ADSB_NORMATIVE_CORE.md)           | **Binding requirement set** for v1 implementation and acceptance. This is the review surface: invariants, algorithms, thresholds, acceptance criteria. On any conflict between the two documents, the core governs (and the conflict is a defect to fix in both, in one change). |
| [RETINA_ADSB_IMPLEMENTATION_SPEC.md](RETINA_ADSB_IMPLEMENTATION_SPEC.md) | Full specification: architecture, rationale, data flows, the Protocol Buffer contract (§11), configuration examples, deployment, testing strategy, rollout plan, and operational guidance. Sections the core incorporates by reference (its Section 15) are equally binding.     |

The two documents version in lockstep. Start with the core to understand _what_ must be true; read the full spec to understand _why_ and _how_.

## Architecture at a glance

```text
ADSBHub SBS feed          RETINA receiver nodes
data.adsbhub.org:5002     BeastReducePlus over mTLS :7444
      │                          │
      ▼                          ▼
adsbhub-adapter          retina-feed-gateway
      └──────────┬───────────────┘
                 ▼
          readsb-hub  (decode, dedup, CPR — reused, not reimplemented)
                 ▼  per-position TCP JSON
        retina-adsb-server  (state, history, regional routing)
                 │  gRPC + mTLS :443, snapshot + ordered deltas
                 ▼
┌──────────────── RETINA node ────────────────┐
│ SDR → existing readsb → existing tar1090    │  ← untouched (Mode A default)
│          │ Beast (read-only tap)            │
│          ▼                                  │
│   readsb-retina sidecar ──► feed-forwarder ─┼─► central (contribution)
│          │ JSON                             │
│          ▼                                  │
│   retina-adsb-agent ◄── central gRPC stream │
│          │ Unix socket                      │
│          ▼                                  │
│   RETINA solver/radar                       │
└─────────────────────────────────────────────┘
```

Phase A as deployed differs from the target above in two decided places
(the spec documents are guidance since 1.4, see their status notes):
nodes read an adsb.lol-compatible **HTTPS REST** surface at
`https://adsb.retina.fm/v2/...` instead of gRPC + mTLS (ADR-0005), and the
**7444 contribution port is an account-less Beast ingest** — plain or TLS,
no client certificate, adsb.lol-style — straight into `readsb-hub`
(ADR-0008); there is no `retina-feed-gateway` yet.

Key invariants (see the core, Section 1, for the full set):

- **The solver talks only to the node-local `retina-adsb-agent` API.** Never to ADSBHub, readsb, tar1090 files, or receiver ports directly (AI-01).
- **Local path has no cloud dependency.** The agent starts and serves even with zero sources; central outages never interrupt local data (AI-02).
- **Local and central candidates never mix** per aircraft and field group; the central feed never enters the local decoder (AI-03).
- **No feedback loops.** Node contribution carries only local receiver data; central/redistributed data is never re-fed to the server or to ADSBHub (AI-04).
- **Non-invasive by default.** The sidecar (Mode A) is a read-only Beast client; existing readsb/tar1090 config and data paths are unchanged (AI-05).
- **Exactly two public ports:** 443 (distribution, mTLS) and 7444 (contribution, mTLS) (AI-06).
- **Everything is bounded:** queues, caches, history, reconnect backoff (AI-08).
- **Reuse, don't rewrite:** readsb performs Mode-S decoding, CPR resolution, and dedup (AI-10).

## Core concepts

- **Field groups** — fusion operates on atomic groups (`POSITION`, `BARO_ALTITUDE`, `GROUND_VECTOR`, `IDENTITY`, …), never individual scalars. Latitude/longitude always come from one observation; each populated group carries its own `ObservationMeta` (source, age, time basis, uncertainty).
- **Selection** — per `(aircraft_key, field_group)` a deterministic algorithm picks between the local and central candidate: local wins ties within 250 ms (150 ms while central is currently selected, to prevent boundary flapping); a materially fresher candidate wins otherwise. See core Section 6 and the truth table in Section 14.
- **Freshness classes** — position age maps to `FRESH` (≤1 s) / `USABLE` (≤2 s) / `STALE` (≤5 s) / `EXPIRED`; expiry produces an explicit state revision, never a magic null.
- **Precision eligibility** — `usable_for_precision_association` is computed by the agent under strict rules (core §7): FRESH, receiver-derived timing with ≤250 ms uncertainty, no latency/surveillance-type unknowns, NACp floor. ADSBHub-derived positions are usable as fallback but never precision-eligible.
- **Time model** — monotonic-clock ages, explicit `time_basis` and `time_uncertainty_ms` per group, conservative penalties when upstream latency is unknown (core Section 3).
- **Streaming** — snapshot barrier + ordered deltas with contiguous `subscription_sequence`, SHA-256 manifest verification, explicit tombstones, bounded per-subscription queues with coalescing, and distance-tiered decimation (core Section 8).

## Contract

The canonical contract is the Protocol Buffer definition in full-spec §11 (package `retina.adsb.v1`), binding as written until `proto/retina/adsb/v1/adsb.proto` exists in this repository — at which point the repository file becomes authoritative. Two services:

- `DistributionService` — server → node: `Stream` (snapshot + deltas), `Probe` (RTT measurement).
- `LocalAircraftService` — agent → solver: `GetSnapshot`, `Watch`, `GetAtTime`, `GetRegionAtTime`.

## Roadmap

Rollout runs in phases (full spec §28) with two acceptance gates (core Section 13):

| Phase | Content                                                                   | Gate       |
| ----- | ------------------------------------------------------------------------- | ---------- |
| 0     | Node inventory, baselines, egress IP + ADSBHub entitlement, schema freeze |            |
| 1     | Server shadow ingest (adapter, gateway, hub, state server)                |            |
| 2     | Node agent shadow mode on 1–5 lab nodes; solver unchanged                 |            |
| 3     | Canary solver integration (1 node → 5% → 20%)                             | **Gate 1** |
| 4     | Fleet rollout 25% → 50% → 100%                                            | **Gate 2** |
| 5     | Optimize and scale; measured latency characterization                     |            |

Thirteen ADRs are required before code freeze (full spec §31), including implementation language, pinned `readsb` build, PKI/enrollment, spatial index, and the region-radius/decimation defaults derived from the solver detection envelope.

## Repository layout

Phase A layout (a Python adaptation of full spec §30 — divergence recorded in
`docs/DESIGN.md` §6 and the conformance ledger):

| Path                                                 | Content                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `services/adsbhub_adapter/`, `services/serving_api/` | The two Phase A Python services                                                                                  |
| `deploy/`                                            | systemd units, install/build scripts, nginx boundary options                                                     |
| `config/`                                            | Example configs (values = shipped defaults)                                                                      |
| `test/`                                              | Unit + hypothesis fuzz suites, live integration suite, SBS/API fixtures                                          |
| `dashboards/`, `observability/`, `runbooks/`         | Grafana dashboards, Prometheus config + alerts, operator runbooks                                                |
| `docs/`                                              | Design (`DESIGN.md`), ADRs, conformance ledger, spec-amendment draft, readsb pin record                          |
| `vendor/`                                            | Pinned reference checkouts (adsblol/api, adsblol/infra, wiedehopf/readsb) as submodules — see `vendor/VENDOR.md` |

Later phases add the spec §30 canonical components (`proto/`, `retina-adsb-server`, `retina-feed-gateway`, node-side services).

## License

[MIT](LICENSE) © 2026 Offworld Labs.
