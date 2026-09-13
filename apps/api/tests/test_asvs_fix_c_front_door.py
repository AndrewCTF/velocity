"""Front-door hardening guards: nginx configs, compose, and the publish workflow.

Config-file guards in the style of test_nginx_resolver.py. Each test names the
ASVS 5.0 requirement it holds; the comment next to the directive in the config
says why the numbers are what they are.
"""

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
NGINX = ROOT / "infra" / "nginx"


def _conf(name: str) -> str:
    return re.sub(r"#.*", "", (NGINX / name).read_text())


def _locations(conf: str) -> dict[str, str]:
    """Top-level-ish location blocks: header -> body (nested braces balanced)."""
    out: dict[str, str] = {}
    for m in re.finditer(r"location\s+([^{]+)\{", conf):
        depth, i = 1, m.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(conf[i], 0)
            i += 1
        out[m.group(1).strip()] = conf[m.end() : i - 1]
    return out


@pytest.mark.parametrize("name", ["nginx.conf", "nginx.prod.conf"])
def test_tier_header_is_cleared_on_every_api_location(name: str) -> None:
    # ASVS 4.1.3: X-Velocity-Tier is believed from a trusted peer (app/tier.py),
    # and nginx is one, so nginx must never forward the client's copy.
    locs = {k: v for k, v in _locations(_conf(name)).items() if "$api_upstream" in v}
    assert locs
    for loc, body in locs.items():
        assert re.search(r'proxy_set_header\s+X-Velocity-Tier\s+""\s*;', body), loc


def test_prod_csp_header_carries_the_asvs_floor() -> None:
    # ASVS 3.4.3: the RESPONSE header needs object-src and base-uri, not only
    # the <meta> policy.
    m = re.search(r'add_header\s+Content-Security-Policy\s+"([^"]+)"\s+always;', _conf("nginx.prod.conf"))
    assert m
    for directive in ("object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"):
        assert directive in m.group(1)


def test_prod_static_responses_declare_utf8() -> None:
    # ASVS 4.1.1
    conf = _conf("nginx.prod.conf")
    assert re.search(r"^\s*charset\s+utf-8;", conf, re.M)
    types = re.search(r"charset_types\s+([^;]+);", conf)
    assert types and {"text/css", "application/javascript"} <= set(types.group(1).split())


def test_prod_ws_and_tiles_are_bounded_per_client() -> None:
    # ASVS 2.4.1 (nginx half)
    conf = _conf("nginx.prod.conf")
    locs = _locations(conf)
    assert re.search(r"limit_conn_zone\s+\$binary_remote_addr\s+zone=conn_per_ip:", conf)
    assert re.search(r"limit_req_zone\s+\$binary_remote_addr\s+zone=tiles_per_ip:", conf)
    assert re.search(r"limit_conn\s+conn_per_ip\s+\d+;", locs["/ws/"])
    assert re.search(r"limit_conn\s+conn_per_ip\s+\d+;", locs["/tiles/"])
    assert re.search(r"limit_req\s+zone=tiles_per_ip\s", locs["/tiles/"])
    # Refusals must not read as "backend down" (503) to the client.
    assert re.search(r"limit_req_status\s+429;", conf)
    assert re.search(r"limit_conn_status\s+429;", conf)


def test_prod_does_not_serve_source_maps() -> None:
    # ASVS 15.2.3: vite builds with sourcemap 'hidden', which still writes .map
    # files into dist; the static root must not hand them out.
    root = _locations(_conf("nginx.prod.conf"))["/"]
    assert re.search(r"location\s+~\*?\s+\\\.map\$\s*\{\s*return\s+404;", root)


def test_prod_workflow_run_outlives_the_engine_budget() -> None:
    # ASVS 15.2.2: POST /api/workflows/{id}/run blocks up to WALL_BUDGET_S.
    from app.workflows.engine import WALL_BUDGET_S

    locs = _locations(_conf("nginx.prod.conf"))
    body = locs["/api/workflows/"]
    t = re.search(r"proxy_read_timeout\s+(\d+)s;", body)
    assert t and int(t.group(1)) >= WALL_BUDGET_S + 10
    assert "limit_req zone=api_per_ip" in body


def _prod_compose() -> dict:
    return yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())


def test_every_prod_service_drops_privileges() -> None:
    # ASVS 13.2.2
    for name, svc in _prod_compose()["services"].items():
        assert svc.get("cap_drop") == ["ALL"], name
        assert "no-new-privileges:true" in svc.get("security_opt", []), name
        assert svc.get("pids_limit"), name


def test_prod_nginx_runs_unprivileged_on_an_unprivileged_port() -> None:
    # ASVS 13.2.2: no root master, no NET_BIND_SERVICE.
    nginx = _prod_compose()["services"]["nginx"]
    assert nginx.get("user") == "nginx"
    assert nginx.get("read_only") is True
    conf = _conf("nginx.prod.conf")
    assert re.search(r"^\s*listen\s+8080;", conf, re.M)
    assert re.search(r"^\s*pid\s+/tmp/", conf, re.M)
    assert nginx["ports"] == ["127.0.0.1:8080:8080"]


def test_prod_compose_documents_secrets_and_log_shipping() -> None:
    # ASVS 13.3.1 / 16.4.3: commented examples an operator can uncomment.
    text = (ROOT / "docker-compose.prod.yml").read_text()
    assert re.search(r"^\s*#\s*secrets:", text, re.M)
    assert re.search(r"^\s*#\s*logging:", text, re.M)


def test_published_images_carry_an_sbom() -> None:
    # ASVS 15.1.2: the SBOM travels with the pushed image, not only a CI artifact.
    wf = yaml.safe_load((ROOT / ".github" / "workflows" / "publish.yml").read_text())
    steps = wf["jobs"]["images"]["steps"]
    push = next(s for s in steps if str(s.get("uses", "")).startswith("docker/build-push-action"))
    assert push["with"].get("sbom") is True
    assert str(push["with"].get("provenance", "")).startswith("mode=max")
