"""Digital-OSINT infra/domain routes — /api/osint/*.

Two surfaces:

  GET  /api/osint/{dns,whois,ip,certs,shodan,threat}?target=…  — keyless lookups
        (public data; the EntityPanel cards self-fetch these). No auth.

  POST /api/osint/investigate {target}  — fan out the connectors for a domain or
        ip and PERSIST the results as Object/Link rows into the caller's ontology
        (same pattern as ``routes/extract.py``: per-user, ACL-stamped, provenance
        in props, one audit row). The frontend then renders the graph via the
        existing ``/api/ontology/search-around/{root}``. Signed-in user when
        Supabase is configured; degrades to the shared local identity on a
        keyless boot (``current_user_or_local``), same as ontology/situations.

New object ids (canonical ``kind:identifier``, kinds registered in
``intel/ontology.py``): ``domain:`` ``ip:`` ``cert:`` ``asn:`` ``service:``
``threat:`` ``org:`` ``email:`` ``url:`` ``file:`` ``wallet:`` ``tx:``.

Phase B of the OSINT source expansion (docs/osint-sources-plan.md) wires the
new keyless connector modules (``app/osint/sources/*``) both as standalone GET
cards and into the existing ``investigate()`` fan-out, so every connector's
output lands in the shared graph, not just an API response. ``kind="company"``
on ``InvestigateRequest`` opts into ``_investigate_company`` for free-text
company names, which aren't machine-classifiable from a bare string.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.audit import audit
from app.config import get_settings
from app.intel.ontology import Link, Object, get_registry
from app.keys import UserCtx, current_user_or_local
from app.osint import connectors as C
from app.osint.fetch import classify_target
from app.osint.sources import corp, crypto, infra, netblock, social, threat_feeds
from app.upstream import get_client

router = APIRouter(tags=["osint"], prefix="/api/osint")

# Bound how much one investigate fans out, so a big domain can't explode the
# graph or the free-tier upstream budget. Honest counts are still reported.
_MAX_ENRICH_IPS = 5
_MAX_SUBDOMAINS = 40
_MAX_SERVICES = 40
_MAX_CONTACTED = 15
_MAX_PEERS = 15
_MAX_TX = 25
_MAX_SANCTIONS = 10
_MAX_OFFICERS = 15


# ── GET connector endpoints (keyless, no auth) ──────────────────────────────────

@router.get("/dns")
async def dns(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await C.lookup_dns(target)


@router.get("/whois")
async def whois(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await C.lookup_whois(target)


@router.get("/certs")
async def certs(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await C.lookup_certs(target)


@router.get("/ip")
async def ip(target: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await C.lookup_ip(target)


@router.get("/shodan")
async def shodan(target: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await C.lookup_shodan(target)


@router.get("/threat")
async def threat(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await C.lookup_threat(target)


@router.get("/gravatar")
async def gravatar(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await C.lookup_gravatar(target)


@router.get("/github")
async def github(target: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await C.lookup_github_user(target)


@router.get("/gitlab")
async def gitlab(target: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await C.lookup_gitlab_user(target)


@router.get("/username")
async def username(target: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await C.lookup_username_sites(target)


@router.get("/hibp")
async def hibp(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await C.lookup_hibp(target)


# ── new connector GET endpoints (keyless, no auth, self-fetch cards) ────────────
# One per connector function (mirrors the block above). Phase B of
# docs/osint-sources-plan.md — apps/web EntityPanel cards for the new
# url/wallet/asn/company node kinds fetch these directly.

@router.get("/wayback")
async def wayback(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await infra.wayback_urls(target)


@router.get("/hackertarget")
async def hackertarget(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await infra.hackertarget_hosts(target)


@router.get("/anubis")
async def anubis(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await infra.anubis_subdomains(target)


@router.get("/columbus")
async def columbus(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await infra.columbus_subdomains(target)


@router.get("/certspotter")
async def certspotter(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await infra.certspotter_issuances(target)


@router.get("/urlscan")
async def urlscan(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await infra.urlscan_domain(target)


@router.get("/bgpview-ip")
async def bgpview_ip(ip: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await netblock.bgpview_ip(ip)


@router.get("/bgpview-asn")
async def bgpview_asn(asn: str = Query(..., max_length=16)) -> dict[str, Any]:
    return await netblock.bgpview_asn(asn)


@router.get("/ripestat")
async def ripestat(ip: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await netblock.ripestat_network(ip)


@router.get("/greynoise")
async def greynoise(ip: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await netblock.greynoise_community(ip)


@router.get("/onionoo")
async def onionoo(ip: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await netblock.onionoo_exit(ip)


@router.get("/feodo")
async def feodo(ip: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await netblock.feodo_listed(ip)


@router.get("/urlhaus-host")
async def urlhaus_host(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await threat_feeds.urlhaus_host(target)


@router.get("/urlhaus-url")
async def urlhaus_url(target: str = Query(..., max_length=2048)) -> dict[str, Any]:
    return await threat_feeds.urlhaus_url(target)


@router.get("/malwarebazaar")
async def malwarebazaar(hash: str = Query(..., max_length=64)) -> dict[str, Any]:  # noqa: A002
    return await threat_feeds.malwarebazaar_hash(hash)


@router.get("/yaraify")
async def yaraify(hash: str = Query(..., max_length=64)) -> dict[str, Any]:  # noqa: A002
    return await threat_feeds.yaraify_hash(hash)


@router.get("/emailrep")
async def emailrep(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await threat_feeds.emailrep(target)


@router.get("/phishstats")
async def phishstats(target: str = Query(..., max_length=2048)) -> dict[str, Any]:
    return await threat_feeds.phishstats_url(target)


@router.get("/mempool")
async def mempool(address: str = Query(..., max_length=128)) -> dict[str, Any]:
    return await crypto.mempool_btc_address(address)


@router.get("/blockstream")
async def blockstream(address: str = Query(..., max_length=128)) -> dict[str, Any]:
    return await crypto.blockstream_btc(address)


@router.get("/blockchair")
async def blockchair(
    chain: str = Query(..., max_length=32), address: str = Query(..., max_length=128)
) -> dict[str, Any]:
    return await crypto.blockchair_address(chain, address)


@router.get("/blockscout")
async def blockscout(address: str = Query(..., max_length=128)) -> dict[str, Any]:
    return await crypto.blockscout_evm(address)


@router.get("/sec-edgar")
async def sec_edgar(name: str = Query(..., max_length=120)) -> dict[str, Any]:
    return await corp.sec_edgar_company(name)


@router.get("/opensanctions")
async def opensanctions(name: str = Query(..., max_length=120)) -> dict[str, Any]:
    return await corp.opensanctions_search(name)


@router.get("/opencorporates")
async def opencorporates(name: str = Query(..., max_length=120)) -> dict[str, Any]:
    return await corp.opencorporates_search(name)


@router.get("/openownership")
async def openownership(name: str = Query(..., max_length=120)) -> dict[str, Any]:
    return await corp.openownership_search(name)


@router.get("/aleph")
async def aleph(name: str = Query(..., max_length=120)) -> dict[str, Any]:
    return await corp.aleph_search(name)


@router.get("/wikidata")
async def wikidata(name: str = Query(..., max_length=120)) -> dict[str, Any]:
    return await corp.wikidata_search(name)


@router.get("/pullpush")
async def pullpush(target: str = Query(..., max_length=64)) -> dict[str, Any]:
    return await social.pullpush_reddit(target)


@router.get("/libravatar")
async def libravatar(target: str = Query(..., max_length=253)) -> dict[str, Any]:
    return await social.libravatar_exists(target)


# ── investigate: fan out + persist into the ontology ────────────────────────────

class InvestigateRequest(BaseModel):
    target: str = Field(..., min_length=1, max_length=253)
    # Company names aren't machine-classifiable from a bare string (they don't
    # look like a domain/ip/wallet/…), so the frontend opts in explicitly.
    kind: str | None = None


class InvestigateResponse(BaseModel):
    root: str
    kind: str
    objects: int
    links: int
    summary: dict[str, Any]


def _slug(s: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", s.strip().lower()).strip("-")
    return out[:64] or "x"


class _Graph:
    """Accumulator: dedups objects by id, links by (src,dst,rel); stamps provenance."""

    def __init__(self, ts: float) -> None:
        self.objs: dict[str, Object] = {}
        self.links: dict[tuple[str, str, str], Link] = {}
        self.ts = ts

    def obj(self, id_: str, entity_type: str, source: str, props: dict[str, Any]) -> str:
        if id_ not in self.objs:
            self.objs[id_] = Object(
                id=id_,
                props={
                    "entity_type": entity_type,
                    "source": source,
                    "collected_at": self.ts,
                    **{k: v for k, v in props.items() if v not in (None, "", [], {})},
                },
            ).normalised()  # derive kind from the id prefix now (domain/ip/…)
        return id_

    def link(self, src: str, dst: str, rel: str) -> None:
        self.links[(src, dst, rel)] = Link(src=src, dst=dst, rel=rel)


async def _investigate_domain(g: _Graph, d: str) -> dict[str, Any]:
    (
        dns_r, whois_r, certs_r, threat_r,
        wayback_r, hackertarget_r, anubis_r, columbus_r, certspotter_r, urlscan_r,
    ) = await asyncio.gather(
        C.lookup_dns(d), C.lookup_whois(d), C.lookup_certs(d), C.lookup_threat(d),
        infra.wayback_urls(d), infra.hackertarget_hosts(d), infra.anubis_subdomains(d),
        infra.columbus_subdomains(d), infra.certspotter_issuances(d), infra.urlscan_domain(d),
    )
    root = g.obj("domain:" + d, "Domain", "rdap+dns", {
        "name": d,
        "registrar": whois_r.get("registrar"),
        "created": whois_r.get("created"),
        "expires": whois_r.get("expires"),
        "status": whois_r.get("status"),
        "nameservers": whois_r.get("nameservers"),
        "dns": dns_r.get("records"),
        "threat_pulses": threat_r.get("pulse_count"),
    })

    for ip_addr in dns_r.get("ips", [])[:_MAX_ENRICH_IPS]:
        g.obj("ip:" + ip_addr, "IPAddress", "dns", {"address": ip_addr})
        g.link(root, "ip:" + ip_addr, "resolves_to")

    # Enrich the resolved IPs (geo + services) concurrently, bounded.
    ips = dns_r.get("ips", [])[:_MAX_ENRICH_IPS]
    enrich = await asyncio.gather(*(_enrich_ip(g, a) for a in ips))
    _ = enrich

    # Registrant → org / email. The org id reuses routes/extract.py's scheme
    # (``ext:organization:<slug>``) ON PURPOSE: a registrant "Acme Corp" and an
    # "Acme Corp" pulled from a document (or an aircraft operator) then collide on
    # ONE node, which is the bridge that links infra-OSINT to the military graph.
    if whois_r.get("registrar"):
        oid = g.obj("ext:organization:" + _slug(whois_r["registrar"]), "Organization", "rdap",
                    {"name": whois_r["registrar"]})
        g.link(root, oid, "registered_by")
    if whois_r.get("registrant_email"):
        eid = g.obj("email:" + whois_r["registrant_email"].lower(), "Email", "rdap",
                    {"address": whois_r["registrant_email"].lower()})
        g.link(root, eid, "registrant_email")

    # Subdomains (bounded; honest total in summary).
    for sub in certs_r.get("subdomains", [])[:_MAX_SUBDOMAINS]:
        g.obj("domain:" + sub, "Domain", "crt.sh", {"name": sub})
        g.link(root, "domain:" + sub, "has_subdomain")

    # More subdomain sources (wayback/hackertarget/anubis/columbus/certspotter) —
    # merged into one deduped, bounded set on top of the crt.sh ones above.
    extra_subs: set[str] = set()
    extra_subs.update(wayback_r.get("subdomains") or [])
    extra_subs.update(h.get("host", "") for h in hackertarget_r.get("hosts") or [])
    extra_subs.update(anubis_r.get("subdomains") or [])
    extra_subs.update(columbus_r.get("subdomains") or [])
    extra_subs.update(certspotter_r.get("subdomains") or [])
    minted_extra = 0
    for sub in sorted(extra_subs):
        if not sub or sub == d or not sub.endswith("." + d):
            continue
        if minted_extra >= _MAX_SUBDOMAINS:
            break
        g.obj("domain:" + sub, "Domain", "infra-osint", {"name": sub})
        g.link(root, "domain:" + sub, "has_subdomain")
        minted_extra += 1

    # CertSpotter cert issuances → cert: nodes.
    for cert in (certspotter_r.get("certs") or [])[:20]:
        cid = g.obj(
            "cert:" + _slug(f"{d}:{cert.get('issuer', '')}:{cert.get('not_before', '')}"),
            "Certificate", "certspotter",
            {"domain": d, "issuer": cert.get("issuer"),
             "not_before": cert.get("not_before"), "not_after": cert.get("not_after")},
        )
        g.link(root, cid, "secured_by")

    # urlscan.io contacted ips.
    for ip_addr in (urlscan_r.get("ips") or [])[:_MAX_CONTACTED]:
        iid = g.obj("ip:" + ip_addr, "IPAddress", "urlscan", {"address": ip_addr})
        g.link(root, iid, "contacted")

    # Threat.
    if threat_r.get("pulse_count"):
        tid = g.obj("threat:" + d, "ThreatIndicator", "otx", {
            "indicator": d, "pulses": threat_r.get("pulses"), "tags": threat_r.get("tags"),
        })
        g.link(tid, root, "indicates_threat")

    return {
        "resolved_ips": len(dns_r.get("ips", [])),
        "subdomains": certs_r.get("subdomain_count", 0),
        "subdomains_persisted": min(len(certs_r.get("subdomains", [])), _MAX_SUBDOMAINS),
        "extra_subdomains_found": len(extra_subs),
        "extra_subdomains_persisted": minted_extra,
        "certs": len(certspotter_r.get("certs") or []),
        "contacted_ips": len(urlscan_r.get("ips") or []),
        "threat_pulses": threat_r.get("pulse_count", 0),
    }


async def _enrich_ip(g: _Graph, ip_addr: str) -> None:
    geo, sh, bgp_r, ripe_r, gn_r, tor_r, feodo_r = await asyncio.gather(
        C.lookup_ip(ip_addr), C.lookup_shodan(ip_addr),
        netblock.bgpview_ip(ip_addr), netblock.ripestat_network(ip_addr),
        netblock.greynoise_community(ip_addr), netblock.onionoo_exit(ip_addr),
        netblock.feodo_listed(ip_addr),
    )
    iid = "ip:" + ip_addr
    if iid in g.objs and "note" not in geo:
        g.objs[iid].props.update({
            "city": geo.get("city"), "country": geo.get("country"),
            "org": geo.get("org"), "asn": geo.get("asn"),
            "lat": geo.get("lat"), "lon": geo.get("lon"),
            "reverse": geo.get("reverse"),
        })
    if geo.get("asn"):
        aid = g.obj(
            "asn:" + geo["asn"], "ASN", "ip-api", {"asn": geo["asn"], "org": geo.get("org")}
        )
        g.link(aid, iid, "announces")
    for port in (sh.get("ports") or [])[:_MAX_SERVICES]:
        sid = g.obj(f"service:{ip_addr}:{port}", "Service", "shodan",
                    {"port": port, "vulns": sh.get("vulns")})
        g.link(iid, sid, "runs_service")

    # BGPView + RIPEstat announcing ASNs (beyond the ip-api one above).
    primary_asn: str | None = geo.get("asn")
    for asn_info in bgp_r.get("asns") or []:
        asn_id = asn_info.get("asn")
        if not asn_id:
            continue
        aid = g.obj("asn:" + asn_id, "ASN", "bgpview", {
            "asn": asn_id, "name": asn_info.get("name"), "country": asn_info.get("country"),
        })
        g.link(aid, iid, "announces")
        primary_asn = primary_asn or asn_id
    for asn_id in ripe_r.get("asns") or []:
        aid = g.obj("asn:" + asn_id, "ASN", "ripestat", {"asn": asn_id})
        g.link(aid, iid, "announces")
        primary_asn = primary_asn or asn_id

    # Peers of the primary announcing ASN — bounded, one hop, no recursion.
    if primary_asn:
        peers_r = await netblock.bgpview_asn(primary_asn)
        pid_self = g.obj("asn:" + primary_asn, "ASN", "bgpview", {"asn": primary_asn})
        for peer in (peers_r.get("peers") or [])[:_MAX_PEERS]:
            peer_id = g.obj("asn:" + peer, "ASN", "bgpview", {"asn": peer})
            g.link(pid_self, peer_id, "peers_with")

    # RIPEstat abuse contact.
    if ripe_r.get("abuse_email"):
        eid = g.obj("email:" + ripe_r["abuse_email"].lower(), "Email", "ripestat",
                    {"address": ripe_r["abuse_email"].lower()})
        g.link(iid, eid, "abuse_contact")

    # Threat feeds: mint one shared threat:<ip> node from whichever flag(s) fired.
    is_malicious = gn_r.get("classification") == "malicious"
    is_listed = bool(feodo_r.get("listed"))
    is_tor = bool(tor_r.get("is_tor_exit"))
    if is_malicious or is_listed or is_tor:
        tid = g.obj("threat:" + ip_addr, "ThreatIndicator", "netblock-osint", {
            "indicator": ip_addr,
            "greynoise_classification": gn_r.get("classification"),
            "greynoise_tags": gn_r.get("tags"),
            "feodo_malware": feodo_r.get("malware"),
            "feodo_first_seen": feodo_r.get("first_seen"),
            "tor_nickname": tor_r.get("nickname"),
        })
        if is_malicious or is_listed:
            g.link(iid, tid, "listed_by")
        if is_tor:
            g.link(iid, tid, "tor_exit")


async def _investigate_ip(g: _Graph, ip_addr: str) -> dict[str, Any]:
    whois_r, threat_r = await asyncio.gather(C.lookup_whois(ip_addr), C.lookup_threat(ip_addr))
    root = g.obj("ip:" + ip_addr, "IPAddress", "rdap", {
        "address": ip_addr,
        "rdap_name": whois_r.get("name"),
        "cidr": whois_r.get("cidr"),
        "country": whois_r.get("country"),
    })
    await _enrich_ip(g, ip_addr)
    if threat_r.get("pulse_count"):
        tid = g.obj("threat:" + ip_addr, "ThreatIndicator", "otx", {
            "indicator": ip_addr, "pulses": threat_r.get("pulses"), "tags": threat_r.get("tags"),
        })
        g.link(tid, root, "indicates_threat")
    return {"threat_pulses": threat_r.get("pulse_count", 0)}


async def _investigate_email(g: _Graph, e: str) -> dict[str, Any]:
    """Mint an email node + its Gravatar-linked person/accounts + breach flag."""
    grav, breach, rep, libra = await asyncio.gather(
        C.lookup_gravatar(e), C.lookup_hibp(e),
        threat_feeds.emailrep(e), social.libravatar_exists(e),
    )
    root = g.obj("email:" + e, "Email", "person-osint", {
        "address": e,
        "reputation": rep.get("reputation"),
        "has_avatar": libra.get("has_avatar"),
    })

    if grav.get("found"):
        name = grav.get("display_name") or e.split("@", 1)[0]
        pid = g.obj("person:" + _slug(name), "Person", "gravatar", {
            "name": name, "about": grav.get("about"),
            "location": grav.get("location"), "profile_url": grav.get("profile_url"),
            "has_avatar": libra.get("has_avatar"),
        })
        g.link(pid, root, "has_email")
        # Self-linked verified accounts (twitter/github/…) → username nodes.
        for acct in grav.get("accounts", []):
            handle = acct.get("username") or ""
            if handle:
                uid = g.obj(
                    "username:" + _slug(handle), "Username", "gravatar",
                    {"handle": handle, "service": acct.get("service"), "url": acct.get("url")},
                )
                g.link(pid, uid, "has_account")

    threat_props: dict[str, Any] = {}
    if breach.get("checked") and breach.get("breach_count"):
        threat_props.update({
            "breach_count": breach.get("breach_count"),
            "breaches": [b.get("name") for b in breach.get("breaches", [])],
        })
    if rep.get("malicious") or rep.get("breach"):
        threat_props.update({
            "emailrep_reputation": rep.get("reputation"),
            "emailrep_suspicious": rep.get("suspicious"),
            "emailrep_malicious": rep.get("malicious"),
        })
    if threat_props:
        tid = g.obj("threat:" + e, "ThreatIndicator", "hibp+emailrep",
                    {"indicator": e, **threat_props})
        g.link(tid, root, "indicates_threat")

    return {
        "gravatar": grav.get("found", False),
        "linked_accounts": len(grav.get("accounts", [])) if grav.get("found") else 0,
        "breach_count": breach.get("breach_count", 0),
        "emailrep_malicious": bool(rep.get("malicious")),
        "has_avatar": bool(libra.get("has_avatar")),
    }


async def _investigate_username(g: _Graph, u: str) -> dict[str, Any]:
    """Mint a username node + a person + its presence across the curated sites."""
    gh, gl, sites, reddit = await asyncio.gather(
        C.lookup_github_user(u), C.lookup_gitlab_user(u), C.lookup_username_sites(u),
        social.pullpush_reddit(u),
    )
    root = g.obj("username:" + u, "Username", "person-osint", {
        "handle": u,
        "reddit_subreddits": reddit.get("subreddits"),
        "reddit_submission_count": reddit.get("count"),
    })

    # A person node keyed by the display name where we have one, else the handle,
    # so a username and a document-extracted person collide on one node.
    display = (gh.get("name") if gh.get("found") else None) or \
              (gl.get("name") if gl.get("found") else None) or u
    pid = g.obj("person:" + _slug(display), "Person", "person-osint", {
        "name": display,
        "github": gh.get("profile_url") if gh.get("found") else None,
        "gitlab": gl.get("profile_url") if gl.get("found") else None,
        "company": gh.get("company") if gh.get("found") else None,
        "location": gh.get("location") if gh.get("found") else None,
    })
    g.link(pid, root, "has_account")

    # A verified GitHub email bridges into the email graph (registrant collisions).
    if gh.get("found") and gh.get("email"):
        eid = g.obj("email:" + str(gh["email"]).lower(), "Email", "github",
                    {"address": str(gh["email"]).lower()})
        g.link(pid, eid, "has_email")

    present = sites.get("present_on", [])
    return {
        "github": gh.get("found", False),
        "gitlab": gl.get("found", False),
        "present_on": present,
        "site_count": len(present),
        "reddit_submissions": reddit.get("count", 0),
    }


async def _investigate_url(g: _Graph, u: str) -> dict[str, Any]:
    """Mint a url node + threat/payload/contacted-ip context."""
    host = urlsplit(u).hostname or ""
    calls: list[Any] = [threat_feeds.urlhaus_url(u), threat_feeds.phishstats_url(u)]
    if host:
        calls.append(infra.urlscan_domain(host))
    results = await asyncio.gather(*calls)
    urlhaus_r, phish_r = results[0], results[1]
    scan_r = results[2] if host else {}

    root = g.obj("url:" + u, "Url", "urlhaus+phishstats", {
        "url": u,
        "status": urlhaus_r.get("status"),
        "phish_score": phish_r.get("score"),
    })

    if urlhaus_r.get("threat") or urlhaus_r.get("tags"):
        tid = g.obj("threat:" + u, "ThreatIndicator", "urlhaus", {
            "indicator": u, "threat": urlhaus_r.get("threat"), "tags": urlhaus_r.get("tags"),
        })
        g.link(tid, root, "indicates_threat")

    for sha in urlhaus_r.get("payloads") or []:
        fid = g.obj("file:" + sha, "File", "urlhaus", {"sha256": sha})
        g.link(root, fid, "distributes")

    for ip_addr in (scan_r.get("ips") or [])[:_MAX_CONTACTED]:
        iid = g.obj("ip:" + ip_addr, "IPAddress", "urlscan", {"address": ip_addr})
        g.link(root, iid, "contacted")

    return {
        "threat": urlhaus_r.get("threat", ""),
        "payload_count": len(urlhaus_r.get("payloads") or []),
        "phish_score": phish_r.get("score"),
        "contacted_ips": len(scan_r.get("ips") or []),
    }


async def _investigate_hash(g: _Graph, h: str) -> dict[str, Any]:
    """Mint a file node (by hash) + malware family/threat context."""
    mb_r, yz_r = await asyncio.gather(
        threat_feeds.malwarebazaar_hash(h), threat_feeds.yaraify_hash(h)
    )
    root = g.obj("file:" + h, "File", "malwarebazaar+yaraify", {
        "sha256": h,
        "file_type": mb_r.get("file_type"),
        "tags": mb_r.get("tags"),
        "first_seen": mb_r.get("first_seen"),
        "yara": yz_r.get("yara"),
        "clamav": yz_r.get("clamav"),
    })

    if mb_r.get("family"):
        tid = g.obj("threat:" + h, "ThreatIndicator", "malwarebazaar", {
            "indicator": h, "family": mb_r.get("family"), "signature": mb_r.get("signature"),
        })
        g.link(tid, root, "indicates_threat")

    return {
        "family": mb_r.get("family", ""),
        "yara_matches": len(yz_r.get("yara") or []),
        "clamav_matches": len(yz_r.get("clamav") or []),
    }


async def _investigate_wallet(g: _Graph, canonical: str) -> dict[str, Any]:
    """Mint a wallet node (``wallet:<chain>:<addr>``) + tx/counterparty context."""
    chain, _, addr = canonical.partition(":")
    root = "wallet:" + canonical
    tokens: list[Any] | None = None
    txs: list[dict[str, Any]] = []

    if chain == "btc":
        primary, fallback = await asyncio.gather(
            crypto.mempool_btc_address(addr), crypto.blockstream_btc(addr)
        )
        balance = primary.get("balance") if "balance" in primary else fallback.get("balance")
        tx_count = primary.get("tx_count") or fallback.get("tx_count")
        txs = primary.get("txs") or []
    elif chain == "eth":
        ev = await crypto.blockscout_evm(addr)
        balance = ev.get("balance")
        tx_count = None
        tokens = ev.get("tokens")
    else:
        bc = await crypto.blockchair_address(chain, addr)
        balance = bc.get("balance")
        tx_count = bc.get("tx_count")

    g.obj(root, "Wallet", "crypto-osint", {
        "address": addr, "chain": chain, "balance": balance, "tx_count": tx_count,
        **({"tokens": tokens} if tokens else {}),
    })

    minted = 0
    for tx in txs:
        if minted >= _MAX_TX:
            break
        txid = tx.get("txid")
        if not txid:
            continue
        tx_id = f"tx:{chain}:{txid}"
        g.obj(tx_id, "Transaction", "crypto-osint", {"value": tx.get("value")})
        g.link(root, tx_id, "sends_to")
        for cp in tx.get("outputs") or []:
            if cp and cp != addr:
                cp_id = g.obj(f"wallet:{chain}:{cp}", "Wallet", "crypto-osint",
                              {"address": cp, "chain": chain})
                g.link(tx_id, cp_id, "receives_from")
        minted += 1

    return {"chain": chain, "balance": balance, "tx_count": tx_count, "txs_persisted": minted}


async def _investigate_asn(g: _Graph, asn: str) -> dict[str, Any]:
    """Mint an asn node (``asn:AS<n>``) + peer ASNs (one hop, bounded)."""
    bgp_r = await netblock.bgpview_asn(asn)
    root = g.obj("asn:" + asn, "ASN", "bgpview", {
        "asn": asn, "name": bgp_r.get("name"), "description": bgp_r.get("description"),
        "country": bgp_r.get("country"), "prefixes": bgp_r.get("prefixes"),
    })
    for peer in (bgp_r.get("peers") or [])[:_MAX_PEERS]:
        pid = g.obj("asn:" + peer, "ASN", "bgpview", {"asn": peer})
        g.link(root, pid, "peers_with")

    return {
        "name": bgp_r.get("name", ""),
        "peer_count": len(bgp_r.get("peers") or []),
        "prefix_count": len(bgp_r.get("prefixes") or []),
    }


async def _investigate_company(g: _Graph, name: str) -> dict[str, Any]:
    """Mint an ``ext:organization:<slug>`` root + filings/sanctions/officers context."""
    sec_r, sanc_r, oc_r, oo_r, al_r, wd_r = await asyncio.gather(
        corp.sec_edgar_company(name), corp.opensanctions_search(name),
        corp.opencorporates_search(name), corp.openownership_search(name),
        corp.aleph_search(name), corp.wikidata_search(name),
    )
    companies = oc_r.get("companies") or []
    top_company = companies[0] if companies else {}
    entities = wd_r.get("entities") or []
    top_entity = entities[0] if entities else {}

    root = g.obj("ext:organization:" + _slug(name), "Organization", "corp-osint", {
        "name": sec_r.get("name") or name,
        "cik": sec_r.get("cik"), "ticker": sec_r.get("ticker"), "sic": sec_r.get("sic"),
        "filings": sec_r.get("filings"),
        "jurisdiction": top_company.get("jurisdiction"),
        "company_number": top_company.get("number"),
        "wikidata_qid": top_entity.get("qid"),
    })

    sanctioned = 0
    for match in (sanc_r.get("matches") or [])[:_MAX_SANCTIONS]:
        topics = [str(t).lower() for t in (match.get("topics") or [])]
        if not any("sanction" in t or "pep" in t for t in topics):
            continue
        tid = g.obj(
            "threat:" + _slug(match.get("id") or match.get("name") or ""),
            "ThreatIndicator", "opensanctions",
            {"indicator": match.get("name"), "schema": match.get("schema"),
             "topics": match.get("topics"), "datasets": match.get("datasets")},
        )
        g.link(root, tid, "sanctioned_as")
        sanctioned += 1

    officers = 0
    for owner in (oo_r.get("owners") or [])[:_MAX_OFFICERS]:
        nm = owner.get("name")
        if not nm:
            continue
        pid = g.obj("person:" + _slug(nm), "Person", "openownership",
                    {"name": nm, "role": owner.get("type")})
        g.link(pid, root, "officer_of")
        officers += 1

    screening = {
        "sanctions_matches": sanctioned,
        "opencorporates_matches": oc_r.get("count", 0),
        "officers": officers,
        "aleph_matches": al_r.get("count", 0),
        "wikidata_matches": wd_r.get("count", 0),
    }
    # These are due-diligence counts, not identity fields: a 0 means "checked,
    # clean" and is the whole point of a durable screening record, so it must
    # survive re-opening the case. g.obj()'s dict comprehension drops falsy
    # values (correct for cik/ticker/sic/etc — an identity field that wasn't
    # found shouldn't render as a fabricated 0/""), so set these directly on
    # the already-minted root, bypassing that filter. collected_at (stamped by
    # g.obj() above) already records when this screening ran — no separate
    # "screened_at" field needed.
    g.objs[root].props.update(screening)

    return {"cik": sec_r.get("cik", ""), **screening}


@router.post("/investigate", response_model=InvestigateResponse)
async def investigate(
    req: InvestigateRequest, ctx: UserCtx = Depends(current_user_or_local)
) -> InvestigateResponse:
    g = _Graph(ts=time.time())

    if req.kind == "company":
        name = req.target.strip()
        if not name:
            raise HTTPException(status_code=400, detail="target must not be empty")
        summary = await _investigate_company(g, name)
        kind = "org"
        root = "ext:organization:" + _slug(name)
    else:
        detected = classify_target(req.target)
        if detected is None:
            raise HTTPException(
                status_code=400,
                detail="target must be a domain, IP, email, username, url, file hash, "
                       "wallet address, or ASN",
            )
        kind, canonical = detected
        if kind == "domain":
            summary = await _investigate_domain(g, canonical)
            root = "domain:" + canonical
        elif kind == "email":
            summary = await _investigate_email(g, canonical)
            root = "email:" + canonical
        elif kind == "username":
            summary = await _investigate_username(g, canonical)
            root = "username:" + canonical
        elif kind == "url":
            summary = await _investigate_url(g, canonical)
            root = "url:" + canonical
        elif kind == "file":
            summary = await _investigate_hash(g, canonical)
            root = "file:" + canonical
        elif kind == "wallet":
            summary = await _investigate_wallet(g, canonical)
            root = "wallet:" + canonical
        elif kind == "asn":
            summary = await _investigate_asn(g, canonical)
            root = "asn:" + canonical
        else:
            summary = await _investigate_ip(g, canonical)
            root = "ip:" + canonical

    reg = get_registry(ctx, get_settings())
    for obj in g.objs.values():
        # Each object's own props already carry the real connector that
        # collected it (rdap+dns, otx, urlscan, …) — stamp that as the
        # assertion source instead of falling through to upsert's "analyst"
        # default, which would mislabel automated collection as a human edit
        # in case-report footnotes.
        await reg.upsert(obj, source=obj.props.get("source") or "osint-investigate")
    for lk in g.links.values():
        await reg.link(lk.model_copy(update={"source": "osint-investigate"}))

    await audit(
        ctx, "osint_investigate", kind, root,
        detail={"objects": len(g.objs), "links": len(g.links), **summary},
    )
    return InvestigateResponse(
        root=root, kind=kind, objects=len(g.objs), links=len(g.links), summary=summary
    )


# ── deep recon via the optional GPL sidecar ─────────────────────────────────────

class ReconRequest(BaseModel):
    target: str = Field(..., min_length=1, max_length=253)
    tool: str = Field("amass")  # amass | theharvester | spiderfoot


@router.post("/recon", response_model=InvestigateResponse)
async def recon(
    req: ReconRequest, ctx: UserCtx = Depends(current_user_or_local)
) -> InvestigateResponse:
    """Run a GPL deep-recon tool via the sidecar and persist results into the graph.

    Off unless ``OSINT_RECON_SIDECAR_URL`` points at a running ``tools/osint-recon``
    (the GPL binaries live only in that separate process). Discovered subdomains /
    IPs / emails are minted as the same node types the keyless investigate produces,
    linked to the target, so they render in the same Investigation canvas.
    """
    s = get_settings()
    if not s.osint_recon_sidecar_url:
        raise HTTPException(503, "recon sidecar not configured (set OSINT_RECON_SIDECAR_URL)")
    detected = classify_target(req.target)
    if detected is None:
        raise HTTPException(400, "target must be a domain or IP")
    kind, canonical = detected

    url = s.osint_recon_sidecar_url.rstrip("/") + "/recon"
    try:
        # Recon scans are slow — override the shared client's 15s timeout.
        r = await get_client().post(
            url, json={"target": canonical, "tool": req.tool},
            timeout=httpx.Timeout(600.0, connect=5.0),
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, "recon sidecar unreachable") from e
    if r.status_code != 200:
        raise HTTPException(r.status_code, f"recon sidecar: {r.text[:200]}")
    data = r.json()

    g = _Graph(ts=time.time())
    root = ("domain:" if kind == "domain" else "ip:") + canonical
    g.obj(root, "Domain" if kind == "domain" else "IPAddress", "recon:" + req.tool,
          {"name": canonical})
    for sub in (data.get("subdomains") or [])[:_MAX_SUBDOMAINS]:
        g.obj("domain:" + sub, "Domain", "recon:" + req.tool, {"name": sub})
        g.link(root, "domain:" + sub, "has_subdomain")
    for ip_addr in (data.get("ips") or [])[:_MAX_SUBDOMAINS]:
        if classify_target(ip_addr) and classify_target(ip_addr)[0] == "ip":  # type: ignore[index]
            g.obj("ip:" + ip_addr, "IPAddress", "recon:" + req.tool, {"address": ip_addr})
            g.link(root, "ip:" + ip_addr, "resolves_to")
    for em in (data.get("emails") or [])[:_MAX_SUBDOMAINS]:
        eid = g.obj("email:" + em.lower(), "Email", "recon:" + req.tool, {"address": em.lower()})
        g.link(root, eid, "has_email")

    reg = get_registry(ctx, s)
    for obj in g.objs.values():
        # Same provenance fix as /investigate: stamp the real connector
        # ("recon:" + tool) instead of the analyst default.
        await reg.upsert(obj, source=obj.props.get("source") or "osint-recon")
    for lk in g.links.values():
        await reg.link(lk.model_copy(update={"source": "osint-recon"}))
    summary = {
        "subdomains": len(data.get("subdomains") or []),
        "ips": len(data.get("ips") or []),
        "emails": len(data.get("emails") or []),
        "tool": req.tool,
    }
    await audit(ctx, "osint_recon", kind, root,
                detail={"objects": len(g.objs), "links": len(g.links), **summary})
    return InvestigateResponse(
        root=root, kind=kind, objects=len(g.objs), links=len(g.links), summary=summary
    )
