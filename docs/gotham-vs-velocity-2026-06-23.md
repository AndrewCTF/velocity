# Palantir Gotham vs. Project Velocity — Deep Comparison

_Compiled 2026-06-23. Multi-modal research: 10 Palantir demo-video transcripts, extracted video frames (vision teardown), official + analyst web sources, and a file:line audit of the Velocity codebase._

---

## 0. Method & evidence provenance (tiered — what is proven vs. relayed)

| Stream | What was done | Status |
|---|---|---|
| **Transcripts** | 10 YouTube videos pulled with `yt-dlp`, VTT cleaned/deduped (~21k words), mined into a cited capability inventory | **proven** — quotes carry `(video_id @ MM:SS)` |
| **Video frames** | Scene-change frames extracted with `ffmpeg` from 5 demos | **partial** — 1 full vision teardown survived (ivory-trade); 6 defense-COP frames I read **personally** this turn; 4 vision agents died to API rate/session limits |
| **Web** | `deep-research` workflow: fan-out search → fetch → adversarial verify | **partial** — 5 claims passed 2–3 vote verification; synthesis + ~40 further votes failed to rate-limits (those claims are *sourced-but-unverified*, not refuted) |
| **Velocity** | file:line audit | **proven** — key symbols re-verified by direct `grep` this turn (round line-numbers from the audit subagent were corrected) |

Honesty notes: the official **Gotham-for-Defense** and **UK-Defense** videos are mostly *cinematic B-roll* (warships, night-Earth satellite renders, dark ops-rooms, talking-heads) — I verified this directly: `GothamDefense @ 02:44` is a rendered satellite over Earth, `@ 04:29` is a warship bow with a talking-head lower-third. Real product UI appears briefly/composited. The **ivory-trade** video is the opposite — a genuine screen-capture of the working Gotham analyst client, so it is the richest UX evidence.

---

## 1. What Gotham actually is (de-mystified)

> _"Palantir is a data analytics software company who got its start during the war on terror"_ (KipDBa4bTl8 @ 04:00). Core job: take messy multi-source data, **integrate it into a model of the real world**, and let analysts/operators search, link, and act on it — *"You have a problem. We will solve it"* (KipDBa4bTl8 @ 03:57).

Three products share one substrate:
- **Gotham** — the GEOINT/intel analyst + operator application (the Velocity analog).
- **Foundry** — the commercial/enterprise twin (supply-chain, ops).
- **Apollo** — the silent CD/orchestration layer that ships both into every environment incl. classified/edge: *"the silent third platform that sits behind both foundry and gotham"* (rWafTcJtjP8 @ 55:02).
- **AIP** — the LLM/agent layer bolted across all three.

The thing that makes Gotham *Gotham* is **not** the map or the graph — those are table stakes. It is the **Ontology** (a managed, write-back, access-controlled model of an org's world) plus the **deployment/security substrate** (classified-grade access control, audit, Apollo). Keep that in mind for §6–8: Velocity matches the *application surface* far better than it matches the *substrate*.

---

## 2. Gotham capability teardown (cited)

### 2.1 Core analytics — the analyst client
Visually proven from the ivory-trade screen-capture:
- **Object Explorer + Histogram** over a live corpus: header *"103,824 objects"*, faceted typed-entity counts (`Location 8,917`, `Airport 3,491`, `Organization 3,118`, `Person 1,086`, `Ship 49`, `Criminal Organization 8`…) and Event-Type facets (`Flight 39,864`, `Conflict Event 38,688`, `Seizure 536`…), a *"Ivory Seizures, 2009-Present"* time histogram with **Bin size: 2 weeks**, and analyst tools **New/Apply Formula**, **New Derived Property**, **Group By**, **Drill Down**.
- **Link/graph analysis** (the centerpiece): typed node icons (person photos, org buildings, ship/ivory glyphs), **verbatim relationship edges** (`Freighter for`, `Consignee`, `commander of`, `80% equity interest in`, `same contact info`), curated swimlane layouts + force-directed exploration, analyst annotation notes, and a **Search Around** expand affordance that pulls + blue-highlights new connections.
- **Selection/entity inspector**: a single object's typed properties, **provenance to source** (`Source: Tanzania Revenue Authority…`, OFAC SDN list, UN report, court PDFs), and structured **Related Events / Related Entities / Related Documents** with add-to-graph.
- **Document entity-extraction**: source PDFs opened in a Document/Properties/Related/Notes/History reader with entities (e.g. `Team Freight Ltd`) **highlighted inline** out of unstructured text.

Cross-confirmed by primary doc: the **Graph app** ships named helpers — *"Histogram… Search Around… Selection, History, Table… Timeline"*; Search Around *"are not limited to just single links and can also return complex graphs"* (UK G-Cloud 14 service definition PDF).

### 2.2 GEOINT / geospatial / temporal
- Map is a first-class app (**"Gaia"** per Palantir docs) with satellite basemaps, a custom legend (`Seizure` dots, `Major Port`, `Elephant Range` overlay), geo draw tools (`radius`, `polygon`, `route`, `path`, `shape`), and a **Geo Flows** panel drawing weighted/animated movement edges across the trafficking corridor.
- I personally verified a defense product shot (`UKDefense @ 03:23`): a **map with a blue vessel track + pins** beside a **"Ship-detection model"** ML panel (vessel wireframe, Vessel type/Beam/Length) over an **EO/IR drone feed** with a **"Capture angle 35°"** sun-dial.
- Track/movement reasoning: a destroyer *"has gone dark"* → *"Gotham fuses data… to project likely [path]"* (rxKghrZU5w8 @ 02:25); **terrain/maneuverability model** → *"suggests the optimal route based on the unit's composition"* (XEM5qz__HOU @ 04:38).
- Geospatial is a typed ontology data type, not bolt-on: *"I have geospatial… all of that in one ontology object"* (k88WbxMEvPY @ 03:30). Docs name **MIL-STD-2525 symbols, tactical graphics, Map Rendering Service (MRS), Geotracker** _(sourced to palantir.com/docs; adversarial verification incomplete this run)_.

### 2.3 Ontology / data model — the crown jewel
- Definition: *"the nouns and verbs that make up your business"* (YDAxITCNcko @ 00:09). Every modeled decision = **data + logic + actions** (YDAxITCNcko @ 00:44).
- Objects backed by *many* integrated sources (object resolution by integration): *"joining massive amounts of data… to create the plant object"* (rWafTcJtjP8 @ 11:16); typed links between objects.
- **Actions write back** to the ontology *and source systems*: *"every action… is written back into the shared ontology"* (rWafTcJtjP8 @ 15:44), with *"complex validations and security conditions"* (@ 15:59).
- **Bi-directional / shared**: *"all user insights and decisions are recorded in the ontology where they become immediately available… for others"* (rWafTcJtjP8 @ 13:06) — i.e. multi-analyst collaboration is a property of the data model.
- It is the **semantic layer for LLMs**: *"context of how your business is operating because the LMS were not trained on your business's data"* (YDAxITCNcko @ 03:52).
- Primary doc: *"transforms structured and unstructured data into objects and associated properties… The data model is called the 'Ontology'… fully adaptable"* (UK G-Cloud PDF, **3-0 verified**).

### 2.4 AIP / AI assist
- **Natural-language tasking** is the interaction: *"Task the MQ nine to capture video of this location"* (XEM5qz__HOU @ 02:21); *"Generate three courses of action…"* (@ 02:41); whole plan *"using natural language… without a single line of code"* (Xt_RLNx1eBM @ 05:29).
- LLM does **RAG over the ontology**: *"the LLM is traversing a data foundation… integrated from across public and classified sources"* (XEM5qz__HOU @ 03:03).
- **Agents** watch data, reason, act or **escalate to humans**: *"whether they can do it autonomously or… exit and ask for human help — AI and human teaming"* (k88WbxMEvPY @ 01:55).
- **Governance is the differentiator**: per-model *"which data objects they can see which actions they can recommend or take"* (Xt_RLNx1eBM @ 05:07); human-in-the-loop *"by policy"* (Xt_RLNx1eBM @ 04:28); hallucination explicitly managed (k88WbxMEvPY @ 12:27).

### 2.5 Architecture / integration / deployment
- **~300 connectors**, virtual tables (Snowflake/Databricks/BigQuery) *"without copying"* (k88WbxMEvPY @ 04:09); pipelines in Python/Java/SQL; batch/CDC/streaming first-class.
- **hyperauto**: *"turning complex systems like sap into usable ontologies within hours"* (k88WbxMEvPY @ 08:40); **data-as-code** branching/lineage; **Ontology SDK** generates a typed SDK from your objects.
- **Apollo** ships to *"active combat zones and classified networks from submarines to airplanes even to drones"* (rWafTcJtjP8 @ 54:47); *"unclassified secret and top secret"* (@ 61:14); **Nexus peering → DoD global mesh** (@ 63:02).
- Cloud certs: **FedRAMP Moderate, IL2 (DoD SRG)** (palantir.com platform-features, **2-0 verified**); **IL6 provisional authorization** via Apollo _(sourced to blog.palantir.com; verification incomplete this run)_.

### 2.6 Security / access control / audit
- **Classification markings auto-tagged + propagated** (XEM5qz__HOU @ 03:12); **need-to-know enforced on the LLM** — *"the LLM shown cannot access soldier health data by policy"* (@ 03:25).
- **Role + marking + purpose-based access control**, approval frameworks, *"granular audit and logging"* (k88WbxMEvPY @ 11:22).
- **Immutable audit**: *"a full digital footprint of all AI inputs outputs and actions including which AI was used… which humans were in the loop"* (Xt_RLNx1eBM @ 01:13); who/what/when/where per action, SIEM export _(palantir.com/docs; verification incomplete this run)_.

### 2.7 The critical outside view (Good Work, KipDBa4bTl8)
- Lethality, in their own words: *"Our product is used on occasion to kill people… We built this… digital kill chain"* (@ 00:39).
- Controversies: ICE workplace-raid surveillance (@ 09:13), New Orleans predictive policing (@ 09:24), NHS patient data (@ 09:45), Israeli military (@ 09:41).
- Limits: *"They have yet to prove that they can build a major weapons system better than a Lockheed Martin"* (@ 16:13); on Ukraine *"what's being used… on a mass scale… is not yet the Palantir's"* (@ 16:25). $1.3B+ DoD contracts since 2009 (@ 08:15).

---

## 3. Project Velocity teardown (file:line, re-verified this turn)

Velocity has independently built **the Gotham analyst surface**:

| Capability | Evidence (verified) |
|---|---|
| Ontology objects/links/actions/search-around/paths | `apps/api/app/intel/ontology.py` — `class Object` L79, `Link` L105, `Action` L116, `SearchAround` L131, `PathResult` L140 |
| Link-analysis canvas + search-around | `apps/web/src/graph/InvestigationCanvas.tsx` — `OntObject` L31, `OntLink` L37, `SearchAround` L44 |
| Map/globe (Cesium) + SVG/MIL-STD-2525 symbology | `apps/web/src/globe/GlobeCanvas.tsx` (697 lines); `adapters/styles.ts`, `MilSymbolAdapter.ts` |
| Timeline / multi-lane playback | `apps/web/src/timeline/Timeline.tsx` (608 lines) |
| Entity dossier (Profile / Pattern-of-Life / Connections / Narrative) | `apps/web/src/entity-panel/*`; `apps/api/app/intel/dossier.py` (361 lines), `pol.py` (429 lines) |
| Cross-domain fusion / incidents (≥2-domain convergence) | `apps/api/app/intel/incidents.py` (501 lines) |
| Watchbox / geofence / anomaly alerting | `apps/api/app/intel/watch.py` (518 lines) |
| COP editor / ORBAT / target F2T2EA kanban / weaponeering | `apps/web/src/cop/*`, `target-kanban/*`, `tasking/*`, `fmv/*` |
| Satellites (SGP4 client-side) | `apps/web/src/globe/adapters/SatelliteAdapter.ts` |
| Imagery / change-detection diff (Maxar/Sentinel) | `apps/web/src/imagery/ImageryDiff.tsx`; `apps/api/app/routes/imagery.py` |
| AI assist: omnibar / agent console / LLM reasoning | `apps/web/src/command-bar/*`; `apps/api/app/intel/agent.py` |
| **MCP server — 22 tools** | `apps/api/app/mcp_server.py` — `FastMCP` L49, 22 `@mcp.tool()` |
| **Live OSINT feeds — 31 registered layers** | `apps/web/src/registry/defaults.ts` (559 lines, 31 `id:` sources): ADS-B (~13k aircraft union), AIS, SAR dark-vessels, CelesTrak sats, GPS-jamming, FIRMS, USGS, GDELT |

**Confirmed gaps (audit subagent + grep):** no classification markings, no attribute-level ACL, no comprehensive audit logging, no multi-tenant org model, no real-time multi-analyst collaboration.

---

## 4. Head-to-head matrix

Legend: ✅ strong · 🟡 partial · ❌ absent

| Dimension | Gotham | Velocity | Verdict |
|---|---|---|---|
| Link-analysis graph + search-around | ✅ mature desktop, 100k+ objects, formulas/derived props | 🟡 web canvas, ontology+search-around present | Gotham deeper; Velocity has the shape |
| Object/entity explorer + histogram facets | ✅ faceted counts, drill-down, group-by | 🟡 dossier + panels | Gotham |
| Map / GEOINT | ✅ Gaia, MRS, MIL-STD-2525, Geo Flows | ✅ Cesium globe, milsymbol, 31 live layers | **Tie / Velocity edge on live OSINT** |
| Timeline / temporal | ✅ histogram + timeline helpers | ✅ multi-lane playback | Tie |
| **Live open-source feeds** | 🟡 ingests feeds; demos show curated data | ✅ ADS-B/AIS/SAR/sat/jamming/fires real-time, keyless | **Velocity** |
| Document ingest + entity-extraction | ✅ inline tagging, provenance to source docs | ❌ feed-centric, no doc-extraction pipeline | **Gotham** |
| **Ontology as managed integration pipeline** | ✅ 300 connectors, hyperauto, write-back Actions, SDK, data-as-code | ❌ in-app object model over feeds only | **Gotham (large)** |
| AI assist | ✅ AIP NL-tasking, RAG-on-ontology, agents | 🟡 omnibar + LLM reasoning (DeepSeek/Ollama) | Gotham (governed); Velocity simpler |
| **AI governance / guardrails** | ✅ per-model data/action perms, HITL by policy | ❌ none | **Gotham** |
| **Access control / classification** | ✅ role+marking+purpose, need-to-know on LLM | 🟡 Supabase JWT + API-key + commercial tier | **Gotham (large)** |
| **Audit / chain-of-custody** | ✅ immutable who/what/when/where, SIEM export | ❌ none comprehensive | **Gotham** |
| **Deployment to classified/edge** | ✅ Apollo, IL2–IL6, air-gap, Skykit, DoD mesh | ❌ droplet + CF container + Supabase | **Gotham (large)** |
| Multi-analyst collaboration | ✅ bi-directional shared ontology | ❌ single-tenant-ish | **Gotham** |
| ML models in-loop | ✅ ship-detection, terrain, effects-pairing, model-ops | 🟡 anomaly/deception heuristics, 3DGS studio | Gotham (managed); Velocity has niche 3DGS |
| Maturity / credibility | ✅ $1.3B+ DoD since 2009, Maven, real deployments | ❌ solo build / demo | **Gotham** |
| Cost / openness | ❌ 7-figure contracts, closed, gov-gated | ✅ keyless OSINT, self-hostable, open | **Velocity** |

---

## 5. Where Velocity stands

**Matches (application surface).** Velocity has independently reproduced Gotham's *analyst feature inventory* — ontology objects/links, link-analysis with search-around, Cesium map with military symbology, timeline, dossiers, fusion/incidents, watchboxes, COP/ORBAT/F2T2EA, imagery diff, an LLM omnibar, and a 22-tool MCP surface. The same named primitives Palantir ships (Histogram, Search Around, Selection, Timeline) exist as Velocity code. For a solo OSINT build this is a genuine Gotham-shaped application.

**Exceeds (where it's actually different and better).** Velocity is **OSINT-native and live**: 31 keyless real-time layers (~13k-aircraft ADS-B union, AIS, Sentinel-1 SAR dark-vessels, SGP4 satellites, GPS-jamming) streaming into the globe. Gotham's demos show *curated* data, not this breadth of open live feeds. Velocity is open, self-hostable, keyless; Gotham is closed and 7-figure-gated. Velocity also has a local 3D Gaussian-Splatting recon studio with no Gotham analog.

**Lags (the substrate — this is the real gap, not the UI).**
1. **Ontology-as-integration.** Gotham's ontology is a managed ETL platform (300 connectors, SAP→ontology in hours, write-back Actions to source systems, generated SDK, data-as-code lineage). Velocity's ontology is an in-app object model over its own feeds. This is the single biggest difference.
2. **Access control & classification.** Gotham enforces role/marking/purpose-based access, auto-propagated classification markings, and need-to-know *even on the LLM*. Velocity has Supabase JWT + API-key + a commercial-tier flag — no markings, no attribute-level ACL.
3. **Audit / chain-of-custody.** Gotham: immutable who/what/when/where + AI chain-of-thought, SIEM-exportable. Velocity: none comprehensive.
4. **Deployment.** Apollo ships Gotham to air-gapped IL2–IL6/classified/edge (Skykit) and a DoD global mesh; it's FedRAMP/IL-certified. Velocity runs on a droplet + Cloudflare container + Supabase — no classified/air-gap path.
5. **AI governance, multi-analyst collaboration, document entity-extraction** — all present in Gotham, absent/thin in Velocity.

---

## 6. Verdict

Velocity has cloned the **front half** of Gotham — the analyst-facing GEOINT/link-analysis application — and on **live open-source data breadth it is arguably ahead** of what Palantir shows publicly. What it has *not* built is the **back half** that justifies Gotham's price and gov adoption: the ontology-as-integration pipeline, classification-grade access control, immutable audit, and the Apollo-class deployment-to-classified substrate. That back half is mostly **non-product engineering** (data governance, security accreditation, deployment) rather than UI — which is exactly why a solo project can match the visible surface but not the institutional substrate.

**If the goal is to close the gap, priority order:**
1. Classification markings + attribute-level ACL + audit log (the "defensible at gov" trio).
2. Write-back **Actions** that mutate source systems with validation/approval (turns the ontology from a viewer into a system of record).
3. A real connector/ingest framework (arbitrary structured + unstructured + **document entity-extraction**), since OSINT is document-heavy and that's a current ❌.
4. AI-governance wrapper around the existing LLM agent (per-tool/per-object permissions, human-in-the-loop gates).

Everything in (1)–(4) is substrate, not screens — and that's the honest shape of the Gotham-vs-Velocity gap.

---

### Source index
- Videos (YouTube ids): `rxKghrZU5w8` Gotham Defense · `mhwDDPQuUQ0` UK Defense · `_Q8bwhAW2Mg` ivory-trade · `YDAxITCNcko` Ontology · `XEM5qz__HOU` AIP Defense · `k88WbxMEvPY` Architecture Speedrun · `Xt_RLNx1eBM` AIP demo · `rWafTcJtjP8` Demo Day · `KipDBa4bTl8` Good Work (critical) · `NaZmhnj-Q-o` embassy (empty caption).
- Web: palantir.com/palantir-gotham/platform-features (FedRAMP/IL2, **verified**); UK G-Cloud 14 service-definition PDF (Ontology + Graph helpers, **verified**); palantir.com/docs (Gaia/MRS/MIL-STD-2525, audit — sourced, verification incomplete); blog.palantir.com IL6/Apollo (sourced, verification incomplete).
- Velocity: file:line citations in §3, re-verified by `grep` 2026-06-23.
