"""Ontology binding sync — mint/update ontology objects from a dataset's rows.

Object ids: ``foundry:{dataset_id}:{key_value}`` (docs/foundry-plan.md).
Written via ``get_registry().upsert()`` (NOT ``assert_props``): a fresh
``assert_props`` write creates the object row with ``kind=kind_of(object_id)``
(the id-prefix-derived kind — "object" for an unrecognised ``foundry:`` prefix)
regardless of the caller's intended ``object_kind``, since the ``kind`` column
is only set on INSERT, and ``assert_props``'s INSERT hard-codes ``kind_of``,
never the caller's kind (see ``intel/ontology_local.py:439-454``). ``upsert``
does not have that bug — it writes ``obj.kind`` verbatim (subject to
``Object.normalised()``, which only overrides an explicit kind when the id
prefix maps to a *different known* kind; ``foundry`` is not a known prefix, so
the explicit ``object_kind`` always wins). Each sync is a full prop
replacement from the binding's current ``prop_map`` — the binding fully owns
this object's synced props, so a wholesale replace (not a merge) is correct
and keeps the object's blob in step with the dataset row it mirrors.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from app.foundry.store import FoundryStore
from app.intel.ontology import Object, get_registry
from app.intel.ontology_local import SqliteRegistry, _canon, _connect
from app.keys import UserCtx


async def _resolve_candidates(
    reg: SqliteRegistry, object_kind: str, key_prop: str, key_value: Any
) -> list[str]:
    """Object ids of kind ``object_kind`` whose ``props[key_prop]`` equals
    ``key_value`` (canonically — same value-equality rule the registry itself
    uses to dedup assertions, ``ontology_local.py:128,206-209``).

    ``SqliteRegistry`` has no public "list objects by kind column + prop
    value" method: ``list_by_kind`` filters on ``props->>kind``, which is a
    convention only workspace nodes (situations/maps) use — see
    ``ontology_local.py:253-274`` and its two callers
    (``routes/situations.py:169``, ``routes/maps.py:186``). Foundry-bound
    objects carry their kind in the ``kind`` column instead (this module's
    own docstring above), so entity resolution has to query that column
    directly. Reaches into the same connection helper (``_connect``) the
    registry's own methods use, scoped by ``user_id`` exactly like every
    other registry query.
    """

    def _sync() -> list[str]:
        con = _connect(reg.s)
        try:
            rows = con.execute(
                "SELECT id, props FROM objects WHERE user_id=? AND kind=?",
                (reg.ctx.user_id, object_kind),
            ).fetchall()
        finally:
            con.close()
        target = _canon(key_value)
        matches: list[str] = []
        for object_id, props_json in rows:
            props = json.loads(props_json)
            if key_prop in props and _canon(props[key_prop]) == target:
                matches.append(object_id)
        return matches

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _sync)


async def sync_binding(
    store: FoundryStore, binding: dict[str, Any], ctx: UserCtx, *, resolve: bool = False
) -> dict[str, Any]:
    """Mint/update ontology objects from a binding's dataset rows.

    ``resolve`` (or ``binding["resolve"]`` as a fallback default, tolerating
    its absence — bindings don't persist this flag yet) turns on entity
    resolution: before minting a new ``foundry:{dataset_id}:{key}`` object,
    look for an existing object of the same ``object_kind`` whose key prop
    already carries the row's key value, and upsert onto that object instead
    of minting a duplicate. Zero matches mints as before; more than one match
    is ambiguous and the row is skipped with an error, never guessed at.
    """
    dataset_id = binding["dataset_id"]
    do_resolve = resolve or bool(binding.get("resolve", False))
    rows = await store.latest_rows(dataset_id)
    reg = get_registry(ctx)
    source = f"foundry:{dataset_id}"
    # The ontology prop that carries the row's key value: the binding's own
    # mapping for the key column when the author chose to expose it, else the
    # raw column name (the convention pre-existing, non-foundry-minted
    # objects use for their natural key, e.g. "mmsi").
    key_prop = binding["prop_map"].get(binding["key_column"], binding["key_column"])
    minted = updated = skipped = 0
    errors: list[str] = []
    for row in rows:
        key_val = row.get(binding["key_column"])
        if key_val is None:
            skipped += 1
            continue
        object_id = f"foundry:{dataset_id}:{key_val}"
        props = {
            prop_name: row.get(col) for col, prop_name in binding["prop_map"].items()
        }
        try:
            target_id = object_id
            if do_resolve:
                candidates = await _resolve_candidates(
                    reg, binding["object_kind"], key_prop, key_val
                )
                if len(candidates) > 1:
                    errors.append(
                        f"ambiguous match for key={key_val} ({len(candidates)} candidates)"
                    )
                    continue
                if len(candidates) == 1:
                    target_id = candidates[0]
            existing = await reg.get(target_id)
            await reg.upsert(
                Object(id=target_id, kind=binding["object_kind"], props=props),
                source=source,
            )
            if existing is None:
                minted += 1
            else:
                updated += 1
        except Exception as exc:  # noqa: BLE001 — one bad row must not abort the sync
            errors.append(f"{object_id}: {exc}")
    result = {
        "minted": minted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
    }
    await store.record_binding_sync(binding["id"], result)
    return result


async def auto_sync_dataset(
    store: FoundryStore, dataset_id: str, ctx: UserCtx, log: list[str] | None = None
) -> list[dict[str, Any]]:
    """Run ``sync_binding`` for every ENABLED binding on ``dataset_id`` — the
    Kinetic-layer auto-propagation gap (docs/foundry-gap-analysis-2026-07-08.md
    row 8). Called from ``builds.run_transform_build`` after a successful
    version write; routes can also call it directly after an upload (a later
    wave wires that in — this helper is already reusable for it).

    A binding sync failure is caught here and never raised — one broken
    binding must not fail the build/upload that triggered it. If ``log`` is
    given, one summary line per binding is appended to it in place.
    Returns one summary dict per binding: ``{"binding_id", "status": "ok" |
    "error", "result": <sync_binding's dict> | None, "error": str | None}``.
    """
    bindings = [
        b for b in await store.list_bindings() if b["dataset_id"] == dataset_id and b["enabled"]
    ]
    summaries: list[dict[str, Any]] = []
    for b in bindings:
        try:
            result = await sync_binding(store, b, ctx)
            if log is not None:
                log.append(
                    f"auto-sync binding {b['id']}: minted={result['minted']}"
                    f" updated={result['updated']} skipped={result['skipped']}"
                    f" errors={len(result['errors'])}"
                )
            summaries.append(
                {"binding_id": b["id"], "status": "ok", "result": result, "error": None}
            )
        except Exception as exc:  # noqa: BLE001 — one bad binding must not fail the build
            if log is not None:
                log.append(f"auto-sync binding {b['id']} FAILED: {exc}")
            summaries.append(
                {"binding_id": b["id"], "status": "error", "result": None, "error": str(exc)}
            )
    return summaries
