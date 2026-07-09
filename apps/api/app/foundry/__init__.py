"""Foundry substrate — BYO-data pipelines bound into the local ontology.

Pillars (docs/foundry-plan.md): datasets (upload + versions), transforms (step
DSL + lineage), builds (run history), ontology binding (mint objects through
``app.intel.ontology.get_registry``), schedules (interval re-runs). Local
SQLite only (``data/foundry.db``, WAL, same idiom as ``app/history.py`` and
``app/intel/ontology_local.py``) — no new heavyweight deps.
"""
