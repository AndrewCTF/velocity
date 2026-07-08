"""Guard: the security-critical clearance schema stays VERSIONED (issue #18).

Issue #18 was raised because the clearance-enforcing RLS could not be found under
`infra/db/` — it lives under `apps/api/supabase/migrations/`. These checks assert
the load-bearing policies remain committed and clearance-aware, so a reviewer can
verify them from the repo and a future edit can't silently drop the predicate.

This is a STATIC content guard (the SQL is applied to Supabase, not exercised by
the SQLite test suite); the in-app `classification.can_read` backstop is tested
separately in test_security_hardening.py.
"""

from __future__ import annotations

import re
from pathlib import Path

_MIG = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
_ACL = (_MIG / "0001_gotham_substrate_acl_audit.sql").read_text()
_PROFILES = (_MIG / "0000_profiles.sql").read_text()


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).lower()


def test_base_profiles_table_is_versioned():
    p = _norm(_PROFILES)
    assert "create table if not exists public.profiles" in p
    assert "references auth.users(id)" in p
    # Own-row RLS the app relies on to read clearance with the user's own token.
    assert "policy profiles_self_select" in p
    assert "auth.uid() = id" in p


def test_collab_docs_read_policy_is_clearance_aware():
    acl = _norm(_ACL)
    assert "create table if not exists public.collab_docs" in acl
    assert "policy collab_docs_read" in acl
    # The clearance + compartment predicate — the whole point of the control.
    assert "classification <= public.current_clearance()" in acl
    assert "compartments <@ public.current_compartments()" in acl


def test_collab_doc_acl_rpc_is_locked_down():
    acl = _norm(_ACL)
    assert "function public.collab_doc_acl(p_doc text)" in acl
    assert "security definer" in acl
    # Never callable by the anon/public role — only signed-in users.
    assert "revoke all on function public.collab_doc_acl(text) from public, anon" in acl
    assert "grant execute on function public.collab_doc_acl(text) to authenticated" in acl


def test_profiles_clearance_columns_added_before_helpers():
    acl = _norm(_ACL)
    assert "add column if not exists clearance smallint not null default 0" in acl
    assert "function public.current_clearance()" in acl
    # Columns must be ALTERed in before the sql helper validates its body.
    assert acl.index("add column if not exists clearance") < acl.index(
        "function public.current_clearance()"
    )
