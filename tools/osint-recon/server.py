#!/usr/bin/env python3
"""OSINT deep-recon sidecar — thin REST wrapper over the GPL recon tools.

This process shells out to SpiderFoot (GPLv3), theHarvester (GPLv2) and Amass
(Apache-2) as SUBPROCESSES. That is the whole point of the sidecar: the GPL
binaries never link into the MIT app — the app talks to this service over HTTP
(``OSINT_RECON_SIDECAR_URL``) and only ever sees normalised JSON. Run it wherever
the tools are installed; leave ``OSINT_RECON_SIDECAR_URL`` unset and the app never
calls it.

  GET  /health          → which tools are on PATH
  POST /recon {target,tool} → run one tool, return {subdomains,emails,ips,hosts}

Only a target that passes a strict domain/IP check is ever passed to a tool, and
tools are exec'd with an argument list (never a shell string), so the target
cannot inject a command. Long scans are bounded by a timeout.

Run:  pip install -r requirements.txt && uvicorn server:app --port 8099
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="osint-recon-sidecar")

_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)
_TOOLS = {"theharvester": "theHarvester", "amass": "amass", "spiderfoot": "sf"}
_DEFAULT_TIMEOUT = 180


def _valid_target(t: str) -> str | None:
    t = (t or "").strip().lower().rstrip(".")
    if _DOMAIN_RE.match(t):
        return t
    try:
        return str(ipaddress.ip_address(t))
    except ValueError:
        return None


def _bin(tool: str) -> str | None:
    """Resolve a tool's executable on PATH (theHarvester ships as several names)."""
    if tool == "theharvester":
        for name in ("theHarvester", "theharvester", "theHarvester.py"):
            p = shutil.which(name)
            if p:
                return p
        return None
    return shutil.which(_TOOLS.get(tool, ""))


# ── parsers (pure — self-checked in __main__) ────────────────────────────────────

def parse_theharvester(doc: dict[str, Any], domain: str) -> dict[str, list[str]]:
    """theHarvester -f JSON → {subdomains, emails, ips, hosts}.

    ``hosts`` entries look like ``www.example.com:1.2.3.4`` or just a hostname.
    """
    emails = sorted({str(e).lower() for e in doc.get("emails", []) if e})
    ips = sorted({str(i) for i in doc.get("ips", []) if i})
    subs: set[str] = set()
    hosts: list[str] = []
    for h in doc.get("hosts", []) or []:
        h = str(h).strip().lower()
        if not h:
            continue
        hosts.append(h)
        name = h.split(":", 1)[0]
        if name.endswith(domain) and name != domain:
            subs.add(name)
        # A "host:ip" form also yields an IP.
        if ":" in h:
            maybe_ip = h.split(":", 1)[1]
            try:
                ipaddress.ip_address(maybe_ip)
                ips = sorted(set(ips) | {maybe_ip})
            except ValueError:
                pass
    return {"subdomains": sorted(subs), "emails": emails, "ips": ips, "hosts": hosts}


def parse_amass(jsonl: str, domain: str) -> dict[str, list[str]]:
    """Amass ``enum -json`` JSONL → {subdomains, ips}."""
    subs: set[str] = set()
    ips: set[str] = set()
    for line in jsonl.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = str(rec.get("name", "")).strip().lower()
        if name and name.endswith(domain) and name != domain:
            subs.add(name)
        for a in rec.get("addresses", []) or []:
            ip = str(a.get("ip", "")).strip()
            if ip:
                ips.add(ip)
    return {"subdomains": sorted(subs), "emails": [], "ips": sorted(ips), "hosts": []}


def parse_spiderfoot_csv(csv_text: str, domain: str) -> dict[str, list[str]]:
    """SpiderFoot ``-o csv`` (Source,Type,Data rows) → {subdomains, emails, ips}."""
    subs: set[str] = set()
    emails: set[str] = set()
    ips: set[str] = set()
    for line in csv_text.splitlines():
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) < 3:
            continue
        typ, data = parts[1], parts[2]
        if typ in ("INTERNET_NAME", "SUBDOMAIN") and data.endswith(domain) and data != domain:
            subs.add(data.lower())
        elif typ == "EMAILADDR":
            emails.add(data.lower())
        elif typ in ("IP_ADDRESS", "IPV6_ADDRESS"):
            ips.add(data)
    return {"subdomains": sorted(subs), "emails": sorted(emails), "ips": sorted(ips), "hosts": []}


# ── subprocess runners ───────────────────────────────────────────────────────────

async def _run(argv: list[str], timeout: int) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "", "timeout"
    return proc.returncode or 0, out.decode("utf-8", "ignore"), err.decode("utf-8", "ignore")


async def run_theharvester(binary: str, domain: str, timeout: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as d:
        stem = str(Path(d) / "out")
        code, _out, err = await _run(
            [binary, "-d", domain, "-b", "crtsh,bing,duckduckgo,otx", "-f", stem], timeout
        )
        for path in (Path(stem + ".json"), Path(stem)):
            if path.exists():
                try:
                    return parse_theharvester(json.loads(path.read_text()), domain)
                except Exception:  # noqa: BLE001
                    break
    return {"subdomains": [], "emails": [], "ips": [], "hosts": [], "note": err[:200] or "no output"}


async def run_amass(binary: str, domain: str, timeout: int) -> dict[str, Any]:
    code, out, err = await _run([binary, "enum", "-d", domain, "-json", "-", "-timeout", "2"], timeout)
    res = parse_amass(out, domain)
    if not res["subdomains"] and err:
        res["note"] = err[:200]
    return res


async def run_spiderfoot(binary: str, target: str, timeout: int) -> dict[str, Any]:
    # -q quiet, -o csv to stdout; a small, fast module set (footprint recon).
    code, out, err = await _run(
        [binary, "-s", target, "-q", "-o", "csv",
         "-m", "sfp_dnsresolve,sfp_crt,sfp_hackertarget,sfp_whois"], timeout
    )
    res = parse_spiderfoot_csv(out, target)
    if not any(res.values()) and err:
        res["note"] = err[:200]
    return res


# ── routes ───────────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "tools": {t: bool(_bin(t)) for t in _TOOLS}}


class ReconRequest(BaseModel):
    target: str = Field(..., max_length=253)
    tool: str = Field("amass")
    timeout: int = Field(_DEFAULT_TIMEOUT, ge=10, le=600)


@app.post("/recon")
async def recon(req: ReconRequest) -> dict[str, Any]:
    target = _valid_target(req.target)
    if target is None:
        raise HTTPException(400, "target must be a domain or IP")
    if req.tool not in _TOOLS:
        raise HTTPException(400, f"tool must be one of {list(_TOOLS)}")
    binary = _bin(req.tool)
    if binary is None:
        raise HTTPException(503, f"{req.tool} is not installed on this host")

    if req.tool == "theharvester":
        result = await run_theharvester(binary, target, req.timeout)
    elif req.tool == "amass":
        result = await run_amass(binary, target, req.timeout)
    else:
        result = await run_spiderfoot(binary, target, req.timeout)
    return {"tool": req.tool, "target": target, **result}


if __name__ == "__main__":  # self-check the parsers (no tools needed)
    th = parse_theharvester(
        {"emails": ["a@example.com"], "hosts": ["www.example.com:1.2.3.4", "example.com"], "ips": ["9.9.9.9"]},
        "example.com",
    )
    assert th["subdomains"] == ["www.example.com"], th
    assert "1.2.3.4" in th["ips"] and "9.9.9.9" in th["ips"], th
    assert th["emails"] == ["a@example.com"], th

    am = parse_amass('{"name":"vpn.example.com","addresses":[{"ip":"5.6.7.8"}]}\n{"name":"example.com"}\n', "example.com")
    assert am["subdomains"] == ["vpn.example.com"], am
    assert am["ips"] == ["5.6.7.8"], am

    sf = parse_spiderfoot_csv('"src","INTERNET_NAME","mail.example.com"\n"src","EMAILADDR","x@example.com"\n', "example.com")
    assert sf["subdomains"] == ["mail.example.com"], sf
    assert sf["emails"] == ["x@example.com"], sf
    print("parser self-check OK")
