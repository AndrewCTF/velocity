"""Guard: no migration sequence lets a signed-in user write their own roles,
clearance or compartments (ASVS V8.2.1 / V8.2.3 / V10.3.2).

0000 granted UPDATE on the whole ``profiles`` row to ``authenticated`` and 0001
added the privilege columns to that row, so ``PATCH /rest/v1/profiles`` with a
user's own token made them admin. The SQL is applied to Supabase, not run by this
suite, so this guard REPLAYS the grants and revokes of every migration in order
and asserts the final privilege state, rather than grepping one file: a later
migration that re-grants update would pass a single-file check.
"""

from __future__ import annotations

import re
from pathlib import Path

_MIG = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
_PRIVILEGED = {"roles", "clearance", "compartments", "email"}


def _statements() -> list[str]:
    out: list[str] = []
    for f in sorted(_MIG.glob("*.sql")):
        sql = re.sub(r"--[^\n]*", "", f.read_text())
        out.extend(re.sub(r"\s+", " ", s).strip().lower() for s in sql.split(";"))
    return [s for s in out if s]


def _replay_profile_writes(role: str) -> tuple[set[str], set[str]]:
    """(table-level write privileges, columns with a column-level UPDATE grant)
    that ``role`` holds on public.profiles after every migration in order."""
    table: set[str] = set()
    cols: set[str] = set()
    grant = re.compile(r"^(grant|revoke) (.+?) on (?:table )?public\.profiles (to|from) (.+)$")
    for st in _statements():
        m = grant.match(st)
        if not m:
            continue
        verb, privs, _, roles = m.groups()
        if role not in {r.strip() for r in roles.split(",")}:
            continue
        for priv in re.findall(r"(all|select|insert|update|delete)(?: \(([^)]*)\))?", privs):
            name, columns = priv
            names = {"insert", "update", "delete"} if name == "all" else {name}
            if name == "select":
                continue
            if columns:
                named = {c.strip() for c in columns.split(",")}
                cols = cols | named if verb == "grant" else cols - named
            elif verb == "grant":
                table |= names
            else:
                table -= names
                if "update" in names:
                    cols = set()
    return table, cols


def test_replay_would_catch_the_original_defect():
    """The replay must see 0000's grant, or it guards nothing."""
    first = _MIG / "0000_profiles.sql"
    assert "grant select, update on public.profiles to authenticated" in re.sub(
        r"\s+", " ", first.read_text()
    )


def test_authenticated_cannot_update_privileged_profile_columns():
    table, cols = _replay_profile_writes("authenticated")
    assert "update" not in table, "authenticated holds table-wide UPDATE on profiles"
    assert "insert" not in table, "authenticated can INSERT a profile with any roles"
    assert not (cols & _PRIVILEGED), f"column UPDATE granted on {cols & _PRIVILEGED}"


def test_anon_holds_no_profile_writes():
    table, cols = _replay_profile_writes("anon")
    assert not table and not cols


def test_admin_rpc_checks_the_caller_is_admin_and_is_not_public():
    sql = " ".join(_statements())
    body = sql[sql.index("function public.admin_set_profile_access("):]
    body = body[: body.index("revoke all on function public.admin_set_profile_access")]
    assert "security definer" in body
    assert "'admin' = any(public.current_roles())" in body
    assert "revoke all on function public.admin_set_profile_access(uuid, text[], smallint, text[]) from public, anon" in sql


def test_clearance_policies_do_not_apply_to_the_public_anon_key():
    """The last CREATE of each permissive clearance policy is scoped to
    authenticated, so the anon key shipped in the web bundle reads nothing."""
    last: dict[str, str] = {}
    for st in _statements():
        m = re.match(r"^create policy (\w+) on public\.(\w+) ", st)
        if m:
            last[m.group(1)] = st
    for name in (
        "objects_clearance_select", "links_clearance_select",
        "target_board_clearance_select", "collab_docs_read", "collab_docs_write",
        "profiles_self_select",
    ):
        assert " to authenticated " in last[name], name
    assert "owner_uid = auth.uid()" in last["collab_docs_write"].split("with check", 1)[1]
