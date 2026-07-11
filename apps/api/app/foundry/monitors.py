"""Foundry monitors — rule watchers over dataset events.

A monitor watches one dataset for a trigger (``new_version``, a safe-DSL
``row_condition``, ``check_failed``, ``build_failed``) and, on firing, runs an
action (publish a bus ``Alert``, call the LLM ladder for a summary, or both).
Every firing is recorded as one ``monitor_events`` row.

``evaluate_monitors`` is the public, fire-and-forget-safe entry point called
from the choke points in ``store.py``/``builds.py`` — it never raises, so a
monitor bug can never break the dataset write path that triggered it.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import TYPE_CHECKING, Any

from app import llm
from app.correlate.bus import bus
from app.correlate.types import Alert
from app.foundry.store import FoundryError
from app.foundry.transforms import compile_expr, eval_expr

if TYPE_CHECKING:
    from app.foundry.store import FoundryStore

log = logging.getLogger(__name__)

TRIGGERS = {"new_version", "row_condition", "check_failed", "build_failed"}
ACTIONS = {"alert", "llm", "both"}
SEVERITIES = {"info", "low", "medium", "high", "critical"}

# Matched/context rows carried in an event and handed to the LLM prompt.
_MAX_ROWS = 50


def validate_monitor(trigger: str, action: str, condition_expr: str, severity: str) -> None:
    """Raise ``FoundryError(422, ...)`` if the monitor definition is not
    well-formed. Called on create and update."""
    if trigger not in TRIGGERS:
        raise FoundryError(422, f"unknown trigger {trigger!r}; must be one of {sorted(TRIGGERS)}")
    if action not in ACTIONS:
        raise FoundryError(422, f"unknown action {action!r}; must be one of {sorted(ACTIONS)}")
    if severity not in SEVERITIES:
        raise FoundryError(
            422, f"unknown severity {severity!r}; must be one of {sorted(SEVERITIES)}"
        )
    if trigger == "row_condition":
        if not condition_expr or not condition_expr.strip():
            raise FoundryError(422, "row_condition trigger requires a non-empty condition_expr")
        compile_expr(condition_expr)  # raises FoundryError(422, ...) on invalid/unsafe expr


async def evaluate_monitors(
    store: FoundryStore,
    dataset_id: str,
    *,
    trigger_kind: str,
    context: dict[str, Any],
) -> None:
    """Evaluate every enabled monitor on ``dataset_id`` against one event.

    ``trigger_kind`` is one of ``"version_written"`` (covers both the
    ``new_version`` and ``row_condition`` monitor triggers — both fire off the
    same "a version was just written" event), ``"check_failed"``, or
    ``"build_failed"``. Fire-and-forget-safe: any exception is logged and
    swallowed here so a monitor bug can never break the write/build path that
    triggered evaluation.
    """
    try:
        await _evaluate(store, dataset_id, trigger_kind=trigger_kind, context=context)
    except Exception:  # noqa: BLE001 — must never propagate into the caller
        log.exception(
            "foundry monitors: evaluation failed for dataset %s (%s)", dataset_id, trigger_kind
        )


async def _evaluate(
    store: FoundryStore,
    dataset_id: str,
    *,
    trigger_kind: str,
    context: dict[str, Any],
) -> None:
    monitors = [m for m in await store.list_monitors(dataset_id) if m["enabled"]]
    if not monitors:
        return
    dataset = await store.get_dataset(dataset_id)
    dataset_name = dataset["name"] if dataset else dataset_id

    if trigger_kind == "version_written":
        rows = context.get("rows") or []
        for m in monitors:
            if m["trigger"] == "new_version":
                await _fire(store, m, dataset_name, rows[:_MAX_ROWS], "new version written")
            elif m["trigger"] == "row_condition":
                matched = _matching_rows(m["condition_expr"], rows)
                if matched:
                    await _fire(
                        store,
                        m,
                        dataset_name,
                        matched[:_MAX_ROWS],
                        f"{len(matched)} row(s) matched condition",
                    )
    elif trigger_kind == "check_failed":
        for m in monitors:
            if m["trigger"] == "check_failed":
                await _fire(
                    store,
                    m,
                    dataset_name,
                    (context.get("rows") or [])[:_MAX_ROWS],
                    context.get("error") or "check failed",
                )
    elif trigger_kind == "build_failed":
        for m in monitors:
            if m["trigger"] == "build_failed":
                await _fire(store, m, dataset_name, [], context.get("error") or "build failed")


def _matching_rows(condition_expr: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tree = compile_expr(condition_expr)
    matched: list[dict[str, Any]] = []
    for r in rows:
        try:
            if eval_expr(tree, r):
                matched.append(r)
        except Exception:  # noqa: BLE001 — a row that can't be evaluated just doesn't match
            continue
    return matched


async def _fire(
    store: FoundryStore,
    monitor: dict[str, Any],
    dataset_name: str,
    sample_rows: list[dict[str, Any]],
    summary_text: str,
) -> None:
    """One monitor firing: run its action(s), record the event."""
    kind = "fired"
    summary = summary_text
    llm_summary: str | None = None
    if monitor["action"] in ("llm", "both"):
        llm_summary = await _run_llm(monitor, dataset_name, sample_rows)
        if llm_summary is None:
            kind = "llm_error"
            summary = f"LLM action failed for trigger {monitor['trigger']!r}"
        else:
            summary = llm_summary
    if monitor["action"] in ("alert", "both"):
        message = f"{monitor['name']}: {dataset_name} — {summary_text}"
        if llm_summary:
            message = f"{message}. {llm_summary}"
        bus.publish(
            Alert(
                id=uuid.uuid4().hex[:12],
                rule_id=f"foundry:monitor:{monitor['id']}",
                severity=monitor["severity"],  # type: ignore[arg-type]
                t=time.time(),
                lon=0.0,
                lat=0.0,
                confidence=1.0,
                message=message,
                contributing=[dataset_name],
            )
        )
    await store.record_monitor_event(
        monitor["id"],
        kind,
        summary,
        {"trigger": monitor["trigger"], "matched_rows": sample_rows, "dataset": dataset_name},
    )


async def _run_llm(
    monitor: dict[str, Any], dataset_name: str, rows: list[dict[str, Any]]
) -> str | None:
    """Call the LLM ladder with the monitor's system prompt + prompt template.
    Returns the summary text, or ``None`` on ANY failure — never raises."""
    try:
        prompt = (monitor["llm_prompt"] or "{dataset}: {rows}").format(
            dataset=dataset_name,
            rows=json.dumps(rows, default=str)[:20_000],
            trigger=monitor["trigger"],
        )
    except Exception as exc:  # noqa: BLE001 — a malformed template must degrade, not crash
        log.warning("foundry monitor %s: prompt template error: %s", monitor["id"], exc)
        return None
    messages = [
        {"role": "system", "content": monitor["llm_system"] or "You are a data monitor assistant."},
        {"role": "user", "content": prompt},
    ]
    try:
        parsed, result = await llm.chat_json(
            messages, tier=monitor["llm_tier"] or "fast", label="foundry_monitor"
        )
    except Exception as exc:  # noqa: BLE001 — LLM failures must never crash monitor eval
        log.warning("foundry monitor %s: llm call raised: %s", monitor["id"], exc)
        return None
    if not result.ok:
        return None
    if parsed is not None:
        return json.dumps(parsed, default=str)[:2000]
    return (result.text or "")[:2000]
