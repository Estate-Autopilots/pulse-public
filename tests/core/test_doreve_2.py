"""DOREVE-2 (17 Nov 2026, migration 2300): orchestrator decisions under the owner's delegation.

Decision 4: an AI employee with operations access may change a task it is not on ONLY when a person who may change that
task asked for it, on that task or on a task that names it (its link or id in the comment, a sub-task, or a doc linked to
the comment's task holding its chip: Kazuk's decision comment); the change is written in the history as done at that
person's request. Decision 5: an AI employee an admin lets read attendance reads everyone's check-ins and leave, and can
write none of it. Decision 3: replay storage keeps a company under its budget, oldest first. Synthetic people only.
"""
import psycopg
import pytest
from psycopg.types.json import Jsonb

from helpers import build_world
from pulse_sdk.db import set_tenant

from test_runners import _people
from test_runner_access import _agent, _as_agent


def _owner_do(owner, w, sql, args=()):
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        cur = owner.execute(sql, args)
        return cur.fetchone() if cur.description else None


def _as(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute(sql, args).fetchone()


def _ai(api, w, aid, sql, args=(), request=None):
    with api.transaction():
        _as_agent(api, w, aid)
        if request:
            api.execute("select set_config('pulse.ai_request',%s,true), set_config('pulse.ai_request_task',%s,true)", (str(request), str(args[0]) if args else ""))
        row = api.execute(sql, args).fetchone()
        viewer = api.execute("select current_setting('pulse.viewer_id',true) v, current_setting('pulse.agent_session',true) a, current_setting('pulse.ai_request',true) r").fetchone()
        assert viewer["v"] == str(aid) and viewer["a"] == "on", "the request check puts the AI's own session back"
        assert (viewer["r"] or "") == (str(request) if request else ""), "and the request"
        return row


def _world(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "leadership", "person", "other"], f"{w.code.lower()}.example")
    aid = _agent(owner, w, p["admin"])
    _as(api, w, p["admin"], "select pulse.agent_access_set(%s,'operations')", (aid,))
    # The task the AI is not on: held by a person, given by the admin.
    t = _as(api, w, p["admin"], "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic overdue: send the brochure", "assigneeId": str(p["person"])}),))["id"]
    # Kazuk's kind of task: the review, held by leadership, with a doc linked to it that lists the overdue task.
    review = _as(api, w, p["leadership"], "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic review: decide the overdue tasks", "assigneeId": str(p["leadership"])}),))["id"]
    doc = _owner_do(owner, w, "insert into pulse.doc(org_id,title,body_html,body_text,created_by) values(%s,'Synthetic overdue review',%s,'row 1',%s) returning id",
                    (w.org, f'<p>Row 1: <a data-task="{t}" href="/tasks/{t}">send the brochure</a></p>', p["leadership"]))["id"]
    _owner_do(owner, w, "insert into pulse.doc_link(org_id,doc_id,kind,ref_id,added_by) values(%s,%s,'task',%s,%s)", (w.org, doc, review, p["leadership"]))
    other = _as(api, w, p["admin"], "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic: a task nobody asked about", "assigneeId": str(p["person"])}),))["id"]
    return w, p, aid, t, review, other


def _comment(api, w, who, task, body):
    return _as(api, w, who, "select pulse.work_comment_add(%s,null,%s,%s) c", (task, body, []))["c"]


def _refused(api, w, aid, sql, args=(), request=None):
    # Refused, or not even visible to it ("Task not found"): either way nothing changes.
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        _ai(api, w, aid, sql, args, request)


def test_an_operations_ai_changes_a_task_it_is_not_on_only_at_the_request_of_someone_who_may(worker, owner, api):
    w, p, aid, t, review, other = _world(worker, owner, api)
    save = "select pulse.task_save(%s,%s)"
    # Not on the task and nobody asked: refused, as before (task_can_edit, 0153).
    _refused(api, w, aid, save, (t, Jsonb({"dueOn": "2026-12-01"})))
    # A colleague who may not change the task asks: still refused.
    c_other = _comment(api, w, p["other"], t, "@coordinator please move this to 1 Dec")
    _refused(api, w, aid, save, (t, Jsonb({"dueOn": "2026-12-01"})), request=c_other)
    # Leadership asks on the task itself: allowed, and the history says at whose request.
    c_lead = _comment(api, w, p["leadership"], t, "@coordinator please move this to 1 Dec and make it low")
    _ai(api, w, aid, save, (t, Jsonb({"dueOn": "2026-12-01", "priority": "low"})), request=c_lead)
    note = _ai(api, w, aid, "select pulse.task_on_request_note(%s,'changed the due day and the priority') r", (t,), request=c_lead)["r"]
    assert note["by"] == str(p["leadership"]) and note["byName"] == "Synthetic runner leadership"
    ev = _as(api, w, p["admin"], "select actor_id,kind,from_value,to_value,note from pulse.task_event where task_id=%s and kind='on_request'", (t,))
    assert ev == {"actor_id": aid, "kind": "on_request", "from_value": str(c_lead), "to_value": "Synthetic runner leadership", "note": "changed the due day and the priority"}
    row = _as(api, w, p["admin"], "select priority,(due_at at time zone 'Asia/Kolkata')::date::text d from pulse.task where id=%s", (t,))
    assert row["priority"] == "low" and row["d"] == "2026-12-01"
    # Kazuk's decision comment on his own review task: it counts for the task its linked doc names, not for another.
    c_review = _comment(api, w, p["leadership"], review, "Decisions: row 1 is obsolete, close it. @coordinator please apply.")
    _ai(api, w, aid, "select pulse.task_move(%s,'not_applicable','Closed at the review') r", (t,), request=c_review)
    assert _as(api, w, p["admin"], "select closed_as from pulse.task where id=%s", (t,))["closed_as"] == "not_applicable"
    _refused(api, w, aid, "select pulse.task_move(%s,'cancelled',null)", (other,), request=c_review)
    # A comment that names the task by its link counts too.
    c_named = _comment(api, w, p["leadership"], review, f"Also /tasks/{other}: move it to 5 Dec")
    _ai(api, w, aid, save, (other, Jsonb({"dueOn": "2026-12-05"})), request=c_named)
    # Without a request the note cannot be written (the API cannot claim one).
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _ai(api, w, aid, "select pulse.task_on_request_note(%s,'x')", (t,))
    # Deleting stays a person's job, request or not.
    with pytest.raises(psycopg.Error):
        _ai(api, w, aid, "select pulse.task_delete(%s)", (other,), request=c_named)


def test_only_operations_access_and_only_a_persons_comment_count(worker, owner, api):
    w, p, aid, t, review, other = _world(worker, owner, api)
    c_lead = _comment(api, w, p["leadership"], t, "@coordinator please move this to 1 Dec")
    # Standard access: the request does not open the task.
    _as(api, w, p["admin"], "select pulse.agent_access_set(%s,'standard')", (aid,))
    _refused(api, w, aid, "select pulse.task_save(%s,%s)", (t, Jsonb({"dueOn": "2026-12-01"})), request=c_lead)
    _as(api, w, p["admin"], "select pulse.agent_access_set(%s,'operations')", (aid,))
    # A comment by an AI employee (here its own) is never a person's request.
    mine = _owner_do(owner, w, "insert into pulse.work_comment(org_id,task_id,author_id,body) values(%s,%s,%s,'I will move it') returning id", (w.org, t, aid))["id"]
    _refused(api, w, aid, "select pulse.task_save(%s,%s)", (t, Jsonb({"dueOn": "2026-12-01"})), request=mine)
    # A person's own session never uses the AI path (agent_session is off).
    with api.transaction():
        set_tenant(api, w.org, p["other"])
        api.execute("select set_config('pulse.ai_request',%s,true)", (str(c_lead),))
        assert api.execute("select pulse.task_can_edit(%s) ok", (t,)).fetchone()["ok"] is False


def test_an_ai_employee_an_admin_lets_read_attendance_reads_it_and_writes_none(worker, owner, api):
    w, p, aid, t, review, other = _world(worker, owner, api)
    _owner_do(owner, w, """insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,client)
        values(%s,%s,(now() at time zone 'Asia/Kolkata')::date,'office',now()-interval '30 minutes','{"via":"web","trigger":"manual"}')""", (w.org, p["person"]))
    _owner_do(owner, w, "insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status) values(%s,%s,current_date+7,current_date+7,'casual','approved')", (w.org, p["other"]))
    count = "select (select count(*) from pulse.attendance_effective where person_id=%s)::int a, (select count(*) from pulse.leave_request where person_id=%s)::int l"
    assert _ai(api, w, aid, count, (p["person"], p["other"])) == {"a": 0, "l": 0}, "nobody else's attendance before"
    # Only an admin may turn it on; the AI itself may not.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _ai(api, w, aid, "select pulse.agent_reads_set(%s,'attendance',true)", (aid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _as(api, w, p["person"], "select pulse.agent_reads_set(%s,'attendance',true)", (aid,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        _as(api, w, p["admin"], "select pulse.agent_reads_set(%s,'pay',true)", (aid,))
    assert _as(api, w, p["admin"], "select pulse.agent_reads_set(%s,'attendance',true) r", (aid,))["r"] == ["attendance"]
    assert _ai(api, w, aid, count, (p["person"], p["other"])) == {"a": 1, "l": 1}, "everyone's check-ins and leave"
    # Read only: an update or delete touches nothing (refused by the new policies, or by the grants themselves).
    for sql, who in (("update pulse.attendance_entry set mode='home' where person_id=%s", p["person"]), ("delete from pulse.attendance_entry where person_id=%s", p["person"]),
                     ("update pulse.leave_request set status='rejected' where person_id=%s", p["other"]), ("delete from pulse.leave_request where person_id=%s", p["other"])):
        try:
            with api.transaction():
                _as_agent(api, w, aid)
                assert api.execute(sql, (who,)).rowcount == 0, sql
        except psycopg.errors.InsufficientPrivilege:
            pass
    assert _as(api, w, p["admin"], "select mode from pulse.attendance_entry where person_id=%s", (p["person"],))["mode"] == "office"
    assert _as(api, w, p["admin"], "select status from pulse.leave_request where person_id=%s", (p["other"],))["status"] == "approved"
    with pytest.raises(psycopg.Error):
        _ai(api, w, aid, """insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,client)
            values(pulse.current_org(),%s,(now() at time zone 'Asia/Kolkata')::date - 1,'office',now()-interval '1 day','{"via":"web","trigger":"manual"}') returning id""", (p["person"],))
    # Nothing else widens: pay stays closed (a person who is not HR sees no colleague's pay either way).
    # Off again: nobody else's.
    assert _as(api, w, p["admin"], "select pulse.agent_reads_set(%s,'attendance',false) r", (aid,))["r"] == []
    assert _ai(api, w, aid, count, (p["person"], p["other"])) == {"a": 0, "l": 0}
    # A person keeps exactly what they had: their own only.
    assert _as(api, w, p["other"], count, (p["person"], p["other"])) == {"a": 0, "l": 1}


def test_replays_stay_under_the_company_budget_oldest_first(worker, owner, api):
    w, p, aid, t, review, other = _world(worker, owner, api)
    _as(api, w, p["admin"], "insert into pulse.telemetry_setting(org_id,replay_budget_mb) values(pulse.current_org(),64) returning org_id")
    mb, chunk = 1048576, 3145728
    # 22 chunks of 3 MB (69 MB) in a 64 MB budget: the oldest is a bug report's, the others full-visit chunks.
    for i in range(22):
        _owner_do(owner, w, """insert into pulse.telemetry_replay(org_id,session_id,seq,person_id,started_at,ended_at,events,reason,bytes,data,created_at)
            values(%s,'synthSESS01',%s,%s,now(),now(),1,%s,%s,'\\x00',now()-make_interval(mins=>%s))""", (w.org, i, p["person"], "report" if i == 0 else "sample", chunk, 100 - i))
    room = _as(api, w, p["person"], "select pulse.telemetry_replay_room(%s,'struggle') r", (chunk,))["r"]
    assert room["fits"] is True and room["budget"] == 64 * mb and room["used"] + chunk <= 64 * mb, room
    left = _as(api, w, p["admin"], "select array_agg(seq order by seq) s from pulse.telemetry_replay where session_id='synthSESS01'")["s"]
    assert left[0] == 0 and left[-1] == 21 and 1 not in left, f"the oldest full-visit chunks went first; the bug report's stayed: {left}"
    usage = _as(api, w, p["admin"], "select pulse.telemetry_replay_usage() u")["u"]
    assert usage["bytes"] == len(left) * chunk and usage["days"] == 7 and usage["budgetBytes"] == 64 * mb and usage["reports"] == 1 and usage["sample"] == 0.1
    # Replays older than 7 days go hourly.
    _owner_do(owner, w, """insert into pulse.telemetry_replay(org_id,session_id,seq,person_id,started_at,ended_at,events,reason,bytes,data,created_at)
        values(%s,'synthSESS02',0,%s,now(),now(),1,'struggle',10,'\\x00',now()-interval '8 days')""", (w.org, p["person"]))
    with worker.transaction():
        worker.execute("select pulse.telemetry_retention()")
    assert _as(api, w, p["admin"], "select count(*)::int n from pulse.telemetry_replay where session_id='synthSESS02'")["n"] == 0
