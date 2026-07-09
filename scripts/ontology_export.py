#!/usr/bin/env python3
"""One-shot migration: Supabase ontology rows → the local SQLite spine.

Pages the operator's ``objects`` and ``links`` tables out of Supabase
(PostgREST) and writes them into the local store (``data/ontology.db`` by
default). Object props are materialized verbatim and each prop additionally
becomes one assertion with ``source='migrated'`` (observed_at = the row's
created_at), so day one the local graph carries the provenance schema.
Idempotent: re-running skips assertions whose latest value+source already
match, and object/link rows are upserts.

Usage (run from the repo root, with the api venv):

  apps/api/.venv/bin/python scripts/ontology_export.py \
      --supabase-url https://<proj>.supabase.co \
      (--service-key <key> | --token <user-jwt>) \
      [--anon-key <key>] [--db data/ontology.db] [--local-user local] \
      [--user-id <uuid>] [--dry-run]

With ``--service-key`` all users' rows are visible — pass ``--user-id`` to
restrict to one owner. With ``--token`` RLS scopes rows to that user already.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.config import Settings  # noqa: E402
from app.intel import ontology_local as ol  # noqa: E402
from app.keys import UserCtx  # noqa: E402

_PAGE = 500


def _fetch_all(
    base: str, table: str, headers: dict[str, str], user_id: str | None
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    with httpx.Client(timeout=30.0) as c:
        while True:
            params: dict[str, str] = {
                "select": "*",
                "order": "created_at.asc",
                "limit": str(_PAGE),
                "offset": str(offset),
            }
            if user_id:
                params["user_id"] = f"eq.{user_id}"
            r = c.get(f"{base}/rest/v1/{table}", params=params, headers=headers)
            r.raise_for_status()
            page = r.json()
            rows.extend(page)
            if len(page) < _PAGE:
                return rows
            offset += _PAGE


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--supabase-url", required=True)
    ap.add_argument("--service-key", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--anon-key", default="")
    ap.add_argument("--db", default="data/ontology.db")
    ap.add_argument("--local-user", default="local")
    ap.add_argument("--user-id", default="", help="filter rows to one owner")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.service_key and not args.token:
        ap.error("one of --service-key / --token is required")
    bearer = args.service_key or args.token
    headers = {
        "apikey": args.service_key or args.anon_key or bearer,
        "Authorization": f"Bearer {bearer}",
        "Accept": "application/json",
    }
    base = args.supabase_url.rstrip("/")

    objects = _fetch_all(base, "objects", headers, args.user_id or None)
    links = _fetch_all(base, "links", headers, args.user_id or None)
    print(f"fetched {len(objects)} objects, {len(links)} links from Supabase")

    if args.dry_run:
        for row in objects[:10]:
            print("  object:", row.get("id"), list((row.get("props") or {}).keys()))
        for row in links[:10]:
            print("  link:", row.get("src"), row.get("rel"), row.get("dst"))
        print("dry run — nothing written")
        return 0

    ol.override_db_path(args.db)
    settings = Settings(supabase_url="")
    ctx = UserCtx(args.local_user, "")
    con = ol._connect(settings)
    reg = ol.SqliteRegistry(ctx, settings)
    n_assert = 0
    try:
        for row in objects:
            props = row.get("props") or {}
            observed = row.get("created_at") or ol._now_iso()
            con.execute(
                """
                INSERT INTO objects (user_id, id, kind, props, classification,
                  compartments, shared, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(user_id, id) DO UPDATE SET
                  kind=excluded.kind, props=excluded.props,
                  classification=excluded.classification,
                  compartments=excluded.compartments,
                  shared=excluded.shared, updated_at=excluded.updated_at
                """,
                (
                    ctx.user_id,
                    row["id"],
                    row.get("kind") or "object",
                    json.dumps(props),
                    int(row.get("classification") or 0),
                    json.dumps(row.get("compartments") or []),
                    int(bool(row.get("shared"))),
                    observed,
                    ol._now_iso(),
                ),
            )
            for prop, value in props.items():
                before = con.total_changes
                reg._insert_assertion_sync(
                    con, row["id"], prop, value, "migrated", 1.0, observed,
                    None, None,
                )
                n_assert += con.total_changes - before
        for row in links:
            observed = row.get("created_at") or ol._now_iso()
            con.execute(
                """
                INSERT INTO links (user_id, src, dst, rel, props, source,
                  confidence, observed_at, valid_until, classification,
                  compartments, shared, created_at)
                VALUES (?,?,?,?,?,'migrated',1.0,?,NULL,?,?,?,?)
                ON CONFLICT(user_id, src, dst, rel) DO UPDATE SET
                  props=excluded.props
                """,
                (
                    ctx.user_id,
                    row["src"],
                    row["dst"],
                    row["rel"],
                    json.dumps(row.get("props") or {}),
                    observed,
                    int(row.get("classification") or 0),
                    json.dumps(row.get("compartments") or []),
                    int(bool(row.get("shared"))),
                    observed,
                ),
            )
        con.commit()
    finally:
        con.close()
    print(
        f"wrote {len(objects)} objects, {len(links)} links, "
        f"{n_assert} assertions → {args.db} (user_id={ctx.user_id})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
