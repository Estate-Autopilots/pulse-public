"""TASKS-3: the Work bugs the owner hit on 11 Oct 2026, reproduced in a browser and kept fixed, on a synthetic agency.
Synthetic tenants only."""
import json
import os
import subprocess
import uuid
from datetime import date
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from psycopg.types.json import Jsonb
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)
from test_work_structure import save_project
from test_work_domains import _seed_work_two

# Flows whose part of TASKS-3 has not landed yet (each part removes its own).
PENDING: set[str] = set()
BROWSER = pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")


def _seed_tasks3(api, worker, w):
    """UX-TASKS-2's synthetic agency, sign-ins for a few more people, and a twin record of Sana Khan (the real roster has
    such duplicates) so name matching is tested against it."""
    ids = _seed_work_two(api, worker, w)
    _tracker_history(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        people = {r["display_name"]: str(r["id"]) for r in worker.execute("select id,display_name from pulse.person where org_id=%s and side='staff'", (w.org,))}
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"outsider@{w.domain}", w.outsider))
        for key, name in (("dev", "Dev Panab"), ("sana", "Sana Khan")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"{key}@{w.domain}", people[name]))
        twin = uuid.uuid4()
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Sana Khan','staff')", (twin, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod) values(%s,%s,'Editor','tracker',77,'sana77x','Pod 1')", (w.org, twin))
    return {**ids, "sana": people["Sana Khan"], "ishaan": people["Ishaan Vivim"], "vikram": people["Vikram Seduh"], "twin": str(twin), "today": date.today().isoformat()}


def _config(value):
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


@BROWSER
def test_tasks3_flows_in_the_browser(worker, owner, api, team, tmp_path):
    w = team
    ids = _seed_tasks3(api, worker, w)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}", "TEST_DEV": f"dev@{w.domain}", "TEST_SANA": f"sana@{w.domain}",
           "TEST_IDS": json.dumps(ids), "PULSE_TASKS3_REPORT": str(tmp_path / "tasks3.json"), "TASKS3_SKIP": ",".join(sorted(PENDING))}
    p = subprocess.run(["node", "test/tasks3-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "tasks3.json").read_text()) if (tmp_path / "tasks3.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]


def test_twin_records_and_people_on_a_task(api, worker, team):
    """One record per person in pickers (the one people sign in with); a leader adds people to a task at once, a member
    can only invite someone outside their reach, and a watcher who is added becomes a collaborator."""
    w = team
    twin = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set display_name='Kabir Shah' where id=%s", (w.editor,))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Kabir  Shah','staff')", (twin, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod) values(%s,%s,'Editor','tracker',70,'kabir70','Pod 1')", (w.org, twin))
    people = {r["id"] for r in as_(api, w, w.manager, "select id from pulse.work_people()")}
    assert w.editor in people and twin not in people, "the twin without a sign-in is left out of pickers"
    t = new_task(api, w, w.editor, title="Cut the Lakeview teaser")
    # The doer (a member) cannot add someone outside their reach: they are invited instead.
    r = one(api, w, w.editor, "select pulse.work_task_people(%s,%s,'{}') r", (t, [w.outsider]))["r"]
    assert r == {"added": 0, "invited": 1, "removed": 0}
    # Leadership adds at once; a mentioned watcher who is added becomes a collaborator.
    one(api, w, w.manager, "select pulse.work_comment_add(%s,null,'Look at this',%s) id", (t, [w.editor2]))
    r = one(api, w, w.manager, "select pulse.work_task_people(%s,%s,'{}') r", (t, [w.editor2, w.outsider]))["r"]
    assert r["added"] == 2
    roles = {x["person_id"]: x["role"] for x in as_(api, w, w.manager, "select person_id,role from pulse.task_member where task_id=%s and removed_at is null", (t,))}
    assert roles == {w.editor2: "collaborator", w.outsider: "collaborator"}
    with worker.transaction():
        set_tenant(worker, w.org)
        told = worker.execute("select count(*) n from pulse.notification where person_id=%s and subject_id=%s and title like '%%added you%%'", (w.outsider, t)).fetchone()["n"]
    assert told == 1
    # Someone can take themselves off; a stranger cannot take others off.
    assert one(api, w, w.outsider, "select pulse.work_task_people(%s,'{}',%s) r", (t, [w.outsider]))["r"]["removed"] == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.work_task_people(%s,'{}',%s)", (t, [w.editor2]))


def test_delete_shows_what_is_connected_and_restores(api, worker, team):
    """Creator, admin or project owner deletes; the preview names subtasks, waiting tasks and files; the delete hides the
    task and its subtasks and frees what waited on it; restore brings it all back. No credit (INTEGRITY 0910)."""
    w = team
    pid = save_project(api, w, w.manager, name="Brand refresh", type="internal", ownerId=str(w.editor2))["id"]
    parent = new_task(api, w, w.editor, title="Duplicate: brochure retouch", projectId=pid)
    child = new_task(api, w, w.editor, title="Check the retouch", parentId=str(parent))
    waiting = new_task(api, w, w.editor, title="Print the brochure", assigneeId=str(w.editor))
    as_(api, w, w.editor, "select pulse.task_block(%s,%s,null)", (waiting, parent))
    as_(api, w, w.editor, "select pulse.task_proof_add(%s,'Draft',%s)", (parent, "https://example.test/draft"))
    done = new_task(api, w, w.editor, title="Retouch the cover", parentId=str(parent))
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (done,))
    as_(api, w, w.editor2, "select pulse.task_accept(%s,3,3)", (done,))
    p = one(api, w, w.editor, "select pulse.task_delete_preview(%s) r", (parent,))["r"]
    assert p["canDelete"] and len(p["subtasks"]) == 2 and [x["title"] for x in p["waiting"]] == ["Print the brochure"] and p["files"] == 1
    assert p["credits"] == []
    # Who may delete: the creator, an admin, the project's owner; not a colleague who only sees it.
    assert one(api, w, w.editor2, "select pulse.task_can_delete(%s) ok", (parent,))["ok"] is True
    assert one(api, w, w.lead, "select pulse.task_can_delete(%s) ok", (parent,))["ok"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.task_delete(%s,null)", (parent,))
    r = one(api, w, w.editor, "select pulse.task_delete(%s,'Made twice') r", (parent,))["r"]
    assert r["deleted"] == 3 and r["creditsTaken"] == 0
    assert as_(api, w, w.manager, "select id from pulse.task where id in (%s,%s,%s)", (parent, child, done)) == []
    assert one(api, w, w.editor, "select status,pulse.task_open_blockers(id) n from pulse.task where id=%s", (waiting,)) == {"status": "open", "n": 0}
    assert one(api, w, w.manager, "select count(*) n from pulse.work_credit where task_id=%s and reversed_at is null", (done,))["n"] == 0
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (child, Jsonb({"title": "Edited after delete"})))
    listed = as_(api, w, w.editor, "select id,subtasks from pulse.task_deleted_list()")
    assert listed == [{"id": parent, "subtasks": 2}], "the root is listed once, with its subtasks"
    assert as_(api, w, w.outsider, "select id from pulse.task_deleted_list()") == []
    restored = one(api, w, w.editor2, "select pulse.task_restore(%s) r", (parent,))["r"]
    assert restored["restored"] == 3
    assert {x["id"] for x in as_(api, w, w.manager, "select id from pulse.task where id in (%s,%s,%s)", (parent, child, done))} == {parent, child, done}
    assert one(api, w, w.manager, "select count(*) n from pulse.work_credit where task_id=%s and reversed_at is null", (done,))["n"] == 0, "restore brings no credit back"
    assert one(api, w, w.editor, "select pulse.task_open_blockers(%s) n", (waiting,))["n"] == 1, "it waits again"
    with worker.transaction():
        set_tenant(worker, w.org)
        actions = [x["action"] for x in worker.execute("select action from pulse.audit_event where resource='task' and resource_id=%s and action in ('delete','restore') order by at", (str(parent),)).fetchall()]
        events = [x["kind"] for x in worker.execute("select kind from pulse.task_event where task_id=%s order by at", (parent,)).fetchall()]
    assert actions[-2:] == ["delete", "restore"] and events[-2:] == ["deleted", "restored"]
    # Thirty days on, it can no longer be restored.
    one(api, w, w.editor, "select pulse.task_delete(%s,null) r", (child,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.task set deleted_at=now()-interval '31 days' where id=%s", (child,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.task_restore(%s)", (child,))


def test_extra_work_is_credited_with_its_reasons(api, worker, team):
    """Accepted work outside the person's domains, claimed from the pool or taken on by themselves counts as extra, with
    the domain it fell in; work inside a domain is not. (No points since INTEGRITY 0910: one per accepted task.)"""
    w = team
    pid = save_project(api, w, w.manager, name="Pod 1 client work", type="internal", pod="Pod 1")["id"]
    dom = one(api, w, w.lead, "select pulse.work_domain_propose(%s,%s) id", (w.editor, Jsonb({"title": "Video editing for Pod 1", "categories": ["video_edit"], "pod": "Pod 1", "basis": "policy"})))["id"]
    inside = new_task(api, w, w.editor2, title="Edit the Northstar walkthrough video", assigneeId=str(w.editor), projectId=pid, category="video_edit")
    pooled = new_task(api, w, w.lead, title="Refresh the agency pitch deck", pool={"scope": "company"})
    as_(api, w, w.editor, "select pulse.work_pool_claim(%s)", (pooled,))
    taken = new_task(api, w, w.editor2, title="Write the Lakeview captions", assigneeId=None)
    as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (taken, Jsonb({"assigneeId": str(w.editor)})))
    for t, reviewer in ((inside, w.editor2), (pooled, w.lead), (taken, w.editor2)):
        as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (t,))
        as_(api, w, reviewer, "select pulse.task_accept(%s,3,3)", (t,))
    got = {t: (sorted(r["extra"]), r["domain_id"]) for t in (inside, pooled, taken) for r in as_(api, w, w.manager, "select extra,domain_id from pulse.work_credit_kind(%s,%s)", (t, w.editor))}
    assert as_(api, w, w.manager, "select task_id from pulse.work_credit where person_id=%s", (w.editor,)) == []
    assert got[inside] == ([], dom)
    assert got[pooled] == (["outside_domains", "pool"], None)
    assert got[taken] == (["outside_domains", "volunteered"], None)


def test_reporting_lines_set_by_hr_and_seen_by_managers(api, worker, team):
    """HR sets a line and a pod head (audited, no loops); a manager and the manager above them see the report's work;
    proposals change nothing until HR confirms one."""
    w = team
    t = new_task(api, w, w.outsider, title="Pod Two edit")
    assert as_(api, w, w.editor, "select id from pulse.task where id=%s", (t,)) == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.org_line_set(%s,%s)", (w.outsider, w.editor))
    as_(api, w, w.lead, "select pulse.org_line_set(%s,%s)", (w.outsider, w.editor))
    as_(api, w, w.lead, "select pulse.org_line_set(%s,%s)", (w.editor, w.editor2))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.lead, "select pulse.org_line_set(%s,%s)", (w.editor2, w.outsider))  # a loop
    assert one(api, w, w.editor, "select pulse.manages(%s) ok", (w.outsider,))["ok"] is True
    assert one(api, w, w.editor2, "select pulse.manages(%s) ok", (w.outsider,))["ok"] is True, "the manager's manager too"
    assert [r["id"] for r in as_(api, w, w.editor, "select id from pulse.task where id=%s", (t,))] == [t]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.audit_event where action='reporting_line' and resource_id=%s", (str(w.outsider),)).fetchone()["n"] == 1
    # A proposal is only a proposal; confirming applies it.
    n = one(api, w, w.lead, "select pulse.org_line_propose(%s) n", (Jsonb([{"kind": "pod_head", "personId": str(w.outsider), "pod": "Pod 2", "confidence": 0.7, "evidence": ["PGS on 40 projects"]}]),))["n"]
    assert n == 1 and one(api, w, w.lead, "select count(*) n from pulse.hr_pod where name='Pod 2'", ())["n"] == 0
    pid = one(api, w, w.lead, "select id from pulse.org_line_proposal where status='pending'", ())["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.org_line_decide(%s,true,null)", (pid,))
    as_(api, w, w.manager, "select pulse.org_line_decide(%s,true,null)", (pid,))
    assert one(api, w, w.lead, "select head_id from pulse.hr_pod where name='Pod 2'", ())["head_id"] == w.outsider


def _tracker_history(worker, w):
    """Synthetic tracker rows: four past client packages that each went through the usual steps."""
    from datetime import date, timedelta
    with worker.transaction():
        set_tenant(worker, w.org)
        start = date.today() - timedelta(days=200)
        for k, key in enumerate(("Alpha Homes", "Beta Realty", "Gamma Estates", "Delta Towers")):
            for i, step in enumerate(("Onboarding", "Scripting", "Video shoot", "VOV edit")):
                worker.execute("insert into pulse.task(org_id,title,status,source,project_key,deliverable_type,work_on) values(%s,%s,'done','imported',%s,%s,%s)",
                               (w.org, f"{step} — {key}", key, step, start + timedelta(days=k * 30 + i * 3)))
        worker.execute("insert into pulse.task(org_id,title,status,source,project_key,deliverable_type,work_on) values(%s,'Scripting — Epsilon','unknown','imported','Epsilon','Scripting',current_date-3)", (w.org,))


def test_pool_proposals_wait_for_leadership(api, worker, team):
    """Pulse proposes pool work in batches from Drive, the usual tracker steps and unowned tracker tasks; nothing reaches
    the pool until leadership approves; taken-out items stay out; approving makes the tasks (with no value: INTEGRITY 0910)."""
    w = team
    pkg = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,start_month,storage_root) values(%s,%s,%s,'Northstar Heights','Northstar Heights',date_trunc('month',now())::date,'index-path:Client Video Shoot/x/Northstar')",
                       (pkg, w.org, no))
    _tracker_history(worker, w)
    batch = {"source": "steps", "title": "Usual steps", "summary": "From the trackers", "items": [
        {"title": "Scripting for Northstar Heights", "category": None, "projectId": str(pkg), "scope": "company", "valuePoints": 8, "evidence": ["4 of 4 tracker packages had Scripting"]},
        {"title": "Video shoot for Northstar Heights", "category": None, "projectId": str(pkg), "scope": "pod", "ref": "Pod 1", "valuePoints": 12, "evidence": ["4 of 4"]}]}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.pool_batch_save(%s)", (Jsonb(batch),))  # HR reads proposals; leadership decides
    bid = one(api, w, w.manager, "select pulse.pool_batch_save(%s) id", (Jsonb(batch),))["id"]
    assert one(api, w, w.manager, "select count(*) n from pulse.task where pool_scope is not null", ())["n"] == 0, "nothing published by itself"
    items = as_(api, w, w.manager, "select id,title from pulse.pool_proposal where batch_id=%s order by position", (bid,))
    as_(api, w, w.manager, "select pulse.pool_proposal_edit(%s,%s)", (items[1]["id"], Jsonb({"removed": True})))
    as_(api, w, w.manager, "select pulse.pool_proposal_edit(%s,%s)", (items[0]["id"], Jsonb({"valuePoints": 10})))
    r = one(api, w, w.manager, "select pulse.pool_batch_approve(%s) r", (bid,))["r"]
    assert r["made"] == 1
    made = as_(api, w, w.manager, "select title,pool_scope,value_points,project_id from pulse.task where pool_scope is not null", ())
    assert made == [{"title": "Scripting for Northstar Heights", "pool_scope": "company", "value_points": None, "project_id": pkg}]
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.manager, "select pulse.pool_batch_approve(%s)", (bid,))
    # Unowned tracker tasks are pooled as they are.
    loose = one(api, w, w.manager, "select id from pulse.task where title='Scripting — Epsilon'", ())["id"]
    b2 = one(api, w, w.manager, "select pulse.pool_batch_save(%s) id", (Jsonb({"source": "tracker", "title": "From the trackers", "items": [
        {"title": "1 unowned scripting task", "scope": "company", "taskIds": [str(loose)], "evidence": []}]}),))["id"]
    assert one(api, w, w.manager, "select pulse.pool_batch_approve(%s) r", (b2,))["r"]["pooled"] == 1
    assert one(api, w, w.manager, "select pool_scope from pulse.task where id=%s", (loose,))["pool_scope"] == "company"
