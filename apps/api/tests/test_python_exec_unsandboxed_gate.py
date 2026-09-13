"""G13: ``op.python`` refuses to run at the ``rlimits-only`` tier unless the
operator opts in with ``WORKFLOWS_PYTHON_UNSANDBOXED=1``.

At that tier the child runs as the API's own uid and can read
``/proc/<api pid>/environ`` (every secret from ``env_file``), so running it by
default is RCE with the API's credentials. Measured in the prod container:
AppArmor's ``apparmor_restrict_unprivileged_userns=1`` stops bwrap's uid map, so
the tier there IS ``rlimits-only``. The tier stays reported in the block help.

The suite's conftest opts in (like ``ALLOW_UNAUTHENTICATED``) so op.python tests
still run on CI hosts without bubblewrap; every test here sets the flag itself.
"""

from __future__ import annotations

import asyncio

import pytest

from app.keys import UserCtx
from app.workflows import blocks, python_exec
from app.workflows.store import WorkflowError

_CODE = "def run(rows, memory):\n    return [{'n': len(rows)}]\n"


@pytest.fixture
def no_bwrap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(python_exec, "_bwrap_path", lambda: None)
    assert python_exec.sandbox_tier() == "rlimits-only"


def test_rlimits_only_without_opt_in_is_refused(no_bwrap, monkeypatch) -> None:
    monkeypatch.delenv("WORKFLOWS_PYTHON_UNSANDBOXED", raising=False)
    spawned: list[object] = []

    async def _spawn(*a, **k):  # type: ignore[no-untyped-def]
        spawned.append(a)
        raise AssertionError("must not spawn")

    monkeypatch.setattr(python_exec.asyncio, "create_subprocess_exec", _spawn)
    with pytest.raises(python_exec.PythonSandboxUnavailable) as ei:
        asyncio.run(python_exec.run_python_block(_CODE, [{}], {}))
    assert "WORKFLOWS_PYTHON_UNSANDBOXED" in str(ei.value)
    assert spawned == []


def test_block_maps_refusal_to_503(no_bwrap, monkeypatch) -> None:
    monkeypatch.delenv("WORKFLOWS_PYTHON_UNSANDBOXED", raising=False)
    with pytest.raises(WorkflowError) as ei:
        asyncio.run(blocks._run_op_python({"code": _CODE}, [[{}]], blocks.BlockCtx(user_ctx=UserCtx("local", ""), workflow_id="w", memory={})))
    assert ei.value.status_code == 503
    assert "WORKFLOWS_PYTHON_UNSANDBOXED" in ei.value.detail


def test_rlimits_only_with_opt_in_runs(no_bwrap, monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOWS_PYTHON_UNSANDBOXED", "1")
    rows, _ = asyncio.run(python_exec.run_python_block(_CODE, [{}, {}], {}))
    assert rows == [{"n": 2}]


@pytest.mark.parametrize("net", ["", "1"])
def test_bwrap_tiers_pass_the_gate(monkeypatch, net: str) -> None:
    monkeypatch.delenv("WORKFLOWS_PYTHON_UNSANDBOXED", raising=False)
    monkeypatch.setenv("WORKFLOWS_PYTHON_NET", net)
    monkeypatch.setattr(python_exec, "_bwrap_path", lambda: "/usr/bin/bwrap")
    assert python_exec.sandbox_tier() == ("bwrap" if net else "bwrap-nonet")
    python_exec._refuse_unsandboxed()  # no raise at a jailed tier


@pytest.mark.skipif(
    python_exec._bwrap_path() is None, reason="bubblewrap not functional on this host"
)
def test_real_bwrap_tier_runs_without_opt_in(monkeypatch) -> None:
    monkeypatch.delenv("WORKFLOWS_PYTHON_UNSANDBOXED", raising=False)
    rows, _ = asyncio.run(python_exec.run_python_block(_CODE, [{}], {}))
    assert rows == [{"n": 1}]


def test_help_text_still_states_the_tier(no_bwrap, monkeypatch) -> None:
    monkeypatch.delenv("WORKFLOWS_PYTHON_UNSANDBOXED", raising=False)
    h = blocks._python_sandbox_help()
    assert "resource limits ONLY" in h and "WORKFLOWS_PYTHON_UNSANDBOXED" in h
