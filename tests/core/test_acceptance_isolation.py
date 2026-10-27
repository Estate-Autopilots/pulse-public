"""Acceptance: a test tenant cannot read the first tenant's rows, even with a broken query (05 §7, ADR-0005).

Covers every table with org_id (generated from the catalogue, so a new table is covered automatically), for every
service login, with the classic mistakes: a missing WHERE, a WHERE naming the other tenant, a forgotten or empty
tenant setting, a join across tenants, a write with the other tenant's id, and a mid-transaction tenant hop through
resolve_route. Also: the list of tables without org_id is exactly the global allow-list, and person-first
visibility for the API (appendix A-tests T4).
"""

from __future__ import annotations

import uuid

import psycopg
import pytest

from pulse_sdk.db import set_tenant
from pulse_workers.projector import ProjectionRunner
from pulse_workers.workgraph import WorkGraph

from helpers import build_world, drive_id, issue_asset, render, upload

GLOBAL_ALLOW_LIST = {"pulse_route.route", "pulse.event_type", "pulse.model_registry", "pulse.ingest_nonce",
                     "privacy.purpose", "privacy.retention_class",
                     "pulse_priv.raw_store_limit", "pulse_priv.raw_store_usage",  # global cap/accounting, owner-only
                     # ORG (0920): one Pulse account per human across organisations: owner-only, no runtime grants,
                     # reached only through SECURITY DEFINER functions; each organisation's rows stay under its RLS.
                     "pulse_priv.handle_name", "pulse_priv.pulse_account", "pulse_priv.account_member",
                     "pulse_priv.account_profile", "pulse_priv.account_badge", "pulse_priv.account_highlight",
                     "pulse_priv.account_share",
                     # CONNECT (0953): client connections between organisations: owner-only, reached through SECURITY DEFINER
                     # functions that check the viewer's organisation and seat (connect.ts).
                     "pulse_priv.connect_request", "pulse_priv.org_connection", "pulse_priv.connect_seat",
                     "pulse_priv.connect_share", "pulse_priv.org_referral",
                     # INTEGRITY (0910): the retired task values and credits, kept as they stood: owner-only archives
                     # (row security on, no policy, no runtime grants), read by no role.
                     "pulse_priv.work_credit_retired", "pulse_priv.task_value_retired",
                     # PULSE-HQ (0943): the Pulse licence register: global and owner-only like the account tables,
                     # read only through licence_list() (SECURITY DEFINER, Pulse organisation only).
                     "pulse_priv.pulse_licence",
                     # PULSE-ID (1115): Sign in with Pulse's registered apps, per-app subjects, one-time codes and tokens are
                     # install-level and owner-only like the account tables (a token is found by its hash before its
                     # organisation is known); connections, webhooks and signals stay under each organisation's RLS.
                     "pulse_priv.oidc_app", "pulse_priv.oidc_subject", "pulse_priv.oidc_code", "pulse_priv.oidc_token",
                     # PULSE-HQ (0973): shared stacks (Stack Intelligence): read-only snapshots any signed-in organisation
                     # browses or copies; owner-only, reached only through SECURITY DEFINER functions (stack_directory, stack_shared).
                     "pulse_priv.stack_share",
                     # PULSE-ADMIN (1140): the platform admin console's admins, audit log, plans and announcements are
                     # install-level and owner-only: no runtime grants, reached only through SECURITY DEFINER functions
                     # that check pulse.platform_admin() themselves.
                     "pulse_priv.platform_admin", "pulse_priv.platform_audit", "pulse_priv.platform_plan",
                     "pulse_priv.platform_announcement"}
ROLES = ("api", "worker", "ingest", "privacy")


def tenant_tables(admin) -> list[str]:
    return [r["t"] for r in admin.execute(
        """select n.nspname || '.' || c.relname as t
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
            where n.nspname in ('pulse', 'pulse_priv', 'privacy') and c.relkind in ('r', 'p') and not c.relispartition
            order by 1""").fetchall()]


@pytest.fixture
def two_tenants(worker, owner, api):
    ea = build_world(worker, owner, api)            # stands in for the first tenant (EA)
    cid = ea.cid("HK", 3)
    issue_asset(api, ea, cid)
    render(worker, ea, ea.device, f"{cid}-v1.mp4", "ea-bytes", minutes=10)
    upload(worker, ea, drive_id(), f"{cid}-v1.mp4", "ea-bytes", folder=ea.drafts, minutes=20)
    ProjectionRunner(worker, WorkGraph()).catch_up(ea.org)
    with worker.transaction():
        set_tenant(worker, ea.org)
        worker.execute("""insert into pulse.score (org_id, subject_type, subject_id, metric, period_start, period_end,
                                                   value, sufficiency, explanation, model_name, model_version, visibility)
                          values (%s, 'person', %s, 'delivery_ratio', '2026-10-05', '2026-10-11', 1, 'enough', '{}',
                                  'delivery_score', '1.0.0', 'team')""", (ea.org, ea.editor))
        worker.execute("""insert into pulse.drive_backfill_emission (org_id, file_id, source_ref)
                          values (%s, 'synthetic-drive-file', 'synthetic-revision')""", (ea.org,))
    test = build_world(worker, owner, api)          # the test tenant
    return ea, test


def test_every_tenant_table_is_forced_rls_and_others_are_allow_listed(admin):
    rows = admin.execute(
        """select n.nspname || '.' || c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as force,
                  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id'
                          and not a.attisdropped) as has_org,
                  (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('pulse', 'pulse_priv', 'privacy', 'pulse_route') and c.relkind in ('r', 'p')
              and not c.relispartition""").fetchall()
    unprotected = {r["t"] for r in rows if not (r["rls"] and r["force"] and r["policies"] > 0)}
    assert unprotected == GLOBAL_ALLOW_LIST
    assert all(r["has_org"] for r in rows if r["t"] not in GLOBAL_ALLOW_LIST | {"pulse.org"})
    no_runtime_bypass = admin.execute(
        """select count(*) as n from pg_roles where rolname like 'pulse%%' and (rolsuper or rolbypassrls)""").fetchone()
    assert no_runtime_bypass["n"] == 0


def test_test_tenant_sees_no_first_tenant_rows_in_any_table(two_tenants, admin, api, worker, ingest, privacy):
    ea, test = two_tenants
    conns = {"api": api, "worker": worker, "ingest": ingest, "privacy": privacy}
    tables = tenant_tables(admin)
    checked = 0
    for role, conn in conns.items():
        for table in tables:
            for setting in (str(test.org), None, ""):
                try:
                    with conn.transaction():
                        if setting is not None:
                            conn.execute("select set_config('pulse.org_id', %s, true)", (setting,))
                        n_all = conn.execute(f"select count(*) as n from {table}").fetchone()["n"]          # no WHERE
                        n_ea = conn.execute(f"select count(*) as n from {table} where org_id = %s or true",  # broken
                                            (ea.org,)).fetchone()["n"]
                        foreign = conn.execute(f"select count(*) as n from {table} where org_id = %s",
                                               (ea.org,)).fetchone()["n"]
                except psycopg.errors.InsufficientPrivilege:
                    continue                                   # this role cannot read the table at all: fine
                assert foreign == 0, f"{role} read {table} rows of the first tenant (org setting {setting!r})"
                if setting in (None, ""):
                    assert n_all == 0 and n_ea == 0, f"{role}: {table} visible without a tenant"
                checked += 1
    assert checked > 3 * len(tables)        # most tables are readable by several roles; all were checked


def test_cross_tenant_join_and_functions_leak_nothing(two_tenants, api, worker):
    ea, test = two_tenants
    with worker.transaction():
        set_tenant(worker, test.org)
        assert worker.execute("""select count(*) as n from pulse.version v join pulse.asset a on a.id = v.asset_id
                                  join pulse.org o on o.id = a.org_id where o.code = %s""", (ea.code,)).fetchone()["n"] == 0
        assert worker.execute("select count(*) as n from pulse.org").fetchone()["n"] == 1
        assert worker.execute("select count(*) as n from pulse.event where subject like 'file:gdrive:%%' "
                              "and org_id <> pulse.current_org()").fetchone()["n"] == 0
    with api.transaction():
        set_tenant(api, test.org, ea.editor)                 # viewer id of a person from the other tenant
        assert api.execute("select count(*) as n from pulse.score").fetchone()["n"] == 0
        assert api.execute("select pulse.can_view_person(%s) as ok", (ea.editor,)).fetchone()["ok"] is False


def test_writes_with_the_first_tenants_id_fail(two_tenants, api, worker, ingest):
    ea, test = two_tenants
    attempts = [
        (worker, "insert into pulse.person (org_id, display_name, side) values (%s, 'Intruder', 'staff')"),
        (worker, "update pulse.person set display_name = 'x' where org_id = %s"),
        (api, "insert into pulse.correction (org_id, opened_by, target_type, target_ref, claim) "
              "values (%s, gen_random_uuid(), 'version', 'x', 'mine')"),
        (ingest, "insert into pulse.raw_inbox (org_id, source, source_ref, payload) values (%s, '/x', 'y', '{}')"),
    ]
    for conn, sql in attempts:
        with conn.transaction():
            set_tenant(conn, test.org)
            try:
                with conn.transaction():
                    cur = conn.execute(sql, (ea.org,))
                    assert cur.rowcount == 0, sql          # an UPDATE simply sees no rows
            except (psycopg.errors.InsufficientPrivilege, psycopg.errors.ForeignKeyViolation):
                pass


def test_resolve_route_cannot_hop_tenants(two_tenants, ingest, api):
    ea, test = two_tenants
    for conn in (ingest, api):
        with conn.transaction():
            set_tenant(conn, test.org)
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute("select pulse.resolve_route('device', %s)", (str(ea.device),))
        with conn.transaction():                                  # before a tenant is known, routing works
            org = conn.execute("select pulse.resolve_route('device', %s) as o", (str(ea.device),)).fetchone()["o"]
            assert org == ea.org
        with conn.transaction():
            assert conn.execute("select pulse.resolve_route('device', %s) as o",
                                (str(uuid.uuid4()),)).fetchone()["o"] is None


def test_runtime_roles_cannot_reach_routes_or_partitions(two_tenants, api, worker, ingest, privacy):
    for conn in (api, worker, ingest, privacy):
        for sql in ("select count(*) from pulse_route.route", "select count(*) from pulse.event_default",
                    "select count(*) from pulse.event_ephemeral_default"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute(sql)


def test_api_cannot_read_the_raw_log(two_tenants, api):
    ea, _ = two_tenants
    for table in ("pulse.event", "pulse.event_ephemeral", "pulse.raw_inbox"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, ea.org)
                api.execute(f"select 1 from {table} limit 1")


def test_person_first_visibility(two_tenants, api, worker):
    """Appendix A-tests T4: the person sees their scores; the manager only week-grain, enough, team-visible ones."""
    ea, _ = two_tenants
    with worker.transaction():
        set_tenant(worker, ea.org)
        for start, end, suff, vis in (("2026-10-05", "2026-10-05", "enough", "team"),
                                      ("2026-09-28", "2026-10-04", "thin", "team"),
                                      ("2026-10-05", "2026-10-11", "enough", "person")):
            worker.execute("""insert into pulse.score (org_id, subject_type, subject_id, metric, period_start,
                                                       period_end, value, sufficiency, explanation, model_name,
                                                       model_version, visibility)
                              values (%s, 'person', %s, 'm', %s, %s, 1, %s, '{}', 'x', '1', %s)""",
                           (ea.org, ea.editor, start, end, suff, vis))
    def visible(viewer):
        with api.transaction():
            set_tenant(api, ea.org, viewer)
            return api.execute("select count(*) as n from pulse.score where subject_type = 'person'").fetchone()["n"]
    assert visible(ea.editor) == 4          # all own scores
    assert visible(ea.manager) == 1         # only the week-grain, enough, team-visible one
    assert visible(ea.editor2) == 0         # a colleague sees none
    with pytest.raises(psycopg.errors.CheckViolation):
        with worker.transaction():
            set_tenant(worker, ea.org)
            worker.execute("""insert into pulse.score (org_id, subject_type, subject_id, metric, period_start,
                                                       period_end, sufficiency, explanation, model_name, model_version,
                                                       visibility)
                              values (%s, 'person', %s, 'm', '2026-10-05', '2026-10-11', 'enough', '{}', 'x', '1',
                                      'org')""", (ea.org, ea.editor))
