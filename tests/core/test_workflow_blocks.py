"""WORKFLOW BUILDER (0530) on a disposable tenant with synthetic people only: boards of workflows as tabs, blocks with
modules, Hand-off blocks that start the next tab's run, ticked checklists, and test runs that follow a draft as the
people it would go to without making a task or sending anything."""
import uuid

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant


def world(worker, owner, api):
    w = build_world(worker, owner, api)
    people = {r: uuid.uuid4() for r in ['lead', 'pgs', 'designer', 'member']}
    titles = {'lead': 'Co-founder / CEO', 'pgs': 'PGS', 'designer': 'Graphic Designer', 'member': 'Video Editor'}
    with worker.transaction():
        set_tenant(worker, w.org)
        for r, pid in people.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic ' + r.title()))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, titles[r]))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'{r}@{w.domain}', pid))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2020-01-01')", (w.org, people['lead']))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,'pgs',%s,'2020-01-01')", (w.org, people['pgs'], w.pod))
    return w, people


def q(api, org, who, sql, args=()):
    with api.transaction():
        set_tenant(api, org, who)
        return api.execute(sql, args).fetchall()


def save(api, org, lead, name, steps, publish=False, board=None):
    with api.transaction():
        set_tenant(api, org, lead)
        wid = api.execute("select pulse.workflow_save(null,%s) id", (Jsonb({"name": name, "definition": {"steps": steps}, "trigger": {"kind": "manual"}}),)).fetchone()["id"]
        if board:
            api.execute("select pulse.workflow_board_tab(%s,%s)", (wid, Jsonb({"boardId": str(board), "role": name})))
        if publish:
            api.execute("select pulse.workflow_publish(%s)", (wid,))
    return wid


def steps_of(api, org, who, run):
    return {r["step_key"]: r for r in q(api, org, who, """select s.id,s.step_key,s.status,s.outcome,s.test_person,s.task_id,s.checks,s.note,t.assignee_person_id who
        from pulse.workflow_run_step s left join pulse.task t on t.id=s.task_id where s.run_id=%s order by s.position""", (run,))}


def site_tab():
    return [{"id": "in", "title": "From sales", "module": "handoff_in", "kind": "task", "next": [{"to": "ok", "port": "lead"}]},
            {"id": "ok", "title": "Design approved", "module": "approval", "kind": "approval", "assign": {"by": "role", "role": "Graphic Designer"},
             "next": [{"to": "end", "port": "approved"}]},
            {"id": "end", "title": "End", "module": "end", "kind": "end", "next": []}]


def sales_tab(site):
    return [{"id": "lead", "title": "Lead capture", "module": "lead_capture", "kind": "task", "next": [{"to": "brief", "port": "lead"}]},
            {"id": "brief", "title": "Brief the team", "module": "checklist", "kind": "task", "role": "PGS", "detail": "• Read the package\n• Call the client",
             "next": [{"to": "go", "port": "done"}]},
            {"id": "go", "title": "To the site team", "module": "handoff", "kind": "task", "handoff": {"workflowId": str(site)}, "next": []}]


def test_test_runs_follow_hand_offs_without_tasks_or_messages(worker, owner, api):
    w, p = world(worker, owner, api)
    org, lead = w.org, p['lead']
    # Members neither make boards nor start tests.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, org, p['member'], "select pulse.workflow_board_save(null,%s)", (Jsonb({"name": "x"}),))
    board = q(api, org, lead, "select pulse.workflow_board_save(null,%s) id", (Jsonb({"name": "Quote to install"}),))[0]["id"]
    site = save(api, org, lead, "Site team", site_tab(), board=board)
    sales = save(api, org, lead, "Sales", sales_tab(site), board=board)
    tabs = q(api, org, p['member'], "select id,board_position from pulse.workflow where board_id=%s order by board_position", (board,))
    assert tabs == [], "drafts are leadership's to read"
    assert [t["id"] for t in q(api, org, lead, "select id from pulse.workflow where board_id=%s order by board_position", (board,))] == [site, sales]
    assert q(api, org, p['member'], "select count(*) n from pulse.workflow_board")[0]["n"] == 1, "everyone reads active boards"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, org, p['member'], "select pulse.workflow_test_start(%s,%s)", (sales, Jsonb({"projectId": str(w.project)})))

    with worker.transaction():
        set_tenant(worker, org)
        before = worker.execute("select count(*) n from pulse.notification").fetchone()["n"]
    run = q(api, org, lead, "select pulse.workflow_test_start(%s,%s) id", (sales, Jsonb({"projectId": str(w.project), "context": {"record.project": "Synthetic"}})))[0]["id"]
    r = q(api, org, lead, "select mode,status,version,context from pulse.workflow_run where id=%s", (run,))[0]
    assert r["mode"] == "test" and r["status"] == "running" and r["context"]["record.project"] == "Synthetic"
    s = steps_of(api, org, lead, run)
    assert s['lead']['status'] == 'done', "Lead capture finishes by itself"
    assert s['brief']['status'] == 'active' and s['brief']['test_person'] == p['pgs'] and s['brief']['task_id'] is None
    # A test step is ticked and moved on by the tester; a live step only by its task.
    assert q(api, org, lead, "select pulse.workflow_step_check(%s,1,true) c", (s['brief']['id'],))[0]["c"] == [1]
    assert q(api, org, lead, "select pulse.workflow_step_check(%s,0,true) c", (s['brief']['id'],))[0]["c"] == [0, 1]
    assert q(api, org, lead, "select pulse.workflow_step_check(%s,1,false) c", (s['brief']['id'],))[0]["c"] == [0]
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        q(api, org, p['pgs'], "select pulse.workflow_test_done(%s,null,'{}')", (s['brief']['id'],))
    q(api, org, lead, "select pulse.workflow_test_done(%s,null,%s)", (s['brief']['id'], Jsonb({"note": "Client called"})))
    s = steps_of(api, org, lead, run)
    assert s['brief']['status'] == 'done' and s['go']['status'] == 'done' and 'Site team' in s['go']['note']
    assert q(api, org, lead, "select status from pulse.workflow_run where id=%s", (run,))[0]["status"] == 'done'
    child = q(api, org, lead, "select id,mode,started_via,parent_run_id,context from pulse.workflow_run where workflow_id=%s", (site,))
    assert len(child) == 1 and child[0]["mode"] == 'test' and child[0]["started_via"] == 'handoff' and child[0]["parent_run_id"] == run
    assert child[0]["context"]["brief.note"] == "Client called" and child[0]["context"]["handoff.from"] == "Sales"
    c = steps_of(api, org, lead, child[0]["id"])
    assert c['in']['status'] == 'done' and c['ok']['status'] == 'active' and c['ok']['test_person'] == p['designer']
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        q(api, org, lead, "select pulse.workflow_test_done(%s,null,'{}')", (c['ok']['id'],))
    q(api, org, lead, "select pulse.workflow_test_done(%s,'Approved','{}')", (c['ok']['id'],))
    assert q(api, org, lead, "select status from pulse.workflow_run where id=%s", (child[0]["id"],))[0]["status"] == 'done'
    with worker.transaction():
        set_tenant(worker, org)
        assert worker.execute("select count(*) n from pulse.task where source='workflow'").fetchone()["n"] == 0, "a test makes no task"
        assert worker.execute("select count(*) n from pulse.notification").fetchone()["n"] == before, "a test sends nothing"


def test_live_hand_off_starts_the_next_tabs_run(worker, owner, api):
    w, p = world(worker, owner, api)
    org, lead = w.org, p['lead']
    board = q(api, org, lead, "select pulse.workflow_board_save(null,%s) id", (Jsonb({"name": "Live"}),))[0]["id"]
    site = save(api, org, lead, "Site team", site_tab(), publish=True, board=board)
    sales = save(api, org, lead, "Sales", sales_tab(site), publish=True, board=board)
    run = q(api, org, lead, "select pulse.workflow_start(%s,%s) id", (sales, Jsonb({"projectId": str(w.project)})))[0]["id"]
    s = steps_of(api, org, lead, run)
    assert s['lead']['status'] == 'done' and s['brief']['who'] == p['pgs'] and s['brief']['task_id'] is not None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        q(api, org, lead, "select pulse.workflow_test_done(%s,null,'{}')", (s['brief']['id'],))
    # The person doing it ticks the checklist; someone else on the team does not.
    assert q(api, org, p['pgs'], "select pulse.workflow_step_check(%s,0,true) c", (s['brief']['id'],))[0]["c"] == [0]
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        q(api, org, p['member'], "select pulse.workflow_step_check(%s,1,true)", (s['brief']['id'],))
    with api.transaction():
        set_tenant(api, org, p['pgs'])
        api.execute("select pulse.task_move(%s,'done')", (s['brief']['task_id'],))
    child = q(api, org, lead, "select id,mode,parent_run_id,parent_step_id from pulse.workflow_run where workflow_id=%s", (site,))
    assert len(child) == 1 and child[0]["mode"] == 'live' and child[0]["parent_run_id"] == run and child[0]["parent_step_id"] == s['go']['id']
    c = steps_of(api, org, lead, child[0]["id"])
    assert c['ok']['status'] == 'active' and c['ok']['task_id'] is not None and c['ok']['who'] == p['designer']
    # A hand-off to a tab that is not published does not lose the work silently: the step says why it stopped.
    draft = save(api, org, lead, "Draft tab", site_tab(), board=board)
    other = save(api, org, lead, "Sales 2", sales_tab(draft), publish=True, board=board)
    run2 = q(api, org, lead, "select pulse.workflow_start(%s,%s) id", (other, Jsonb({"projectId": str(w.project)})))[0]["id"]
    s2 = steps_of(api, org, lead, run2)
    with api.transaction():
        set_tenant(api, org, p['pgs'])
        api.execute("select pulse.task_move(%s,'done')", (s2['brief']['task_id'],))
    s2 = steps_of(api, org, lead, run2)
    assert s2['brief']['status'] == 'done' and s2['go']['status'] == 'active' and 'not live' in s2['go']['note'], "the hand-off waits with its reason"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        q(api, org, lead, "select pulse.workflow_step_retry(%s)", (s2['go']['id'],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, org, p['member'], "select pulse.workflow_step_retry(%s)", (s2['go']['id'],))
    q(api, org, lead, "select pulse.workflow_publish(%s)", (draft,))
    q(api, org, lead, "select pulse.workflow_step_retry(%s)", (s2['go']['id'],))
    assert steps_of(api, org, lead, run2)['go']['status'] == 'done'
    assert q(api, org, lead, "select count(*) n from pulse.workflow_run where workflow_id=%s and parent_run_id=%s", (draft, run2))[0]["n"] == 1
    # Test runs stay out of the live views; a test can be stopped.
    t = q(api, org, lead, "select pulse.workflow_test_start(%s,%s) id", (sales, Jsonb({})))[0]["id"]
    q(api, org, lead, "select pulse.workflow_run_cancel(%s,'Test stopped')", (t,))
    assert q(api, org, lead, "select status from pulse.workflow_run where id=%s", (t,))[0]["status"] == 'cancelled'


def test_hand_offs_that_start_each_other_stop_with_a_note(worker, owner, api):
    w, p = world(worker, owner, api)
    org, lead = w.org, p['lead']
    a = save(api, org, lead, "A", [{"id": "in", "title": "Lead", "module": "lead_capture", "kind": "task", "next": [{"to": "go", "port": "lead"}]},
                                   {"id": "go", "title": "To B", "module": "handoff", "kind": "task", "next": []}])
    b = save(api, org, lead, "B", [{"id": "in", "title": "From A", "module": "handoff_in", "kind": "task", "next": [{"to": "go", "port": "lead"}]},
                                   {"id": "go", "title": "To A", "module": "handoff", "kind": "task", "handoff": {"workflowId": str(a)}, "next": []}], publish=True)
    with api.transaction():
        set_tenant(api, org, lead)
        api.execute("select pulse.workflow_save(%s,%s)", (a, Jsonb({"name": "A", "trigger": {"kind": "manual"}, "definition": {"steps": [
            {"id": "in", "title": "Lead", "module": "lead_capture", "kind": "task", "next": [{"to": "go", "port": "lead"}]},
            {"id": "go", "title": "To B", "module": "handoff", "kind": "task", "handoff": {"workflowId": str(b)}, "next": []}]}})))
        api.execute("select pulse.workflow_publish(%s)", (a,))
    run = q(api, org, lead, "select pulse.workflow_start(%s,%s) id", (a, Jsonb({"projectId": str(w.project)})))[0]["id"]
    runs = q(api, org, lead, "select count(*) n from pulse.workflow_run where mode='live'")[0]["n"]
    assert 2 <= runs <= 22, runs
    stuck = q(api, org, lead, "select note from pulse.workflow_run_step where status='active' and note like 'Could not hand over%%'")
    assert len(stuck) == 1 and 'circle' in stuck[0]["note"], stuck
    assert run
