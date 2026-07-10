"""Photo-geolocation pipeline (docs/photo-geolocation-pipeline.md).

Funnel: A forensics -> B geo-prior fusion -> C candidate retrieval ->
D precise pose -> E verification/report. Stages read/write only the JSON
contracts in :mod:`geolocate.contracts` so they parallelise across builders
without shared-file contention (see the spec §4/§5).

This package is imported as a top-level module named ``geolocate`` with
``apps/ml`` on ``sys.path`` (mirrors how ``apps/ml/fusion`` sits beside it) —
either run the CLI with ``PYTHONPATH=apps/ml`` from the repo root, or run
pytest against ``apps/ml/geolocate`` (its ``tests/conftest.py`` adds
``apps/ml`` to ``sys.path`` itself, so no external env var is required for
the test suite).
"""

from __future__ import annotations
