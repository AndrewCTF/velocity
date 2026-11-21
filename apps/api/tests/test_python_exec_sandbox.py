"""Guards for the ``op.python`` jail (2026-08-29 hardening wave).

Before this, the block bounded ACCIDENTS — RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE
and a parent wall timeout — and nothing else. Block code could read
``apps/api/.env`` (every API key on the box) and post it anywhere, which turned
any principal allowed to run a workflow into remote code execution with the
API's own filesystem and network reach.

These tests drive the REAL ``run_python_block`` against the REAL bind list. A
test that asserted on a mocked argv would stay green while the jail leaked,
which is the only failure mode that matters here.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.workflows import python_exec

pytestmark = pytest.mark.skipif(
    python_exec._bwrap_path() is None,
    reason="bubblewrap unavailable or non-functional here (unprivileged userns off?); "
    "run_python_block falls back to the rlimits-only tier, which these guards do not describe",
)

REPO_ROOT = Path(__file__).resolve().parents[3]
DOTENV = REPO_ROOT / "apps" / "api" / ".env"


async def _run(code: str):
    return await python_exec.run_python_block(code, [], {})


@pytest.mark.anyio
async def test_a_block_still_runs():
    """The jail is worthless if it also stops the feature working."""
    rows, _ = await python_exec.run_python_block(
        "def run(rows, memory):\n    return [{'n': sum(r['n'] for r in rows)}]",
        [{"n": 1}, {"n": 2}],
        {},
    )
    assert rows == [{"n": 3}]


@pytest.mark.anyio
async def test_the_stdlib_and_site_packages_are_still_importable():
    rows, _ = await _run(
        "def run(rows, memory):\n"
        "    import hashlib, json, itertools\n"
        "    return [{'v': hashlib.sha256(b'x').hexdigest()[:8]}]"
    )
    assert rows == [{"v": "2d711642"}]


@pytest.mark.anyio
async def test_numpy_imports_and_a_runaway_allocation_still_dies():
    """RLIMIT_AS bounds VIRTUAL address space and OpenBLAS reserves far more
    than it touches, so the 1 GiB ceiling made `import numpy` — the most
    obvious thing to do in a data-transform block — fail outright."""
    rows, _ = await _run(
        "def run(rows, memory):\n"
        "    import numpy as np\n"
        "    return [{'v': float(np.arange(1000).mean())}]"
    )
    assert rows == [{"v": 499.5}]
    with pytest.raises(python_exec.PythonExecError) as exc:
        await _run("def run(rows, memory):\n    bytearray(9 * (1 << 30))\n    return []")
    assert "memory limit" in str(exc.value)


@pytest.mark.anyio
async def test_a_block_cannot_read_the_env_file():
    """The specific thing this exists to stop."""
    with pytest.raises(python_exec.PythonExecError) as exc:
        await _run(f"def run(rows, memory):\n    return [{{'v': open({str(DOTENV)!r}).read()}}]")
    assert "FileNotFoundError" in str(exc.value)


@pytest.mark.anyio
async def test_a_block_cannot_read_the_repo():
    with pytest.raises(python_exec.PythonExecError):
        await _run(
            "def run(rows, memory):\n"
            f"    return [{{'v': open({str(REPO_ROOT / 'README.md')!r}).read()}}]"
        )


@pytest.mark.anyio
async def test_a_block_cannot_open_a_socket_by_default():
    with pytest.raises(python_exec.PythonExecError) as exc:
        await _run(
            "def run(rows, memory):\n"
            "    import socket\n"
            "    socket.create_connection(('1.1.1.1', 53), 3)\n"
            "    return []"
        )
    assert "unreachable" in str(exc.value).lower() or "gaierror" in str(exc.value)


@pytest.mark.anyio
async def test_a_block_cannot_write_outside_its_tmpfs():
    with pytest.raises(python_exec.PythonExecError) as exc:
        await _run("def run(rows, memory):\n    open('/usr/x', 'w').write('x')\n    return []")
    assert "Read-only file system" in str(exc.value)
    # /tmp is a private tmpfs, so scratch files still work and vanish with the run.
    rows, _ = await _run(
        "def run(rows, memory):\n    open('/tmp/x', 'w').write('x')\n    return [{'v': 'ok'}]"
    )
    assert rows == [{"v": "ok"}]


@pytest.mark.anyio
async def test_the_child_does_not_inherit_this_process_environment():
    """Inheriting os.environ hands over whatever the operator exported —
    tokens, proxy credentials — to code the jail otherwise keeps off the disk."""
    rows, _ = await _run(
        "def run(rows, memory):\n    import os\n    return [{'v': sorted(os.environ)}]"
    )
    assert set(rows[0]["v"]) <= {
        "PATH", "HOME", "TMPDIR", "LC_ALL", "PYTHONDONTWRITEBYTECODE", "PWD",
    }


def test_the_bind_list_never_carries_a_parent_of_the_env_file():
    """sys.prefix (the venv) and py_runner.py both live inside the repo, and so
    does apps/api/.env. Binding a convenient parent is the one edit that would
    silently undo every test above, so it is asserted directly on the argv."""
    argv = python_exec._child_argv()
    bound = {argv[i + 1] for i, a in enumerate(argv) if a in ("--ro-bind", "--bind", "--ro-bind-try")}
    for path in bound:
        assert not DOTENV.is_relative_to(path), f"{path} contains {DOTENV}"


def test_a_base_python_outside_usr_is_bound_at_the_path_the_venv_names(tmp_path, monkeypatch):
    """uv's layout: venv/bin/python -> cpython-3.12-…/bin/python3.12, where
    cpython-3.12-… is itself a symlink to cpython-3.12.13-…. Binding only the
    resolved install leaves the alias missing in the jail (CI's 12 failures)."""
    (tmp_path / "real" / "bin").mkdir(parents=True)
    (tmp_path / "real" / "bin" / "python3.12").write_text("")
    (tmp_path / "alias").symlink_to(tmp_path / "real")
    (tmp_path / "venv" / "bin").mkdir(parents=True)
    venv_py = tmp_path / "venv" / "bin" / "python"
    venv_py.symlink_to(tmp_path / "alias" / "bin" / "python3.12")
    monkeypatch.setattr(python_exec.sys, "executable", str(venv_py))
    monkeypatch.setattr(python_exec.sys, "prefix", str(tmp_path / "venv"))
    alias = str(tmp_path / "alias")
    assert python_exec._base_python_binds() == ["--ro-bind", alias, alias]

    usr_py = tmp_path / "venv" / "bin" / "python3"
    usr_py.symlink_to("/usr/bin/python3")
    monkeypatch.setattr(python_exec.sys, "executable", str(usr_py))
    assert python_exec._base_python_binds() == []  # /usr is already in the jail

    # An alias that RESOLVES to a parent of the repo is refused: bwrap mounts
    # the realpath of the source, which would carry the .env into the jail.
    (tmp_path / "runtime" / "bin").mkdir(parents=True)
    (tmp_path / "runtime" / "bin" / "python3.12").write_text("")
    (tmp_path / "runtime-alias").symlink_to(tmp_path / "runtime")
    sneaky = tmp_path / "venv" / "bin" / "python3.12"
    sneaky.symlink_to(tmp_path / "runtime-alias" / "bin" / "python3.12")
    monkeypatch.setattr(python_exec.sys, "executable", str(sneaky))
    monkeypatch.setattr(python_exec, "_RUNNER", tmp_path / "runtime" / "project" / "py_runner.py")
    assert python_exec._base_python_binds() == []


def test_the_probe_uses_the_same_bind_list_as_the_real_spawn():
    """A probe testing a different sandbox than the one that runs proves nothing
    about the one that runs."""
    exe = python_exec._bwrap_path()
    assert exe is not None
    probe = python_exec._JAIL_BINDS(exe)
    real = python_exec._child_argv()
    assert real[: len(probe)] == probe
