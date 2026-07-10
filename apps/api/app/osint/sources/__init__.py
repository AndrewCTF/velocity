"""Keyless (or key-optional, degrade-to-note) OSINT source connectors.

One module per source family; each function returns a normalised dict and never
raises on upstream failure (degrades to an empty result + ``note``), mirroring
``app/osint/connectors.py``. The investigate orchestrator in ``routes/osint.py``
composes these into ontology Object/Link rows so every source links into the
shared graph. See ``docs/osint-sources-plan.md``.
"""
