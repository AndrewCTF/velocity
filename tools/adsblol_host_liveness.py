#!/usr/bin/env python3
"""Liveness-check every known adsb.lol / planes.lol hostname at the DNS + TLS layer.

Deliberately makes NO HTTP request to any data path: it resolves DNS, then opens
a TLS handshake and reads the peer certificate. That separates three very
different failure modes that all read as "dead" if you only try a data endpoint:

  - NXDOMAIN / no A record      -> the host is genuinely gone
  - TLS verify failure          -> the host is UP but the cert is wrong
                                  (self-signed, expired, or no matching SAN)
  - TLS + valid cert            -> the host is alive; any later block is an
                                  HTTP-layer block (Cloudflare 403/451/420)

CAVEAT — a valid chain is not a working host. `planes.lol` verifies against a
wildcard Let's Encrypt cert and answers `404 DEPLOYMENT_NOT_FOUND` from Vercel on
every path. Always pair this sweep with an HTTP body check before adding a host.

Run it from the deployment you care about. A datacenter IP gets 451 from a
Cloudflare-fronted property where a home IP gets 200, so "reachable here" is
egress-dependent and is reported as DNS/TLS facts only.

    python tools/adsblol_host_liveness.py
"""

from __future__ import annotations

import socket
import ssl
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import NamedTuple

# Hostnames harvested from the published source trees (adsblol/infra ingress
# rules + external-dns annotation, adsblol/api, adsblol/status/Upptime, docs),
# plus the two prior-pass casualties that need re-verification.
HOSTS = [
    # --- apex + www (docs claim adsb.lol/docs 302s to api) ---
    "adsb.lol",
    "www.adsb.lol",
    # --- FULL APP ALIAS: same title/bundle as adsb.lol, /v2/* 302s to api.adsb.lol.
    # Discovered only via the SAN list on the adsb.lol Let's Encrypt cert --
    # it is NOT in any published doc, ingress rule, or status-page monitor.
    "birds.adsb.lol",
    # --- vanity apex on a .zip TLD: 302s every path to birds.adsb.lol ---
    "birds.fbi.zip",
    "fbi.zip",
    # --- the operator's OTHER project (feeder images), NOT a data mirror ---
    "adsb.im",
    "sdre.im",
    # --- the alternate apex (same ingress rule as adsb.lol in the manifest) ---
    "planes.lol",
    "www.planes.lol",
    "api.planes.lol",
    "in.planes.lol",
    "feed.planes.lol",
    # --- api ---
    "api.adsb.lol",
    "api.2.adsb.lol",  # prior pass: self-signed
    "ops-manager.adsb.lol",  # prior pass: self-signed
    # --- map / globe / proxy ---
    "globe.adsb.lol",
    "map.adsb.lol",
    "mapproxy.adsb.lol",
    "history.adsb.lol",
    "test.adsb.lol",
    # --- readsb re-api (feeder-gated) ---
    "re-api.adsb.lol",
    # --- per-receiver + mlat ---
    "my.adsb.lol",
    "mlat.adsb.lol",
    "glider.adsb.lol",
    # --- ingest + raw aggregate out ---
    "feed.adsb.lol",
    "in.adsb.lol",
    "out.adsb.lol",
    "feed-acars.adsb.lol",
    # --- standing data + ops/status ---
    "vrs-standing-data.adsb.lol",
    "status.adsb.lol",
    "grafana.adsb.lol",
    "ingress-system2.adsb.lol",
]

CTX = ssl.create_default_context()  # CERT_REQUIRED + check_hostname
TIMEOUT = 10


class Row(NamedTuple):
    host: str
    dns: str
    ips: str
    tls: str
    cn: str
    exp: str

    @property
    def alive(self) -> bool:
        return self.tls == "VALID"


def resolve(host: str) -> tuple[str, list[str]]:
    """-> (dns_status, ips). Probes v4 and v6; a v6-only host is still alive."""
    ips: list[str] = []
    try:
        for _f, _t, _p, _c, sockaddr in socket.getaddrinfo(host, 443):
            ip = str(sockaddr[0])
            if ip not in ips:
                ips.append(ip)
    except socket.gaierror as e:
        return f"DNSFAIL({e.strerror or e})", []
    return ("ok", ips) if ips else ("NOADDR", [])


def common_name(cert: dict) -> str:
    """getpeercert()['subject'] is a tuple of RDNs, each a tuple of (key, value)."""
    for rdn in cert.get("subject", ()):
        for key, value in rdn:
            if key == "commonName":
                return str(value)
    return "-"


def probe(host: str) -> Row:
    dns, ips = resolve(host)
    if not ips:
        return Row(host, dns, "-", dns, "-", "-")
    last = "NO_IP"
    for ip in ips:
        try:
            with socket.create_connection((ip, 443), timeout=TIMEOUT) as raw:
                with CTX.wrap_socket(raw, server_hostname=host) as s:
                    cert = s.getpeercert() or {}
            return Row(
                host,
                dns,
                ",".join(ips[:4]),
                "VALID",
                common_name(cert),
                str(cert.get("notAfter", "-")),
            )
        except ssl.SSLCertVerificationError as e:
            last = f"CERT_INVALID({e.verify_message[:60]})"
        except ssl.SSLError as e:
            last = f"SSLError({e.reason or e})"
        except socket.timeout:
            last = "TIMEOUT"
        except OSError as e:
            last = type(e).__name__
    return Row(host, dns, ",".join(ips[:4]), last, "-", "-")


def main() -> None:
    hosts = sys.argv[1:] or HOSTS
    with ThreadPoolExecutor(max_workers=16) as ex:
        rows = list(ex.map(probe, hosts))
    rows.sort(key=lambda r: (not r.alive, r.host))  # alive first, then by name
    print(f"{'host':<28} {'dns':<10} {'tls':<52} {'cn':<24} {'expires':<26} ips")
    for r in rows:
        print(
            f"{r.host:<28} {r.dns:<10} {r.tls[:52]:<52} {r.cn[:24]:<24} "
            f"{r.exp[:26]:<26} {r.ips}"
        )
    alive = [r.host for r in rows if r.alive]
    print(f"\nTLS-VALID ({len(alive)}/{len(rows)}): {', '.join(alive)}")


if __name__ == "__main__":
    main()
