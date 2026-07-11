"""Workflows — user-authored DAG pipelines over live platform data.

See ``docs/dashboard-workflows-plan.md`` section 2 for the spec. Mirrors the
Foundry substrate's architecture (``app/foundry/``): a local SQLite store
(``store.py``), a typed block registry (``blocks.py``), a DAG engine
(``engine.py``), and a BYO-compute Python block runner (``python_exec.py`` +
the static ``py_runner.py`` subprocess entry point).
"""

from __future__ import annotations
