"""EST-1035 (0510): AI co-workers inside a company's Pulse, leaders first, against plan revision 3 and the slice-1
review. An agent never signs in and holds no role; its key works only in its own session; a leader's own message wakes
it once; dispatch re-checks the invocation and reserves capacity before any model call; it answers only in that run's
conversation; a dispatched event is never handed out again; hand-offs need a leader's acceptance. Synthetic only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def as_agent(api, w, agent, sql, args=()):
    """The agent's own session, the way the API's agent route opens it after checking the key."""
    with api.transaction():
        set_tenant(api, w.org, agent)
        api.execute("select set_config('pulse.agent_session','on',true)")
        return api.execute(sql, args).fetchall()


def agent_one(api, w, agent, sql, args=()):
    return as_agent(api, w, agent, sql, args)[0]


def make_agent(api, w, username="pulse-ceo", **caps):
    agent = one(api, w, w.manager, "select pulse.agent_create(%s) id",
                (Jsonb({"name": username.replace("-", " ").title(), "username": username, "title": "CEO agent",
                        "ownerId": str(w.manager), "lane": "quick", **caps}),))["id"]
    key = one(api, w, w.manager, "select pulse.agent_key_issue(%s,'runner') k", (agent,))["k"]
    return agent, key


def ask(api, w, who, channel, text):
    return one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]',%s,null) id", (channel, text, uuid.uuid4()))["id"]


def claim(api, w, agent):
    return agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]


def dispatch(api, w, agent, c):
    return agent_one(api, w, agent, "select pulse.agent_dispatch(%s,%s,'quick','gpt-6-luna') d", (c["event"]["id"], c["leaseToken"]))["d"]


def owner_sql(owner, w, sql, args=()):
    with owner.transaction():
        set_tenant(owner, w.org)
        cur = owner.execute(sql, args)
        return cur.fetchall() if cur.description else None


def lead(worker, w, person, until=None):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from,valid_to) values (%s,%s,'leadership','2026-01-01',%s)", (w.org, person, until))


def test_identity_keys_and_no_way_to_act_as_a_person(api, worker, owner, team):  # noqa: F811
    w = team
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_create(%s)", (Jsonb({"name": "Mine", "username": "mine-agent"}),))
    agent, key = make_agent(api, w)
    assert key.startswith("pak_") and len(key) == 4 + 8 + 1 + 64
    resolve = lambda k: one(api, w, w.manager, "select pulse.agent_key_resolve(%s) a", (k,))["a"]  # noqa: E731
    assert resolve(key) == agent and resolve(key[:-1] + ("0" if key[-1] != "0" else "1")) is None
    assert one(api, w, w.manager, "select p.side, pp.username, pp.role from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=%s",
               (agent,)) == {"side": "agent", "username": "pulse-ceo", "role": "CEO agent"}
    # No password, Workspace account or device token; no role; no side change either way.
    with pytest.raises((psycopg.errors.InvalidParameterValue, psycopg.errors.InsufficientPrivilege)):
        as_(api, w, w.manager, "select pulse.login_issue(%s,'a-long-password-1')", (agent,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="does not sign in"):
        owner_sql(owner, w, "insert into pulse.login_credential(org_id,person_id,password_hash) values (%s,%s,'x')", (w.org, agent))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="does not sign in"):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) values (%s,%s,'google',%s,%s,'Workspace account')",
                           (uuid.uuid4(), w.org, f"agent@{w.domain}", agent))
    for role in ("admin", "leadership", "hr"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="holds no role"):
            with worker.transaction():
                set_tenant(worker, w.org)
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,%s,'2026-01-01')", (w.org, agent, role))
    lead(worker, w, w.editor2)  # ordinary staff grants are unchanged
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="never becomes"):
        owner_sql(owner, w, "update pulse.person set side='staff' where id=%s", (agent,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="never becomes"):
        owner_sql(owner, w, "update pulse.person set side='agent' where id=%s", (w.editor,))
    # Outside its own session it is nobody; the staff pickers never list it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, agent, "select pulse.agent_events_claim(5)")
    assert all(r["id"] != agent for r in as_(api, w, w.manager, "select id from pulse.work_people()"))
    # Admins see it with its keys; switched off its keys stop at once; expired, revoked and old keys fail.
    listed = one(api, w, w.manager, "select pulse.agent_list() a")["a"]
    assert [(x["username"], x["on"], [k["prefix"] for k in x["keys"]]) for x in listed] == [("pulse-ceo", True, [key[4:12]])]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_list()")
    one(api, w, w.manager, "select pulse.agent_switch(%s,false)", (agent,))
    assert resolve(key) is None
    one(api, w, w.manager, "select pulse.agent_switch(%s,true)", (agent,))
    assert resolve(key) == agent
    short = one(api, w, w.manager, "select pulse.agent_key_issue(%s,'short',1) k", (agent,))["k"]
    owner_sql(owner, w, "update pulse_priv.agent_key set expires_at=now()-interval '1 second' where prefix=%s", (short[4:12],))
    assert resolve(short) is None
    rotated = one(api, w, w.manager, "select pulse.agent_key_issue(%s,'rotated') k", (agent,))["k"]
    one(api, w, w.manager, "select pulse.agent_key_revoke(%s)", (key[4:12],))
    assert resolve(key) is None and resolve(rotated) == agent


def test_a_leaders_direct_message_is_dispatched_once_and_answered_only_there(api, worker, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "ops-agent")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.chat_direct(%s)", (agent,))
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    asked = ask(api, w, w.manager, dm, "Which releases are waiting on staging?")
    [c] = claim(api, w, agent)
    assert set(c) == {"event", "leaseToken", "leaseUntil", "lane"} and c["lane"] == "quick" and set(c["event"]) == {"id", "eventType", "subjectType", "subjectId", "eventKey", "createdAt"}
    assert c["event"]["eventType"] == "chat.message" and c["event"]["subjectId"] == str(asked)
    assert claim(api, w, agent) == []                                     # leased
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not leased to you"):
        agent_one(api, w, agent, "select pulse.agent_dispatch(%s,%s,'quick','m')", (c["event"]["id"], uuid.uuid4()))
    d = dispatch(api, w, agent, c)
    assert d["status"] == "dispatched" and d["reserved"] == 16000 and d["context"]["message"]["id"] == str(asked)
    assert [m["body"] for m in d["context"]["recent"]] == ["Which releases are waiting on staging?"]
    run = d["runId"]
    assert claim(api, w, agent) == []                                     # a dispatched event is never handed out again
    # Only that run's conversation: not another one, even a member one.
    other = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (w.editor,))["id"]
    ask(api, w, w.manager, other, "Private between people")
    assert {r["channel_id"] for r in as_agent(api, w, agent, "select channel_id from pulse.chat_message")} == {dm}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, agent, "select pulse.agent_chat_reply(%s,'Not here',null,%s,%s)", (other, uuid.uuid4(), run))
    client = uuid.uuid4()
    reply = agent_one(api, w, agent, "select pulse.agent_chat_reply(%s,'Two: v0.3.65 and the desktop build.',null,%s,%s) id", (dm, client, run))["id"]
    assert agent_one(api, w, agent, "select pulse.agent_chat_reply(%s,'Two: v0.3.65 and the desktop build.',null,%s,%s) id", (dm, client, run))["id"] == reply
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="key already used"):    # a conflicting retry fails
        as_agent(api, w, agent, "select pulse.agent_chat_reply(%s,'Something else',null,%s,%s)", (dm, client, run))
    done = agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',12410,6.2,null) r", (run,))["r"]
    assert done == {"usedToday": 12410, "dailyBudget": 160000, "reserve": 16000, "paused": False}
    # After the run, nothing more goes out on it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, agent, "select pulse.agent_chat_reply(%s,'Late',null,%s,%s)", (dm, uuid.uuid4(), run))
    with worker.transaction():
        set_tenant(worker, w.org)
        told = worker.execute("select person_id from pulse.notification where message_id=%s", (reply,)).fetchall()
    assert [t["person_id"] for t in told] == [w.manager]
    row = one(api, w, w.manager, "select e.state, r.tokens, r.seconds, r.state rs, (select count(*) from pulse.agent_event x where x.subject_id=%s) woke "
              "from pulse.agent_event e join pulse.agent_run r on r.id=e.run_id where e.subject_id=%s", (reply, asked))
    assert {**row, "seconds": float(row["seconds"])} == {"state": "done", "tokens": 12410, "seconds": 6.2, "rs": "done", "woke": 0}


def test_dispatch_rechecks_the_invocation_and_stale_runs_never_replay(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "check-agent")
    lead(worker, w, w.editor2)
    dm = one(api, w, w.editor2, "select pulse.chat_direct(%s) id", (agent,))["id"]
    # Demoted between asking and dispatch: refused, with the reason, and closed.
    ask(api, w, w.editor2, dm, "One for you")
    [c] = claim(api, w, agent)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.role_assignment set valid_to=current_date-1 where person_id=%s and role_key='leadership'", (w.editor2,))
    assert dispatch(api, w, agent, c) == {"status": "refused", "reason": "not_leader"}
    # Membership lost: refused too.
    dm2 = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm2, "Another one")
    [c] = claim(api, w, agent)
    owner_sql(owner, w, "delete from pulse.chat_member where channel_id=%s and person_id=%s", (dm2, agent))
    assert dispatch(api, w, agent, c)["reason"] == "agent_left"
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values (%s,%s,%s)", (w.org, dm2, agent))
    # A conversation with only failed events takes no answer.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, agent, "select pulse.agent_chat_reply(%s,'Hm',null,%s,%s)", (dm2, uuid.uuid4(), uuid.uuid4()))
    # A run past its deadline: no reply, then uncertain (keeping its reservation) and its event is never claimed again.
    ask(api, w, w.manager, dm2, "Third")
    [c] = claim(api, w, agent)
    d = dispatch(api, w, agent, c)
    owner_sql(owner, w, "update pulse.agent_run set deadline=now()-interval '1 second' where id=%s", (d["runId"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, agent, "select pulse.agent_chat_reply(%s,'Too late',null,%s,%s)", (dm2, uuid.uuid4(), d["runId"]))
    assert claim(api, w, agent) == []
    rs = owner_sql(owner, w, "select r.state, e.state es, r.reserved from pulse.agent_run r join pulse.agent_event e on e.id=r.event_id where r.id=%s", (d["runId"],))
    assert rs == [{"state": "uncertain", "es": "uncertain", "reserved": 16000}]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not running"):
        as_agent(api, w, agent, "select pulse.agent_run_finish(%s,'done',100,1,null)", (d["runId"],))
    # A run that wrote its answer and then went quiet is settled as done, with usage unknown.
    ask(api, w, w.manager, dm2, "Fourth")
    [c] = claim(api, w, agent)
    d = dispatch(api, w, agent, c)
    as_agent(api, w, agent, "select pulse.agent_chat_reply(%s,'Answered.',null,%s,%s)", (dm2, uuid.uuid4(), d["runId"]))
    owner_sql(owner, w, "update pulse.agent_run set deadline=now()-interval '1 second' where id=%s", (d["runId"],))
    claim(api, w, agent)
    assert owner_sql(owner, w, "select state, tokens from pulse.agent_run where id=%s", (d["runId"],)) == [{"state": "done", "tokens": None}]


def test_reservations_cap_the_day_one_run_at_a_time_and_an_overrun_is_flagged(api, worker, owner, team):  # noqa: F811
    w = team
    agent, key = make_agent(api, w, "budget-agent", runReserve=12000, dailyTokenBudget=30000)
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm, "First")
    ask(api, w, w.manager, dm, "Second")
    first, second = claim(api, w, agent)
    d1 = dispatch(api, w, agent, first)
    assert d1["status"] == "dispatched"
    assert dispatch(api, w, agent, second) == {"status": "busy", "reason": "one_at_a_time"}   # queued again
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',13000,7,null) r", (d1["runId"],))
    # 13,000 used against a 12,000 reservation: flagged (over_cap, below), but within a chat's budget (30,000 + 4,000),
    # so the co-worker stays on (1003); only a runaway pauses it (test_dispatch_settlement_and_pause_...).
    assert one(api, w, w.manager, "select pulse.agent_key_resolve(%s) a", (key,))["a"] is not None
    [still] = one(api, w, w.manager, "select pulse.agent_list() a")["a"]
    assert still["on"] is True and not still["pausedReason"]
    owner_sql(owner, w, "update pulse.agent_event set retry_at=null where id=%s", (second["event"]["id"],))
    [again] = claim(api, w, agent)
    d2 = dispatch(api, w, agent, again)                                    # 13,000 + 12,000 reserved fits 30,000
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',null,3,null) r", (d2["runId"],))   # usage unknown: the reservation counts
    ask(api, w, w.manager, dm, "Third")
    [third] = claim(api, w, agent)
    assert dispatch(api, w, agent, third) == {"status": "refused", "reason": "budget_spent"}
    assert owner_sql(owner, w, "select over_cap from pulse.agent_run where agent_id=%s order by started_at", (agent,)) == [{"over_cap": True}, {"over_cap": False}]


def test_group_mentions_replies_and_one_event_per_message(api, worker, owner, team):  # noqa: F811
    w = team
    a1, _ = make_agent(api, w, "first-agent")
    a2, _ = make_agent(api, w, "second-agent")
    group = one(api, w, w.manager, "select pulse.chat_group_create('Launch room',%s) id", ([w.editor],))["id"]
    # People's own group path still takes staff only; the leader's explicit path adds a co-worker; a member cannot.
    as_(api, w, w.manager, "select pulse.chat_group_members(%s,%s,'{}')", (group, [a1]))
    assert owner_sql(owner, w, "select count(*) n from pulse.chat_member where channel_id=%s and person_id=%s", (group, a1)) == [{"n": 0}]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_group_member(%s,%s,true)", (group, a1))
    for a in (a1, a2):
        as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (group, a))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (one(api, w, w.manager, "select pulse.chat_direct(%s) id", (w.editor,))["id"], a1))
    # A member mentioning wakes nobody; the leader mentioning both wakes each once.
    ask(api, w, w.editor, group, "@first-agent can you look?")
    both = ask(api, w, w.manager, group, "@first-agent and @second-agent, what shipped today?")
    got1, got2 = claim(api, w, a1), claim(api, w, a2)
    assert [(c["event"]["eventType"], c["event"]["subjectId"]) for c in got1] == [("chat.mention", str(both))]
    assert [(c["event"]["eventType"], c["event"]["subjectId"]) for c in got2] == [("chat.mention", str(both))]
    # The co-worker answers in the group; a leader's reply to that answer wakes it as a reply.
    d = dispatch(api, w, a1, got1[0])
    answer = agent_one(api, w, a1, "select pulse.agent_chat_reply(%s,'v0.3.64 went out.',null,%s,%s) id", (group, uuid.uuid4(), d["runId"]))["id"]
    agent_one(api, w, a1, "select pulse.agent_run_finish(%s,'done',12000,5,null) r", (d["runId"],))
    reply = one(api, w, w.manager, "select pulse.chat_send(%s,'And tomorrow?',%s,'[]',%s,null) id", (group, answer, uuid.uuid4()))["id"]
    assert [(c["event"]["eventType"], c["event"]["subjectId"]) for c in claim(api, w, a1)] == [("chat.reply", str(reply))]
    # A direct message that also mentions it wakes it once.
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (a2,))["id"]
    once = ask(api, w, w.manager, dm, "@second-agent quick one")
    assert [c["event"]["eventType"] for c in claim(api, w, a2) if c["event"]["subjectId"] == str(once)] == ["chat.message"]


def test_a_hand_off_becomes_work_only_when_a_leader_accepts_and_is_filed_once(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "handoff-agent")
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm, "Can you check the release train and write it up?")
    [c] = claim(api, w, agent)
    d = dispatch(api, w, agent, c)
    answer = agent_one(api, w, agent, "select pulse.agent_chat_reply(%s,'I can take that on. Hand it over?',null,%s,%s) id", (dm, uuid.uuid4(), d["runId"]))["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):            # only on its own answer, inside its run
        as_agent(api, w, agent, "select pulse.agent_handoff_propose(%s,%s,'Check','x')", (d["runId"], c["event"]["subjectId"]))
    handoff = agent_one(api, w, agent, "select pulse.agent_handoff_propose(%s,%s,'Check the release train','Which releases ran today') id", (d["runId"], answer))["id"]
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',12000,5,null) r", (d["runId"],))
    assert agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"] == []      # nothing until a leader accepts
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_handoff_decide(%s,true)", (handoff,))
    assert one(api, w, w.manager, "select pulse.agent_handoff_decide(%s,true) s", (handoff,))["s"] == "accepted"
    [h] = agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"]
    assert h["id"] == str(handoff) and h["title"] == "Check the release train"
    assert agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"] == []      # being filed
    client, token = uuid.uuid4(), h["filingToken"]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not being filed by you"):
        as_agent(api, w, agent, "select pulse.agent_handoff_filed(%s,%s,'EST-9999',%s)", (handoff, uuid.uuid4(), client))
    assert agent_one(api, w, agent, "select pulse.agent_handoff_filed(%s,%s,'EST-9999',%s) r", (handoff, token, client))["r"] == {"boardRef": "EST-9999", "state": "filed"}
    assert agent_one(api, w, agent, "select pulse.agent_handoff_filed(%s,%s,'EST-9999',%s) r", (handoff, token, client))["r"] == {"boardRef": "EST-9999", "state": "filed"}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already filed as EST-9999"):    # a conflicting board issue fails
        as_agent(api, w, agent, "select pulse.agent_handoff_filed(%s,%s,'EST-1234',%s)", (handoff, token, client))
    notes = owner_sql(owner, w, "select body from pulse.chat_message where channel_id=%s and author_id=%s and body like 'Handed over%%'", (dm, agent))
    assert notes == [{"body": "Handed over as EST-9999. I'll report back here for you to review."}]


API_SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const call = async (url, headers, payload) => { const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers, ...(payload ? { payload } : {}) }); return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 700)); process.exit(1); } };
const admin = { 'cf-access-authenticated-user-email': 'admin@estateautopilots.com' };
const member = { 'cf-access-authenticated-user-email': process.env.TEST_MEMBER };
const agentH = { 'x-pulse-agent-key': process.env.TEST_AGENT_KEY };
const agentId = process.env.TEST_AGENT;
let r = await call('/api/v0/chats', admin);
ok(r.status === 200 && r.body.people.some((p) => p.id === agentId && p.agent === true), 'leaders see the co-worker in Chats', r.status);
r = await call('/api/v0/chats', member);
ok(r.status === 200 && !r.body.people.some((p) => p.id === agentId), 'other people do not', r.status);
ok((await call('/api/v0/chats/direct', member, { personId: agentId })).status === 400, 'a member cannot open a conversation with it');
r = await call('/api/v0/chats/direct', admin, { personId: agentId });
ok(r.status === 200 && r.body.id, 'a leader opens a direct message', r); const dm = r.body.id;
r = await call(`/api/v0/chats/${dm}/messages`, admin, { body: 'Can you check how many releases went out today?', clientId: crypto.randomUUID() });
ok(r.status === 200 && r.body.id, 'the leader asks', r); const asked = r.body.id;
// The live stream: the open chat hears a co-worker's state change at once (no reload, no new message).
await app.listen({ port: 0, host: '127.0.0.1' });
const stream = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v0/chats/events`, { headers: admin });
const reader = stream.body.getReader(), dec = new TextDecoder();
let heard = '', pending = null;                                      // one read in flight: a timed-out wait never drops a chunk
const hear = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) {
  pending ??= reader.read();
  const got = await Promise.race([pending, new Promise((done) => setTimeout(() => done({ wait: true }), Math.max(1, end - Date.now())))]);
  if (got.wait) break; pending = null; if (got.done) break; heard += dec.decode(got.value); if (heard.includes(dm)) return true; } return false; };
await hear(2500); heard = '';                                         // the opening "all" event
// Mixed credentials are refused on people's routes; a person's session never acts as the agent.
ok((await call('/api/v0/chats', { ...admin, ...agentH })).status === 401, 'an agent key next to a person is refused');
for (const extra of [admin, { cookie: 'pulse_session=x' }, { 'x-pulse-session': 'a'.repeat(43) }, { authorization: 'Bearer ' + 'b'.repeat(43) }]) {
  ok((await call('/api/v0/agent/me', { ...agentH, ...extra })).status === 401, 'a person\'s credential next to the key is refused', Object.keys(extra));
}
ok((await call('/api/v0/agent/me', admin)).status === 401, 'a person is not an agent');
ok((await call('/api/v0/agent/me', { 'x-pulse-agent-key': 'pak_00000000_' + '0'.repeat(64) })).status === 401, 'an unknown key');
r = await call('/api/v0/agent/me', agentH);
ok(r.status === 200 && r.body.id === agentId && r.body.runReserve === 16000 && r.body.usedToday === 0, 'the agent knows itself and its caps', r);
r = await call('/api/v0/agent/events/claim', agentH, { limit: 5 });
ok(r.status === 200 && r.body.events.length === 1 && r.body.events[0].leaseUntil && r.body.events[0].event.subjectId === asked, 'the question arrives leased', r);
const { event, leaseToken } = r.body.events[0];
ok(await hear(6000), 'the open chat hears the co-worker pick the question up', heard); heard = '';
r = await call(`/api/v0/agent/events/${event.id}/dispatch`, agentH, { leaseToken, lane: 'quick', model: 'gpt-6-luna' });
ok(r.status === 200 && r.body.status === 'dispatched' && r.body.context.message.id === asked && r.body.context.message.channelKind === 'direct', 'dispatched with its context', r);
const run = r.body.runId;
ok((await call(`/api/v0/agent/events/${event.id}/dispatch`, agentH, { leaseToken, lane: 'quick' })).status === 400, 'a lease dispatches once');
r = await call(`/api/v0/chats/${dm}/messages`, admin);
const before = (Array.isArray(r.body) ? r.body : r.body.messages ?? []).find((m) => m.id === asked);
ok(before?.agentAsk?.state === 'dispatching', 'the leader sees the co-worker answering', before);
r = await call(`/api/v0/agent/chats/${dm}/messages`, agentH, { body: 'Two went out today: v0.3.63 and v0.3.64. Want me to write it up?', clientId: crypto.randomUUID(), runId: run });
ok(r.status === 200 && r.body.id, 'it answers in that conversation', r); const answer = r.body.id;
r = await call(`/api/v0/agent/runs/${run}/handoff`, agentH, { messageId: answer, title: 'Write up today\'s releases', details: 'Two releases, one note each' });
ok(r.status === 200 && r.body.id, 'it proposes a hand-off', r); const handoff = r.body.id;
ok(await hear(6000), 'the open chat hears the proposal', heard); heard = '';
r = await call(`/api/v0/agent/runs/${run}`, agentH, { state: 'done', tokens: null, seconds: 6.25 });
ok(r.status === 200 && r.body.usedToday === 16000, 'usage unknown: the reservation counts', r);
r = await call(`/api/v0/chats/${dm}/messages`, admin);
const list = Array.isArray(r.body) ? r.body : r.body.messages ?? [];
const said = list.find((m) => m.id === answer), q = list.find((m) => m.id === asked);
ok(said?.byAgent === true && said.agentRun?.lane === 'quick' && said.agentRun.model === 'gpt-6-luna' && said.agentRun.tokens === null && Number(said.agentRun.seconds) === 6.3 && said.agentRun.state === 'done', 'the answer shows its run (tokens unknown)', said);
ok(said?.handoff?.state === 'proposed' && q?.agentAsk?.state === 'done', 'the proposal and the answered question show', { said, q });
ok((await call(`/api/v0/chats/handoffs/${handoff}/decide`, member, { accept: true })).status === 403, 'a member cannot accept');
r = await call(`/api/v0/chats/handoffs/${handoff}/decide`, admin, { accept: true });
ok(r.status === 200 && r.body.state === 'accepted', 'a leader accepts', r);
r = await call('/api/v0/agent/handoffs/claim', agentH, {});
ok(r.status === 200 && r.body.handoffs.length === 1 && r.body.handoffs[0].id === handoff, 'the runner gets the accepted hand-off', r);
const filingToken = r.body.handoffs[0].filingToken;
r = await call(`/api/v0/agent/handoffs/${handoff}/filed`, agentH, { filingToken, boardRef: 'EST-9999', clientId: crypto.randomUUID() });
ok(r.status === 200 && r.body.state === 'filed', 'filed once', r);
// EST-1473: current-key isolation, clipping, replay and terminal cancellation in the actual HTTP path.
const updatePath = `/api/v0/agent/handoffs/${handoff}/updates`;
const update = { clientId: crypto.randomUUID(), state: 'started', text: 'x'.repeat(650) };
for (const headers of [{ 'x-pulse-agent-key': process.env.TEST_OTHER_KEY }, { 'x-pulse-agent-key': process.env.TEST_FOREIGN_KEY, 'x-pulse-host': 'relay-other.example' }]) {
  ok((await call(updatePath, headers, update)).status === 403, 'another agent/org cannot report work');
}
r = await call(`/api/v0/chats/${dm}/messages`, admin);
ok(!r.body.messages.some(m => m.handoffUpdate), 'refused reports wrote no messages', r);
const firstUpdate = await call(updatePath, agentH, update);
ok(firstUpdate.status === 200 && firstUpdate.body.id, 'started report accepted', firstUpdate);
ok((await call(updatePath, agentH, update)).body.id === firstUpdate.body.id, 'same client produces one row');
ok((await call(updatePath, agentH, { ...update, text: 'conflict' })).status === 400, 'conflicting replay refused');
ok((await call(updatePath, agentH, { ...update, clientId: crypto.randomUUID(), state: 'done' })).status === 400, 'done is not a report state');
r = await call(`/api/v0/chats/${dm}/messages`, admin);
const updates = r.body.messages.filter(m => m.handoffUpdate);
ok(updates.length === 1 && updates[0].body.length === 600 && updates[0].byAgent && updates[0].handoffUpdate.boardRef === 'EST-9999', 'one clipped AI update in same chat', updates);
const commentReport = { clientId: crypto.randomUUID(), state: 'progress', text: 'Checked once', commentId: crypto.randomUUID() };
const commentReply = await call(updatePath, agentH, commentReport);
ok(commentReply.status === 200, 'board comment delivered with its stable identity', commentReply);
ok((await call(updatePath, agentH, { clientId: crypto.randomUUID(), state: 'blocked', text: 'Waiting' })).status === 200, 'state change delivered');
ok((await call(updatePath, agentH, { ...commentReport, clientId: crypto.randomUUID() })).body.id === commentReply.body.id, 'fresh status UUID cannot duplicate an old comment');
r = await call(`/api/v0/chats/${dm}/messages`, admin);
ok(r.body.messages.filter(m => m.body === 'Checked once').length === 1, 'comment appears once across status change');
const cancel = { clientId: crypto.randomUUID(), state: 'cancelled', text: 'Cancelled.' };
ok((await call(updatePath, agentH, cancel)).status === 200, 'cancellation delivered');
ok((await call(updatePath, agentH, cancel)).status === 200, 'cancellation retry idempotent');
ok((await call(updatePath, agentH, { clientId: crypto.randomUUID(), state: 'progress', text: 'Late' })).status === 403, 'no update after cancelled');
ok((await call('/api/v0/agent/handoffs/poll', agentH, {})).body.handoffs.length === 0, 'cancelled stops polling');
// Admins list co-workers and revoke a key (it stops at once); nobody else may.
ok((await call('/api/v0/agents', member)).status === 403, 'only admins manage co-workers');
r = await call('/api/v0/agents', admin);
ok(r.status === 200 && r.body.agents.some((x) => x.id === agentId && x.keys.length === 1), 'admins see co-workers and their keys', r);
const prefix = process.env.TEST_AGENT_KEY.slice(4, 12);
ok((await call(`/api/v0/agents/keys/${prefix}/revoke`, member, {})).status === 403, 'a member cannot revoke');
ok((await call(`/api/v0/agents/keys/${prefix}/revoke`, admin, {})).status === 200, 'an admin revokes the key');
ok((await call('/api/v0/agent/me', agentH)).status === 401, 'a revoked key stops at once');
await reader.cancel();
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def test_the_agent_api_end_to_end(worker, owner, api, team):  # noqa: F811
    import json
    import os
    import subprocess
    from pathlib import Path

    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    agent, key = make_agent(api, w, "release-agent")
    _, other_key = make_agent(api, w, "other-agent")
    from helpers import build_world
    from test_hr_suite import _staff
    foreign = build_world(worker, owner, api)
    _staff(worker, foreign)
    _, foreign_key = make_agent(api, foreign, "foreign-agent")
    owner_sql(owner, foreign, "insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,'relay-other.example','password','synthetic')", (foreign.org,))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_OTHER_KEY": other_key, "TEST_FOREIGN_KEY": foreign_key, "TEST_MEMBER": w.editor_handle, "TEST_AGENT": str(agent), "TEST_AGENT_KEY": key}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", API_SCRIPT], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_dispatch_settlement_and_pause_are_serialized_per_co_worker(api, worker, owner, team):  # noqa: F811
    """Two connections: an overrun settling while another dispatch waits must stop that dispatch; two dispatches at once
    give one run and one busy, never a unique-index error."""
    import threading

    from conftest import dsn
    from psycopg.rows import dict_row
    w = team
    agent, _ = make_agent(api, w, "race-agent", runReserve=10000, dailyTokenBudget=100000)
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    for text in ("One", "Two", "Three"):
        ask(api, w, w.manager, dm, text)
    first, second, third = claim(api, w, agent)
    d1 = dispatch(api, w, agent, first)

    def agent_conn():
        c = psycopg.connect(dsn("api"), row_factory=dict_row)
        c.execute("begin")
        set_tenant(c, w.org, agent)
        c.execute("select set_config('pulse.agent_session','on',true)")
        return c
    # A settles a runaway (70,000: more than twice a chat's 34,000 budget, 1003) and holds the lock; B dispatches
    # meanwhile and must wait.
    a = agent_conn()
    a.execute("select pulse.agent_run_finish(%s,'done',70000,4,null)", (d1["runId"],))
    out = {}
    b = agent_conn()

    def later():
        out["b"] = b.execute("select pulse.agent_dispatch(%s,%s,'quick','m') d", (second["event"]["id"], second["leaseToken"])).fetchone()["d"]
        b.execute("commit")
    t = threading.Thread(target=later)
    t.start()
    t.join(1.5)
    assert t.is_alive()                                                   # waiting on the co-worker's lock
    a.execute("commit")
    t.join(10)
    assert out["b"] == {"status": "busy", "reason": "paused"}              # the runaway paused it first
    [paused] = one(api, w, w.manager, "select pulse.agent_list() a")["a"]
    assert paused["on"] is False and "70000 tokens" in paused["pausedReason"]
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_run where agent_id=%s", (agent,)) == [{"n": 1}]
    # Switched on, two dispatches at once: one run, one busy.
    one(api, w, w.manager, "select pulse.agent_switch(%s,true)", (agent,))
    owner_sql(owner, w, "update pulse.agent_event set retry_at=null where agent_id=%s", (agent,))
    [c2] = claim(api, w, agent)
    c3 = third                                                            # still leased from the first claim
    x, y = agent_conn(), agent_conn()
    rx = x.execute("select pulse.agent_dispatch(%s,%s,'quick','m') d", (c2["event"]["id"], c2["leaseToken"])).fetchone()["d"]

    def other():
        out["y"] = y.execute("select pulse.agent_dispatch(%s,%s,'quick','m') d", (c3["event"]["id"], c3["leaseToken"])).fetchone()["d"]
        y.execute("commit")
    t = threading.Thread(target=other)
    t.start()
    t.join(1.5)
    x.execute("commit")
    t.join(10)
    assert rx["status"] == "dispatched" and out["y"] == {"status": "busy", "reason": "one_at_a_time"}
    for c in (a, b, x, y):
        c.close()


def test_hand_off_filing_is_fenced_and_access_is_checked_again_when_claimed(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "fence-agent")
    lead(worker, w, w.editor2)

    def proposal(leader, text):
        dm = one(api, w, leader, "select pulse.chat_direct(%s) id", (agent,))["id"]
        ask(api, w, leader, dm, text)
        [c] = claim(api, w, agent)
        d = dispatch(api, w, agent, c)
        said = agent_one(api, w, agent, "select pulse.agent_chat_reply(%s,'Hand it over?',null,%s,%s) id", (dm, uuid.uuid4(), d["runId"]))["id"]
        h = agent_one(api, w, agent, "select pulse.agent_handoff_propose(%s,%s,'Look into it','details') id", (d["runId"], said))["id"]
        agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',12000,5,null) r", (d["runId"],))
        one(api, w, leader, "select pulse.agent_handoff_decide(%s,true) s", (h,))
        return dm, h
    # A filing whose lease ran out (a worker that went quiet, or a board that timed out) is never handed out again.
    dm, h = proposal(w.manager, "First job")
    [lease] = agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"]
    owner_sql(owner, w, "update pulse.agent_handoff set filing_until=now()-interval '1 second' where id=%s", (h,))
    assert agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"] == []
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not being filed by you"):     # the stale worker's report is refused
        as_agent(api, w, agent, "select pulse.agent_handoff_filed(%s,%s,'EST-1',%s)", (h, lease["filingToken"], uuid.uuid4()))
    assert owner_sql(owner, w, "select state, reason from pulse.agent_handoff where id=%s", (h,)) == [{"state": "uncertain", "reason": "filing_unconfirmed"}]
    # The runner reports a filing it cannot confirm: uncertain, and never filed again by itself.
    _, h2 = proposal(w.manager, "Second job")
    [lease2] = agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"]
    as_agent(api, w, agent, "select pulse.agent_handoff_unsure(%s,%s)", (h2, lease2["filingToken"]))
    assert agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"] == []
    # Accepted, then the co-worker is taken out of the conversation: closed, and nothing of it reaches the runner.
    dm3, h3 = proposal(w.editor2, "Third job")
    owner_sql(owner, w, "delete from pulse.chat_member where channel_id=%s and person_id=%s", (dm3, agent))
    assert agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"] == []
    assert owner_sql(owner, w, "select state, reason from pulse.agent_handoff where id=%s", (h3,)) == [{"state": "closed", "reason": "agent_left"}]
    # Accepted, then the leader who accepted it is no longer a leader: closed too.
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values (%s,%s,%s)", (w.org, dm3, agent))
    _, h4 = proposal(w.editor2, "Fourth job")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.role_assignment set valid_to=current_date-1 where person_id=%s and role_key='leadership'", (w.editor2,))
    assert agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"] == []
    assert owner_sql(owner, w, "select state, reason from pulse.agent_handoff where id=%s", (h4,)) == [{"state": "closed", "reason": "decider_not_leader"}]


@pytest.mark.parametrize("change,reason", [
    ("agent_removed", "agent_left"), ("decider_demoted", "decider_not_leader"),
    ("decider_removed", "decider_left"), ("accepted_after_agent_removed", "agent_left"),
])
def test_handoff_claim_rechecks_access_after_cleanup(api, worker, owner, team, change, reason):  # noqa: F811
    """A test-only row trigger stops the real claim inside cleanup, before its separate picking statement.
    Connection two commits the revocation (and late acceptance) before releasing that barrier. No runner gets work."""
    import time
    from concurrent.futures import ThreadPoolExecutor
    from psycopg import sql

    w = team
    agent, _ = make_agent(api, w, "handoff-race-agent")
    lead(worker, w, w.editor2)

    def proposal(leader, accept=True):
        dm = one(api, w, leader, "select pulse.chat_direct(%s) id", (agent,))["id"]
        ask(api, w, leader, dm, "Check the synthetic release")
        [event] = claim(api, w, agent)
        run = dispatch(api, w, agent, event)["runId"]
        message = agent_one(api, w, agent, "select pulse.agent_chat_reply(%s,'Proposed work',null,%s,%s) id", (dm, uuid.uuid4(), run))["id"]
        handoff = agent_one(api, w, agent, "select pulse.agent_handoff_propose(%s,%s,'Private proposal','Private details') id", (run, message))["id"]
        agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',100,1,null)", (run,))
        if accept:
            one(api, w, leader, "select pulse.agent_handoff_decide(%s,true)", (handoff,))
        return dm, handoff

    # An unrelated invalid accepted proposal makes cleanup touch a row, giving the trigger an exact barrier.
    sentinel_dm, sentinel = proposal(w.manager)
    dm, handoff = proposal(w.editor2, accept=change != "accepted_after_agent_removed")
    owner_sql(owner, w, "delete from pulse.chat_member where channel_id=%s and person_id=%s", (sentinel_dm, w.manager))
    gate = uuid.uuid4().int % (2**31 - 1)
    owner.execute(sql.SQL("""create function pulse.est1088_claim_barrier() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock({}); return new; end $$""").format(sql.Literal(gate)))
    try:
        owner.execute(sql.SQL("""create trigger est1088_claim_barrier after update on pulse.agent_handoff
            for each row when (new.id = {} and new.state = 'closed')
            execute function pulse.est1088_claim_barrier()""").format(sql.Literal(sentinel)))
        api.execute("set statement_timeout='15s'")
        with ThreadPoolExecutor(max_workers=1) as pool:
            with owner.transaction():
                set_tenant(owner, w.org, w.editor2)
                owner.execute("select pg_advisory_xact_lock(%s)", (gate,))
                pending = pool.submit(agent_one, api, w, agent, "select pulse.agent_handoffs_claim() h")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    waiting = owner.execute("select exists(select 1 from pg_locks where pid=%s and locktype='advisory' and not granted) b",
                                            (api.info.backend_pid,)).fetchone()["b"]
                    if waiting:
                        break
                    time.sleep(0.02)
                else:
                    pytest.fail("claim did not reach the barrier between cleanup and pick")
                if change in ("agent_removed", "accepted_after_agent_removed"):
                    owner.execute("delete from pulse.chat_member where channel_id=%s and person_id=%s", (dm, agent))
                elif change == "decider_removed":
                    owner.execute("delete from pulse.chat_member where channel_id=%s and person_id=%s", (dm, w.editor2))
                else:
                    owner.execute("update pulse.role_assignment set valid_to=current_date-1 where person_id=%s and role_key='leadership'", (w.editor2,))
                if change == "accepted_after_agent_removed":
                    assert owner.execute("select pulse.agent_handoff_decide(%s,true) s", (handoff,)).fetchone()["s"] == "accepted"
            # Revocation/acceptance and the barrier release commit together; the pick must use fresh authorization.
            assert pending.result(timeout=10)["h"] == []
        assert owner_sql(owner, w, "select state, filing_token, board_ref from pulse.agent_handoff where id=%s", (handoff,)) == [
            {"state": "accepted", "filing_token": None, "board_ref": None}]
        assert agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"] == []
        assert owner_sql(owner, w, "select state, reason from pulse.agent_handoff where id=%s", (handoff,)) == [{"state": "closed", "reason": reason}]
    finally:
        owner.execute("drop function pulse.est1088_claim_barrier() cascade")


def test_a_client_key_is_bound_to_its_run_and_every_state_change_wakes_the_live_stream(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "bound-agent")
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    seq = lambda: owner_sql(owner, w, "select coalesce(max(seq),0) s from pulse.chat_event where channel_id=%s", (dm,))[0]["s"]  # noqa: E731
    ask(api, w, w.manager, dm, "First")
    [c] = claim(api, w, agent)
    before = seq()
    d = dispatch(api, w, agent, c)
    assert seq() > before                                                 # dispatching shows at once
    client = uuid.uuid4()
    agent_one(api, w, agent, "select pulse.agent_chat_reply(%s,'Same words',null,%s,%s) id", (dm, client, d["runId"]))
    before = seq()
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',12000,5,null) r", (d["runId"],))
    assert seq() > before                                                 # settled usage shows at once
    ask(api, w, w.manager, dm, "Second")
    [c] = claim(api, w, agent)
    d2 = dispatch(api, w, agent, c)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="another run"):    # run A's key reused in run B fails
        as_agent(api, w, agent, "select pulse.agent_chat_reply(%s,'Same words',null,%s,%s)", (dm, client, d2["runId"]))
    before = seq()
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'error',null,1,'model_error') r", (d2["runId"],))
    assert seq() > before                                                 # an error shows at once
    assert owner_sql(owner, w, "select state, reason from pulse.agent_event where id=%s", (c["event"]["id"],)) == [{"state": "failed", "reason": "model_error"}]
    # A refusal shows at once too, with a fixed reason code (never free text).
    ask(api, w, w.manager, dm, "Third")
    [c] = claim(api, w, agent)
    owner_sql(owner, w, "delete from pulse.chat_member where channel_id=%s and person_id=%s", (dm, agent))
    before = seq()
    assert dispatch(api, w, agent, c) == {"status": "refused", "reason": "agent_left"}
    assert seq() > before
    with pytest.raises(psycopg.errors.CheckViolation):
        owner_sql(owner, w, "update pulse.agent_event set reason='Something a runner made up' where id=%s", (c["event"]["id"],))


@pytest.mark.parametrize("stop", ["in_review", "cancelled"])
def test_handoff_relay_durable_backoff_access_and_stop(api, worker, owner, team, stop):
    w = team
    agent, _ = make_agent(api, w, "relay-agent")
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm, "Check the synthetic release")
    [c] = claim(api, w, agent)
    run = dispatch(api, w, agent, c)["runId"]
    msg = agent_one(api, w, agent, "select pulse.agent_chat_reply(%s,'I can check.',null,%s,%s) id", (dm, uuid.uuid4(), run))["id"]
    h = agent_one(api, w, agent, "select pulse.agent_handoff_propose(%s,%s,'Check','Synthetic') id", (run, msg))["id"]
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',1,1,null)", (run,))
    one(api, w, w.manager, "select pulse.agent_handoff_decide(%s,true)", (h,))
    [filing] = agent_one(api, w, agent, "select pulse.agent_handoffs_claim() h")["h"]
    agent_one(api, w, agent, "select pulse.agent_handoff_filed(%s,%s,'EST-9999',%s)", (h, filing["filingToken"], uuid.uuid4()))
    poll = lambda: agent_one(api, w, agent, "select pulse.agent_handoffs_poll() h")["h"]
    for minutes in (5, 5, 30, 30):
        assert [x["id"] for x in poll()] == [str(h)]
        assert poll() == []  # another process/restart cannot claim the reserved interval
        [row] = owner_sql(owner, w, "select extract(epoch from relay_after-clock_timestamp()) seconds from pulse.agent_handoff where id=%s", (h,))
        assert minutes*60-10 <= float(row["seconds"]) <= minutes*60
        owner_sql(owner, w, "update pulse.agent_handoff set relay_after=now()-interval '1 second' where id=%s", (h,))
    client, comment = uuid.uuid4(), uuid.uuid4()
    report = lambda state, text, key, cid=None: agent_one(api, w, agent, "select pulse.agent_handoff_update(%s,%s,%s,%s,%s) r", (h, key, state, text, cid))["r"]
    first = report("progress", "Checked", client, comment)
    assert report("progress", "Checked", client, comment) == first
    assert report("progress", "Checked", uuid.uuid4(), comment) == first
    assert owner_sql(owner, w, "select relay_reads from pulse.agent_handoff where id=%s", (h,)) == [{"relay_reads": 0}]
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_handoff_update where handoff_id=%s", (h,)) == [{"n": 1}]
    owner_sql(owner, w, "update pulse.agent_handoff set relay_after=now()-interval '1 second' where id=%s", (h,))
    [admission] = poll()
    assert admission["commentIds"] == [str(comment)]  # a fresh runner receives durable identity
    report("blocked", "Waiting", uuid.uuid4())
    assert report("progress", "Checked", uuid.uuid4(), comment) == first
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_handoff_update where handoff_id=%s", (h,)) == [{"n": 2}]
    # Removal suppresses board content and reports. Reinstating membership preserves the durable hand-off.
    owner_sql(owner, w, "delete from pulse.chat_member where channel_id=%s and person_id=%s", (dm, agent))
    assert poll() == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        report("progress", "Not authorized", uuid.uuid4())
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, dm, agent))
    report(stop, "Ready for review" if stop == "in_review" else "Cancelled", uuid.uuid4())
    owner_sql(owner, w, "update pulse.agent_handoff set relay_after=now()-interval '1 second' where id=%s", (h,))
    assert poll() == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        report("progress", "Too late", uuid.uuid4())
    assert claim(api, w, agent) == []  # no agent-to-agent event loop


def test_an_ai_employee_asks_the_person_set_for_a_group(api, worker, owner, team):  # noqa: F811
    """FEATURES-1024 (0987): in a chosen group it asks a chosen person (say the project's coordinator) before it posts;
    everywhere else, and once that person leaves the group, its usual approver (here who it reports to)."""
    w = team
    a, _ = make_agent(api, w, "group-asker")
    group = one(api, w, w.manager, "select pulse.chat_group_create('Project room',%s) id", ([w.editor, w.lead],))["id"]
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (group, a))
    asks = lambda channel: owner_sql(owner, w, "select pulse.agent_approver_for(%s,%s) p", (a, channel))[0]["p"]  # noqa: E731
    assert asks(group) == w.manager
    one(api, w, w.manager, "select pulse.agent_group_approver_set(%s,%s,%s) g", (a, group, w.lead))
    assert asks(group) == w.lead
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (a,))["id"]
    assert asks(dm) == w.manager
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.agent_group_approver_set(%s,%s,%s)", (a, group, w.editor2))
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.editor, "select pulse.agent_group_approver_set(%s,%s,%s)", (a, group, w.editor))
    owner_sql(owner, w, "delete from pulse.chat_member where channel_id=%s and person_id=%s", (group, w.lead))
    assert asks(group) == w.manager
    one(api, w, w.manager, "select pulse.agent_group_approver_set(%s,%s,null) g", (a, group))
    assert owner_sql(owner, w, "select group_approvers g from pulse.agent_member where person_id=%s", (a,))[0]["g"] == {}


def test_engine_router_record_and_budget_asks(api, worker, owner, team):  # noqa: F811
    """FEATURES-1024 (0988): a run records the engine that ran it (tokens in and out, what it fell back from); work over
    its budget waits for its manager's one-tap "Allow it", which grants it and runs it again; a day's ask raises today's
    allowance until the day ends; the spend is readable by its managers."""
    w = team
    agent, _ = make_agent(api, w, "budget-agent")
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm, "Summarise the last quarter's deliveries in detail")
    [c] = claim(api, w, agent)
    d = dispatch(api, w, agent, c)
    run, event = d["runId"], c["event"]["id"]
    cfg = agent_one(api, w, agent, "select pulse.agent_engines_read() e")["e"]
    assert cfg["agent"] == [] and cfg["org"] == [] and cfg["grants"] == [] and isinstance(cfg["connections"], list)
    agent_one(api, w, agent, "select pulse.agent_run_engine(%s,%s) r", (run, Jsonb({"engine": "server:codex/gpt-test", "tier": "fast", "tokensIn": "1200", "tokensOut": "80",
                                                                                   "fallbackFrom": "Claude subscription: out of quota"})))
    assert owner_sql(owner, w, "select engine, engine_tier, tokens_in, tokens_out, fallback_from from pulse.agent_run where id=%s", (run,)) == [
        {"engine": "server:codex/gpt-test", "engine_tier": "fast", "tokens_in": 1200, "tokens_out": 80, "fallback_from": "Claude subscription: out of quota"}]
    # Over budget: the run closes at no cost, the work waits, the manager gets the card in their direct message.
    asked = agent_one(api, w, agent, "select pulse.agent_budget_ask(%s,%s,%s) r", (run, Jsonb({"scope": "run", "estimate": "50000", "why": "The quarter has 400 deliveries."}), uuid.uuid4()))["r"]
    held = owner_sql(owner, w, "select r.state, r.error_code, e.state es, e.retry_at > now() + interval '1 day' later from pulse.agent_run r join pulse.agent_event e on e.id=r.event_id where r.id=%s", (run,))[0]
    assert held == {"state": "error", "error_code": "needs_budget", "es": "queued", "later": True}
    card = owner_sql(owner, w, "select kind, approver_id, state, dm_message_id is not null posted from pulse.agent_proposal where id=%s", (asked["id"],))[0]
    assert card == {"kind": "budget", "approver_id": w.manager, "state": "pending", "posted": True}
    # One tap: allowed; the grant is kept and the work is due again now.
    one(api, w, w.manager, "select pulse.agent_proposal_decide(%s,'send',null,'button') d", (asked["id"],))
    assert owner_sql(owner, w, "select extra, event_id from pulse.agent_budget_grant where proposal_id=%s", (asked["id"],)) == [{"extra": 50000, "event_id": uuid.UUID(event)}]
    assert owner_sql(owner, w, "select retry_at <= now() due from pulse.agent_event where id=%s", (event,)) == [{"due": True}]
    assert agent_one(api, w, agent, "select pulse.agent_engines_read() e")["e"]["grants"][0]["extra"] == 50000
    # Today's ask: allowed, today's allowance grows; after the day it is back to its usual amount.
    base = owner_sql(owner, w, "select daily_token_budget b from pulse.agent_member where person_id=%s", (agent,))[0]["b"]
    day = agent_one(api, w, agent, "select pulse.agent_budget_ask(null,%s,%s) r", (Jsonb({"scope": "day", "estimate": "20000", "why": "Today is used up."}), uuid.uuid4()))["r"]
    one(api, w, w.manager, "select pulse.agent_proposal_decide(%s,'send',null,'button') d", (day["id"],))
    assert owner_sql(owner, w, "select daily_token_budget b from pulse.agent_member where person_id=%s", (agent,))[0]["b"] == base + 20000
    owner_sql(owner, w, "update pulse.agent_member set budget_restore = jsonb_set(budget_restore, '{day}', to_jsonb((current_date - 2)::text)) where person_id=%s", (agent,))
    agent_one(api, w, agent, "select pulse.agent_engines_read() e")
    assert owner_sql(owner, w, "select daily_token_budget b, budget_restore r from pulse.agent_member where person_id=%s", (agent,)) == [{"b": base, "r": None}]
    # Spend: its manager reads it; someone who may not change it does not.
    spend = one(api, w, w.manager, "select pulse.agent_spend(%s,7) s", (agent,))["s"]
    assert any(r["engine"] == "server:codex/gpt-test" and r["tokensIn"] == 1200 for r in spend["runs"])
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.editor, "select pulse.agent_spend(%s,7)", (agent,))


def test_unanswered_asks_expire_after_three_days(api, worker, owner, team):  # noqa: F811
    """FEATURES-1024 (0991): an ask nobody answered for three days closes as Expired; a fresh one stays."""
    w = team
    agent, _ = make_agent(api, w, "expiring-agent")
    old = agent_one(api, w, agent, "select pulse.agent_budget_ask(null,%s,%s) r", (Jsonb({"scope": "day", "estimate": "20000", "why": "Old ask."}), uuid.uuid4()))["r"]["id"]
    owner_sql(owner, w, "update pulse.agent_proposal set created_at = now() - interval '4 days' where id=%s", (old,))
    assert agent_one(api, w, agent, "select pulse.agent_proposals_expire() n")["n"] == 1
    assert owner_sql(owner, w, "select state from pulse.agent_proposal where id=%s", (old,)) == [{"state": "expired"}]
    assert agent_one(api, w, agent, "select pulse.agent_proposals_expire() n")["n"] == 0
