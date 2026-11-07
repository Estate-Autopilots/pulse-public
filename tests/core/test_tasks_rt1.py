"""RT1 tasks, outcome-based work mode and protected compensation, against row-level security. Synthetic tenants only."""
import json
import os
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff


def as_(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute(sql, args).fetchall()


def one(api, w, who, sql, args=()):
    rows = as_(api, w, who, sql, args)
    return rows[0] if rows else None


@pytest.fixture
def team(worker, owner, api):
    """Pod 1: editor (member) and editor2 (pod head). Pod 2: an outsider. lead is HR, manager is an admin."""
    w = build_world(worker, owner, api)
    _staff(worker, w)
    w.outsider = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Pod Two Outsider','staff')", (w.outsider, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod) values(%s,%s,'Editor','test',9,'outsider9','Pod 2')", (w.org, w.outsider))
        worker.execute("insert into pulse.unit(org_id,kind,name) values(%s,'pod','Pod 2')", (w.org,))
        worker.execute("update pulse.people_profile set pod='Pod 1' where person_id in (%s,%s)", (w.editor, w.editor2))
        # The Pod 1 unit roles from the world builder would make pgs/head_pgs managers too; this team uses pod heads only.
        worker.execute("update pulse.role_assignment set valid_to='2026-01-02' where org_id=%s and role_key in ('pgs','head_pgs')", (w.org,))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_pod_set('Pod 1',%s,%s)", (w.editor2, [w.editor, w.editor2]))
    return w


def new_task(api, w, who, **fields):
    return one(api, w, who, "select pulse.task_save(null,%s) id", (Jsonb(fields),))["id"]


def notes(worker, w, person, kind):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select title,href,subject_id from pulse.notification where person_id=%s and event_type=%s order by created_at", (person, kind)).fetchall()


def test_take_give_and_pod_rules(api, worker, team):
    w = team
    mine = new_task(api, w, w.editor, title="Fix login on phone")
    row = one(api, w, w.editor, "select assignee_person_id,owner_id,review_owner_id,status,created_by from pulse.task where id=%s", (mine,))
    # Self-assigned by default; the reviewer defaults to the pod head.
    assert row["assignee_person_id"] == w.editor == row["owner_id"] and row["review_owner_id"] == w.editor2 and row["status"] == "open"
    # A member cannot give work to a colleague or to another pod; a pod head gives inside the pod; HR gives to anyone.
    for target in (w.editor2, w.outsider):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (mine, Jsonb({"assigneeId": str(target)})))
    head = new_task(api, w, w.editor2, title="Cut the reel", assigneeId=str(w.editor))
    assert one(api, w, w.editor, "select assignee_person_id from pulse.task where id=%s", (head,))["assignee_person_id"] == w.editor
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        new_task(api, w, w.editor2, title="Outside my pod", assigneeId=str(w.outsider))
    hr_task = new_task(api, w, w.lead, title="Confirm policy items", assigneeId=str(w.outsider))
    # Assigning someone else notifies them; taking a task yourself notifies nobody.
    assert [n["subject_id"] for n in notes(worker, w, w.outsider, "task.assigned")] == [hr_task]
    open_task = new_task(api, w, w.editor2, title="Anyone can take this", assigneeId=None)
    as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (open_task, Jsonb({"assigneeId": str(w.editor)})))
    assert all(n["subject_id"] != open_task for n in notes(worker, w, w.editor, "task.assigned"))
    # The outsider sees their own task but not Pod 1's work; the pod head sees the pod.
    assert one(api, w, w.outsider, "select count(*)::int n from pulse.task where id in (%s,%s)", (mine, head))["n"] == 0
    assert one(api, w, w.editor2, "select count(*)::int n from pulse.task where id in (%s,%s)", (mine, head))["n"] == 2
    # Subtasks nest to any depth but never under themselves.
    child = new_task(api, w, w.editor, title="Repro on Android", parentId=str(mine))
    grandchild = new_task(api, w, w.editor, title="Capture logs", parentId=str(child))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (mine, Jsonb({"parentId": str(grandchild)})))


def test_done_accept_points_and_proof(api, worker, team):
    w = team
    t = new_task(api, w, w.editor, title="Ship the brochure")
    as_(api, w, w.editor, "select pulse.task_move(%s,'in_progress')", (t,))
    r = one(api, w, w.editor, "select pulse.task_move(%s,'done') r", (t,))["r"]
    assert r["status"] == "done"
    # The reviewer (pod head) is asked to accept, with a one-tap link to the task.
    done = notes(worker, w, w.editor2, "task.done")
    assert done and done[-1]["href"] == f"/tasks/{t}"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_accept(%s,3,4,null)", (t,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor2, "select pulse.task_accept(%s,9,4,null)", (t,))
    # A project that requires proof refuses acceptance until a link or file is attached.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set requires_proof=true where id=%s", (w.project,))
    as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (t, Jsonb({"projectId": str(w.project)})))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="needs proof"):
        as_(api, w, w.editor2, "select pulse.task_accept(%s,3,4,null)", (t,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.task_proof_add(%s,'Drive','not a link')", (t,))
    as_(api, w, w.editor, "select pulse.task_proof_add(%s,'Final PDF','https://drive.google.com/file/d/synthetic/view')", (t,))
    file_proof = one(api, w, w.editor, "select pulse.task_proof_add(%s,'Screenshot',null,%s,'shot.png','image/png') id", (t, b"\x89PNG synthetic"))["id"]
    assert one(api, w, w.editor2, "select name,mime from pulse.task_proof_read(%s)", (file_proof,))["mime"] == "image/png"
    assert as_(api, w, w.outsider, "select id from pulse.task_proof where task_id=%s", (t,)) == []
    r = one(api, w, w.editor2, "select pulse.task_accept(%s,3,4,'Brochure live for the launch') r", (t,))["r"]
    assert r == {"status": "accepted", "points": 12}
    row = one(api, w, w.editor, "select status,effort,impact,value_note,accepted_by from pulse.task where id=%s", (t,))
    assert (row["status"], row["effort"] * row["impact"], row["accepted_by"]) == ("accepted", 12, w.editor2)
    assert notes(worker, w, w.editor, "task.accepted")[-1]["title"].endswith("12 points")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.task_proof_remove(%s)", (file_proof,))
    events = [e["kind"] for e in as_(api, w, w.editor, "select kind from pulse.task_event where task_id=%s order by at", (t,))]
    assert events[0] == "created" and "accepted" in events and "proof" in events


def test_blockers_unblock_and_notifications(api, worker, team):
    w = team
    waiting = new_task(api, w, w.editor, title="Publish the launch film")
    blocker = new_task(api, w, w.lead, title="Approve the music licence", assigneeId=str(w.outsider))
    # HR links them (a member blocks only on tasks they can see, or on a new task for someone they may give work to).
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.task_block(%s,%s)", (waiting, blocker))
    lid = one(api, w, w.lead, "select pulse.task_block(%s,%s,'needs the licence') id", (waiting, blocker))["id"]
    assert lid
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (waiting,))["status"] == "blocked"
    # The waiting person sees what it waits on and who owns it, although that task sits in another pod.
    seen = one(api, w, w.editor, "select t.title,p.display_name from pulse.task t join pulse.person p on p.id=t.assignee_person_id where t.id=%s", (blocker,))
    assert seen == {"title": "Approve the music licence", "display_name": "Pod Two Outsider"}
    assert notes(worker, w, w.outsider, "task.blocked")[-1]["subject_id"] == blocker
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="wait on each other"):
        as_(api, w, w.outsider, "select pulse.task_block(%s,%s)", (blocker, waiting))
    # Finishing the blocker releases the waiting task and tells its owner.
    as_(api, w, w.outsider, "select pulse.task_move(%s,'done')", (blocker,))
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (waiting,))["status"] == "open"
    assert notes(worker, w, w.editor, "task.unblocked")[-1]["subject_id"] == waiting
    # One tap to unblock: the blocker's owner may clear the link; leaving Blocked by hand clears every link.
    second = new_task(api, w, w.lead, title="Share bank statement", assigneeId=str(w.outsider))
    as_(api, w, w.lead, "select pulse.task_block(%s,%s)", (waiting, second))
    assert as_(api, w, w.outsider, "select pulse.task_unblock(%s,%s) n", (waiting, second))[0]["n"] == 1
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (waiting,))["status"] == "open"
    third = new_task(api, w, w.editor, title="Book the studio")
    as_(api, w, w.editor, "select pulse.task_block(%s,%s)", (waiting, third))
    as_(api, w, w.editor, "select pulse.task_move(%s,'in_progress')", (waiting,))
    assert one(api, w, w.editor, "select pulse.task_open_blockers(%s) n", (waiting,))["n"] == 0
    # Nothing is deleted: cleared links stay as history.
    links = one(api, w, w.editor, "select count(*)::int n,count(*) filter(where cleared_at is null)::int open from pulse.task_link where task_id=%s", (waiting,))
    assert links == {"n": 3, "open": 0}


def test_due_soon_and_time_from_work(api, worker, team):
    w = team
    soon = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    t = new_task(api, w, w.editor2, title="Send the deck", assigneeId=str(w.editor), dueAt=soon)
    new_task(api, w, w.editor2, title="Later deck", assigneeId=str(w.editor), dueAt=(datetime.now(timezone.utc) + timedelta(days=3)).isoformat())
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.task_due_tick() n").fetchone()["n"] == 1
        assert worker.execute("select pulse.task_due_tick() n").fetchone()["n"] == 0
    assert notes(worker, w, w.editor, "task.due_soon")[-1]["subject_id"] == t
    e = one(api, w, w.editor, "select pulse.time_log(%s) id", (Jsonb({"taskId": str(t), "date": "2026-10-09", "minutes": 90, "note": "deck"}),))["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        p = worker.execute("select pulse.time_propose(%s,'2026-10-08',45,'commit','synthetic:commit:1','3 commits',%s) id", (w.editor, t)).fetchone()["id"]
        assert worker.execute("select pulse.time_propose(%s,'2026-10-08',45,'commit','synthetic:commit:1','again',%s) id", (w.editor, t)).fetchone()["id"] is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.time_decide(%s,'confirm',null)", (p,))
    as_(api, w, w.editor, "select pulse.time_decide(%s,'confirm',30)", (p,))
    rows = as_(api, w, w.editor, "select id,minutes,status from pulse.time_entry where person_id=%s order by minutes", (w.editor,))
    assert [(r["minutes"], r["status"]) for r in rows] == [(30, "confirmed"), (90, "confirmed")] and e in [r["id"] for r in rows]
    assert as_(api, w, w.outsider, "select id from pulse.time_entry where person_id=%s", (w.editor,)) == []


def test_outcome_mode_and_protected_compensation(api, worker, owner, team):
    w = team
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.work_terms_set(%s,%s)", (w.editor, Jsonb({"workMode": "outcome"})))
    as_(api, w, w.lead, "select pulse.work_terms_set(%s,%s)", (w.editor, Jsonb({"workMode": "outcome", "roleStatus": "Synthetic trial", "weeklyHoursMin": "15", "weeklyHoursMax": "20", "otherRoles": ["Synthetic side role"]})))
    assert one(api, w, w.editor, "select pulse.work_mode(%s) m", (w.editor,))["m"] == "outcome"
    assert as_(api, w, w.outsider, "select person_id from pulse.person_work_terms where person_id=%s", (w.editor,)) == []
    # R19b late and half-day rules do not apply to outcome-based people.
    with worker.transaction():
        set_tenant(worker, w.org)
        for who in (w.editor, w.editor2):
            worker.execute("""insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at,late_minutes)
              values(%s,%s,'2026-10-07','2026-10-07 06:00+00','2026-10-07 07:00+00',95)""", (w.org, who))
    days = as_(api, w, w.lead, "select day,late,half_day from pulse.hr_rule_days(%s,'2026-10-01','2026-10-09')", (w.editor,))
    assert days and not any(d["late"] or d["half_day"] for d in days)
    # The same late arrival still counts for someone on a shift.
    assert any(d["late"] for d in as_(api, w, w.lead, "select late from pulse.hr_rule_days(%s,'2026-10-01','2026-10-09')", (w.editor2,)))
    # Compensation terms sit in the protected salary area: only HR with the salary permission reads them, and each read is logged.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis,terms_status,terms_note)
          values(%s,%s,'2026-10-01','monthly',12345,'synthetic-terms','Synthetic terms','Compensation','Synthetic proposal','proposed','Pending acceptance')""", (w.org, w.editor))
        worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,'hr.salary.read','synthetic test')", (w.org, w.lead))
        doc = worker.execute("""insert into pulse_priv.hr_file(org_id,person_id,doc_kind,title,name,mime,bytes,sha256,source_key)
          values(%s,%s,'role_terms','Synthetic role terms','terms.pdf','application/pdf','%%PDF synthetic','x','synthetic:terms') returning id""", (w.org, w.editor)).fetchone()["id"]
    rows = one(api, w, w.lead, "select pulse.hr_salary_components_read(%s) r", (w.editor,))["r"]
    assert rows[0]["amount"] == 12345 and rows[0]["termsStatus"] == "proposed"
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*)::int n from privacy.access_log where subject_person_id=%s and resource='hr.salary'", (w.editor,)).fetchone()["n"] >= 1
    for who in (w.manager, w.editor2, w.editor, w.outsider):   # an admin without the permission, the pod head, the person, a colleague
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.hr_salary_components_read(%s)", (w.editor,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select amount from pulse_priv.hr_compensation")
    # Task views never carry amounts.
    t = new_task(api, w, w.editor, title="Decide on the role offer")
    assert "12345" not in json.dumps(as_(api, w, w.lead, "select * from pulse.task where id=%s", (t,)), default=str)
    # Protected documents: the person and HR with the documents permission; not the pod head, not an admin without it.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,'hr.documents.read','synthetic test')", (w.org, w.lead))
        worker.execute("insert into pulse.task_proof(org_id,task_id,kind,label,hr_file_id) values(%s,%s,'document','Role terms',%s)", (w.org, t, doc))
    assert one(api, w, w.editor, "select name from pulse.hr_file_read(%s)", (doc,))["name"] == "terms.pdf"
    assert len(one(api, w, w.lead, "select pulse.hr_file_list(%s) r", (w.editor,))["r"]) == 1
    assert one(api, w, w.manager, "select pulse.hr_file_list(%s) r", (w.editor,))["r"] == []
    proof = one(api, w, w.editor2, "select id from pulse.task_proof where task_id=%s", (t,))["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select * from pulse.task_proof_read(%s)", (proof,))
    assert one(api, w, w.lead, "select name from pulse.task_proof_read(%s)", (proof,))["name"] == "terms.pdf"


def test_tracker_normalise_and_pod_cards(api, worker, owner, team):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set project_key='northstar@baner',title='Northstar' where id=%s", (w.project,))
        for n, (title, status, period, key, due) in enumerate([
                ("Model Video — Wednesday, 16 September", "Edit Pending", "sept 2026", "", ""),
                ("Single Image C — Northstar", "creative finalised", "Graphics Mar 2026", "northstar", ""),
                ("VOV — Riverside", "Edit In process", "Videos Mar 26", "riverside", "6th June"),
                ("Scripting — Ghost", "unknown", "May 2025", "ghost", "")]):
            worker.execute("""insert into pulse.task(org_id,source_key,title,status,source_status,source_period,project_key,due_label,source)
              values(%s,%s,%s,'unknown',%s,%s,%s,nullif(%s,''),'imported')""", (w.org, f"synthetic-tracker-{n}", title, status, period, key, due))
        r = worker.execute("select pulse.task_tracker_normalise() r").fetchone()["r"]
        rows = {x["title"]: x for x in worker.execute("select title,status,deliverable_type,work_on::text,(due_at at time zone 'Asia/Kolkata')::date::text due,project_id from pulse.task where source='imported'").fetchall()}
    assert r["linked"] == 1 and r["status"] == 3
    model = rows["Model Video — Wednesday, 16 September"]
    assert (model["status"], model["deliverable_type"], model["work_on"]) == ("open", "Model video", "2026-09-16")
    assert rows["Single Image C — Northstar"]["project_id"] == w.project and rows["Single Image C — Northstar"]["status"] == "done"
    assert (rows["VOV — Riverside"]["status"], rows["VOV — Riverside"]["due"]) == ("in_progress", "2026-06-06")
    assert rows["Scripting — Ghost"]["status"] == "unknown" and rows["Scripting — Ghost"]["project_id"] is None
    # Pod cards: move the outsider into Pod 1 without a head change, and accept a review suggestion in the same save.
    with worker.transaction():
        set_tenant(worker, w.org)
        sid = worker.execute("""insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed)
          values(%s,'synthetic-pod-suggestion','manager','person',%s,'Outsider: pod','{"pod":"Pod 1"}') returning id""", (w.org, w.outsider)).fetchone()["id"]
    pods = {"pods": [{"name": "Pod 1", "headId": str(w.editor2), "members": [str(w.editor), str(w.editor2), str(w.outsider)]}, {"name": "Pod 2", "headId": None, "members": []}], "accepted": [str(sid)]}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.hr_pods_save(%s)", (Jsonb(pods),))
    assert one(api, w, w.lead, "select pulse.hr_pods_save(%s) n", (Jsonb(pods),))["n"] == 2
    assert one(api, w, w.lead, "select pod,manager_id from pulse.people_profile where person_id=%s", (w.outsider,)) == {"pod": "Pod 1", "manager_id": w.editor2}
    assert one(api, w, w.lead, "select status from pulse.review_item where id=%s", (sid,))["status"] == "accepted"


API_SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const call = async (url, email, payload) => { const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 600)); process.exit(1); } };
const member = process.env.TEST_MEMBER, admin = 'admin@estateautopilots.com', hr = 'hr@estateautopilots.com';
let r = await call('/api/v0/tasks/quick', member, { text: 'Fix login on phone #Northstar fri !high', preview: true });
ok(r.status === 200 && r.body.parsed.title === 'Fix login on phone' && r.body.parsed.priority === 'high' && r.body.parsed.project?.name === 'Northstar', 'quick preview', r);
r = await call('/api/v0/tasks/quick', member, { text: 'Fix login on phone #Northstar fri !high' });
ok(r.status === 200 && r.body.id, 'quick create', r); const tid = r.body.id;
r = await call('/api/v0/tasks/quick', member, { text: 'Help @Outsider' });
// TASKS-3: the member still cannot give it outside the pod, but quick add asks them (like + Create) instead of refusing.
ok(r.status === 200 && r.body.assigned === false && r.body.asked?.id && r.body.mode?.mode === 'request', 'member cannot give outside the pod: it is a request', r);
const helpId = r.body.id;
r = await call(`/api/v0/tasks/${helpId}`, member);
ok(r.status === 200 && r.body.task.assigneeId === process.env.TEST_MEMBER_ID, 'the task stays the member’s until the outsider accepts', r);
r = await call('/api/v0/tasks/home', member);
ok(r.status === 200 && r.body.rows.some((t) => t.id === tid) && r.body.summary.weekDone === 0, 'my tasks', r);
r = await call(`/api/v0/tasks/${tid}/move`, member, { status: 'done' });
ok(r.status === 200 && r.body.weekDone === 1 && r.body.streak === 1, 'done celebration counts', r);
r = await call('/api/v0/tasks/board?scope=mine', member);
ok(r.status === 200 && r.body.columns.done.some((t) => t.id === tid), 'board done column', r);
r = await call(`/api/v0/tasks/${tid}`, member);
ok(r.status === 200 && r.body.task.title === 'Fix login on phone' && r.body.events.length >= 2 && r.body.can.accept === false, 'detail', r);
r = await call(`/api/v0/tasks/${tid}/proof`, member, { url: 'https://github.com/synthetic/pulse/pull/1', label: 'PR' });
ok(r.status === 200, 'proof link', r);
r = await call('/api/v0/tasks/blocking', member);
ok(r.status === 403, 'blocking view is leadership only', r);
r = await call('/api/v0/tasks/blocking', admin);
ok(r.status === 200 && Array.isArray(r.body.groups), 'blocking view', r);
r = await call('/api/v0/tasks/projects', admin);
ok(r.status === 200 && r.body.rows.some((p) => p.name === 'Northstar'), 'projects', r);
r = await call(`/api/v0/tasks/projects/${process.env.TEST_PROJECT}`, member);
ok(r.status === 200 && r.body.tasks.some((t) => t.id === tid), 'project tree', r);
r = await call('/api/v0/outcomes', member);
ok(r.status === 200 && r.body.weeks.length === 8 && r.body.self === true, 'outcome dashboard', r);
r = await call(`/api/v0/outcomes?person=${process.env.TEST_OUTSIDER}`, member);
ok(r.status === 403, 'outcome dashboard of a colleague', r);
r = await call(`/api/v0/people/${process.env.TEST_MEMBER_ID}/work-terms`, member, { workMode: 'outcome' });
ok(r.status === 403, 'member cannot set work mode', r);
r = await call(`/api/v0/people/${process.env.TEST_MEMBER_ID}/work-terms`, hr, { workMode: 'outcome', otherRoles: 'Synthetic role A; Synthetic role B' });
ok(r.status === 200, 'HR sets work mode', r);
r = await call('/api/v0/tasks?q=Fix+login', hr);
ok(r.status === 200 && Array.isArray(r.body.statuses), 'HR reads tasks', r);
r = await call('/api/v0/time', member, { date: '2026-10-09', minutes: 45, taskId: tid, note: 'synthetic' });
ok(r.status === 200, 'log time', r);
r = await call('/api/v0/hr/pods', member, { pods: [] });
ok(r.status === 403, 'pods need HR', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def test_task_api(worker, owner, api, team):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set title='Northstar' where id=%s", (w.project,))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"outsider@{w.domain}", w.outsider))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_MEMBER": w.editor_handle, "TEST_MEMBER_ID": str(w.editor), "TEST_OUTSIDER": str(w.outsider), "TEST_PROJECT": str(w.project)}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", API_SCRIPT], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_history_import_is_idempotent_quiet_and_protected(api, worker, team, tmp_path):
    from pulse_workers.work_history import load
    w = team
    (tmp_path / "terms.pdf").write_bytes(b"%PDF-1.4 synthetic role terms")
    data = {
        "person": {"email": w.editor_handle}, "people": {"head": {"name": "Editor Two"}}, "client": "Synthetic Co (internal)",
        "terms": {"workMode": "outcome", "roleTitle": "Synthetic lead (proposed)", "roleStatus": "Offer not yet accepted: trial period", "weeklyHoursMin": 15, "weeklyHoursMax": 20,
                  "officeDaysMin": 1, "officeDaysMax": 2, "otherRoles": ["Director, Synthetic Ltd"], "profileRole": "Synthetic lead (proposed)"},
        "documents": [{"key": "terms", "kind": "role_terms", "title": "Synthetic role terms", "path": "terms.pdf"}],
        "compensation": [{"month": "2026-10-01", "kind": "monthly", "amount": 4321, "status": "proposed", "note": "Pending acceptance", "sourceKey": "synthetic", "sourceName": "Synthetic terms", "sourceSheet": "Terms", "basis": "Stated"}],
        "kpis": [{"key": "k1", "area": "Pilot", "title": "Two editors live", "target": "95% detected", "due": "2026-11-23", "source": "Synthetic plan p.1"}],
        "projects": [{"key": "p1", "name": "Synthetic platform"}, {"key": "p2", "name": "Synthetic strategy"}],
        "tasks": [
            {"key": "h1", "title": "Strategy sessions", "project": "p2", "status": "done", "start": "2026-09-02", "done": "2026-09-30", "hours": 10, "reviewer": "head", "value": "Plan agreed", "proof": [{"label": "Role terms", "doc": "terms"}]},
            {"key": "h2", "title": "Release v0.1", "project": "p1", "status": "done", "start": "2026-10-04", "done": "2026-10-05", "hours": 2, "via": "via AI team", "proof": [{"label": "Tag", "url": "https://github.com/synthetic/pulse/releases/tag/v0.1.0"}]},
            {"key": "o1", "title": "Approve the notice", "assignee": "head", "reviewer": "me", "status": "open", "due": "2026-11-06"},
            {"key": "o2", "title": "Start the pilot", "status": "open", "blockedBy": ["o1"]},
        ],
    }
    with worker.transaction():
        set_tenant(worker, w.org)
        before = worker.execute("select count(*)::int n from pulse.notification").fetchone()["n"]
        first = load(worker, w.org, data, tmp_path)
        second = load(worker, w.org, data, tmp_path)
        assert worker.execute("select count(*)::int n from pulse.notification").fetchone()["n"] == before   # nobody is messaged
    assert first["tasks"] == second["tasks"] == 4 and second["time"] == 0   # re-running never duplicates
    mine = as_(api, w, w.editor, "select title,status,done_at is not null done from pulse.task where $1 in (owner_id,assignee_person_id) order by title".replace("$1", "%s"), (w.editor,))
    assert [m["title"] for m in mine] == ["Release v0.1", "Start the pilot", "Strategy sessions"]
    assert {m["title"]: m["status"] for m in mine}["Start the pilot"] == "blocked"
    time = as_(api, w, w.editor, "select sum(minutes)::int m,count(*)::int n from pulse.time_entry where person_id=%s and status='proposed'", (w.editor,))[0]
    assert time["m"] == 12 * 60 and time["n"] >= 5   # ten hours spread over the September weeks, two on 5 Oct
    assert one(api, w, w.editor, "select pulse.work_mode(%s) m", (w.editor,))["m"] == "outcome"
    assert one(api, w, w.editor, "select count(*)::int n from pulse.kpi where person_id=%s", (w.editor,))["n"] == 1
    # The amount is only in the protected salary area; the person's colleague cannot read it, nor the document.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.hr_salary_components_read(%s)", (w.editor,))
    assert one(api, w, w.editor2, "select pulse.hr_file_list(%s) r", (w.editor,))["r"] == []
    assert len(one(api, w, w.editor, "select pulse.hr_file_list(%s) r", (w.editor,))["r"]) == 1


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_task_screens_in_the_browser(worker, owner, api, team, tmp_path):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set title='Northstar' where id=%s", (w.project,))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_PROJECT": str(w.project), "PULSE_TASKS_REPORT": str(tmp_path / "tasks.json")}
    p = subprocess.run(["node", "test/tasks-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "tasks.json").read_text())
    assert report["browserChecks"] >= 40
