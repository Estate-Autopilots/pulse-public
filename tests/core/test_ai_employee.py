"""0660: permanent AI employee IDs, required ownership, lanes and scoped reads. Synthetic only."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import psycopg
import pytest
from conftest import ADMIN_URL, MODE, _connect
from helpers import build_world, new_code
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb
from pulse_sdk import migrate
from pulse_sdk.db import set_tenant
from test_agent_coworkers import agent_one, ask, claim, lead, make_agent, one, owner_sql
from test_hr_suite import _staff
from test_tasks_rt1 import as_, team  # noqa: F401


def create(api, w, **fields):
    return one(api, w, w.manager, "select pulse.agent_create(%s) id", (Jsonb({
        "name": "Studio AI", "username": "studio-ai", "title": "Checks drafts",
        "ownerId": str(w.manager), "lane": "quick", **fields}),))["id"]


def profile(api, w, who, agent):
    return one(api, w, who, "select pulse.agent_profile(%s) p", (agent,))["p"]


def test_ids_are_company_local_stable_never_reused_and_grow_past_999(api, worker, owner, team):  # noqa: F811
    for w in (team, build_world(worker, owner, api)):
        if w is not team:
            _staff(worker, w)
        aid = create(api, w)
        eid = f"{w.code}-AI-001"
        assert profile(api, w, w.manager, aid)["employeeId"] == eid
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.person set display_name='Renamed AI' where id=%s", (aid,))
            worker.execute("update pulse.org set code=%s where id=%s", (new_code(), w.org))
        owner_sql(owner, w, "update pulse.agent_member set title='Reviews drafts' where person_id=%s", (aid,))
        for on in (False, True):
            as_(api, w, w.manager, "select pulse.agent_switch(%s,%s)", (aid, on))
            assert profile(api, w, w.manager, aid)["employeeId"] == eid
        for field, value in (("employee_no", 7), ("employee_id", "XX-AI-007"), ("org_id", uuid.uuid4())):
            with pytest.raises(psycopg.errors.InsufficientPrivilege, match="permanent"):
                owner_sql(owner, w, f"update pulse.agent_member set {field}=%s where person_id=%s", (value, aid))
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="deleted"):
            owner_sql(owner, w, "delete from pulse.agent_member where person_id=%s", (aid,))
        as_(api, w, w.manager, "select pulse.agent_switch(%s,false)", (aid,))
        second = create(api, w, username="second-ai")
        assert profile(api, w, w.manager, second)["employeeId"].endswith("-AI-002")
        # An existing large company sequence must grow, rather than lpad truncating 1000 to 100.
        owner_sql(owner, w, """with p as (insert into pulse.person(org_id,display_name,side)
          values(%s,'Legacy AI','agent') returning id)
          insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id)
          select %s,id,%s,999,'OLD-AI-999' from p""", (w.org, w.org, w.manager))
        thousand = create(api, w, username="thousand-ai")
        assert profile(api, w, w.manager, thousand)["employeeId"].endswith("-AI-1000")


def test_required_fields_and_foreign_inactive_or_nonstaff_owner_are_refused(api, worker, owner, team):  # noqa: F811
    foreign = build_world(worker, owner, api)
    for field in ("ownerId", "title", "lane"):
        for value in (None, ""):
            with pytest.raises(psycopg.errors.InvalidParameterValue):
                create(api, team, **{field: value})
        payload = {"name": "Missing field", "username": "missing-ai", "title": "Reviews", "ownerId": str(team.manager), "lane": "quick"}
        del payload[field]
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            as_(api, team, team.manager, "select pulse.agent_create(%s)", (Jsonb(payload),))
    for fields in ({"ownerId": str(foreign.manager)}, {"title": " "}, {"title": "x" * 121}, {"lane": "slow"}):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            create(api, team, **fields)
    with worker.transaction():
        set_tenant(worker, team.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (team.editor,))
    aid = create(api, team)
    for pid in (team.editor, aid):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            create(api, team, username="invalid-owner", ownerId=str(pid))


def test_concurrent_creates_allocate_distinct_numbers(api, team):  # noqa: F811
    start = Barrier(2)

    def concurrent(n):
        with _connect("api") as conn:
            start.wait(timeout=10)
            return create(conn, team, username=f"concurrent-{n}")

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(concurrent, (1, 2)))
    assert {profile(api, team, team.manager, aid)["employeeId"] for aid in ids} == {
        f"{team.code}-AI-001", f"{team.code}-AI-002"}


def test_scoped_profile_list_count_and_lane_dispatch(api, worker, owner, team):  # noqa: F811
    w = team
    aid, _ = make_agent(api, w, lane="thinking", runtime="synthetic-runtime")
    assert profile(api, w, w.editor, aid) is None
    lead(worker, w, w.editor2)
    p = profile(api, w, w.editor2, aid)
    assert p == {"id": str(aid), "employeeId": f"{w.code}-AI-001", "name": "Pulse Ceo", "orgName": f"Synthetic {w.code}",
                 "orgCode": w.code, "owner": {"id": str(w.manager), "name": "Pod Manager"}, "title": "CEO agent",
                 "lane": "thinking", "model": "synthetic-runtime", "status": "on", "pausedReason": None,
                 "dailyBudget": 160000, "usedToday": 0}
    listed = one(api, w, w.manager, "select pulse.agent_list() a")["a"][0]
    assert {k: listed[k] for k in ("employeeId", "lane", "ownerId", "ownerName")} == {
        "employeeId": p["employeeId"], "lane": "thinking", "ownerId": str(w.manager), "ownerName": "Pod Manager"}
    cid = one(api, w, w.manager, "select pulse.chat_group_create('Review group',%s) id", ([w.editor],))["id"]
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (cid, aid))
    assert profile(api, w, w.editor, aid) == p
    assert profile(api, w, w.outsider, aid) is None
    assert agent_one(api, w, aid, "select pulse.agent_profile(%s) p", (aid,))["p"] is None  # AI keys never read profiles
    foreign = build_world(worker, owner, api)
    _staff(worker, foreign)
    assert profile(api, foreign, foreign.manager, aid) is None
    assert one(api, foreign, foreign.manager, "select pulse.agent_count() n")["n"] == 0
    for supplied, expected in ((None, "thinking"), ("", "thinking"), ("quick", "quick")):
        ask(api, w, w.manager, cid, "Review @pulse-ceo")
        event = claim(api, w, aid)[0]
        assert event["lane"] == "thinking"
        run = agent_one(api, w, aid, "select pulse.agent_dispatch(%s,%s,%s,'synthetic') r",
                        (event["event"]["id"], event["leaseToken"], supplied))["r"]
        assert run["status"] == "dispatched"
        assert owner_sql(owner, w, "select lane from pulse.agent_run where id=%s", (run["runId"],)) == [{"lane": expected}]
        agent_one(api, w, aid, "select pulse.agent_run_finish(%s,'done',100,1,null)", (run["runId"],))
    assert profile(api, w, w.manager, aid)["usedToday"] == 300
    assert one(api, w, w.manager, "select pulse.agent_count() n")["n"] == 1  # humans never counted
    owner_sql(owner, w, "update pulse.agent_member set disabled_at=now(),paused_reason='budget' where person_id=%s", (aid,))
    assert profile(api, w, w.manager, aid)["status"] == "paused"
    as_(api, w, w.manager, "select pulse.agent_switch(%s,true)", (aid,))
    as_(api, w, w.manager, "select pulse.agent_switch(%s,false)", (aid,))
    assert profile(api, w, w.manager, aid)["status"] == "off"
    assert one(api, w, w.manager, "select pulse.agent_count() n")["n"] == 0
    as_(api, w, w.manager, "select pulse.agent_switch(%s,true)", (aid,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (aid,))
    assert one(api, w, w.manager, "select pulse.agent_count() n")["n"] == 0
    owner_sql(owner, w, "update pulse.agent_member set paused_reason='budget' where person_id=%s", (aid,))
    assert profile(api, w, w.manager, aid)["status"] == "off"  # deactivated outranks paused


def test_populated_upgrade_backfills_order_owners_and_fails_clearly_without_owner(admin, tmp_path):
    if MODE["value"] != "superuser":
        pytest.skip("isolated upgrade database needs the scratch superuser")
    dbname = "pulse_ci_ai_upgrade_" + uuid.uuid4().hex
    admin.execute(sql.SQL("create database {}").format(sql.Identifier(dbname)))
    try:
        with psycopg.connect(make_conninfo(ADMIN_URL, dbname=dbname), autocommit=True) as conn:
            migrate.bootstrap_scratch(conn)
            directory = tmp_path / "migrations"
            directory.mkdir()
            target = None
            for version, path in migrate.migration_files():
                if version < "0660":
                    (directory / path.name).write_text(path.read_text())
                elif version == "0660":
                    target = path
            assert target is not None
            migrate.migrate(conn, directory, owner="pulse_owner", verbose=False)
            tenants = []
            for code in ("YA", "YB"):
                org, admin_id, creator, explicit = [uuid.uuid4() for _ in range(4)]
                ids = sorted([uuid.uuid4() for _ in range(3)])
                with conn.transaction():
                    conn.execute("set local role pulse_owner")
                    set_tenant(conn, org)
                    conn.execute("insert into pulse.org(id,slug,name,code) values(%s,%s,'Synthetic upgrade',%s)", (org, str(org), code))
                    for pid in (admin_id, creator, explicit):
                        conn.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Staff','staff')", (pid, org))
                    conn.execute("update pulse.person set created_at=now()-interval '3 days' where id=%s", (admin_id,))
                    conn.execute("update pulse.person set created_at=now()-interval '4 days' where id=%s", (explicit,))
                    for pid in (admin_id, creator, explicit):
                        conn.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from,valid_to)
                          values(%s,%s,'admin',current_date-10,case when %s then current_date-1 end)""", (org, pid, pid == explicit))
                    # Reverse insertion order, with a timestamp tie resolved by person_id.
                    for n in (2, 1, 0):
                        conn.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Legacy AI','agent')", (ids[n], org))
                        conn.execute("""insert into pulse.agent_member(org_id,person_id,owner_person_id,created_by,created_at)
                          values(%s,%s,%s,%s,now()-make_interval(days=>%s))""",
                                     (org, ids[n], explicit if n == 0 else None, creator if n == 1 else None, 2 if n < 2 else 1))
                tenants.append((org, code, ids, [explicit, creator, admin_id]))
            with conn.transaction():
                conn.execute("set local role pulse_owner")
                assert conn.execute("select count(*) from pulse.agent_member").fetchone()[0] == 0
            source = migrate.up_section(target.read_text())
            # Remove fallback admins, so one legacy row cannot acquire an owner.
            conn.execute("delete from pulse.role_assignment where org_id=%s", (tenants[0][0],))
            with pytest.raises(psycopg.errors.RaiseException, match="owner backfill failed"), conn.transaction():
                conn.execute("set local role pulse_owner")
                conn.execute(source)
            conn.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin',current_date)",
                         (tenants[0][0], tenants[0][3][2]))
            (directory / target.name).write_text(target.read_text())
            assert migrate.migrate(conn, directory, owner="pulse_owner", verbose=False) == ["0660"]
            for org, code, ids, owners in tenants:
                with conn.transaction():
                    conn.execute("set local role pulse_owner")
                    set_tenant(conn, org)
                    rows = conn.execute("select person_id,employee_no,employee_id,owner_person_id,lane from pulse.agent_member order by employee_no").fetchall()
                    assert rows == [(pid, n, f"{code}-AI-{n:03}", own, "quick") for n, (pid, own) in enumerate(zip(ids, owners), 1)]
    finally:
        admin.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(dbname)))
