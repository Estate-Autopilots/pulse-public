"""AI-EMP-2 (1056): what an AI employee follows up by itself, always through a person. A card nobody decides gets one
reminder to its approver (quoting the card, so "fine, send it" still decides it), then a leader of that conversation is
asked; a client quiet for three days while we wait on them becomes a follow-up card; a missed call from a client becomes
work for the group's AI employee; urgent cards say so; the workload view is for leaders and the AI's managers.
Synthetic people only."""
import uuid

import psycopg
import pytest
from test_agent_coworkers import agent_one, as_agent, lead, make_agent, owner_sql
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def world(api, worker, owner, w):
    agent, _ = make_agent(api, w, "follow-up-agent")
    owner_sql(owner, w, """update pulse.agent_member set speak_scope='its_groups', tools=array['chats','tasks'],
        autonomy='{"group":"approve","direct":"approve","mention":"approve"}' where person_id=%s""", (agent,))
    lead(worker, w, w.lead)
    group = one(api, w, w.manager, "select pulse.chat_group_create('Client room (test)',%s) id", ([w.editor, w.lead],))["id"]
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (group, agent))
    client = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Ashby Rook (test client)','client')", (client, w.org))
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, group, client))
    # Working hours all day, every day, so the test does not depend on when it runs.
    owner_sql(owner, w, """insert into pulse.hr_policy(org_id,work_days,shift_start,shift_end) values(%s,'{1,2,3,4,5,6,7}','00:00','23:59:59')
        on conflict (org_id) do update set work_days=excluded.work_days, shift_start=excluded.shift_start, shift_end=excluded.shift_end""", (w.org,))
    return agent, group, client


def card(owner, w, agent, group, src, approver, body, age="2 hours"):
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (agent, approver))[0]["id"]
    msg = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'The card (test)',%s) returning id", (w.org, dm, agent, uuid.uuid4()))[0]["id"]
    pid = owner_sql(owner, w, f"""insert into pulse.agent_proposal(org_id,agent_id,channel_id,source_message_id,approver_id,dm_channel_id,dm_message_id,kind,body,why,created_at)
        values(%s,%s,%s,%s,%s,%s,%s,'reply',%s,'They asked.',now()-interval '{age}') returning id""", (w.org, agent, group, src, approver, dm, msg, body))[0]["id"]
    return pid, dm, msg


def follow(api, w, agent):
    return agent_one(api, w, agent, "select pulse.agent_follow_up(null) r")["r"]


def test_a_card_nobody_decides_is_reminded_then_a_leader_decides_it(api, worker, owner, team):  # noqa: F811
    w = team
    agent, group, client = world(api, worker, owner, w)
    src = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id,created_at) values(%s,%s,%s,'Can you resend the brochure? (test)',%s,now()-interval '2 hours') returning id",
                    (w.org, group, client, uuid.uuid4()))[0]["id"]
    pid, dm, msg = card(owner, w, agent, group, src, w.manager, "Here is the brochure again (test).")
    assert follow(api, w, agent) == {"reminded": 1, "escalated": 0, "quiet": 0}
    last = owner_sql(owner, w, "select body, quote_id from pulse.chat_message where channel_id=%s order by created_at desc limit 1", (dm,))[0]
    assert last["quote_id"] == msg and "Ashby Rook (test client) has had no answer" in last["body"]
    assert follow(api, w, agent) == {"reminded": 0, "escalated": 0, "quiet": 0}, "one reminder, and no escalation right after it"
    owner_sql(owner, w, "update pulse.agent_proposal set created_at=now()-interval '5 hours', reminded_at=now()-interval '30 minutes' where id=%s", (pid,))
    assert follow(api, w, agent)["escalated"] == 1
    esc = owner_sql(owner, w, "select escalated_to, escalation_message_id from pulse.agent_proposal where id=%s", (pid,))[0]
    assert esc["escalated_to"] == w.lead, "a leader of that conversation, never the approver again"
    edm = owner_sql(owner, w, "select channel_id from pulse.chat_message where id=%s", (esc["escalation_message_id"],))[0]["channel_id"]
    # The leader answers in words in their own direct message with the AI: the card is decided and posted.
    as_(api, w, w.lead, "select pulse.chat_send(%s,'fine, send it',null,'[]',%s,null)", (edm, uuid.uuid4()))
    done = owner_sql(owner, w, "select state, decided_by, decided_via, posted_message_id is not null posted from pulse.agent_proposal where id=%s", (pid,))[0]
    assert done == {"state": "sent", "decided_by": w.lead, "decided_via": "reply", "posted": True}
    assert follow(api, w, agent) == {"reminded": 0, "escalated": 0, "quiet": 0}


def test_the_approvers_reply_after_a_reminder_still_decides_the_card(api, worker, owner, team):  # noqa: F811
    w = team
    agent, group, client = world(api, worker, owner, w)
    src = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'When is the shoot? (test)',%s) returning id", (w.org, group, client, uuid.uuid4()))[0]["id"]
    pid, dm, _ = card(owner, w, agent, group, src, w.manager, "Saturday at 9 (test).")
    assert follow(api, w, agent)["reminded"] == 1
    as_(api, w, w.manager, "select pulse.chat_send(%s,'ok send',null,'[]',%s,null)", (dm, uuid.uuid4()))
    assert owner_sql(owner, w, "select state, decided_via from pulse.agent_proposal where id=%s", (pid,)) == [{"state": "sent", "decided_via": "reply"}]


def test_an_urgent_card_is_reminded_after_fifteen_minutes_and_a_fresh_one_is_left_alone(api, worker, owner, team):  # noqa: F811
    w = team
    agent, group, client = world(api, worker, owner, w)
    src = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'URGENT wrong number on the hoarding (test)',%s) returning id", (w.org, group, client, uuid.uuid4()))[0]["id"]
    fresh, _, _ = card(owner, w, agent, group, src, w.manager, "Fresh (test).", age="5 minutes")
    urgent, _, _ = card(owner, w, agent, group, src, w.manager, "We are holding the print (test).", age="20 minutes")
    owner_sql(owner, w, "update pulse.agent_proposal set urgent=true where id=%s", (urgent,))
    assert follow(api, w, agent)["reminded"] == 1
    assert owner_sql(owner, w, "select id from pulse.agent_proposal where reminded_at is not null and agent_id=%s", (agent,)) == [{"id": urgent}]
    assert owner_sql(owner, w, "select reminded_at from pulse.agent_proposal where id=%s", (fresh,)) == [{"reminded_at": None}]


def test_a_quiet_client_becomes_a_follow_up_card_once(api, worker, owner, team):  # noqa: F811
    w = team
    agent, group, client = world(api, worker, owner, w)
    owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id,created_at) values(%s,%s,%s,'Sure, will send (test)',%s,now()-interval '5 days')", (w.org, group, client, uuid.uuid4()))
    ours = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id,created_at) values(%s,%s,%s,'Could you share the RERA number? (test)',%s,now()-interval '4 days') returning id",
                     (w.org, group, w.manager, uuid.uuid4()))[0]["id"]
    assert follow(api, w, agent)["quiet"] == 1
    assert follow(api, w, agent)["quiet"] == 0, "once per waiting message"
    [c] = agent_one(api, w, agent, "select pulse.agent_events_claim_kinds(5,false) e")["e"]
    assert c["event"]["eventType"] == "client.silent" and c["event"]["subjectId"] == str(ours)
    d = agent_one(api, w, agent, "select pulse.agent_own_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"]
    assert d["status"] == "dispatched" and d["context"]["kind"] == "client.silent" and d["context"]["mode"] == "approve"
    assert d["context"]["own"]["quietDays"] == 4 and d["context"]["own"]["clientLast"]["body"] == "Sure, will send (test)"
    p = agent_one(api, w, agent, "select pulse.agent_propose_own(%s,%s,%s,%s) r", (d["runId"], "A gentle nudge on the RERA number (test).", "Quiet 4 days.", uuid.uuid4()))["r"]
    agent_one(api, w, agent, "select pulse.agent_proposal_urgent(%s) r", (d["runId"],))
    row = owner_sql(owner, w, "select pr.approver_id, pr.urgent, m.body from pulse.agent_proposal pr join pulse.chat_message m on m.id=pr.dm_message_id where pr.id=%s", (p["id"],))[0]
    assert row["approver_id"] == w.manager and row["urgent"] is True and row["body"].startswith("Follow-up in “Client room (test)”")
    # Nothing was posted in the client's group.
    assert owner_sql(owner, w, "select count(*) n from pulse.chat_message where channel_id=%s and author_id=%s", (group, agent)) == [{"n": 0}]


def test_a_missed_client_call_is_work_for_the_groups_ai_employee(api, worker, owner, team):  # noqa: F811
    w = team
    agent, group, client = world(api, worker, owner, w)
    line = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'Voice call',%s) returning id", (w.org, group, client, uuid.uuid4()))[0]["id"]
    call = owner_sql(owner, w, "insert into pulse.chat_call(org_id,channel_id,started_by,message_id) values(%s,%s,%s,%s) returning id", (w.org, group, client, line))[0]["id"]
    owner_sql(owner, w, "update pulse.chat_call set state='ended', end_reason='missed', ended_at=now() where id=%s", (call,))
    ev = owner_sql(owner, w, "select event_type, subject_id, invoked_by from pulse.agent_event where agent_id=%s and event_key=%s", (agent, f"call-missed:{call}"))
    assert ev == [{"event_type": "call.missed", "subject_id": line, "invoked_by": client}]
    # A staff member's own unanswered call is not "a client called".
    line2 = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'Voice call',%s) returning id", (w.org, group, w.editor, uuid.uuid4()))[0]["id"]
    call2 = owner_sql(owner, w, "insert into pulse.chat_call(org_id,channel_id,started_by,message_id) values(%s,%s,%s,%s) returning id", (w.org, group, w.editor, line2))[0]["id"]
    owner_sql(owner, w, "update pulse.chat_call set state='ended', end_reason='missed', ended_at=now() where id=%s", (call2,))
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_event where event_key=%s", (f"call-missed:{call2}",)) == [{"n": 0}]


def test_the_workload_is_for_leaders_and_the_ais_managers(api, worker, owner, team):  # noqa: F811
    w = team
    agent, group, client = world(api, worker, owner, w)
    src = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'Hello (test)',%s) returning id", (w.org, group, client, uuid.uuid4()))[0]["id"]
    card(owner, w, agent, group, src, w.manager, "Hi (test).", age="10 minutes")
    mine = one(api, w, w.manager, "select pulse.agent_workload(null) w")["w"]
    a = next(x for x in mine["agents"] if x["id"] == str(agent))
    assert a["cards"]["made"] == 1 and a["cards"]["waiting"] == 1 and a["waitingCards"][0]["client"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_workload(null)")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, agent, "select pulse.agent_workload(null)")


def test_a_recorded_client_call_becomes_a_recap_card_for_the_groups_ai(api, worker, owner, team):  # noqa: F811
    """1057 (on CALLS-V2's 1033): a client call's transcript is done → the group's AI employee gets call.recorded with the
    transcript in its context; with the company's AI notes off, nothing."""
    w = team
    if not owner_sql(owner, w, "select to_regprocedure('pulse.agent_call_recorded()') is not null ok")[0]["ok"]:
        pytest.skip("1057 (on CALLS-V2's 1033) is not in this tree")
    agent, group, _client = world(api, worker, owner, w)

    def recording(transcript):
        line = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'Call recording',%s) returning id", (w.org, group, w.manager, uuid.uuid4()))[0]["id"]
        call = owner_sql(owner, w, "insert into pulse.chat_call(org_id,channel_id,started_by,message_id,state,answered_at,ended_at,end_reason) values(%s,%s,%s,%s,'ended',now(),now(),'completed') returning id",
                         (w.org, group, w.manager, line))[0]["id"]
        rec = owner_sql(owner, w, """insert into pulse.chat_call_recording(org_id,call_id,channel_id,started_by,state,seconds,message_id,transcript_state,transcript)
            values(%s,%s,%s,%s,'saved',540,%s,'working',%s) returning id""", (w.org, call, group, w.manager, line, transcript))[0]["id"]
        owner_sql(owner, w, "update pulse.chat_call_recording set transcript_state='done' where id=%s", (rec,))
        return line, rec

    line, rec = recording("Manager: Reel 3 by Friday. Client: yes, and call me on 98765 43210 about the brochure. (test)")
    ev = owner_sql(owner, w, "select event_type, subject_id from pulse.agent_event where agent_id=%s and event_key=%s", (agent, f"call-recorded:{rec}"))
    assert ev == [{"event_type": "call.recorded", "subject_id": line}]
    [c] = agent_one(api, w, agent, "select pulse.agent_events_claim_kinds(5,false) e")["e"]
    d = agent_one(api, w, agent, "select pulse.agent_own_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"]
    own = d["context"]["own"]
    assert d["context"]["kind"] == "call.recorded" and own["minutes"] == 9.0 and "Reel 3 by Friday" in own["transcript"]
    assert "98765" not in own["transcript"], "phone numbers are masked before an engine sees them"
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',0,0,null) r", (d["runId"],))
    owner_sql(owner, w, """insert into pulse.chat_call_policy(org_id,ai_summary) values(%s,'off') on conflict (org_id) do update set ai_summary='off'""", (w.org,))
    _, rec2 = recording("Nothing for the AI (test).")
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_event where event_key=%s", (f"call-recorded:{rec2}",)) == [{"n": 0}]
