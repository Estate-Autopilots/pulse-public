"""AI-AUTONOMY (1410): unanswered questions gather in ONE waiting list per approver a day (no new question that swallows
the approver's next message); a new colleague's profile and join link, and a file for HR documents, each as one card that
an admin or HR applies; nothing for the wrong people or across organisations. Synthetic only."""
import json
import uuid

import psycopg
import pytest
from helpers import build_world
from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_hr_suite import _staff
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def run_of(api, owner, w, agent, who=None):
    who = who or w.manager
    owner_sql(owner, w, "update pulse.agent_member set listens_to='everyone', tools=array['chats','tasks','memory','projects'] where person_id=%s", (agent,))
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (agent, who))[0]["id"]
    as_(api, w, who, "select pulse.chat_send(%s,%s,null,'[]',%s,null)", (dm, f"Please help (test) {uuid.uuid4()}", uuid.uuid4()))
    [c] = agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]
    d = agent_one(api, w, agent, "select pulse.agent_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"]
    return d, dm


def finish(api, w, agent, run):
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',0,0,null) r", (run,))


def test_unanswered_questions_gather_in_one_message_per_approver(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "digest-test")
    ed = owner_sql(owner, w, "select username from pulse.people_profile where person_id=%s", (w.editor,))[0]["username"]
    asked = []
    for i in range(2):
        d, _ = run_of(api, owner, w, agent)
        asked.append(agent_one(api, w, agent, "select pulse.agent_consult_ask(%s,%s,%s,%s) r", (d["runId"], ed, f"When is reel {i} due? (test)", uuid.uuid4()))["r"])
        finish(api, w, agent, d["runId"])
    owner_sql(owner, w, "update pulse.agent_consult set created_at=now()-interval '7 hours', nudged_at=now()-interval '5 hours' where agent_id=%s", (agent,))
    s = agent_one(api, w, agent, "select pulse.agent_consults_sweep() r")["r"]
    assert s["escalated"] == 2
    rows = owner_sql(owner, w, "select message_id, jsonb_array_length(items) n from pulse.agent_waiting_digest where agent_id=%s", (agent,))
    assert len(rows) == 1 and rows[0]["n"] == 2, "one list a day per approver"
    body = owner_sql(owner, w, "select body from pulse.chat_message where id=%s", (rows[0]["message_id"],))[0]["body"]
    assert "Still waiting on colleagues (2)" in body and "reel 0" in body and "reel 1" in body
    assert owner_sql(owner, w, "select count(*)::int n from pulse.agent_consult where agent_id=%s and escalated_from is not null", (agent,))[0]["n"] == 0, \
        "no new question for the approver to 'answer'"
    # The approver's next message is a message of their own, not an answer to an old question.
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (agent, w.manager))[0]["id"]
    as_(api, w, w.manager, "select pulse.chat_send(%s,'New request: call the editor (test)',null,'[]',%s,null)", (dm, uuid.uuid4()))
    kinds = [c["event"]["eventType"] for c in agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]]
    assert kinds == ["chat.message"]


def test_a_new_colleague_is_one_card_an_admin_or_hr_applies(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "hr-cards-test")
    owner_sql(owner, w, "update pulse.agent_member set owner_person_id=%s, approver_person_id=%s where person_id=%s", (w.editor, w.editor, agent))
    d, _ = run_of(api, owner, w, agent)
    card = agent_one(api, w, agent, "select pulse.agent_propose_person(%s,%s::jsonb) r",
                     (d["runId"], json.dumps({"name": "Tanvi Shah (test)", "title": "Video Editor", "email": "tanvi@example.test", "startsOn": "2026-11-02"})))["r"]
    pr = owner_sql(owner, w, "select kind, state, approver_id from pulse.agent_proposal where id=%s", (card["id"],))[0]
    assert pr["kind"] == "person" and pr["state"] == "pending" and pr["approver_id"] == w.editor
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="admin or HR"):
        as_(api, w, w.editor, "select pulse.agent_proposal_decide(%s,'send',null,'button')", (card["id"],))
    r = one(api, w, w.manager, "select pulse.agent_proposal_decide(%s,'send',null,'button') r", (card["id"],))["r"]
    assert r["state"] == "sent" and r["username"]
    got = owner_sql(owner, w, "select p.display_name, pp.role, pp.email from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=%s", (r["personId"],))[0]
    assert got == {"display_name": "Tanvi Shah (test)", "role": "Video Editor", "email": "tanvi@example.test"}
    sent = owner_sql(owner, w, "select sent_body from pulse.agent_proposal where id=%s", (card["id"],))[0]["sent_body"]
    assert "/join#" in sent
    assert owner_sql(owner, w, "select count(*)::int n from pulse_priv.org_invite where org_id=%s", (w.org,))[0]["n"] >= 1
    with pytest.raises(psycopg.errors.UniqueViolation):
        agent_one(api, w, agent, "select pulse.agent_propose_person(%s,%s::jsonb) r", (d["runId"], json.dumps({"name": "Tanvi Shah (test)"})))


def test_a_file_sent_to_it_is_filed_in_hr_documents_through_one_card(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "doc-cards-test")
    d, dm = run_of(api, owner, w, agent)
    fid = owner_sql(owner, w, "insert into pulse_priv.chat_file(org_id,channel_id,person_id,name,mime,bytes) values(%s,%s,%s,'Offer letter (test).pdf','application/pdf','%%PDF-1.4 test') returning id",
                    (w.org, dm, w.manager))[0]["id"]
    ed = owner_sql(owner, w, "select username from pulse.people_profile where person_id=%s", (w.editor,))[0]["username"]
    card = agent_one(api, w, agent, "select pulse.agent_propose_document(%s,%s::jsonb) r", (d["runId"], json.dumps({"fileId": str(fid), "person": ed, "docType": "offer_letter"})))["r"]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="file someone sent you"):
        agent_one(api, w, agent, "select pulse.agent_propose_document(%s,%s::jsonb) r", (d["runId"], json.dumps({"fileId": str(uuid.uuid4()), "person": ed})))
    # HR (with document rights) files it; someone without them is told to ask HR.
    r = one(api, w, w.lead, "select pulse.agent_proposal_decide(%s,'send',null,'button') r", (card["id"],))["r"]
    assert r["state"] == "sent"
    docs = one(api, w, w.lead, "select coalesce(jsonb_agg(jsonb_build_object('t', doc_type, 'n', file_name)), '[]') d from pulse.hr_documents_read(%s)", (w.editor,))["d"]
    assert docs == [{"t": "offer_letter", "n": "Offer letter (test).pdf"}]
    # Another organisation's AI employee cannot name this file.
    other = build_world(worker, owner, api)
    _staff(worker, other)
    ag2, _ = make_agent(api, other, "doc-cards-other")
    d2, _ = run_of(api, owner, other, ag2)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        agent_one(api, other, ag2, "select pulse.agent_propose_document(%s,%s::jsonb) r", (d2["runId"], json.dumps({"fileId": str(fid), "person": ed})))


def test_only_a_waiting_question_takes_the_colleagues_next_message_as_its_answer(api, worker, owner, team):  # noqa: F811
    """1411: once the colleague answered, their next message is a new request of their own (battery 08)."""
    w = team
    agent, _ = make_agent(api, w, "answer-open-test")
    owner_sql(owner, w, "update pulse.agent_member set listens_to='everyone' where person_id=%s", (agent,))
    ed = owner_sql(owner, w, "select username from pulse.people_profile where person_id=%s", (w.editor,))[0]["username"]
    d, _ = run_of(api, owner, w, agent)
    q = agent_one(api, w, agent, "select pulse.agent_consult_ask(%s,%s,'When is the reel due? (test)',%s) r", (d["runId"], ed, uuid.uuid4()))["r"]
    finish(api, w, agent, d["runId"])
    as_(api, w, w.editor, "select pulse.chat_send(%s,'Friday (test)',null,'[]',%s,null)", (q["chatId"], uuid.uuid4()))
    as_(api, w, w.editor, "select pulse.chat_send(%s,'Also, can you file my resume? (test)',null,'[]',%s,null)", (q["chatId"], uuid.uuid4()))
    kinds = [c["event"]["eventType"] for c in agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]]
    assert kinds == ["consult.answer", "chat.message"]


def test_a_one_card_proposal_gets_its_reminder_and_no_escalation(api, worker, owner, team):  # noqa: F811
    """1440: a triage card (batch) left undecided gets one reminder to its approver in working hours, never an escalation."""
    w = team
    agent, _ = make_agent(api, w, "batch-remind-test")
    owner_sql(owner, w, "update pulse.agent_member set access='operations' where person_id=%s", (agent,))
    owner_sql(owner, w, """insert into pulse.hr_policy(org_id,work_days,shift_start,shift_end) values(%s,'{1,2,3,4,5,6,7}','00:00','23:59:59')
        on conflict (org_id) do update set work_days=excluded.work_days, shift_start=excluded.shift_start, shift_end=excluded.shift_end""", (w.org,))
    t1 = one(api, w, w.manager, "select pulse.task_save(null,'{\"title\": \"Unowned (test)\"}') id")["id"]
    d, _ = run_of(api, owner, w, agent)
    card = agent_one(api, w, agent, "select pulse.agent_propose_batch(%s,%s::jsonb) r", (d["runId"], json.dumps({"items": [{"taskId": str(t1), "dueOn": "2026-11-05"}]})))["r"]
    finish(api, w, agent, d["runId"])
    owner_sql(owner, w, "update pulse.agent_proposal set created_at=now()-interval '5 hours' where id=%s", (card["id"],))
    assert agent_one(api, w, agent, "select pulse.agent_follow_up(null) r")["r"]["reminded"] == 1
    last = owner_sql(owner, w, "select body from pulse.chat_message where channel_id=%s order by created_at desc limit 1", (card["chatId"],))[0]["body"]
    assert "Still waiting for you" in last and "Apply, or Don't" in last
    owner_sql(owner, w, "update pulse.agent_proposal set created_at=now()-interval '30 hours', reminded_at=now()-interval '1 hour' where id=%s", (card["id"],))
    assert agent_one(api, w, agent, "select pulse.agent_follow_up(null) r")["r"]["escalated"] == 0
