# OSINT source expansion — implementation spec

Batch-adds keyless (or key-optional, degrade-to-note) OSINT connectors harvested
from `jivoi/awesome-osint`, `Astrosp/Awesome-OSINT-List`, and a web/reddit/docs
sweep. Every connector MUST link its output into the shared ontology graph (mint
canonical `kind:identifier` Object/Link rows), not merely expose a GET endpoint —
that is the whole point ("all linked together, not just APIs"). Cross-source id
collisions (`ext:organization:<slug>`, `email:`, `asn:AS…`, `ip:`) are the bridge
between infra-OSINT and the rest of the graph.

## Hard invariants every connector obeys (non-negotiable — see CLAUDE.md)

1. **Keyless-first / never-raise.** Each connector is `async def name(arg) -> dict`,
   returns a normalised dict, and NEVER raises on upstream failure — degrade to an
   empty result + a `"note"` key (exactly like `connectors.py`). Key-optional
   sources read the key from `get_settings()`; with no key they return
   `{"…": …, "note": "needs <ENV> key"}` — they must still import and run keyless.
2. **Use the shared fetch layer** (`app/osint/fetch.py`): `fetch_json` (GET) or the
   new `fetch_json_post` (Phase 0). Never construct a raw httpx client. Pass
   `browser_ua=True` for hosts that reject non-browser UAs (crt.sh, OTX, SEC, abuse.ch).
3. **Bounded.** Cap list outputs (subdomains ≤40, txs ≤25, results ≤25). Report an
   honest total count alongside the truncated list.
4. **Validate input format** before the upstream call (reuse the `normalise_*`
   helpers); a bad target returns a `note`, not a mangled request.
5. **No new deps.** Stdlib + existing `httpx`/`upstream` only.

## New ObjectKinds (Phase 0, `intel/ontology.py`)

Add to the `ObjectKind` Literal AND `_KNOWN_KINDS` frozenset (DB `kind` is free
text — no migration): `"url"`, `"wallet"`, `"tx"`, `"file"`.
Reuse existing kinds where they already fit: company → `org` (id
`ext:organization:<slug>`, bridges registrant/document orgs), sanctions/abuse/
breach → `threat`, cert → `cert`, ASN → `asn`, officers/people → `person`.

### Canonical id schemes

| kind | id scheme | example |
|------|-----------|---------|
| url | `url:<normalised-url>` (scheme+host+path, lowercased, ≤200 char) | `url:http://evil.test/x` |
| file | `file:<sha256>` (or sha1/md5 lowercased) | `file:ab12…` |
| wallet | `wallet:<chain>:<address>` | `wallet:btc:1A1z…`, `wallet:eth:0xabc…` |
| tx | `tx:<chain>:<txid>` | `tx:btc:9f2c…` |
| asn | `asn:AS<n>` (already used) | `asn:AS15169` |
| org (company) | `ext:organization:<slug>` (already used) | `ext:organization:acme-corp` |

### New link relations (documented in `KNOWN_RELS` comment, not enforced)

`archived_url`, `contacted`, `announces` (exists), `peers_with`, `tor_exit`,
`listed_by` (threat feed → ip), `distributes` (url → file), `sends_to` /
`receives_from` (wallet ↔ tx), `officer_of`, `sanctioned_as`, `same_as`
(wikidata entity bridge), `posted_by` (reddit activity → username).

## Phase 0 — `fetch.py` + `ontology.py` (ONE agent, runs first)

Owns `app/osint/fetch.py` and `app/api/app/intel/ontology.py`. Deliverables:

1. `fetch_json_post(url, ttl, *, data=None, json_body=None, headers=None,
   browser_ua=False) -> Any` — mirrors `fetch_json` (semaphore + cache + degrade to
   None) but issues a POST (form `data` or `json_body`). Cache key = url + a stable
   hash of the body. Keep GET `fetch_json` unchanged (backward compat).
2. New normalisers, each `-> str | None`:
   - `normalise_url` — require a scheme (`http`/`https`) OR a path/query (so a bare
     domain does NOT classify as a url); lowercase host, keep path; reject >2048 char.
   - `normalise_hash` — 32/40/64 hex → lowercased md5/sha1/sha256; else None.
   - `normalise_wallet` — return `(chain, address)`-style canonical `"btc:<addr>"` /
     `"eth:0x…"`. BTC: base58 26–35 (`1`/`3` prefix) or bech32 `bc1…`; ETH: `0x`+40 hex.
   - `normalise_asn` — `AS?\d+` (case-insensitive) → `AS<n>`.
3. Extend `classify_target` — NEW ORDER (specific → loose), returning `(kind, canonical)`:
   `ip → email → wallet → asn → file(hash) → url → domain → username`.
   Rationale: an ETH `0x…` (42 char) and a hash are hex but wallet has the `0x`/
   base58 shape; asn `AS15169` before domain; url needs a scheme/path so it can't
   eat a bare domain; username stays the loosest. **Existing classify assertions in
   `tests/test_osint_person.py` must still pass** (ip/email/domain/username inputs
   unchanged). Add new-kind assertions there or in a new test.
4. `ontology.py`: add the 4 kinds above to `ObjectKind` + `_KNOWN_KINDS`; extend the
   `KNOWN_RELS` doc comment with the new verbs. Run
   `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api/tests/test_ontology_local.py -q`
   green.

## Phase A — connector modules (6 agents, PARALLEL, disjoint files)

Each agent creates ONE module under `app/osint/sources/` (create the package with an
`__init__.py`) plus ONE unit test `apps/api/tests/test_osint_src_<name>.py` that
monkeypatches `fetch_json`/`fetch_json_post` and asserts the normalised dict shape
(no live network in tests). Follow the connector docstring style of `connectors.py`.

### A1 `sources/infra.py` — domain/ip infrastructure enrichment
| fn | endpoint | auth | returns |
|----|----------|------|---------|
| `wayback_urls(domain)` | `http://web.archive.org/cdx/search/cdx?url={d}&matchType=domain&output=json&fl=original&collapse=urlkey&limit=500` | keyless | `{domain, urls:[…], subdomains:[…], count}` (derive subdomains from url hosts) |
| `hackertarget_hosts(domain)` | `https://api.hackertarget.com/hostsearch/?q={d}` (plaintext `host,ip` lines) | keyless (50/day) | `{domain, hosts:[{host,ip}], count, note?}` |
| `anubis_subdomains(domain)` | `https://jldc.me/anubis/subdomains/{d}` | keyless | `{domain, subdomains:[…], count}` |
| `columbus_subdomains(domain)` | `https://columbus.elmasy.com/api/lookup/{d}` | keyless | `{domain, subdomains:[…], count}` |
| `certspotter_issuances(domain)` | `https://api.certspotter.com/v1/issuances?domain={d}&include_subdomains=true&expand=dns_names` | key-optional (`CERTSPOTTER_API_KEY`) | `{domain, subdomains:[…], certs:[{issuer,not_before,not_after}], count}` |
| `urlscan_domain(domain)` | `https://urlscan.io/api/v1/search/?q=domain:{d}` | key-optional (`URLSCAN_API_KEY`) | `{domain, scans:[{url,ip,asn,time}], ips:[…], count}` |

### A2 `sources/netblock.py` — ip/asn routing + reputation
| fn | endpoint | auth | returns |
|----|----------|------|---------|
| `bgpview_ip(ip)` | `https://api.bgpview.io/ip/{ip}` | keyless | `{ip, prefixes:[…], asns:[{asn,name,country}]}` |
| `bgpview_asn(asn)` | `https://api.bgpview.io/asn/{n}` + `/asn/{n}/prefixes` | keyless | `{asn, name, description, country, prefixes:[…], peers:[…], upstreams:[…]}` |
| `ripestat_network(ip)` | `https://stat.ripe.net/data/network-info/data.json?resource={ip}` + `abuse-contact-finder` | keyless (add `sourceapp=velocity-osint`) | `{ip, asns:[…], prefix, abuse_email}` |
| `greynoise_community(ip)` | `https://api.greynoise.io/v3/community/{ip}` | key-optional (`GREYNOISE_API_KEY`) | `{ip, classification, name, tags:[…], last_seen, noise:bool}` |
| `onionoo_exit(ip)` | `https://onionoo.torproject.org/details?type=relay&running=true&search={ip}` | keyless | `{ip, is_tor_exit:bool, nickname, country}` |
| `feodo_listed(ip)` | `https://feodotracker.abuse.ch/downloads/ipblocklist.json` (cache 1h, scan for ip) | keyless | `{ip, listed:bool, malware, first_seen}` |

### A3 `sources/threat_feeds.py` — url/hash/email threat
| fn | endpoint | auth | returns |
|----|----------|------|---------|
| `urlhaus_host(host)` | POST `https://urlhaus-api.abuse.ch/v1/host/` form `host={host}`, header `Auth-Key` if set | key-optional (`ABUSECH_AUTH_KEY`) | `{host, urls:[…], url_count, note?}` |
| `urlhaus_url(url)` | POST `https://urlhaus-api.abuse.ch/v1/url/` form `url={url}` | key-optional | `{url, threat, tags:[…], payloads:[sha256], status}` |
| `malwarebazaar_hash(hash)` | POST `https://mb-api.abuse.ch/api/v1/` form `query=get_info&hash={h}` | key-optional | `{hash, family, file_type, tags:[…], first_seen, signature}` |
| `yaraify_hash(hash)` | POST `https://yaraify-api.abuse.ch/api/v1/` form `query=lookup_hash&search_term={h}` | keyless | `{hash, yara:[…], clamav:[…]}` |
| `emailrep(email)` | `https://emailrep.io/{email}` (browser_ua) | keyless (key-optional `EMAILREP_API_KEY`) | `{email, reputation, suspicious:bool, malicious:bool, breach:bool, profiles:[…]}` |
| `phishstats_url(url)` | `https://phishstats.info:2096/api/phishing?_where=(url,eq,{url})` | keyless | `{url, score, tld, ip, count}` |

### A4 `sources/crypto.py` — wallet/tx (BTC + EVM)
| fn | endpoint | auth | returns |
|----|----------|------|---------|
| `mempool_btc_address(addr)` | `https://mempool.space/api/address/{a}` + `/address/{a}/txs` | keyless | `{address, chain:"btc", funded, spent, balance, tx_count, txs:[{txid,value,in:[addr],out:[addr]}]}` (≤25 txs) |
| `blockstream_btc(addr)` | `https://blockstream.info/api/address/{a}` | keyless | `{address, chain:"btc", funded, spent, tx_count}` (cross-check/fallback) |
| `blockchair_address(chain, addr)` | `https://api.blockchair.com/{chain}/dashboards/address/{a}` | key-optional (`BLOCKCHAIR_API_KEY`) | `{address, chain, balance, tx_count, txs:[…]}` |
| `blockscout_evm(addr, host?)` | `https://eth.blockscout.com/api/v2/addresses/{a}` + `/token-balances` | keyless | `{address, chain:"eth", balance, tokens:[…]}` |

Wallet/tx linking: mint `wallet:<chain>:<addr>`; for each tx mint `tx:<chain>:<txid>`
and link counterparties `wallet -sends_to-> tx -receives_from-> wallet` (bounded).

### A5 `sources/corp.py` — company / person / sanctions / entity-resolution
| fn | endpoint | auth | returns |
|----|----------|------|---------|
| `sec_edgar_company(name)` | `https://efts.sec.gov/LATEST/search-index?q="{name}"` then `https://data.sec.gov/submissions/CIK{cik}.json` (browser_ua + descriptive UA) | keyless | `{name, cik, ticker, sic, filings:[{form,date,accession}], officers?}` |
| `opensanctions_search(name)` | `https://api.opensanctions.org/search/default?q={name}` | keyless (key-optional) | `{query, matches:[{id,name,schema,topics,datasets}], count}` |
| `opencorporates_search(name)` | `https://api.opencorporates.com/v0.4/companies/search?q={name}` | key-optional (`OPENCORPORATES_API_KEY`) | `{query, companies:[{name,number,jurisdiction,status}], count, note?}` |
| `openownership_search(name)` | `https://register.openownership.org/statements?query={name}` (or api) | keyless | `{query, owners:[{name,type}], count}` |
| `aleph_search(name)` | `https://aleph.occrp.org/api/2/entities?q={name}` | key-optional (`ALEPH_API_KEY`) | `{query, entities:[{id,name,schema,collection}], count}` |
| `wikidata_search(name)` | `https://www.wikidata.org/w/api.php?action=wbsearchentities&search={name}&format=json&language=en` | keyless | `{query, entities:[{qid,label,description}], count}` |

### A6 `sources/social.py` — username/email social enrichment
| fn | endpoint | auth | returns |
|----|----------|------|---------|
| `pullpush_reddit(username)` | `https://api.pullpush.io/reddit/search/submission/?author={u}&size=25` | keyless | `{username, submissions:[{subreddit,title,created}], subreddits:[…], count}` |
| `libravatar_exists(email)` | `https://seccdn.libravatar.org/avatar/{md5}?d=404&s=80` (HEAD/GET, 200=exists) | keyless | `{email, has_avatar:bool}` |

## Phase B — integration (ONE agent, after Phase A)

Owns `app/routes/osint.py`, `apps/web/src/osint/InvestigatePanel.tsx`, and
`apps/api/tests/test_osint_investigate_v2.py`. Deliverables:

1. **GET endpoints** (self-fetch cards, keyless, no auth) for the new connectors,
   mirroring the existing `/api/osint/{dns,whois,…}` pattern — one per connector,
   `target`/`name`/`ip` query param as appropriate.
2. **Extend existing orchestrators** (mint + link into the same root):
   - `_investigate_domain`: add wayback+hackertarget+anubis+columbus subdomains
     (`has_subdomain`), certspotter certs (`cert:` nodes, `secured_by`), urlscan
     contacted ips (`ip:` nodes, `contacted`).
   - `_enrich_ip`: add bgpview/ripestat asn+peers (`asn:` `announces`/`peers_with`),
     ripestat abuse email (`email:` `abuse_contact`), greynoise+onionoo+feodo →
     `threat:` node `listed_by`/`tor_exit` when flagged.
   - `_investigate_email`: add emailrep (reputation → `threat:` when malicious/breach),
     libravatar presence prop.
   - `_investigate_username`: add pullpush activity (subreddits as props/count).
3. **New orchestrators + dispatch** in `investigate()`:
   - `_investigate_url` → `url:` root, urlscan+urlhaus+phishstats; distributed files
     `file:` `distributes`; contacted `ip:` `contacted`; threat on match.
   - `_investigate_hash` → `file:` root, malwarebazaar+yaraify; `threat:` when family
     known; link to distributing `url:` if seen.
   - `_investigate_wallet` → `wallet:` root, mempool/blockstream/blockchair/blockscout;
     `tx:` nodes + counterparty wallets.
   - `_investigate_asn` → `asn:` root, bgpview/ripestat; `ip:`/prefix + peer `asn:`.
   - `_investigate_company` → `ext:organization:<slug>` root, sec/opensanctions/
     opencorporates/openownership/aleph/wikidata; officers `person:` `officer_of`,
     sanctions `threat:` `sanctioned_as`, wikidata `same_as`.
   - Wire classify: url/file/wallet/asn auto-route. Company is NOT machine-classifiable
     from a bare string → add optional `kind: str | None` to `InvestigateRequest`;
     when `kind=="company"` route to `_investigate_company` with the raw `target` name.
4. **Frontend**: update `InvestigatePanel` placeholder + hint text to advertise the new
   target types (url · hash · btc/eth wallet · ASN · company). Keep `apiFetch`. Add a
   small "Company" mode toggle that sends `{target, kind:"company"}`. Typecheck green.
5. **Tests** `test_osint_investigate_v2.py`: monkeypatch the new connectors, call each
   `_investigate_X(g, target)`, assert the expected nodes + links land in
   `g.objs`/`g.links` (pattern = existing `test_osint_person.py`).

## Verification (Phase C — orchestrator)

- `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` ≥ inherited baseline (939) + new tests.
- `pnpm -r typecheck` green.
- `bash scripts/verify.sh` green.

## Explicitly SKIPPED (documented, not built) — and why

- **Key-required, no free/degrade tier or unverified path**: Shodan(full), Censys,
  ZoomEye, FOFA, VirusTotal, AbuseIPDB, SecurityTrails, BuiltWith, Ahrefs, SimilarWeb,
  WPScan, BeVigil, FullHunt, Criminal IP, ONYPHE, Hunter.io, Clearbit/FullContact,
  Proxycurl, Twilio/numverify (phone), WiGLE (mac→geo), Crunchbase, Spamhaus DQS,
  Shadowserver (vetted), DeHashed, Intelligence X, Companies House. Add later behind
  BYOK if the operator wants a specific one — the connector pattern is identical.
- **Phone / MAC input kinds**: no verified keyless source with graph value → deferred.
- **Unverified small/new services** (Frostbyte, digga.dev, oti-labs, HoneyLabs, IPOK,
  isMalicious, SikkerAPI, Validin, ODIN, DFIR-Platform, etc.): not built until an
  endpoint is confirmed — too flaky for a batch.
- Twitter/X unofficial scrapers (TwitterAPI.io, GetXAPI, SocialData, Xquik): ToS/
  stability risk, all key+paid → skipped.
</content>
