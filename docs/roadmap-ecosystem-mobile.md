# Roadmap — from console to ecosystem, and a mobile app (2026-07-11)

Planning-only. No code changes proposed here; this document sets direction and
sequencing so a later cycle can spec a vertical slice. It assumes the identity
fixed by `CLAUDE.md` and `docs/roadmap-users-2026-07.md`: keyless, local-first,
self-hosted, evidence-first, no data resale. "Ecosystem" and "mobile" are only
worth building if they extend that identity rather than dilute it.

Every "already exists" claim below cites a file verified this session.

---

## 1. What "ecosystem" concretely means here

The platform is already more substrate than app. An ecosystem play is mostly
*exposing and gluing what exists*, not new capability. The pieces:

- **HTTP API + auth wrapper.** Every browser→backend call goes through
  `apps/web/src/transport/http.ts` (`apiFetch` / WS key wrap), authenticating
  with either a Supabase bearer token or a static `X-API-Key` (`VITE_API_KEY`),
  against a base URL (`VITE_API_URL`). This is the one integration seam every
  other client — including mobile — reuses. It is framework-agnostic TypeScript
  (plain `fetch` + headers), which matters for §2.
- **MCP server, in-process at `/mcp`.** `apps/api/app/mcp_server.py` serves a
  streamable-HTTP MCP endpoint mounted into the FastAPI app
  (`apps/api/app/main.py:494`, gzip-bypassed at `main.py:124`). Agents get a
  typed world model (query aircraft/vessels/jamming/SAR/incidents) over the
  same box. This is the "let any agent drive it" surface.
- **Plugin marketplace.** The repo *is* a Claude Code plugin marketplace:
  `plugin/osint-geoint/` bundles a skill (`skills/osint-intel/SKILL.md`),
  commands (`osint-brief`, `osint-jamming`, `osint-watch`), and an agent
  (`agents/osint-watch-officer.md`) with cross-platform installers. This is the
  distribution channel for the agent-facing side.
- **Workflows engine.** `apps/api/app/workflows/` (`engine.py`, `store.py`,
  `blocks.py`, `control.py`) plus the web app `apps/web/src/workflows/` — a
  block-graph automation runtime (subprocess Python/SQL/LLM, persistent memory).
  This is the user-programmable layer: users compose behavior without touching
  the codebase.
- **Actuation / egress blocks.** `apps/api/app/workflows/control.py` +
  `mavlink_bridge.py` (documented in `docs/workflows-control-blocks.md`) give
  `op.http` / webhook / drone / device blocks — the platform can *act*, not just
  observe. Downstream systems can be driven from a workflow.
- **Alert delivery sinks.** `apps/api/app/intel/alert_rules_local.py` +
  `routes/alert_rules.py` define `discord` / `webhook` channels with a
  `sink_url`; delivery is `watch.py::_deliver_sinks` reusing the workflow HTTP
  path. This is the outbound-event bus — the thing a phone ultimately subscribes
  to.

**Already built:** all six substrates above, plus the local ontology
(`apps/api/app/intel/ontology_local.py`, `routes/ontology.py`) and incident
briefs (`intel/incident_store.py`, `intel/incidents.py`) that a client reads.

**Missing glue (the actual ecosystem work), in rough order:**

1. A **stable, versioned public API contract** for third-party clients. Today
   the API is shaped by the web app's needs; nothing documents which routes are
   safe to build against. An ecosystem needs a small, frozen read surface
   (entity lookup, watchlist, incidents, alert stream) with a compatibility
   promise.
2. **Pairing / credential issuance** for non-browser clients (see §3). The
   `X-API-Key` mechanism exists but there is no in-product flow to mint and hand
   a key to a phone or a third-party tool.
3. **Outbound event fan-out beyond Discord/webhook** — the sink list is the
   right substrate but a mobile app wants push, not a Discord poke (see §3).
4. **A published, semver'd MCP tool contract** so external agents don't break on
   internal refactors (the W5 item in the users roadmap already flags rate
   limiting as the prerequisite).

None of this is a rebuild. The ecosystem is a documentation, contract, and
credential-issuance problem layered on substrate that already runs.

---

## 2. Mobile app: the realistic options for *this* codebase

The mobile value proposition is narrow and clear: **an analyst's watch-officer
in their pocket** — alerts pushed to the phone, a watchlist they can check,
entity lookup, and incident briefs to read. Read-mostly. It is *not* a second
full console. The question is only which shell delivers that against this repo.

### Option A — PWA of the existing web app
Wrap `apps/web` as an installable PWA. Lowest nominal effort, but the web app is
a Cesium/WebGL globe SPA with a large bundle; it is built for a desktop GPU and
a mouse. On a phone it is heavy, awkward, and battery-hostile, and the one
feature that justifies a mobile app — **background push notifications** — is
exactly what PWAs do worst (iOS web-push is constrained and historically
unreliable for this use case). A PWA drags the whole heavyweight frontend to get
a poor version of the one thing we need. Reject as the primary path.

### Option B — React Native / Expo, reusing the TS transport layer  ✅ recommended
Build a purpose-made read-mostly app in Expo. It reuses the existing
framework-agnostic transport code (`apps/web/src/transport/*.ts` — `http.ts`
`apiFetch`, `config.ts`, `entity.ts`, `search.ts`) by extracting it into a
shared TS package both `apps/web` and the mobile app import. The UI is rebuilt
native (lists, cards, a lightweight 2D map), which is the point — mobile
ergonomics, not a shrunk desktop. Crucially, **native push** via Expo
Notifications → APNs/FCM is first-class, which is the whole reason to ship
mobile. 2D mapping has mature native libraries (MapLibre GL Native /
react-native-maps). Medium effort; highest payoff.

### Option C — Tauri 2 mobile
The desktop shell is already Tauri (`apps/desktop/src-tauri/tauri.conf.json`,
which *already* carries an `android` block), so Tauri 2 mobile is superficially
"free." But Tauri mobile renders a **webview** — it would either ship the same
heavyweight Cesium SPA (Option A's problem in a native wrapper) or require a
separate lightweight web frontend built anyway, at which point Option B's native
UI is the better spend. Tauri 2 mobile's background-push story is also less
mature than Expo's. Keep Tauri for desktop; do not stretch it to phone v1.

### Recommendation
**React Native / Expo (Option B).** The deciding factor is push: the mobile
app's reason to exist is turning the existing keyless alert engine
(`alert_rules_local.py` / `watch.py`) into a phone notification, and native push
is a solved problem in Expo and a chronic pain in the other two. The transport
layer being plain TS makes the reuse real, not aspirational. Bonus: extracting
`transport/` into a shared package is a healthy refactor regardless.

### What mobile v1 ships (read-mostly)
- **Push alerts** from the existing rules engine ("aircraft went dark",
  "vessel entered AOI", "watchlist hit") — the headline feature.
- **Watchlist** view/manage against the existing entity + alert-rule routes.
- **Entity lookup** — search a callsign/MMSI/reg, see the current fix + recent
  history, reusing `transport/search.ts` and `entity.ts`.
- **Incident briefs** — read the cited briefs from `incident_store` /
  `incidents.py` in the Inbox.
- **A lightweight 2D map** (MapLibre / react-native-maps) to place an entity or
  an AOI — enough to orient, not to fuse.

### What v1 explicitly does NOT ship
- **No Cesium globe port.** The 3D fused globe stays desktop/web only. A 2D map
  is the mobile surface; do not attempt the WebGL globe on a phone in v1.
- No workflow editing, no Foundry, no imagery/SAR, no data entry beyond
  watchlist toggles. Mobile is a consumption + notification client, not an
  authoring tool. Authoring stays on the desktop console.

---

## 3. Sync / auth model against self-hosted instances

The platform is keyless-local-first: there is no central Velocity cloud that a
phone logs into. **The mobile app pairs with the user's own instance.** This is
a feature (your data never leaves your box), and it shapes the design.

- **Credential.** Reuse the existing `X-API-Key` mechanism
  (`transport/http.ts` sends `X-API-Key`; the backend already accepts it). The
  instance mints a scoped, read-mostly key for the phone.
- **QR pairing.** The desktop console shows a QR encoding `{ baseUrl, apiKey }`.
  The app scans it, stores both in the device secure store (Keychain /
  Keystore), and every request is the mobile analog of `apiFetch` — base URL +
  `X-API-Key`. No account, no password, consistent with identity.
- **Reachability.** `baseUrl` is the user's instance address. Three tiers, in
  honesty order: (a) **same LAN** — direct, zero infra; (b) **overlay VPN**
  (Tailscale / WireGuard) — the self-hosted community's default, direct and
  private, recommended in docs; (c) **optional relay** — a Cloudflare Tunnel
  (the prod topology already fronts the box with a CF Worker → Caddy chain per
  `velocity-prod-deployment` memory) for users who want off-LAN access without a
  VPN. The app treats all three as just a base URL; only docs differ.
- **Push is the hard part, name it honestly.** A self-hosted box behind NAT
  cannot itself hold an APNs/FCM connection per device without a push service.
  Two honest options: **(1)** background notifications ride the *existing*
  Discord/webhook sink (`_deliver_sinks`) — the phone's OS notifies from
  Discord/Telegram, zero new infra, ships day one; **(2)** a thin, optional
  Velocity push relay that the instance POSTs firings to and that fans out to
  APNs/FCM by device token. Option (1) is the v1 answer (reuse, no new server);
  option (2) is a later convenience that must stay optional to preserve the
  "nothing leaves your box unless you opt in" promise — and the relay must carry
  only an opaque "you have an alert, open the app" ping, never the alert
  contents, so the payload still comes from the user's instance.
- **Foreground sync** is trivial: when open, the app polls/WS the same routes
  the web app uses. The only genuinely new engineering is background delivery,
  and v1 sidesteps it via the existing sink.

---

## 4. Phasing, effort, dependency order, kill criteria

Effort: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks. This sequence is **downstream of
the users roadmap** (`docs/roadmap-users-2026-07.md`): W3 keyless alert push is
the hard dependency for anything mobile, and launch/replay come first. Do not
start Phase M1 before the platform has users asking for a phone client.

- **E0 — API contract freeze (S).** Document the small read surface third-party
  clients (incl. mobile) may build against; add a version header. *Depends on:*
  nothing. *Kill:* if no external client demand materializes post-launch, this
  stays a one-page doc and goes no further.
- **E1 — Extract shared transport package (S).** Lift `apps/web/src/transport/*`
  into a shared TS package consumed by web now, mobile later. *Depends on:* E0.
  *Kill:* if the mobile track is abandoned, this is still a net-positive refactor
  — no kill needed.
- **M1 — Pairing flow (S/M).** QR mint on desktop + `X-API-Key` scoped key
  issuance. *Depends on:* E0. *Kill:* if the security review can't bound a
  phone-scoped key's blast radius acceptably, defer mobile entirely.
- **M2 — Mobile v1 (Expo), read-mostly (L).** Alerts (via Discord/webhook sink
  in v1), watchlist, entity lookup, briefs, 2D map. *Depends on:* E1, M1, and
  **users-roadmap W3** (keyless alert push must actually fire server-side).
  *Kill:* if W3's keyless firing isn't reliable, mobile has nothing to notify
  about — hold until it is.
- **M3 — Optional push relay (M).** Opaque-ping APNs/FCM fan-out for off-LAN
  background push. *Depends on:* M2 shipped and a real user asking. *Kill:* if
  demand is absent, the Discord/webhook path is sufficient — never build the
  relay speculatively; it adds the first always-on Velocity-operated service and
  must be justified by real users.
- **E2 — MCP/plugin public contract (S/M).** Semver the MCP tools + list the
  plugin, *after* rate-limiting the MCP layer (users-roadmap W5). *Depends on:*
  W5 rate limiting. *Kill:* if agent traffic can't be kept off the throttled
  upstreams, do not list publicly.

---

## 5. Risks

- **Mobile is a distraction from launch.** The scarce resource is the 90-day
  launch window (users roadmap §5). A mobile app before there are users is
  building for an imagined persona. Gate M1+ on real post-launch demand; the
  ecosystem doc work (E0/E1) is cheap and can proceed, the app cannot.
- **Push against self-hosted boxes is genuinely hard** and the honest v1 answer
  (ride Discord) may feel second-class to users expecting native push. Set that
  expectation in docs; do not over-promise native background push in v1.
- **A push relay betrays local-first if done wrong.** Any Velocity-operated
  service is a rug-pull surface and a metadata leak. Keep it optional, opaque
  (ping only, contents from the user's box), and never on the default path.
- **App-store friction / ToS.** Shipping an OSINT client that surfaces
  aircraft/vessel positions may draw store review scrutiny; the feeds' own
  redistribution ToS (adsb.lol, airplanes.live, AIS) constrain what a
  *published* app may show vs. what a user's own instance shows them. Legal
  surface is larger than for a self-hosted web console.
- **Maintaining two frontends** (web + Expo) doubles UI upkeep. The shared
  transport package limits the damage to the view layer, but it is real ongoing
  cost — justify it with the push feature, not feature parity.
- **Contract freeze rigidity.** Freezing a public API/MCP surface slows internal
  refactors of guarded feed/perf code. Keep the frozen surface deliberately
  small (read-mostly) so it doesn't ossify the hot backend paths.

**Bottom line:** the ecosystem is 80% exposing substrate that already runs (API,
MCP, plugin marketplace, workflows, actuation, alert sinks) behind a small
frozen contract; the mobile app is a read-mostly Expo client reusing the TS
transport layer, whose sole must-have is turning the keyless alert engine into a
phone push — and whose whole design is downstream of pairing with the user's own
self-hosted box. Do the cheap contract/refactor work anytime; gate the app on
real users and on the keyless-alert-firing dependency landing first.
