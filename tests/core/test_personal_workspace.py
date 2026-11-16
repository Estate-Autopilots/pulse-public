"""PERSONAL-WORKSPACE (1640): an organisation is a company or a personal workspace; a project is client delivery,
internal or personal. A personal workspace belongs to one account, is private (only its owner's seat), shows first in
the switcher as the account's own, and keeps personal projects only. Synthetic organisations and people only; nothing
is sent."""
import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_my_day import _account
from test_tasks_rt1 import as_, one


def _ensure(owner, account):
    with owner.transaction():
        return owner.execute("select pulse.personal_workspace_ensure(%s) o", (account,)).fetchone()["o"]


def _seat(owner, org, account):
    with owner.transaction():
        return owner.execute("select person_id from pulse_priv.account_member where member_org=%s and account_id=%s", (org, account)).fetchone()["person_id"]


def test_new_columns_and_functions_keep_tenant_rules(worker):
    # Columns only: no new table, so the tenant policies of pulse.org and pulse.work_project still decide who reads them.
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c
      where c.oid in ('pulse.org'::regclass,'pulse.work_project'::regclass) order by 1""").fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"]) for r in rows] == [("org", True, True), ("work_project", True, True)]


def test_an_account_gets_one_private_personal_workspace(api, worker, owner):
    w = build_world(worker, owner, api)
    account = _account(owner, (w.org, w.editor))
    mine = _ensure(owner, account)
    assert _ensure(owner, account) == mine, "made once; asking again returns the same one"
    me = _seat(owner, mine, account)
    with owner.transaction():
        set_tenant(owner, mine)
        o = owner.execute("select kind,personal_account,handle,status from pulse.org where id=%s", (mine,)).fetchone()
        seats = owner.execute("select count(*) n from pulse_priv.account_member where member_org=%s", (mine,)).fetchone()["n"]
        assert owner.execute("select count(*) n from pulse.notification where org_id=%s", (mine,)).fetchone()["n"] == 0
    assert (o["kind"], o["personal_account"], o["handle"], o["status"]) == ("personal", account, None, "active")
    assert seats == 1, "private: only its owner until they invite someone"
    # Inside it: personal, admin of it, no client sections.
    r = one(api, type("W", (), {"org": mine})(), me, "select pulse.org_kind() k, pulse.viewer_is('admin') a, (pulse.work_settings_get())->>'businessModel' m")
    assert (r["k"], r["a"], r["m"]) == ("personal", True, "internal")
    # The company stays a company, and the company's people cannot read the personal workspace.
    assert one(api, w, w.editor, "select pulse.org_kind() k")["k"] == "company"
    assert as_(api, w, w.lead, "select id from pulse.org where id=%s", (mine,)) == []
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert api.execute("select count(*) n from pulse.work_project where org_id=%s", (mine,)).fetchone()["n"] == 0


def test_the_switcher_lists_my_workspace_first_and_the_one_password_prompt_ignores_it(api, worker, owner):
    w = build_world(worker, owner, api)
    account = _account(owner, (w.org, w.editor))
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set password_hash=null where id=%s", (account,))
    mine = _ensure(owner, account)
    me = one(api, w, w.editor, "select pulse.account_me() a")["a"]
    assert me["orgs"][0]["id"] == str(mine) and me["orgs"][0]["mine"] is True and me["orgs"][0]["orgKind"] == "personal"
    assert me["personal"] == str(mine)
    assert [o["orgKind"] for o in me["orgs"][1:]] == ["company"]
    assert me["unify"] is False, "one company and my own workspace is not 'several workspaces'"


def test_the_signed_in_person_makes_their_own_on_first_open(api, worker, owner):
    w = build_world(worker, owner, api)
    account = _account(owner, (w.org, w.editor))
    made = one(api, w, w.editor, "select pulse.personal_workspace_mine() o")["o"]
    with owner.transaction():
        set_tenant(owner, made)
        assert owner.execute("select personal_account from pulse.org where id=%s", (made,)).fetchone()["personal_account"] == account
    assert one(api, w, w.editor, "select pulse.personal_workspace_mine() o")["o"] == made
    # A seat with no account cannot have one; the API role cannot make one for someone else.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.personal_workspace_mine()")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.personal_workspace_ensure(%s)", (account,))


def test_project_types_client_delivery_internal_personal(api, worker, owner):
    w = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership',current_date)", (w.org, w.editor))
    pid = one(api, w, w.editor, "select (pulse.work_project_save(null,'{\"type\":\"internal\",\"name\":\"Synthetic Office Move\"}'::jsonb))->>'id' id")["id"]
    t = lambda: one(api, w, w.editor, "select project_type t, kind k from pulse.work_project where project_id=%s", (pid,))  # noqa: E731
    assert (t()["t"], t()["k"]) == ("internal", "internal")
    # A company person marks it client delivery, then internal again, then personal; each is kept in its history.
    one(api, w, w.editor, "select pulse.work_project_type_set(%s,'client_delivery')", (pid,))
    assert (t()["t"], t()["k"]) == ("client_delivery", "fulfilment")
    one(api, w, w.editor, "select pulse.work_project_type_set(%s,'internal')", (pid,))
    assert (t()["t"], t()["k"]) == ("internal", "internal")
    one(api, w, w.editor, "select pulse.work_project_type_set(%s,'personal')", (pid,))
    assert t()["t"] == "personal"
    hist = as_(api, w, w.editor, "select new_value from pulse.record_change where entity_id=%s and field='project_type'", (pid,))
    assert sorted(h["new_value"] for h in hist) == ["client_delivery", "internal", "personal"]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.work_project_type_set(%s,'agency')", (pid,))


def test_a_personal_workspace_keeps_personal_projects_only(api, worker, owner):
    w = build_world(worker, owner, api)
    account = _account(owner, (w.org, w.editor))
    mine = _ensure(owner, account)
    me = _seat(owner, mine, account)
    pw = type("W", (), {"org": mine})()
    pid = one(api, pw, me, "select (pulse.work_project_save(null,'{\"type\":\"internal\",\"name\":\"Synthetic Flat Move\"}'::jsonb))->>'id' id")["id"]
    assert one(api, pw, me, "select project_type t from pulse.work_project where project_id=%s", (pid,))["t"] == "personal"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, pw, me, "select pulse.work_project_type_set(%s,'client_delivery')", (pid,))


def test_adopt_turns_a_one_person_org_into_its_owners_personal_workspace(api, worker, owner):
    solo = build_world(worker, owner, api)
    account = _account(owner, (solo.org, solo.editor))
    with owner.transaction():
        set_tenant(owner, solo.org)
        owner.execute("""insert into pulse.project(org_id,registry_no,name,title,kind,status)
          values(%s,(select coalesce(max(registry_no),0)+1 from pulse.project where org_id=%s),'Synthetic PR and Story','Synthetic PR and Story','client_work','active')""", (solo.org, solo.org))
    with owner.transaction():
        r = owner.execute("select pulse.personal_workspace_adopt(%s,%s) r", (solo.org, account)).fetchone()["r"]
        set_tenant(owner, solo.org)
        kinds = owner.execute("select distinct project_type from pulse.work_project where org_id=%s", (solo.org,)).fetchall()
        o = owner.execute("select kind,personal_account from pulse.org where id=%s", (solo.org,)).fetchone()
    assert r["projects"] >= 1 and [k["project_type"] for k in kinds] == ["personal"]
    assert (o["kind"], o["personal_account"]) == ("personal", account)
    assert _ensure(owner, account) == solo.org, "the adopted one is the account's personal workspace"
    # A company where other people sign in is never adopted.
    co = build_world(worker, owner, api)
    a1 = _account(owner, (co.org, co.editor))
    _account(owner, (co.org, co.editor2))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with owner.transaction():
            owner.execute("select pulse.personal_workspace_adopt(%s,%s)", (co.org, a1))


def test_no_definer_function_reaches_another_organisation(api, worker, owner):
    """Security review (7 Nov 2026): every SECURITY DEFINER function of 1640, used across organisations, is refused or
    sees only the caller's own organisation and account."""
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    for w in (a, b):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin',current_date),(%s,%s,'leadership',current_date) on conflict do nothing",
                          (w.org, w.editor, w.org, w.editor))
    acct_a, acct_b = _account(owner, (a.org, a.editor)), _account(owner, (b.org, b.editor))
    pid = one(api, a, a.editor, "select (pulse.work_project_save(null,'{\"type\":\"internal\",\"name\":\"Synthetic Org A Project\"}'::jsonb))->>'id' id")["id"]
    # work_project_type_set: B's admin cannot see or change A's project.
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, b, b.editor, "select pulse.work_project_type_set(%s,'personal')", (pid,))
    assert one(api, a, a.editor, "select project_type t from pulse.work_project where project_id=%s", (pid,))["t"] == "internal"
    # org_kind: each organisation reads its own kind only.
    with owner.transaction():
        mine_a = owner.execute("select pulse.personal_workspace_ensure(%s) o", (acct_a,)).fetchone()["o"]
    assert one(api, b, b.editor, "select pulse.org_kind() k")["k"] == "company"
    # personal_workspace_mine: B's person gets B's account's own workspace, never A's.
    made = one(api, b, b.editor, "select pulse.personal_workspace_mine() o")["o"]
    assert made != mine_a
    with owner.transaction():
        set_tenant(owner, made)
        assert owner.execute("select personal_account from pulse.org where id=%s", (made,)).fetchone()["personal_account"] == acct_b
    # personal_workspace_ensure / _adopt are the platform's tools only: the API role cannot call them at all.
    for sql, args in (("select pulse.personal_workspace_ensure(%s)", (acct_a,)), ("select pulse.personal_workspace_adopt(%s,%s)", (a.org, acct_b)),
                      ("select pulse.personal_workspace_adopt(%s,%s)", (mine_a, acct_b))):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, b, b.editor, sql, args)
    # The owner tool refuses to give A's workspace to B's account, or adopt A's company for an account with no seat there.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with owner.transaction():
            owner.execute("select pulse.personal_workspace_adopt(%s,%s)", (mine_a, acct_b))
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.UniqueViolation)):
        with owner.transaction():
            owner.execute("select pulse.personal_workspace_adopt(%s,%s)", (a.org, acct_b))
    stranger = _account(owner, (b.org, b.editor2))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with owner.transaction():
            owner.execute("select pulse.personal_workspace_adopt(%s,%s)", (a.org, stranger))
    # account_me in B lists B's account's seats only: not A's company, not A's workspace.
    me_b = one(api, b, b.editor, "select pulse.account_me() a")["a"]
    assert {o["id"] for o in me_b["orgs"]} == {str(b.org), str(made)}
    # Inside A's personal workspace nobody from B reads its rows.
    assert as_(api, b, b.editor, "select id from pulse.org where id=%s", (mine_a,)) == []
