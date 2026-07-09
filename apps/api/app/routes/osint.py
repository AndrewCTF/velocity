"""Digital-OSINT infra/domain routes — /api/osint/*.

Two surfaces:

  GET  /api/osint/{dns,whois,ip,certs,shodan,threat}?target=…  — keyless lookups
        (public data; the EntityPanel cards self-fetch these). No auth.

  POST /api/osint/investigate {target}  — fan out the connectors for a domain or
        ip and PERSIST the results as Object/Link rows into the caller's ontology
        (same pattern as ``routes/extract.py``: per-user, ACL-stamped, provenance
        in props, one audit row). The frontend then renders the graph via the
        existing ``/api/ontology/search-around/{root}``. Requires a signed-in user.

New object ids (canonical ``kind:identifier``, kinds registered in
``intel/ontology.py``): ``domain:`` ``ip:`` ``cert:`` ``asn:`` ``service:``
``threat:`` ``org:`` ``email:``.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.audit import audit
from app.config import get_settings
from app.intel.ontology import Link, Object, get_registry
from app.keys import UserCtx, current_user
from app.osint import connectors as C
from app.osint.fetch import classify_target
from app.upstream import get_client

router = APIRouter(tags=["osint"], prefix="/api/osint")

# Bound how much one investigate fans out, so a big domain can't explode the
# graph or the free-tier upstream budget. Honest counts are still reported.
_MAX_ENRICH_IPS = 5
_MAX_SUBDOMAINS = 40
_MAX_SERVICES = 40


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


# ── investigate: fan out + persist into the ontology ────────────────────────────

class InvestigateRequest(BaseModel):
    target: str = Field(..., min_length=1, max_length=253)


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
    dns_r, whois_r, certs_r, threat_r = await asyncio.gather(
        C.lookup_dns(d), C.lookup_whois(d), C.lookup_certs(d), C.lookup_threat(d)
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
        "threat_pulses": threat_r.get("pulse_count", 0),
    }


async def _enrich_ip(g: _Graph, ip_addr: str) -> None:
    geo, sh = await asyncio.gather(C.lookup_ip(ip_addr), C.lookup_shodan(ip_addr))
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
    grav, breach = await asyncio.gather(C.lookup_gravatar(e), C.lookup_hibp(e))
    root = g.obj("email:" + e, "Email", "person-osint", {"address": e})

    if grav.get("found"):
        name = grav.get("display_name") or e.split("@", 1)[0]
        pid = g.obj("person:" + _slug(name), "Person", "gravatar", {
            "name": name, "about": grav.get("about"),
            "location": grav.get("location"), "profile_url": grav.get("profile_url"),
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

    if breach.get("checked") and breach.get("breach_count"):
        tid = g.obj("threat:" + e, "ThreatIndicator", "hibp", {
            "indicator": e, "breach_count": breach.get("breach_count"),
            "breaches": [b.get("name") for b in breach.get("breaches", [])],
        })
        g.link(tid, root, "indicates_threat")

    return {
        "gravatar": grav.get("found", False),
        "linked_accounts": len(grav.get("accounts", [])) if grav.get("found") else 0,
        "breach_count": breach.get("breach_count", 0),
    }


async def _investigate_username(g: _Graph, u: str) -> dict[str, Any]:
    """Mint a username node + a person + its presence across the curated sites."""
    gh, gl, sites = await asyncio.gather(
        C.lookup_github_user(u), C.lookup_gitlab_user(u), C.lookup_username_sites(u)
    )
    root = g.obj("username:" + u, "Username", "person-osint", {"handle": u})

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
    }


@router.post("/investigate", response_model=InvestigateResponse)
async def investigate(
    req: InvestigateRequest, ctx: UserCtx = Depends(current_user)
) -> InvestigateResponse:
    detected = classify_target(req.target)
    if detected is None:
        raise HTTPException(
            status_code=400, detail="target must be a domain, IP, email, or username"
        )
    kind, canonical = detected

    g = _Graph(ts=time.time())
    if kind == "domain":
        summary = await _investigate_domain(g, canonical)
        root = "domain:" + canonical
    elif kind == "email":
        summary = await _investigate_email(g, canonical)
        root = "email:" + canonical
    elif kind == "username":
        summary = await _investigate_username(g, canonical)
        root = "username:" + canonical
    else:
        summary = await _investigate_ip(g, canonical)
        root = "ip:" + canonical

    reg = get_registry(ctx, get_settings())
    for obj in g.objs.values():
        await reg.upsert(obj)
    for lk in g.links.values():
        await reg.link(lk)

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
    req: ReconRequest, ctx: UserCtx = Depends(current_user)
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
        await reg.upsert(obj)
    for lk in g.links.values():
        await reg.link(lk)
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
