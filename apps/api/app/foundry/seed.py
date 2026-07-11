"""Seed the built-in reference datasets into Foundry.

"Everything is a part of Foundry" (operator, 2026-07-11): the platform's
static reference data — airports, ports, bases, the unified infrastructure
and military facility sets, the country-OSINT resource catalog, and the
country-statistics indicator manifest — become ordinary Foundry datasets so
they get versions, SQL, transforms, checks and ontology bindings like any
upload.

Idempotent: an existing dataset (matched by name) is left untouched unless
``refresh=True``, which writes a new immutable version (Foundry's normal
versioning keeps history). Row caps are respected honestly: a source larger
than MAX_ROWS_PER_DATASET is truncated with the dropped count recorded in
the dataset description and the result payload — never silently.
"""

from __future__ import annotations

from typing import Any

from app import places
from app.foundry import ingest
from app.foundry.store import MAX_ROWS_PER_DATASET, FoundryError, FoundryStore
from app.osint import country_catalog
from app.routes import country_stats

SEED_SOURCE = "seed:reference"


def _country_resource_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for rec in country_catalog._load_catalog():
        for r in rec.resources:
            rows.append(
                {
                    "country_code": rec.code,
                    "country": rec.name,
                    "region": rec.region,
                    "resource": r.name,
                    "url": r.url,
                    "category": r.category,
                    "keyless": r.keyless,
                }
            )
    return rows


def _indicator_rows() -> list[dict[str, Any]]:
    return [
        {"source": "worldbank", **i} for i in country_stats.WB_INDICATORS
    ] + [{"source": "un-sdg", **s} for s in country_stats.UN_SERIES]


def reference_sources() -> dict[str, Any]:
    """name -> zero-arg loader returning list[dict]. Lazy so seeding never
    loads a dataset nobody asked for."""
    return {
        "ref_airports": places.airports,
        "ref_ports": places.ports,
        "ref_bases": places.bases,
        "ref_infrastructure": places.infrastructure,
        "ref_military": places.military,
        "ref_country_osint_resources": _country_resource_rows,
        "ref_country_indicators": _indicator_rows,
    }


async def seed_reference_datasets(store: FoundryStore, refresh: bool = False) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for name, loader in reference_sources().items():
        try:
            rows = loader()
        except Exception as e:  # noqa: BLE001 — one bad source never kills the seed
            results.append({"dataset": name, "status": "error", "note": str(e)[:120]})
            continue
        if not rows:
            results.append({"dataset": name, "status": "empty", "rows": 0})
            continue
        dropped = 0
        if len(rows) > MAX_ROWS_PER_DATASET:
            dropped = len(rows) - MAX_ROWS_PER_DATASET
            rows = rows[:MAX_ROWS_PER_DATASET]
        existing = await store.get_dataset_by_name(name)
        if existing is not None:
            if not refresh:
                results.append({"dataset": name, "status": "exists", "id": existing["id"]})
                continue
            ds_id = existing["id"]
        else:
            desc = f"Built-in reference data ({SEED_SOURCE})"
            if dropped:
                desc += f"; TRUNCATED: {dropped} rows over the {MAX_ROWS_PER_DATASET} cap were dropped"
            ds = await store.create_dataset(name, desc, kind="reference")
            ds_id = ds["id"]
        try:
            schema = ingest.infer_schema(rows)
            await store.add_version(ds_id, rows, schema, source=SEED_SOURCE)
        except FoundryError as exc:
            results.append({"dataset": name, "status": "error", "note": str(exc.detail)[:160]})
            continue
        results.append(
            {
                "dataset": name,
                "status": "seeded",
                "id": ds_id,
                "rows": len(rows),
                **({"dropped": dropped} if dropped else {}),
            }
        )
    return {"results": results}
