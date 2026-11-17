"""AI-TASKS (1064): an AI employee is given tasks like a colleague and works them on the task. Anyone on the staff gives
it one (the organisation may narrow that), a person always reviews it and an AI never accepts or returns work; in a run
on its own task it plans, comments (mentions ask), attaches what it wrote, makes sub-tasks for people, messages
colleagues and drafts a card for a client conversation, all at once and only once per run; a colleague's answer (on the
task or in their direct message), a finished sub-task and a return with a note wake it again; each working day it looks
at its idle open tasks; the task, its queue and the throughput read what it did. Synthetic people only."""
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (team is a fixture)


def ai(api, owner, w, name="mira-test", pod="Pod 1"):
    agent, _ = make_agent(api, w, name)
    owner_sql(owner, w, "update pulse.agent_member set tools=array['chats','tasks','memory'], daily_token_budget=500000 where person_id=%s", (agent,))
    owner_sql(owner, w, "update pulse.people_profile set pod=%s where person_id=%s", (pod, agent))
    return agent


def look(api, w, agent):
    """Claim its next event and dispatch it, as its runtime does; the run's id and context."""
    evs = agent_one(api, w, agent, "select pulse.agent_events_claim_kinds(5,true) e")["e"]
    assert evs, "something to look at"
    c = evs[0]
    d = agent_one(api, w, agent, "select pulse.agent_task_dispatch(%s,%s,'quick','test-model') d", (c["event"]["id"], c["leaseToken"]))["d"]
    assert d["status"] == "dispatched", d
    return d["runId"], d["context"]


def act(api, w, agent, run, p, key=None):
    return agent_one(api, w, agent, "select pulse.agent_task_act(%s,%s,%s) r", (run, Jsonb(p), key or uuid.uuid4()))["r"]


def finish(api, w, agent, run):
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',1200,2.5,null) r", (run,))


def setting(owner, w, value):
    owner_sql(owner, w, "insert into pulse.work_settings(org_id,ai_task_from) values(%s,%s) on conflict (org_id) do update set ai_task_from=excluded.ai_task_from", (w.org, value))


def takes(api, w, who, agent):
    return one(api, w, who, "select pulse.agent_takes_tasks(%s) ok", (agent,))["ok"]


def test_colleagues_give_an_ai_employee_tasks_and_a_person_always_reviews(api, worker, owner, team):  # noqa: F811
    w = team
    agent = ai(api, owner, w)
    other = ai(api, owner, w, "luna-test")
    # Anyone on the staff by default: a plain member gives it a task at once; the giver reviews; its manager hears.
    assert takes(api, w, w.editor, agent) and takes(api, w, w.outsider, agent)
    tid = new_task(api, w, w.editor, title="Draft the Diwali captions (test)", assigneeId=str(agent))
    t = owner_sql(owner, w, "select assignee_person_id a, review_owner_id r, status from pulse.task where id=%s", (tid,))[0]
    assert t == {"a": agent, "r": w.editor, "status": "open"}
    assert any(n["subject_id"] == tid for n in notes(worker, w, w.manager, "task.update")), "its manager hears about it"
    assert owner_sql(owner, w, "select event_type from pulse.agent_event where agent_id=%s and subject_id=%s", (agent, tid)) == [{"event_type": "task.assigned"}]
    # Never an AI as the reviewer.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        new_task(api, w, w.manager, title="Check the brochure (test)", assigneeId=str(agent), reviewerId=str(other))
    # Reassigning to it from the task page is direct.
    mine = new_task(api, w, w.editor2, title="Summarise the shoot notes (test)")
    assert one(api, w, w.editor2, "select pulse.work_assign_mode(%s,null,null,'{}') m", (agent,))["m"] == {"mode": "direct", "why": "ai_employee"}
    as_(api, w, w.editor2, "select pulse.task_save(%s,%s)", (mine, Jsonb({"assigneeId": str(agent)})))
    assert owner_sql(owner, w, "select assignee_person_id a, review_owner_id r from pulse.task where id=%s", (mine,))[0] == {"a": agent, "r": w.editor2}
    # Narrowed to Who can do what: members give work to themselves only; the pod head reaches its pod; HR anyone.
    setting(owner, w, "reach")
    assert not takes(api, w, w.editor, agent) and takes(api, w, w.editor2, agent) and not takes(api, w, w.outsider, agent) and takes(api, w, w.lead, agent)
    assert one(api, w, w.editor, "select pulse.work_assign_mode(%s,null,null,'{}') m", (agent,))["m"] == {"mode": "none", "why": "ai_employee"}
    # Leaders and its manager only.
    setting(owner, w, "leaders")
    assert not takes(api, w, w.editor2, agent) and not takes(api, w, w.lead, agent) and takes(api, w, w.manager, agent)
    # Its key never gives work as a person would.
    assert agent_one(api, w, agent, "select pulse.agent_takes_tasks(%s) ok", (other,))["ok"] is False


def test_the_work_loop_ask_answer_subtask_review_return_accept(api, worker, owner, team):  # noqa: F811
    w = team
    agent = ai(api, owner, w)
    tid = new_task(api, w, w.manager, title="Write the weekly client update (test)", notes="Cover Reel 2 and the drone shots.", assigneeId=str(agent))
    run, ctx = look(api, w, agent)
    assert ctx["v"] == 2 and ctx["cause"] == "assigned" and ctx["task"]["reviewer"] == "Pod Manager" and ctx["thread"] == []
    assert owner_sql(owner, w, "select status from pulse.task where id=%s", (tid,))[0]["status"] == "in_progress"
    assert one(api, w, w.manager, "select pulse.agent_task_status(%s) s", (tid,))["s"]["running"] is True
    p = {"plan": [{"label": "Read the brief", "done": True}, {"label": "Draft the update", "done": False}, "Send it for review"],
         "comment": "Started on it. @user1x can you confirm when Reel 2 is final?",
         "files": [{"name": "Update draft", "text": "# Weekly update (test)\n\nReel 2: [to confirm]\n"}],
         "subtasks": [{"title": "Share the Reel 2 export (test)", "assignee": "user2x", "dueOn": "2026-11-02", "notes": "The final export for the update."},
                      {"title": "Ask nobody (test)", "assignee": "nobody.here"}],
         "messages": [{"to": "user1x", "text": "When is Reel 2 final?"}], "status": "waiting", "waitingOn": "@user1x"}
    key = uuid.uuid4()
    r = act(api, w, agent, run, p, key)
    assert r["status"] == "blocked" and r["phase"] == "waiting" and r["files"] == 1 and r["messages"] == 1 and len(r["subtasks"]) == 1
    assert [s["why"] for s in r["skipped"]] == ["no active colleague by that username"]
    assert act(api, w, agent, run, p, key) == r, "a retry of the same run is the same step"
    com = owner_sql(owner, w, "select body, mentions from pulse.work_comment where task_id=%s", (tid,))
    assert len(com) == 1 and com[0]["body"].startswith("My plan:\n1. Read the brief\n2. Draft the update\n3. Send it for review\n\nStarted on it.") and com[0]["mentions"] == [w.editor]
    assert owner_sql(owner, w, "select label from pulse.task_attachment where task_id=%s", (tid,)) == [{"label": "Update draft.md"}]
    sub = owner_sql(owner, w, "select id, assignee_person_id a, review_owner_id r, created_by c, parent_id from pulse.task where parent_id=%s", (tid,))[0]
    assert (sub["a"], sub["r"], sub["c"]) == (w.editor2, w.manager, agent)
    assert any(n["subject_id"] == sub["id"] for n in notes(worker, w, w.editor2, "task.assigned"))
    assert owner_sql(owner, w, "select count(*) n from pulse.task_member where task_id=%s and person_id=%s and removed_at is null", (tid, w.editor2))[0]["n"] == 1, "they follow the task it belongs to (1096)"
    assert any(n["title"].startswith("Mira Test asked you on") for n in notes(worker, w, w.editor, "task.mention")), "named in full (1096)"
    assert owner_sql(owner, w, "select via from pulse.agent_task_ask where task_id=%s order by via", (tid,)) == [{"via": "comment"}, {"via": "direct"}]
    finish(api, w, agent, run)
    # The colleague answers in the direct message: it comes back to the task, not as a chat answer.
    dm = owner_sql(owner, w, "select dm_channel_id d from pulse.agent_task_ask where task_id=%s and via='direct'", (tid,))[0]["d"]
    as_(api, w, w.editor, "select pulse.chat_send(%s,'Reel 2 is final on Thursday (test)',null,'[]',%s,null)", (dm, uuid.uuid4()))
    queued = owner_sql(owner, w, "select event_type, subject_type, subject_id from pulse.agent_event where agent_id=%s and state='queued'", (agent,))
    assert queued == [{"event_type": "task.mention", "subject_type": "task", "subject_id": tid}]
    run, ctx = look(api, w, agent)
    assert ctx["cause"] == "direct" and any(a["answered"] and "Thursday" in a["answer"] for a in ctx["asks"])
    assert owner_sql(owner, w, "select status from pulse.task where id=%s", (tid,))[0]["status"] == "in_progress", "an answer unblocks it"
    # Done while its sub-task is open: it waits for the sub-task.
    r = act(api, w, agent, run, {"comment": "Reel 2 is final on Thursday; draft updated.", "status": "done"})
    assert r["status"] == "blocked" and r["phase"] == "waiting"
    assert owner_sql(owner, w, "select waiting_on from pulse.agent_task_work where task_id=%s", (tid,))[0]["waiting_on"] == "its sub-tasks (1 open)"
    finish(api, w, agent, run)
    as_(api, w, w.editor2, "select pulse.task_move(%s,'done','Export shared in the group (test)')", (sub["id"],))
    run, ctx = look(api, w, agent)
    assert ctx["cause"] == "subtask" and ctx["subtasks"][0]["status"] == "done" and ctx["subtasks"][0]["note"] == "Export shared in the group (test)"
    r = act(api, w, agent, run, {"comment": "Everything is in; sent for review.", "plan": [{"label": "Read the brief", "done": True}, {"label": "Draft the update", "done": True}, {"label": "Send it for review", "done": True}], "status": "done"})
    assert r["status"] == "in_review" and r["phase"] == "in_review"
    assert owner_sql(owner, w, "select review_owner_id r from pulse.task where id=%s", (tid,))[0]["r"] == w.manager
    assert any(n["subject_id"] == tid for n in notes(worker, w, w.manager, "task.done"))
    finish(api, w, agent, run)
    # An AI never accepts or returns work, its own or anyone's (refused before anything is read: task_review_check and
    # task_return name the AI session, behind "sign in as a team member").
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.task_review(%s,%s)", (tid, Jsonb({"quality": "good"})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.task_return(%s,'Not good (test)')", (tid,))
    # The reviewer returns it with a note: it picks the note up and sends it again.
    as_(api, w, w.manager, "select pulse.task_return(%s,'Add the RERA number (test)')", (tid,))
    run, ctx = look(api, w, agent)
    assert ctx["cause"] == "returned" and any(h["kind"] == "returned" and "RERA" in (h["note"] or "") for h in ctx["history"])
    r = act(api, w, agent, run, {"comment": "Added the RERA number.", "files": [{"name": "Update v2.md", "text": "# Weekly update v2 (test)\n"}], "status": "done"})
    assert r["status"] == "in_review"
    finish(api, w, agent, run)
    as_(api, w, w.manager, "select pulse.task_review(%s,%s)", (tid, Jsonb({"quality": "good"})))
    s = one(api, w, w.manager, "select pulse.agent_task_status(%s) s", (tid,))["s"]
    assert s["phase"] == "stopped" and s["runs"] == 4 and s["tokens"] == 4800 and len(s["plan"]) == 3 and all(x["done"] for x in s["plan"])
    tp = {a["id"]: a for a in one(api, w, w.manager, "select pulse.agent_task_throughput(14) t")["t"]["agents"]}
    a = tp[str(agent)]
    assert (a["given"], a["accepted"], a["returned"], a["subtasks"], a["runs"], a["tokens"]) == (1, 1, 1, 1, 4, 4800) and a["submitted"] >= 1
    assert one(api, w, w.editor, "select pulse.agent_task_throughput(14) t")["t"]["agents"] == [], "a colleague who manages no AI sees none"


def test_comments_wake_it_and_it_continues_and_looks_daily(api, worker, owner, team):  # noqa: F811
    w = team
    agent = ai(api, owner, w)
    tid = new_task(api, w, w.editor2, title="Research a competitor's launch campaign (test)", assigneeId=str(agent), priority="high")
    run, _ = look(api, w, agent)
    act(api, w, agent, run, {"plan": ["Collect what we know", "Write the summary"], "comment": "Plan set.", "status": "working"})
    finish(api, w, agent, run)
    # Its own comments never wake it; a colleague's does.
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_event where agent_id=%s and state='queued'", (agent,))[0]["n"] == 0
    as_(api, w, w.editor2, "select pulse.work_comment_post(%s)", (Jsonb({"taskId": str(tid), "body": "Focus on their Instagram reels (test)"}),))
    run, ctx = look(api, w, agent)
    assert ctx["cause"] == "comment" and [c["body"] for c in ctx["thread"] if c["new"] and not c["mine"]] == ["Focus on their Instagram reels (test)"]
    act(api, w, agent, run, {"comment": "Noted, reels first.", "status": "working", "continue": True})
    nxt = owner_sql(owner, w, "select event_key, retry_at > now() later from pulse.agent_event where agent_id=%s and state='queued'", (agent,))
    assert len(nxt) == 1 and ":continue:" in nxt[0]["event_key"] and nxt[0]["later"]
    finish(api, w, agent, run)
    # The daily look: nothing while something is queued or it worked on the task lately; an idle task once a day.
    hour = datetime.now(ZoneInfo(owner_sql(owner, w, "select pulse.org_time_zone() z")[0]["z"])).hour
    daily = lambda: agent_one(api, w, agent, "select pulse.agent_tasks_daily() r")["r"]  # noqa: E731
    if hour < 9:
        assert daily() == {"queued": 0, "why": "before working hours"}
        return
    assert daily() == {"queued": 0}
    owner_sql(owner, w, "update pulse.agent_event set state='done' where agent_id=%s and state='queued'", (agent,))
    owner_sql(owner, w, "update pulse.agent_task_work set updated_at=now()-interval '2 days' where task_id=%s", (tid,))
    owner_sql(owner, w, "update pulse.task set updated_at=now()-interval '2 days' where id=%s", (tid,))
    assert daily() == {"queued": 1}
    owner_sql(owner, w, "update pulse.agent_event set state='done' where agent_id=%s and state='queued'", (agent,))
    assert daily() == {"queued": 0}, "once a task a day"
    q = one(api, w, w.manager, "select pulse.agent_task_queue(%s) q", (agent,))["q"]
    assert [x["id"] for x in q] == [str(tid)] and q[0]["steps"] == 2


def test_follow_ups_for_colleagues_do_not_hold_its_task(api, worker, owner, team):  # noqa: F811
    w = team
    agent = ai(api, owner, w)
    tid = new_task(api, w, w.editor2, title="Summarise the shoot day and create follow-ups (test)", assigneeId=str(agent))
    run, _ = look(api, w, agent)
    r = act(api, w, agent, run, {"comment": "Summary attached; follow-ups made.", "files": [{"name": "Shoot summary", "text": "# Summary (test)"}],
                                 "followups": [{"title": "Send the drone footage to the client (test)", "assignee": "user1x", "dueOn": "2026-11-03", "notes": "From the shoot."},
                                               {"title": "Send the drone footage to the client (test)", "assignee": "user1x"}, {"title": "Nobody (test)", "assignee": "nobody.here"}],
                                 "status": "done"})
    assert r["status"] == "in_review", "follow-ups do not hold the task (1097)"
    assert [f["title"] for f in r["followups"]] == ["Send the drone footage to the client (test)"]
    assert sorted(x["why"] for x in r["skipped"]) == ["already made", "no active colleague by that username"]
    f = owner_sql(owner, w, "select parent_id, assignee_person_id a, review_owner_id rv, created_by c, notes from pulse.task where id=%s", (r["followups"][0]["id"],))[0]
    assert f["parent_id"] is None and f["a"] == w.editor and f["rv"] == w.editor2 and f["c"] == agent and str(tid) in f["notes"]
    assert any(str(n["subject_id"]) == r["followups"][0]["id"] for n in notes(worker, w, w.editor, "task.assigned"))
    finish(api, w, agent, run)


def test_a_client_message_is_a_card_for_its_approver_and_an_internal_group_gets_the_post(api, worker, owner, team):  # noqa: F811
    w = team
    agent = ai(api, owner, w)
    client_room = one(api, w, w.manager, "select pulse.chat_group_create('Client room (test)',%s) id", ([w.editor],))["id"]
    team_room = one(api, w, w.manager, "select pulse.chat_group_create('Team room (test)',%s) id", ([w.editor],))["id"]
    for g in (client_room, team_room):
        as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (g, agent))
    client = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Ashby Rook (test client)','client')", (client, w.org))
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, client_room, client))
    owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'RERA P52100012345 is on the hoarding; call me on +91 98765 43210 (test)',%s)",
              (w.org, client_room, client, uuid.uuid4()))
    tid = new_task(api, w, w.manager, title="Tell the Client room the update is ready (test)", assigneeId=str(agent))
    run, ctx = look(api, w, agent)
    assert any(g["id"] == str(client_room) and g["withClient"] for g in ctx["groups"]), "the group the task names is in its context"
    said = [m["body"] for g in ctx["groups"] for m in g["messages"]]
    assert any("RERA P52100012345" in x and "[phone]" in x and "98765" not in x for x in said), "phone numbers masked, RERA numbers kept (1096)"
    r = act(api, w, agent, run, {"comment": "Drafted the message for the client.", "post": {"channel": str(client_room), "text": "Hi Ashby, this week's update is ready (test).", "why": "They asked weekly."}, "status": "working"})
    assert r["cards"] == 1 and r["posted"] is False
    card = owner_sql(owner, w, "select approver_id, channel_id, state, kind from pulse.agent_proposal where agent_id=%s", (agent,))
    assert card == [{"approver_id": w.manager, "channel_id": client_room, "state": "pending", "kind": "reply"}]
    assert owner_sql(owner, w, "select count(*) n from pulse.chat_message where channel_id=%s and author_id=%s", (client_room, agent))[0]["n"] == 0, "nothing reaches the client by itself"
    finish(api, w, agent, run)
    as_(api, w, w.manager, "select pulse.work_comment_post(%s)", (Jsonb({"taskId": str(tid), "body": "Also tell the team room (test)"}),))
    run, _ = look(api, w, agent)
    r = act(api, w, agent, run, {"post": {"channel": str(team_room), "text": "The weekly update is out for review (test)."}, "status": "working"})
    assert r["posted"] is True and r["cards"] == 0
    assert owner_sql(owner, w, "select count(*) n from pulse.chat_message where channel_id=%s and author_id=%s", (team_room, agent))[0]["n"] == 1
    finish(api, w, agent, run)
    # Outside its runs, or on a task that is not its own, it can do nothing.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        act(api, w, agent, run, {"comment": "Late (test)"})
