"""Both nginx configs resolve compose service names per request.

A static ``upstream { server api:8000; }`` (or ``proxy_pass http://api;``) pins
the IP nginx saw at boot; recreating the api container then sends traffic to a
dead or reused address (measured 2026-09-13: 502 after ``up -d api``). The fix
is a ``resolver`` plus a variable in every ``proxy_pass`` (nginx.conf says why).
"""

import re
from pathlib import Path

import pytest

NGINX = Path(__file__).resolve().parents[3] / "infra" / "nginx"


@pytest.mark.parametrize("name", ["nginx.conf", "nginx.prod.conf"])
def test_proxy_pass_goes_through_the_resolver(name: str) -> None:
    conf = re.sub(r"#.*", "", (NGINX / name).read_text())
    assert re.search(r"^\s*resolver\s+127\.0\.0\.11\b", conf, re.M)
    assert not re.search(r"^\s*upstream\s", conf, re.M)
    targets = re.findall(r"proxy_pass\s+([^;]+);", conf)
    assert targets
    assert all(t.startswith("http://$") for t in targets), targets
