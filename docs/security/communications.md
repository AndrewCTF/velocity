# Communications inventory and egress policy

| Field | Value |
| --- | --- |
| Covers | OWASP ASVS 5.0 V13.1.1 (communication needs), V13.2.4 and V13.2.5 (outbound allowlist, accepted as a denylist), V12.3.3 (internal hops, see [`crypto-and-keys.md`](crypto-and-keys.md) §2.1); ISO/IEC 27001:2022 A.8.20, A.8.21, A.8.22 |
| Version | 1.0 (Draft until merged to `master`) |
| Adopted | 2026-09-13 |
| Owner | Maintainer (inventory and software guards); Operator (host firewall, TLS proxy) |
| Review | Yearly with the SoA, and whenever a new upstream, sidecar, workflow block or listener is added (reassessment trigger in [`isms/risk-assessment.md`](isms/risk-assessment.md) §4) |
| Code citations | Working tree of branch `compliance-2026-09`, read on 2026-09-13 (base commit `56db34f`). Files other work was still changing are cited by symbol name, not line, and marked `<!-- recheck -->` |

The software runs in three deployment modes (keyless, static key, multi-user;
[`auth-and-sessions.md`](auth-and-sessions.md)). The tables below apply to all three unless a row says
otherwise.

## 1. Inbound

| Listener | Bind address and port | Protocol | Who connects | Authentication | TLS | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Host reverse proxy (operator's) | Public, 443 | HTTPS, WSS | Browsers, MCP clients, scripts, ingest senders | Passes credentials through | **Yes, operator-configured** | [`operator-hardening.md`](operator-hardening.md) §1 |
| nginx (production compose) | `127.0.0.1:8080` on the host → nginx in the container | HTTP | The host proxy only | None of its own; edge rate limit | No (loopback) | nginx `ports:` in `docker-compose.prod.yml`; `listen` in `infra/nginx/nginx.prod.conf` <!-- recheck --> |
| api (uvicorn) | Container port 8000 on the compose bridge `front` (`172.28.0.0/24`); **no published port** | HTTP, WebSocket, SSE | nginx | Per route: [`auth-and-sessions.md`](auth-and-sessions.md) pathway table | No (bridge, accepted risk R28) | `Settings.api_port` in `apps/api/app/config.py`; the `api` service and `networks:` in `docker-compose.prod.yml`; `set $api_upstream api:8000` in `infra/nginx/nginx.prod.conf` <!-- recheck --> |
| api routes reached through nginx | `/api/`, `/api/workflows/`, `/api/evidence/upload`, `/api/recon/jobs`, `/tiles/`, `/ws/`, `/mcp` | as above | as above | as above | as above | `location` blocks in `infra/nginx/nginx.prod.conf` <!-- recheck --> |
| `POST /api/ingest/{dataset_id}` | through nginx | HTTP | External systems pushing rows | `X-Ingest-Token` | at the host proxy | [`auth-and-sessions.md`](auth-and-sessions.md) |
| ADS-B tar1090 sidecar | `127.0.0.1:8090` | HTTP | api only | `SIDECAR_TOKEN` bearer on data requests; `/health` open | No | `_PORT` in `apps/api/app/adsb_sidecar.py`; `listen(PORT, '127.0.0.1')` in `tools/adsb-globe-feeder/index.js`; `apps/api/app/sidecar_token.py` <!-- recheck --> |
| AIS sidecars: VesselFinder, MarineTraffic (off by default), MyShipTracking | `127.0.0.1:8091`, `8092`, `8093` | HTTP | api only | `SIDECAR_TOKEN` bearer | No | `Settings.ais_vesselfinder_sidecar_url`, `ais_marinetraffic_sidecar_url`, `ais_myshiptracking_sidecar_url` in `apps/api/app/config.py`; `apps/api/app/ais_sidecar.py`; `tools/ais-*-feeder/index.js` <!-- recheck --> |
| llama.cpp sidecar | `127.0.0.1:8094` | HTTP | api only | Per-boot bearer key | No | `Settings.llamacpp_host`; `_api_key` in `apps/api/app/llamacpp_sidecar.py` |
| vLLM sidecar (off by default) | `127.0.0.1:8095` | HTTP | api only | Per-boot bearer key | No | `Settings.vllm_host`; `_api_key` in `apps/api/app/vllm_sidecar.py` |
| Browser-fetch sidecar (off by default) | `127.0.0.1:8095` | HTTP | api only | `SIDECAR_TOKEN` bearer and a loopback `Host` check | No | `Settings.browser_fetch_port`; `hostOk`, `tokenOk` in `tools/browser-fetch/index.js`. **Same default port as vLLM**: enabling both needs one port changed <!-- recheck --> |
| MAVLink bridge (off by default) | `127.0.0.1:9010` | HTTP | api workflow blocks | `MAVLINK_BRIDGE_TOKEN`, required when an uplink is armed | No | `Settings.mavlink_bridge_enabled`, `mavlink_bridge_port`; `apps/api/app/mavlink_bridge.py:375-381` |
| OSINT recon sidecar (off by default) | Operator-set, for example `127.0.0.1:8099` | HTTP | api only | None | No | `Settings.osint_recon_sidecar_url` in `apps/api/app/config.py` |
| Vite dev server (development only) | `:5173` | HTTP | Developer browser | — | No | Root `CLAUDE.md`; not in production compose |

Sidecars bind `127.0.0.1` only. Most now require a bearer token on data requests, but the traffic is clear
text and any local user can reach the ports; the host itself is the trust boundary (see R28).

## 2. Outbound

### 2.1 Fixed upstreams (hosts chosen by the software)

These destinations are named in code. `grep -rhoE 'https?://[a-zA-Z0-9.-]+\.[a-z]{2,}' --include=*.py apps/api/app | sort -u`
listed **446** distinct hosts on 2026-09-13. That count over-states real egress: many entries are links
in the OSINT source catalogue that the software shows to the analyst but never fetches. The table groups
the ones the backend does call.

| Group | Examples | Protocol and port | Auth | When | Source |
| --- | --- | --- | --- | --- | --- |
| ADS-B aggregators | airplanes.live, adsb.fi, adsb.lol, adsbexchange, OpenSky | HTTPS 443; headless Chrome through sidecars | Keyless | Always on (1 s snapshot loop) | Keyless ADS-B settings block in `apps/api/app/config.py` |
| AIS | Kystverket NMEA stream `153.44.253.27:5631`; Digitraffic; ShipXplorer; aisstream.io | **Raw TCP 5631, no TLS**; HTTPS 443; WSS 443 | Keyless, except aisstream (`AISSTREAM_KEY`) | Always on (Kystverket, ShipXplorer); aisstream when keyed | `Settings.ais_firehose_enabled`, `ais_firehose_host`, `ais_firehose_port`, `ais_shipxplorer_url` in `apps/api/app/config.py`; `AISSTREAM_URL` in `apps/api/app/routes/ais.py` |
| Hazards, weather, space | USGS, GDACS, NOAA, CelesTrak, FIRMS | HTTPS 443 | Keyless; FIRMS keyed | Background polls | `apps/api/app/routes/firms.py:48-51` and the feed modules |
| Basemaps and imagery | Carto, EOX, Sentinel Hub | HTTPS 443 | Keyless; Sentinel Hub OAuth | On map use | [`data-protection.md`](data-protection.md) §5 |
| OSINT lookups | rdap.org, crt.sh, Shodan InternetDB, certspotter, Gravatar, Libravatar, HIBP | HTTPS 443 | Mostly keyless; HIBP keyed | Analyst-initiated | [`data-protection.md`](data-protection.md) §5 |
| LLM providers | NVIDIA, DeepSeek, MiniMax endpoints, or local | HTTPS 443 | Provider keys | Analyst-initiated or scheduled briefs | `Settings.minimax_api_key`, `nvidia_api_key`, `deepseek_api_key` in `apps/api/app/config.py` |
| Supabase | The operator's project (`SUPABASE_URL`) | HTTPS 443 | Anon key plus the caller's token; audit rows | Multi-user mode | `Settings.supabase_url`, `supabase_anon_key`; `_url` in `apps/api/app/audit.py` |
| Model and binary downloads | Hugging Face, GitHub releases | HTTPS 443 | Keyless | Operator-initiated | `apps/api/app/localllm/` |
| Optional egress tiers | Operator proxy pool (`UPSTREAM_PROXIES`); Cloudflare WARP SOCKS5 on `127.0.0.1:40000` | HTTP(S) proxy, SOCKS5 | Operator's | Off by default | `Settings.upstream_proxies`, `warp_enabled`, `warp_proxy_port` in `apps/api/app/config.py` |

Every shared-client HTTPS request verifies certificates (no `verify=False` in `apps/api/app`,
[`crypto-and-keys.md`](crypto-and-keys.md) §2).

### 2.2 Destinations chosen by a user

| Feature | Who sets the destination | Guard | Allowlist setting | Source |
| --- | --- | --- | --- | --- |
| Evidence URL capture | Any signed-in analyst | Public addresses only: every resolved address of the host must pass `netguard.is_non_public_ip` (redirect handling: [`input-and-files.md`](input-and-files.md) §1) | None | `_validate_public_host_sync` in `apps/api/app/intel/evidence.py` <!-- recheck --> |
| News image fetch | Feed content | Public addresses only | None | `apps/api/app/news/images.py:15`, `apps/api/app/news/images.py:59` |
| `/tiler?url=` (cloud-optimised GeoTIFF) | Any caller allowed on the route | Public addresses only | `TILER_ALLOW_HOSTS` **widens** the rule: a listed host skips the public-address check | `apps/api/app/imagery/tiler.py:104-122`, `Settings.tiler_allow_hosts` |
| Alert-rule sinks (webhook delivery) | Any signed-in analyst | Public addresses only, at create and at delivery | `WORKFLOWS_HTTP_ALLOW_HOSTS`: when set, **only** listed hosts are allowed, and a listed host may be private | `apps/api/app/workflows/control.py:256-270`, `apps/api/app/workflows/control.py:288` |
| Workflow `op.http`, `control.webhook`, `control.drone`, `control.device` | Operator only (`require_operator` on workflow routes) | http(s) only; link-local and cloud-metadata ranges always refused; loopback and LAN **allowed by default** because the operator's control server is often local; `WORKFLOWS_HTTP_BLOCK_PRIVATE=1` also refuses private ranges | `WORKFLOWS_HTTP_ALLOW_HOSTS`: when set, **only** listed hosts are allowed | `apps/api/app/workflows/control.py:104-113`, `apps/api/app/workflows/control.py:116-130`, `apps/api/app/workflows/control.py:210-252` |
| Foundry connections (MQTT, Kafka, SQL) | Operator only | Operator gate; DSN stored as an environment variable name, not a value. No address filter | None | `apps/api/app/routes/foundry.py:438`, `apps/api/app/foundry/connections.py:51`, `apps/api/app/foundry/connections.py:72` |

## 3. Egress policy decision (V13.2.4, V13.2.5)

**Decision (2026-09-13).** The server's outbound allowlist is defined as **"public unicast internet
addresses"**, enforced by `apps/api/app/netguard.py` (which refuses loopback, private, link-local,
reserved, multicast, unspecified and CGNAT ranges, including IPv4 embedded in IPv6, `apps/api/app/netguard.py:25-49`), plus the fixed upstreams in §2.1. It is not a
host allowlist.

Reason: capturing arbitrary public web pages as evidence, and looking up arbitrary domains, is the product.
A host allowlist would stop the evidence locker and the OSINT lookups from working. The main danger of
unrestricted egress, reaching internal services (SSRF), is covered by the public-address rule. Operator-gated
features that must reach the LAN (§2.2) are restricted to accounts that already hold operator authority.

Residual risk: a compromised or malicious analyst can make the deployment send requests to any public host,
which discloses the deployment's IP address and can be used to probe third parties. Risk register: R29.

**Hardening for deployments that do not need arbitrary egress** (operator controls):

1. Set `WORKFLOWS_HTTP_ALLOW_HOSTS` to the exact hosts workflows and alert sinks may reach.
2. Set `WORKFLOWS_HTTP_BLOCK_PRIVATE=1` if no workflow needs the LAN.
3. Leave `TILER_ALLOW_HOSTS` empty.
4. Put a host or container egress firewall in front of the api. Example with nftables on the Docker host,
   for the compose bridge `172.28.0.0/24`:

   ```
   table inet velocity_egress {
     set allowed_v4 { type ipv4_addr; flags interval; elements = { <resolved upstream addresses> } }
     chain forward {
       type filter hook forward priority 0; policy accept;
       ip saddr 172.28.0.0/24 ip daddr 172.28.0.0/24 accept
       ip saddr 172.28.0.0/24 ct state established,related accept
       ip saddr 172.28.0.0/24 ip daddr @allowed_v4 tcp dport { 443, 5631 } accept
       ip saddr 172.28.0.0/24 udp dport 53 accept
       ip saddr 172.28.0.0/24 drop
     }
   }
   ```

   Docker inserts its own forwarding rules, so test the result with `docker compose exec api` and a
   request to a host that is not listed. Because upstream addresses change, a forward proxy with a
   **domain** allowlist (for example Squid or Envoy, set as `UPSTREAM_PROXIES`) is easier to maintain than
   an address set. Point every proxy at infrastructure you control
   (`Settings.upstream_proxies` in `apps/api/app/config.py`).
5. The Kystverket AIS stream is plain TCP on port 5631 without TLS. Allow it only if you use that feed, or
   disable it with `AIS_FIREHOSE_ENABLED=false` (`Settings.ais_firehose_enabled`).
