"""Make ``geolocate`` importable when pytest is pointed straight at this
directory (``apps/api/.venv/bin/pytest apps/ml/geolocate -q`` from the repo
root, per docs/photo-geolocation-pipeline.md §5) -- there is no repo-root
pyproject.toml/pytest.ini to install this standalone package, so add its
parent (``apps/ml``) to ``sys.path`` directly, the same relationship the CLI
needs (``PYTHONPATH=apps/ml python -m geolocate.pipeline ...``)."""

from __future__ import annotations

import sys
from pathlib import Path

_ML_DIR = Path(__file__).resolve().parents[2]  # apps/ml/geolocate/tests -> apps/ml
if str(_ML_DIR) not in sys.path:
    sys.path.insert(0, str(_ML_DIR))
