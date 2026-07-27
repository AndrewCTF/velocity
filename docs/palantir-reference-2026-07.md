# Palantir reference — Gotham, Foundry, Gaia: panels, predictions, and techniques

Compiled 2026-07-27 from Palantir's own public documentation, two G-Cloud service
definition PDFs, two Palantir engineering blog posts, and three product video
transcripts. Every claim is quoted or cited; nothing here is inferred from memory.

Purpose: this repo is building a fusion/geoint console. Palantir has shipped that
product for a decade. This document records, panel by panel, what their system contains,
what ours contains, and where the gap is — so design arguments start from evidence.

Companion documents:
- `docs/perf-baseline-2026-07-27.md` / `docs/perf-results-2026-07-27.md` — the measured
  before/after this reference motivated.
- `docs/decisions.md` — the operator decisions that constrain what we may copy.

## 1. Sources actually read (not just found)

| # | Source | Type | What it gave |
|---|---|---|---|
| S1 | `palantir.com/docs/foundry/map/map-overview` | HTML doc | Full Map panel + toolbar inventory |
| S2 | `palantir.com/docs/foundry/map/getting-started` | HTML doc | Navigation grammar, core workflows |
| S3 | `palantir.com/docs/foundry/map/layer-editor` | HTML doc | Raster/vector/object layer display options |
| S4 | `palantir.com/docs/foundry/map/objects-loading-methods` | HTML doc | Auto / Tile / Object loading, the scale answer |
| S5 | `palantir.com/docs/foundry/workshop/widgets-map` | HTML doc | The exhaustive map-widget option list |
| S6 | `palantir.com/docs/foundry/getting-started/application-reference` | HTML doc | The complete Foundry application inventory |
| S7 | `palantir.com/docs/gotham/api/target-workbench/target/create-target` | HTML API ref | Gotham Target data model |
| S8 | G-Cloud 14 *Palantir Platform: Gotham* Service Definition | **PDF** | The Gotham application-by-application description |
| S9 | G-Cloud 14 *Palantir Platform: Foundry & AIP* Service Definition | **PDF** | Foundry pillars + AIP capability list |
| S10 | `blog.palantir.com` — *Redefining Real-Time Map Collaboration* | HTML blog | Gaia Follow Along: state sync + throttling numbers |
| S11 | `blog.palantir.com` — *Plotlines in Three.js* | HTML blog | The GPU/instancing/circular-buffer techniques |
| S12 | YouTube `rxKghrZU5w8` *Gotham for Defense Decision Making* | **video transcript** | The understand→decide→act loop |
| S13 | YouTube `XEM5qz__HOU` *AIP \| Defense and Military* | **video transcript** | The AI-in-the-loop panel grammar |
| S14 | YouTube `tZVx3BTkLlI` *Gotham: Europa* | **video transcript** | Chat/Slides/MetaConstellation release framing |

Exact URLs are in §9. The video-transcript recipe (repeatable, no API key) is in §8.

## 2. Palantir Map / Gaia — the panel inventory, verbatim

From S1/S2. This is the layout our globe is competing with.

**Left-side panels**

| Panel | Palantir's own description | We have | Gap |
|---|---|---|---|
| **Layers** | "Add, manage, and style object and overlay layers; set the base layer" | LayerRail | No per-layer *styling*; style is hard-coded in `styles.ts` |
| **Find** | "Find objects and locations; navigate to specific geospatial coordinates" | search box + `CoordEntry.tsx` | Split across two surfaces; no unified find |
| **Histogram** | "Analyze and filter objects based on property and time series values" | `explorer/facets.ts` | Exists as facets, not as a map-side filter panel |
| **Info** | "Display an overall summary of the map" | `useEntityStats` | Exists as counts, not as a panel |

**Right-side panels**

| Panel | Palantir's own description | We have |
|---|---|---|
| **Selection** | "Analyze details about and take actions on the selected items" | `EntityPanel.tsx` — closest thing we have to parity |
| **Time Selection** | "Set the time range and current timestamp to apply to the map and time series views" | partial (timeline/replay) |
| **Series** (bottom-right) | "Enables temporal analysis of time series and event data" | not built |

**Top toolbar — the seven tools**

| Tool | Palantir's own description | Our equivalent |
|---|---|---|
| **Select** | "Select all items on the map, invert selection, or select items intersecting with a drawn shape" | `area` tool → box only; no invert, no select-all, no lasso |
| **Search Around** | "Explore object relations" | `GlobeCanvas.tsx:696-705` right-click → `useInvestigation.searchAround` ✅ |
| **Draw** | "Draw and interact with shapes on the map, including polygons, circles, rectangles, lines, points" | `draw.ts` supports **all five** — the UI exposes three |
| **Capture** | "Capture a screenshot of the current map state" | `state/captures.ts` ✅ |
| **Measure** | "Measure physical distances on the map" | `measure` tool ✅ (distance only, no area/bearing) |
| **Annotate** | "Add text or polygon annotations to the map" | point-only, no text entry, no polygon |
| **Delete** | "Remove items from the map" | store-level `remove`, no map-side delete tool |

**The single most important line in the Palantir map docs, for us** (S5):

> Renders using MapboxGL (WebGL dependent) … Geoshape properties automatically render
> but "may impact loading performance" due to value size.

and (S4):

> **Auto:** "By default, the application will use the contents of the layer to infer the
> optimal choice between tile-based and object-based loading."
> **Tile:** "Loads simplified geometry data within the bounds of the map viewport. This
> option is best suited for large object sets and prioritizing performance."
> **Object:** "Loads full details for individual objects. This option is best suited for
> complex styling settings."

Palantir's answer to "too many objects" is **not** a faster renderer. It is: *change what
you load, per layer, automatically, based on how much there is.* We load everything,
always, for every enabled layer. That single architectural difference is the root of
"the backend will blowup when I enable all toggles" — §5 turns it into our design.

Corroborating threshold from the Workshop/Contour map docs: **at ~1,000 features
performance "slows down noticeably"** and the guidance is to switch to vector/tiled
layers. We ship ~13,000 aircraft plus up to 30,000 vessels plus 50+ other layers into a
single entity graph.

## 3. Palantir Gotham — the application inventory, verbatim (S8)

This is the "describe each panel" deliverable. Quotes are from the G-Cloud service
definition PDF.

| Application | Verbatim purpose | Notable internals |
|---|---|---|
| **Browser** | "enables users to view and edit information related to specific objects or groups of objects within the platform's canonical data model (or 'Ontology')" | view/edit properties, add notes, change history, federated single-query search |
| **Custom Object Views (COVs)** | "configurable dashboards … enable individual users or teams to modify the standard object views" | per-team layouts of the *same* object type; tab-level permissioning |
| **Object Explorer** | "Palantir Gotham's top-down analysis application … run analyses on millions of records at a time" | embedded timelines + aggregations; bar/histogram/pie; **real-time object alerts** |
| **Chat** | "securely send and receive messages, files, and data in a classification-controlled, hybrid network environment" | drag-and-drop objects into a channel; auto-redaction by clearance; bridges third-party IM |
| **Inbox** | "centralises results, notifications, and alerts in an inbox-style interactive operational interface" | four alert types: **search feeds, object watch feeds, geofence alerts, sharing alerts** |
| **Slides** | "a data-centric briefing and presentation application … decks are backed by live data" | template mode, intelligent auto-populating fields, live broadcast with presenter hand-off, PPTX/PDF export |
| **Dossier** | "a real-time collaborative text editor … capture notes, annotate investigations, and compile custom profile sheets" | embedded objects keep a **dynamic link to source**; nested dossiers; reusable templates; Word/PDF export |
| **Graph** | "a network analysis application … visual representations of networked data on a shared canvas" | six helpers, below |
| **Gaia** | "a collaborative geospatial command and control application … near real-time" | geotagging, radius/route/polygon/temporal geo-search, heatmaps, SHP/KMZ/KML/LYR, ATAK/WinTAK/Mapbox bridges |
| **Video** | "view, analyse, and enrich full motion video ('FMV')" | AR overlays, sub-second latency on live streams, AI detections with accept/dismiss feedback, burn-in export, **Soak Tool** heatmaps |

**Graph's six "helpers"** — this is a panel grammar worth stealing outright for our
Investigation canvas:

1. **Histogram** — "displays the frequency of occurrence for different buckets or groups:
   Object Types, Entity Properties, Event Properties, Entity Relationships, Events per
   Entity, Notes, Hints, and Tags."
2. **Selection** — "a miniature version of the Browser application that shows users
   details about selected objects and links."
3. **History** — "view how the content and styling of a graph has changed over time, as
   well as which user performed the change."
4. **Table** — "a tabular view of data on a graph," exportable.
5. **Search Around** — "visually query data in the platform … Searches are not limited to
   just single links and can also return complex graphs."
6. **Timeline** — "visualise the time ranges of objects, properties, and links."

The PDF explicitly notes an omission, which is itself information:

> "there are other applications which are used for more sensitive workflows, such as
> **targeting, fires control and execution, ISR, and ISINT analysis** which are not
> listed here."

S7 confirms one of them by name: **Target Workbench**, whose data model is
`name / description / targetBoard / column ∈ {DRAFT, PLAN_DEVELOPMENT, PLANNED,
EXECUTION, CLOSED} / targetType / entityRid / sidc (MIL-STD-2525C) / targetIdentifier /
location (manual | geotimeTrack | geotrackable) / highPriorityTargetListTargetSubtype /
aimpoints / security / detectionReasoning`, with sibling **Target Board** and **High
Priority Target List (HPTL)** resources.

Two things fall out of that model that we can use immediately:

- `sidc` — a **MIL-STD-2525C Symbol Identification Code** field on a first-class object.
  That is the annotation vocabulary §7 should adopt.
- `column` — targeting is modelled as a **kanban with a fixed lifecycle**, not free-form.

## 4. Palantir Foundry — the application inventory, verbatim (S6)

Grouped as Palantir groups them. This is the map of "how complete their system is".

**Data connectivity and integration** — Data Lineage ("shows a graph of how different
resources interacts with and flows through the platform"), Pipeline Builder ("creates
end-to-end pipelines from data sources to final outputs using LLMs"), Code Repositories,
Dataset Preview, Data Health ("define health checks to ensure datasets are
high-quality"), Data Connection, HyperAuto/SDDI ("generates end-to-end data pipelines on
top of common ERP systems"), **Linter** ("analyzes the state of your enrollment to
identify anti-patterns and offers recommendations for optimizing resources, enhancing
cost-efficiency, and improving pipeline stability and resilience").

**Model connectivity** — Model Assets, Modeling Objectives.

**Ontology building** — Ontology Manager, Object Views, Object Explorer, **Vertex**
("explore object relationships and run simulations"), **Machinery** ("understanding and
management of processes by identifying unwanted behaviors"), Foundry Rules ("actively
manage complex business logic"), **Map** ("powerful geospatial and temporal analysis"),
Dynamic Scheduling.

**Developer toolchain** — Ontology SDK, Compute Modules, Code Workspaces, VS Code
Workspaces, Palantir VS Code extension, **Palantir MCP** ("enables external AI IDEs and
agents to connect to the Palantir platform and gain context"), **Ontology MCP (OMCP)**
("exposes application ontology resources as MCP tools").

**Application building** — Workshop, Slate, OSDK React Applications, **Pilot** ("an
AI-powered application builder that creates applications from natural language prompts").

**Workflow building** — Automate, Solution Designer, Carbon ("combine apps and other
resources … to create curated workspaces").

**Analytics** — Contour ("high-scale, top-down analysis on datasets"), Quiver ("analysis
on object data and time series"), Insight ("point-and-click analysis on Ontology objects
with step-by-step analysis paths"), Code Workbook, Notepad, Fusion ("a bidirectional
spreadsheet application").

**Product delivery** — DevOps, Marketplace.
**Security and governance** — Approvals, Checkpoint, Cipher, Sensitive Data Scanner, Data
Lifetime.
**Management** — In-Platform Custom Documentation, Walkthroughs.

We already have recognisable analogues of: Ontology Manager (`intel/ontology_local.py`),
Object Explorer (`explorer/`), Map (globe), Workshop (dashboard panels), Pipeline
Builder + Data Lineage + Dataset Preview (`foundry/`), Palantir MCP (`mcp_server.py`),
Automate (alert rules), Notepad/Dossier (case export), Graph (`graph/InvestigationCanvas`).

We have **no** analogue of: Linter, Data Health, Machinery, Vertex, Fusion, Checkpoint,
Marketplace, Walkthroughs.

## 5. Predicting the unshown panels from their names — the ask, done

The operator explicitly asked to *"predict the other panels feature based on name, try
guessing it."* Each prediction below states the guess, the reasoning, the confidence, and
— the useful part — **what it would mean for this repo**.

| Name | Prediction | Basis | Conf. | What we'd build |
|---|---|---|---|---|
| **Linter** | A platform-wide *anti-pattern scanner* that ranks resources by cost/fragility and emits ranked, actionable recommendations — a "your enrollment is unhealthy in these 12 ways" inbox. | Name + the verbatim description in S6 mentions "anti-patterns", "cost-efficiency", "stability and resilience" | High | A `/api/health/lint` that ranks our own feeds by cost-per-useful-row and flags dead ones. Directly relevant to §5. |
| **Data Health** | Declarative *checks* attached to a dataset (freshness, row-count delta, null-rate, schema drift) with a pass/fail history and alerting. | Name + "define health checks to ensure datasets are high-quality" | High | We already compute `seen_pos_s` freshness ad hoc. Formalise as per-layer health checks surfaced in one panel. |
| **Machinery** | Process-mining: it reads event logs of an object's state transitions and shows the actual process graph vs. the intended one, highlighting loops, rework and stalls. | "identifying unwanted behaviors and facilitating improvements" + the word *machinery* (a process, not a dataset) | Med-High | Applies to our targeting/case lifecycle if §2.3's kanban `column` model is adopted. |
| **Vertex** | A node-graph *simulation* canvas: bind models to ontology objects, wire outputs to inputs, run what-if, watch nodes turn red. | S6 "explore object relationships and run simulations" + the Demo Day description of Vertex chaining models with nodes that "turn red" | High | Our `workflows/EditorView.tsx` is 80% of this already. Add model-node binding + red-state propagation. |
| **Quiver** | Time-series workbench: pick object(s) → pick series properties → stack/overlay/derive (smooth, diff, resample) → annotate → save as a reusable analysis. | "analysis on object data **and time series**"; the name suggests a bundle of arrows/series | High | This is the Palantir **Series** panel's full-page sibling. Our track history + `history.db` already stores the series. |
| **Insight** | Guided analysis: a linear, undoable *path* of point-and-click steps over ontology objects, shareable as a recipe. | "point-and-click analysis on Ontology objects with **step-by-step analysis paths**" | High | Record + replay of an analyst's filter/aggregate steps — cheap on top of `explorer/facets.ts`. |
| **Fusion** | A live spreadsheet whose cells are bound to ontology objects, where editing a cell **writes back** to the object. | "**bidirectional** spreadsheet application" | High | An editable table view over our ontology objects. |
| **Contour** | Board-based SQL-less analysis: each "board" is a step (filter → pivot → join → chart) over a dataset, chained top-down. | "high-scale, **top-down** analysis on datasets"; the Contour docs reference a "Map board" | High | Distinct from Quiver: Contour is dataset/tabular, Quiver is object/temporal. |
| **Carbon** | A workspace shell: pin apps, objects, and saved views into one tabbed/tiled surface per mission. | "combine apps and other resources … to create **curated workspaces**" | High | Our `AppRouter` tabs + detachable panels are the beginning of this. |
| **Pilot** | Natural-language app generation: prompt → generated Workshop layout wired to real object types. | "creates applications from natural language prompts" | High | We have `AgentConsole`; generating a *panel layout* is the missing half. |
| **Checkpoint** | An interstitial that blocks a sensitive action until the user types a justification, which is then audited. | "prompts users for **justifications**" | High | Pairs with our evidence locker's chain-of-custody. |
| **Solution Designer** | A whiteboard for architecture: draw object types, links, pipelines and apps as a diagram that is *live-bound* to the real resources. | "interactive tool for crafting **architectural representations** of solutions" | Med-High | — |
| **Marketplace / DevOps** | Package a working solution (ontology + pipelines + app) as an installable product with versioning. | Names + "Discover and install Foundry products" | High | Our plugin marketplace is a lesser version of this. |
| **Walkthroughs** | Authorable in-product step-by-step coach-marks. | "custom, step-by-step tutorials" | High | Would fix a real persona finding: new users don't know where to start. |
| **Cipher** | Format-preserving/deterministic encryption of columns so joins still work on ciphertext. | "obfuscate data through **cryptographic operations**" | Med | — |
| **Data Lifetime** | Retention policies that propagate along lineage, so deleting a source deletes derivatives. | "**lineage-aware** retention policies" | High | Directly relevant: our `history.db` retention is byte-capped, not lineage-aware. |
| **Nexus Peering** | Store-and-forward replication between disconnected Gotham instances that merges each side's enrichments on reconnect. | Name (peer + nexus) + the SDD's emphasis on "low-bandwidth, high-latency networks" | Med-High | — |
| **Target Workbench** | Confirmed by S7, not a guess: kanban target boards + HPTL + aimpoints + 2525C symbols. | S7 | Certain | §7 borrows the `sidc` idea. |
| **Gaia** | Confirmed by S8. | S8 | Certain | — |

## 6. Palantir video transcripts — what the panels *do* in motion

**S12 — "Gotham for Defense Decision Making" (5:20).** The loop the whole product is
shaped around:

- *Detect*: "AI models running on satellite data detect an increased level of military
  activity"; "Ship detection models identify an alarming buildup of fishing vessels";
  "An activity model detects that many of those ships are tied together suggesting an
  ulterior motive".
- *Fuse and hypothesise*: "Gotham fuses data from multiple sources to project likely
  pass for the Lu Yang. The most dangerous routes head east… The analyst identifies a
  key fork to monitor between the routes."
- *Task collection*: "the models determined that satellite coverage alone is not
  enough… Based on what is capable and ready the system recommends a few alternatives.
  The best option is an aircraft from Okinawa."
- *Verify*: "An analyst back in the operations center **verifies the detection**".
- *Decide*: "examines several human and machine-generated **courses of action** that have
  been jointly tested and developed in past exercises" — three COAs, each scored by
  likely success and risk.
- *Act*: "a task order is submitted and the American ship quickly alters course."

Three things we lack: a **projected-route/uncertainty** product from a dark contact; a
**collection-tasking recommender** ("what asset can see this, and is it available");
**COA cards with explicit risk/time/probability**.

**S13 — "AIP | Defense and Military" (8:05).** The panel grammar of AI-in-the-loop.
The demo is a sequence of *typed natural-language commands*, each producing a
structured, auditable artifact:

`Show me more details` → `What enemy military unit is in the region?` →
`Task new imagery for this location at a resolution of one meter or higher` →
`Task the MQ nine to capture video of this location` →
`Generate three courses of action to target this enemy equipment` →
`Send these three options to my commander for review` →
`Approve course of action three` →
`Analyze the battlefield, considering a Stryker vehicle and a platoon size unit` →
`Generate a route from Team Omega to the enemy equipment` →
`How many Javelin missiles does Team Omega have?` →
`Assign jammers to each of the validated high priority communications targets` →
`Summarize the operational plan` → `Submit` → `Initiate jamming operation`.

The two design rules stated outright:

> "Every response from AIP retains **links back to the underlying data records**,
> propagating the correct classifications, as well as enabling transparency for the user
> who can investigate as necessary."

> "In the AIP control panel, organizations set the **guardrails** for models, including
> how the model interacts with cl[assified data]…"

Our `AgentConsole` has the command surface. It does not have citation-linked responses as
a hard contract, and our LLM path (§8) is too slow for this interaction rhythm — the
demo's whole premise is that each command answers in seconds.

**S14 — "Gotham: Europa" (2:54).** Release framing: Chat and Slides as the collaboration
pillars; pre-deployment ML model testing ("test machine learning models supporting those
decisions **before they are deployed**"); MetaConstellation for commercial-space tasking;
"a new data integration engine and platform architecture" underneath.

## 7. Palantir's own frontend engineering — the techniques, with numbers (S10, S11)

This is the most directly actionable research in the whole section. From
*Plotlines in Three.js* (S11), describing how Gaia renders satellites and tracks:

- **Instanced mesh for high-density objects.** "With tens of thousands of objects circling
  around the globe, we used an instanced mesh to update objects on and off the map" —
  thousands of satellites in a **single draw call**.
- **Batch lines by style.** "The `EarthLineGroup` batches lines by style into single draw
  calls. **10,000 lines with the same styling become one GPU operation.**"
- **Circular buffer instead of recomputation.** Rather than "perform thousands of SGP4
  propagations per second," they advance a sliding queue: "When a point falls off the
  front, we recalculate it for the next block at the back." Stated saving: **~95%**.
- **Touch the GPU buffer only on change.** "we only touch the GPU buffer when visibility
  actually changes."
- **Visibility via shader, not geometry.** "each line maps to a range of segments, and we
  can flip their opacity between 0 and 1," with a shader that "discards invisible
  fragments" — no geometry rebuild.
- **No per-frame allocation.** Animation callbacks: "only material properties update, no
  geometry rebuilds."
- **Amortise heavy work across frames.** `this.currentBatch = this.nextBatch()` —
  SGP4 propagation is spread over many frames instead of concentrated in one.

From *Redefining Real-Time Map Collaboration* (S10):

- **Send the minimum.** Only "user info, viewport, cursor location, and selection state"
  cross the wire — designed for low-bandwidth networks.
- **Throttle by count, not time.** "Processed only **every third cursor event**, reducing
  update frequency by two-thirds" while staying perceptually smooth.
- **Sync only when someone is watching.** State is "only stored and synced across clients
  when a user is actively being followed."
- **Pre-stream before you need it.** "Critical state is now passively streamed before a
  user starts following."
- **Geo-coordinates, not pixels**, for cursors and viewport bounding boxes, so clients
  with different screen sizes agree.
- 15-second disconnect tolerance; scaled to "hundreds of concurrent users following the
  same leader."

**The four we adopt directly**, mapped to phases:

| Palantir technique | Our phase | Our application |
|---|---|---|
| Batch by style into one draw call | §6.3 | Our per-entity billboards with per-category SVG → one `BillboardCollection` per category atlas |
| Only touch GPU buffers on change | §6.2 | Already partly done (position-unchanged skip); extend to label + colour |
| Amortise heavy work across frames | §6.4 | Chunk the upsert loop against `frameBudget.ts` |
| Throttle by event count | §7.5 | The measure/move mousemove storm |

## 8. The repeatable video-transcript recipe (no API key, no file writes)

Used for S12–S14 and re-runnable for any future Palantir video:

```bash
yt-dlp --dump-json --no-warnings "https://www.youtube.com/watch?v=<ID>" \
| python3 -c "
import json,sys,urllib.request,re
d=json.load(sys.stdin)
subs=(d.get('subtitles') or {}).get('en') or (d.get('automatic_captions') or {}).get('en') or []
url=next((s['url'] for s in subs if s.get('ext')=='vtt'), subs[0]['url'])
req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
txt=urllib.request.urlopen(req,timeout=30).read().decode('utf-8','replace')
out=[]
for l in txt.splitlines():
    if '-->' in l or l.startswith(('WEBVTT','Kind:','Language:')) or not l.strip(): continue
    l=re.sub(r'<[^>]+>','',l).replace('&nbsp;',' ').strip()
    if out and out[-1]==l: continue
    out.append(l)
print(' '.join(out))"
```

PDFs: `pdftotext -layout <file>.pdf -` streams to stdout, no temp file.

## 9. Source URLs

- S1 https://www.palantir.com/docs/foundry/map/map-overview
- S2 https://www.palantir.com/docs/foundry/map/getting-started
- S3 https://www.palantir.com/docs/foundry/map/layer-editor
- S4 https://www.palantir.com/docs/foundry/map/objects-loading-methods
- S5 https://www.palantir.com/docs/foundry/workshop/widgets-map
- S6 https://www.palantir.com/docs/foundry/getting-started/application-reference
- S7 https://www.palantir.com/docs/gotham/api/target-workbench/target/create-target
- S8 https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/92736/801146272055049-service-definition-document-2024-11-26-1253.pdf
- S9 https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/92736/804537709233305-service-definition-document-2024-11-26-1252.pdf
- S10 https://blog.palantir.com/frontend-engineering-at-palantir-redefining-real-time-map-collaboration-8845ebb928d1
- S11 https://blog.palantir.com/frontend-engineering-at-palantir-plotlines-in-three-js-c0c47f310715
- S12 https://www.youtube.com/watch?v=rxKghrZU5w8
- S13 https://www.youtube.com/watch?v=XEM5qz__HOU
- S14 https://www.youtube.com/watch?v=tZVx3BTkLlI
- Contour map board (feature-count guidance) https://www.palantir.com/docs/foundry/contour/boards-map
- Workshop Map [Legacy] https://www.palantir.com/docs/foundry/workshop/widgets-map-legacy
- Gotham platform page https://www.palantir.com/platforms/gotham/
- Palantir Learn https://learn.palantir.com/
- IEEE, *A Brief Analysis of Palantir Gotham* https://ieeexplore.ieee.org/iel8/10808182/10808189/10808897.pdf

Supporting technical sources for the implementation phases:

- Cesium, *Entity API Performance* https://cesium.com/blog/2018/06/21/entity-api-performance/
- Cesium community, EntityCollection vs Billboard/LabelCollection https://community.cesium.com/t/entitycollection-performance-vs-billboardcollection-labelcollection/8168
- Cesium, *Drawing on 3D Models and Terrain* https://cesium.com/blog/2016/03/21/drawing-on-the-globe-and-3d-models/
- `@cesium-extends/drawer` https://www.npmjs.com/package/@cesium-extends/drawer
- `cesium-drawhelper` https://github.com/leforthomas/cesium-drawhelper
- milsymbol (MIL-STD-2525 / APP-6 in JS, "1000 symbols in less than 20 milliseconds") https://github.com/spatialillusions/milsymbol
- mil-sym-js (2525B/C, multi-point control measures) https://github.com/Xuvasi/mil-sym-js
- deck.gl (1M+ points at 60fps) https://deck.gl/docs
- FastAPI GZipMiddleware vs pre-gzipped responses https://github.com/fastapi/fastapi/discussions/11972
- Headless Chromium memory tuning https://webscraping.ai/faq/headless-chromium/what-are-the-best-practices-for-managing-memory-usage-in-headless-chromium

---


After writing §2.5 the predictions were checked against Palantir's analytics docs. Scoring
the guesses matters: it tells us how much weight to put on the ones still unverified.

| Name | Predicted | Palantir's own words | Verdict |
|---|---|---|---|
| **Quiver** | "Time-series workbench: pick object(s) → pick series properties → stack/overlay/derive → annotate → save as a reusable analysis" | "Quiver provides a point-and-click interface to perform data analysis on **object and time series data from the Ontology**, and you can use these analyses to create **interactive dashboards** that allow others to explore and investigate the data in operational workflows" | **Correct**, and it adds dashboards — Quiver dashboards can be "embedded in Object Views, Workshop applications, or Notepad documents" |
| **Contour** | "Board-based analysis: each board is a step (filter → pivot → join → chart) over a dataset, chained top-down" | "Contour enables data analysis on **tabular data at scale** … a point-and-click user interface to perform data analysis on tables at scale". Contour dashboards "support chart-to-chart filtering, inline parameter references, a fullscreen presentation view, and PDF exports" | **Correct** on tabular/top-down; the board chain is confirmed by the Map board doc |
| **Insight** | "Guided analysis: a linear, undoable path of point-and-click steps over ontology objects, shareable as a recipe" | "Insight is designed for **operational users** to analyze the ontology and **create object sets**" | **Partly correct** — the point-and-click-over-ontology half is right; the emphasis is object-set construction for operators, not a shareable recipe |
| **Vertex** | "A node-graph simulation canvas: bind models to ontology objects, wire outputs to inputs, run what-if, watch nodes turn red" | Not in the analytics docs; the Demo Day narration describes exactly this ("simulate the interactions of all of the models and the impact on the supply chain into the future"; visualization nodes "turn red to alert users") | **Corroborated by video, not by doc** |
| **Machinery**, **Fusion** | process mining / bidirectional spreadsheet | Not covered in the analytics docs | **Still prediction only** |

Two useful lessons for us:

1. **The split Palantir draws is dataset-vs-object, not chart-type.** Contour is tabular
   and top-down; Quiver is ontology objects and time series. Our `explorer/` is closer to
   Insight, our `foundry/` closer to Contour, and we have nothing at all in the Quiver
   slot. `docs/…` follow-up (Series panel)'s Series panel is the cheapest entry into it.
2. **Dashboards are an output of an analysis, not a separate app.** Both Contour and
   Quiver produce embeddable, read-only, interactive dashboards from a saved analysis.
   Our dashboard panels are hand-built React; the leverage would be making a saved
   `explorer/` analysis renderable as a panel. Not in scope, but worth a `docs/roadmap`
   line.

Sources for this appendix:
https://www.palantir.com/docs/foundry/analytics/types-of-analysis ,
https://www.palantir.com/docs/foundry/analytics/overview ,
https://www.palantir.com/docs/foundry/analytics/dashboards ,
https://www.palantir.com/docs/foundry/quiver/overview ,
https://www.palantir.com/docs/foundry/contour/overview

---


The operator asked to *"describe each panels and predict the other panels feature based on
name."* Sections 2-5 give the inventory and the predictions; this section walks each panel
individually with the four things an implementer needs: **what it shows**, **what its
controls are**, **what we have**, and **the smallest thing we could build**.

Panels are ordered by how much they would change this product, not by Palantir's ordering.

### 11.1 Gaia / Map — Selection panel (right)

**Palantir:** "Analyze details about and take actions on the selected items." It is the
right-hand column of the map and it is where an object becomes actionable — properties,
links, and the actions the ontology permits on that object type.

**Controls:** object header with type + primary key; property list; linked-object
sections; an actions menu; and (from the Workshop map options, S5) a "Show selection
panel" toggle with "display selected objects or details" modes and a "Panel size: full or
compact".

**We have:** `EntityPanel.tsx` (61 KB) — the strongest parity in the whole product. It
carries the dossier, the enrichment fusion, the AI brief, the track, and the actions.

**Gap:** no compact mode; no multi-select summary (Palantir's "selected objects" mode vs
"details" mode); actions are hard-coded per kind rather than declared by the ontology.

**Smallest build:** a compact/full toggle and a multi-select summary header
("14 aircraft selected · 3 military · 2 emergency") with the per-kind facet counts
`explorer/facets.ts` already computes. ~1 day.

### 11.2 Gaia / Map — Time Selection panel (right)

**Palantir:** "Set the time range and current timestamp to apply to the map and time
series views."

**Controls (from S5, which is unusually explicit):** enable timeline; allow the user to
change the selected time; a user-facing **live mode** toggle ("View latest"); open by
default; a `Selected time` variable; a `Time window` as two timestamps; time zone (local
or UTC); time format (12/24/local); a **playback state** boolean; a **playback position**
in milliseconds; and **"Auto pause at"** — an array of timestamps the playback stops on.

That last one is the interesting design: playback that *stops itself at the moments that
matter*. Our replay has no such concept.

**We have:** a timeline and replay, plus `situations/controlStore.ts`.

**Gap:** no "View latest" affordance distinct from scrubbing; no auto-pause; no explicit
UTC/local switch on the timeline itself.

**Smallest build:** auto-pause at detected events. We already generate incidents
(`intel/incidents.py`) and alerts — feed their timestamps in as pause points during
replay. That turns replay from a scrub into a briefing. ~2 days.

### 11.3 Gaia / Map — Series panel (bottom right)

**Palantir:** "Enables temporal analysis of time series and event data." It is Quiver's
territory embedded into the map.

**We have:** nothing. Track history exists in `history.db` and the selection track ring,
but there is no chart.

**Smallest build:** `docs/…` follow-up (Series panel) — altitude and speed for the selected entity over the last hour,
drawn from `/api/history/tracks`. One sparkline pair, no interaction beyond hover. This is
the highest value-per-line item in the whole appendix: it turns a position into a
behaviour.

### 11.4 Gaia / Map — Layers panel (left)

**Palantir:** "Add, manage, and style object and overlay layers; set the base layer." Three
layer types: base map, object layers, overlay layers. Object layers are configured by
**object type + filters** or by a **saved object set from Object Explorer**. Display
options include colour, opacity, labels/tooltips, per-geometry styling, geometry reorder
and delete, a legend toggle per layer and per geometry, a **lock layer** toggle that
prevents selection, and the loading method (§2).

Raster layers get opacity, **sampling** (linear vs nearest, quoted in S3), and min/max
zoom levels.

**We have:** `LayerRail` (all 64 sources, per-layer opacity slider) and `LayerCatalog`
(7 curated folders, 52 rows, 3 hidden).

**Gap, in order of impact:**
1. **No per-layer styling.** Style is compiled into `styles.ts`. Palantir's layer is a
   data selection *plus* a style; ours is a data selection with a fixed style.
2. **No saved-set layer.** Palantir can drop a saved Object Explorer exploration onto the
   map as a layer. Our `explorer/` produces filtered sets that cannot become layers.
3. **No lock.** A layer you can see but not select is genuinely useful for reference data
   — it is exactly the fix for "I keep selecting the airport instead of the aircraft".
4. **No per-layer legend.**

**Smallest build:** (3) first — one boolean per layer, honoured in the selection pick.
Then (1) as colour + size overrides on the existing `styleKind` dispatch, not a full style
editor.

### 11.5 Gaia / Map — Find panel (left)

**Palantir:** "Find objects and locations; navigate to specific geospatial coordinates."
One panel, both jobs.

**We have:** a search box (objects) and `CoordEntry.tsx` (coordinates) — two surfaces.

**Smallest build:** one input that sniffs its content. A string that parses as a coordinate
in any of the common formats (DD, DMS, MGRS, UTM) flies there; anything else searches
objects. MGRS/UTM parsing is ~80 lines and is the format military users actually type.

### 11.6 Gaia / Map — Histogram panel (left)

**Palantir:** "Analyze objects based on property and time series values" — and in Graph the
Histogram helper buckets by "Object Types, Entity Properties, Event Properties, Entity
Relationships, Events per Entity, Notes, Hints, and Tags."

Note it is *both* an analysis and a **filter**: you brush a bucket and the map filters.

**We have:** `explorer/facets.ts` computes facets, and there is a histogram in the
explorer — but it does not filter the map.

**Smallest build:** wire the existing facet counts to a click-to-filter on the globe. The
facets are already computed on an idle walk (`globe/entityStats.ts`); the missing piece is
a filter predicate the adapters honour.

### 11.7 Gaia / Map — Info panel (left)

**Palantir:** "Display an overall summary of the map."

**We have:** `useEntityStats` counts, shown in `CommandBar` `SysStats`, with the two most
diagnostic numbers hidden above 1920 px (the perf-HUD item).

**Smallest build:** the perf-HUD item's perf popover, doubling as the Info panel: entity counts by
layer, feed freshness, renders/s, drain ms, backend event-loop lag. One panel that answers
both "what am I looking at" and "why is it slow".

### 11.8 Map toolbar — Select

**Palantir:** "Select all items on the map, invert selection, or select items intersecting
with a drawn shape," plus (S5) "advanced selection tools", a "Search within" geospatial
Ontology query, "Track search" and "Filter breadcrumbs" for tracks, and a "Modify" tool for
editing a drawn shape.

**We have:** box-select via the `area` tool, which then offers `areaActions()`.

**Gap:** no invert, no select-all-in-view, no polygon select (the draw mode exists), no
track-specific search.

**Smallest build:** the Select-tools follow-up. All three operate on `useSelection` and `draw.ts` modes that
already exist.

### 11.9 Map toolbar — Search Around

**Palantir:** "Explore object relations." In Graph it is stronger: "Searches are not
limited to just single links and can also return complex graphs."

**We have:** parity, and it is good — `GlobeCanvas.tsx:696-705` right-click on an entity →
`useInvestigation.searchAround(id)` → the Investigation canvas.

**Gap:** single-hop framing in the UI even though the backend can do more.

**Smallest build:** a hop-count control (1/2/3) on the search-around menu item.

### 11.10 Map toolbar — Draw

**Palantir:** "polygons, circles, rectangles, lines, points," with drawn-shape colour and
opacity, a **shape output type** (GeoJSON feature vs geometry collection), a
**single-draw mode**, **clear shapes after operation**, **antimeridian splitting**, and an
**"On drawn shape" event** that triggers app logic.

**We have:** `draw.ts` implements all five modes. Three are reachable.

**Gap:** the antimeridian is unhandled — `GlobeToolbar.tsx:84-92` builds a box from
`min`/`max` lat/lon, which is wrong across the dateline; and the "on drawn shape" event is
implicit (each caller passes a callback) rather than a shared hook.

**Smallest build:** the annotation plan §9.7 wires the missing modes; add an antimeridian split to the rect
path (detect `east < west` after normalization, emit two boxes).

### 11.11 Map toolbar — Measure

**Palantir (S5):** measurements are a *display* property of a shape, not a separate mode —
"Polygon perimeter: segment or total length", "Polygon area: display within shape",
"Line measurements: segment or cumulative length", units following the map or org default.

That is a better model than ours. We have a Measure *tool* whose output disappears when
you switch tools; Palantir has measurements *on the geometry*.

**Smallest build:** the annotation plan §9.6's on-geometry measurement labels. Then the Measure tool becomes a
convenience (draw a throwaway line) rather than the only way to get a number.

### 11.12 Map toolbar — Capture

**Palantir:** "Capture a screenshot of the current map state."

**We have:** parity — `state/captures.ts`, localStorage-persisted, and captures can become
map entities (a pattern already documented in project memory).

**Gap:** none worth fixing now.

### 11.13 Map toolbar — Annotate

**Palantir:** "Add text or polygon annotations to the map." Note the two kinds Palantir
names first are exactly the two we do not have: **text** and **polygon**.

**We have:** the annotate audit's inventory.

**Build:** the annotation overhaul, in full (see the plan).

### 11.14 Map toolbar — Delete

**Palantir:** "Remove items from the map."

**We have:** store-level remove from the annotation list; nothing on the map.

**Smallest build:** the Delete-tool follow-up.

### 11.15 Gotham Browser + Custom Object Views

**Palantir:** Browser views and edits an object; COVs are per-team, per-object-type
dashboards of widgets, with tab-level permissioning, configurable without code.

**We have:** `EntityPanel` is Browser. We have no COV concept — every object type gets one
hard-coded layout.

**Why it matters here:** COVs are the answer to a persona complaint we already have on
record (different users want different things from the same panel). It is also the
Workshop pattern applied to the selection panel.

**Smallest build:** a saved per-kind panel layout (which sections, in what order,
collapsed or not) in the ontology, with a "reset to default". Not a widget editor.

### 11.16 Gotham Object Explorer

**Palantir:** "top-down analysis … run analyses on millions of records at a time," with
embedded timelines and aggregations, bar/histogram/pie, drill-down filters, **and
subscribable real-time object alerts** delivered to Inbox or email.

**We have:** `explorer/` with facets. No alerts from the explorer.

**Gap:** the alert subscription is the operationally important half — "tell me when
anything matching this filter appears" is the difference between a tool you open and a
tool that opens you.

**We already have the substrate:** local alert rules + Discord/webhook sinks
(`docs/decisions.md`, 2026-07-11) and `/ws/alerts`. The missing piece is "save this
explorer filter as a rule".

**Smallest build:** a "Subscribe" button on a saved explorer filter that mints an alert
rule. This is Palantir's **search feed** (§3) exactly.

### 11.17 Gotham Inbox

**Palantir:** one triage surface for four alert types — **search feeds**, **object watch
feeds**, **geofence alerts**, **sharing alerts** — grouped into channels, resolvable
in place, with "a clear path to the relevant application to perform those actions."

**We have:** alerts exist; a unified triage inbox does not.

**Gap:** this is the single most Palantir-shaped thing we are missing, because it changes
the product's mode from "look at a map" to "work a queue".

**Smallest build:** a panel over the existing alert store with the four channel types,
grouped, each row carrying a "go to" action that selects the entity and flies there. The
geofence type maps directly onto our watchbox.

### 11.18 Gotham Graph and its six helpers

**Palantir:** a shared canvas of nodes and links with Histogram / Selection / History /
Table / Search Around / Timeline helpers, real-time collaborative, exportable to
standalone HTML.

**We have:** `graph/InvestigationCanvas.tsx` (35 KB), with search-around wired.

**Gap:** four of the six helpers (Histogram, History, Table, Timeline). **History** is the
interesting one — "view how the content and styling of a graph has changed over time, as
well as which user performed the change" — because it is provenance for analysis, and our
ontology already has an append-only `assertions` table that could back it.

**Smallest build:** the Table helper (a tabular view of the canvas contents, exportable).
Then Timeline, reusing the Series work from §21.3.

### 11.19 Gotham Dossier

**Palantir:** collaborative rich-text where embedded objects "retain a dynamic link back to
its source, which updates to reflect any changes in the underlying data", with nested
dossiers, reusable templates, and Word/PDF export.

**We have:** case → report export (evidence locker), which is the export half.

**Gap:** the *dynamic link*. Our exports are snapshots.

**Smallest build:** an object-mention syntax in the case notes that renders live from the
ontology. The ontology already stores the objects; this is a renderer.

### 11.20 Gotham Slides

**Palantir:** "decks are backed by live data", template mode, intelligent auto-populating
fields, live broadcast with presenter hand-off, PPTX/PDF export.

**We have:** `python-pptx` is already a dependency and the report export path exists.

**Gap:** the live-data binding and the template system.

**Not in scope**, but noted: of everything in this appendix, Slides is the one whose
absence a *briefer* would feel most, and the dependency is already installed.

### 11.21 Gotham Video

**Palantir:** FMV with AR overlays (maps, blue-force tracks, no-strike lists, AI
detections), sub-second latency, tag-to-create-object, burn-in export, and the **Soak
Tool** — "generate heatmaps on aggregate detections in a given area over the course of a
single stream, or to compare detections in the same area recorded at two different times."

**We have:** camera layers, HLS playback (`hls.js` is a dependency), detection overlays,
and a spotlight/FOV layer.

**Gap:** tagging a detection into an object; the Soak Tool.

**Smallest build:** click-to-tag on a camera stream, creating an ontology object at the
camera's location with the frame attached. The evidence locker already handles the
chain-of-custody half.

### 11.22 Gotham Chat

**Palantir:** classification-controlled messaging with drag-and-drop object sharing,
automatic redaction by clearance, and third-party IM bridging.

**We have:** nothing, and `yjs` is installed.

**Not in scope.** Listed because it is one of only two features Palantir chose to headline
in the Europa release (S14), which says something about what operational users ask for.

### 11.23 AIP — the control panel and the citation contract

From S13, the two design rules that are worth adopting even without building AIP:

1. **"Every response from AIP retains links back to the underlying data records."** Our
   selection brief and country brief produce prose with no structured citations. Making
   citations a *hard contract* of the LLM response schema (each claim carries the object
   ids it came from) is a bounded change to `llm.py`'s response handling and it is what
   makes model output auditable.
2. **A guardrail control panel** where "organizations set the guardrails for models,
   including how the model interacts with cl[assified data]". We have `_INJECTION_GUARD`
   and `with_prose_style` as code constants. A settings panel that shows what the model
   can and cannot see is a small UI over existing config.

Both are model-path adjacent and both are cheaper than they look. Neither is in this branch's
scope; both belong in the follow-up entry the deferred-work list creates.

---


The operator asked for more sources across the board. Three categories, each with what it
would take to wire.

### 12.1 Palantir / competitive reference — already used, listed for the doc

Everything in §1 and §9, plus the analytics docs in §15. Two more worth reading during
implementation, not before:

- Palantir Learn (https://learn.palantir.com/) — free training tracks; the Workshop and
  Ontology tracks are the closest thing to a public spec of the panel grammar.
- IEEE, *A Brief Analysis of Palantir Gotham: A Collaborative and Interactive Big Data
  Visualization Analysis Software Based on Dynamic Ontology*
  (https://ieeexplore.ieee.org/iel8/10808182/10808189/10808897.pdf) — an outside-in
  architecture read.
- Palantir Privacy and Governance Whitepaper
  (https://www.palantir.com/assets/xrfr7uokpv1b/6pey1VnYHULqeggNbPKqP0/9f577de3e3dfb9fc031bd75dc7526517/Palantir_Privacy_and_Governance_Whitepaper__1_.pdf)
  — relevant to our Checkpoint/audit gap (§5).
- `palantir/defense-sdk-examples` (https://github.com/palantir/defense-sdk-examples) and
  `palantir/gotham-platform-python` (https://github.com/palantir/gotham-platform-python) —
  the public Gotham API surface, which is where §2.3's Target model came from.

### 12.2 Comparable open platforms — worth reading for what they got cheap

| Project | Why it is worth an hour |
|---|---|
| ShadowBroker (https://github.com/BigBodyCobain/Shadowbroker) | Same premise as ours (ADS-B + AIS + orbital + seismic in one globe) with a "Recon Toolkit panel for keyless OSINT lookups". Compare their layer set to our 64. |
| Godseye (https://github.com/VrushankPatel/godseye) | Frontend-only, backend-free, keyless — an extreme version of our keyless invariant. Their CelesTrak fallback chain is worth copying. |
| Phantom Tide (https://phantom.labs.jamessawyer.co.uk/) | Cross-domain correlation dashboard (ships + aircraft + notices + environment + satellite detections). Closest to our incident-brief fusion. |
| IntelSky (https://www.intelsky.org/) | Squawk monitoring + a 147 k-aircraft profile database. Our `emergencies` layer is a thin version of this. |
| The OSINT Toolbox, Flight & Marine (https://github.com/The-Osint-Toolbox/Flight-And-Marine-OSINT) | A maintained source list — the cheapest way to find feeds we do not have. |
| deck.gl (https://deck.gl/docs) | Not a migration proposal. Read it for the layer/attribute-update model, which is the same idea as §7.3's batching. |

### 12.3 Candidate new data layers, ranked by (value ÷ effort)

Each is keyless or degrades keylessly, which is a CLAUDE.md invariant. **None of these is
in scope for this branch** — they are the answer to "find more sources", to be filed in
`docs/osint-sources-plan.md` and picked up separately.

| Candidate | Kind | Why | Effort |
|---|---|---|---|
| NOTAMs (FAA/EUROCONTROL) | airspace polygons | We have TFRs but not the broader NOTAM set; directly complements `airspace.tfr` | M — XML, same shape as the TFR parser |
| GDACS tropical-cyclone **track forecasts** | line + cone | We show cyclone points; the forecast cone is the decision-relevant part | S — same feed we already pull |
| Copernicus EMS rapid-mapping activations | polygons | Authoritative "something happened here" boundaries | S |
| OpenSky **flight tracks** (not just states) | polylines | We reconstruct tracks client-side; upstream has real ones | M |
| USGS **ShakeMap** contours | polygons | Turns a quake point into an impact footprint | S |
| NOAA/NWS **radar** tiles | raster | The one basemap-adjacent layer analysts always ask for | M — tile proxying already exists |
| Global Fishing Watch (public tiles) | raster/points | Directly complements the SAR dark-vessel AOIs | M — check licence |
| OpenInfraMap power lines | lines | We have plants and substations, not the grid between them | M — vector tiles |
| Wikidata **conflict/incident** items | points | Fills GDELT's gaps for historical events | M — SPARQL, and the query-shape traps in `intel/country_profile.py` apply |
| ADS-B **receiver coverage** map | polygons | Honest coverage reporting — an antidote to "why is this area empty" | S |
| SWPC **aurora oval forecast** | polygon | We have the point/index feed; the oval is the visual | S |
| Sentinel-2 **NDVI/burn-scar** on demand | raster | Fits the existing on-demand imagery path | L |

The honest ranking rule for adding any of these: a layer earns its slot only if it changes
what an operator would *do*, not just what they can *see*. The persona studies in
`docs/user-feedback-personas-*.md` are the input for that judgement, not this document.

---

