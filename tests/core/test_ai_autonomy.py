"""AI-AUTONOMY (1230): an AI employee acts on its own with colleagues and always answers leadership one to one; it asks
first only by its risk policy (clients, money, deleting, legal or HR, above a cost limit). Who may loosen the policy, the
organisation's client switch, the client guard, and tenant isolation. Synthetic people only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from helpers import build_world
from test_agent_coworkers import agent_one, lead, make_agent, owner_sql
from test_hr_suite import _staff
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def world(api, worker, owner, w, autonomy='{"group":"approve","direct":"approve","mention":"approve"}', access="operations"):
    agent, _ = make_agent(api, w, "ops-chief-test")
    owner_sql(owner, w, f"""update pulse.agent_member set speak_scope='its_groups', tools=array['chats','tasks'], listens_to='everyone',
        autonomy='{autonomy}', access='{access}' where person_id=%s""", (agent,))
    lead(worker, w, w.lead)
    return agent


def dm_from(api, owner, w, agent, person, text):
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (agent, person))[0]["id"]
    as_(api, w, person, "select pulse.chat_send(%s,%s,null,'[]',%s,null)", (dm, text, uuid.uuid4()))
    return dm


def dispatch_all(api, w, agent):
    out = []
    for c in agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]:
        out.append(agent_one(api, w, agent, "select pulse.agent_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"])
        agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',0,0,null) r", (out[-1]["runId"],))
    return out


def test_leadership_dm_is_answered_on_its_own_even_set_to_ask_first_with_operations_access(api, worker, owner, team):  # noqa: F811
    w = team
    agent = world(api, worker, owner, w)
    dm_from(api, owner, w, agent, w.lead, "hi")
    [d] = dispatch_all(api, w, agent)
    assert d["status"] == "dispatched"
    c = d["context"]
    assert c["mode"] == "own" and c["askerIsLeader"] is True and c["clientFacing"] is False
    assert c["policy"]["internal"] == "send" and c["policy"]["money"] == "ask" and c["policy"]["clients"] == "ask" and c["policy"]["costLimit"] == 25000


def test_a_colleague_dm_is_on_its_own_by_default_and_asks_when_its_policy_says_so(api, worker, owner, team):  # noqa: F811
    w = team
    agent = world(api, worker, owner, w)
    dm_from(api, owner, w, agent, w.editor, "Is the Skyline reel on track? (test)")
    [d] = dispatch_all(api, w, agent)
    assert d["context"]["mode"] == "own" and d["context"]["askerIsLeader"] is False
    as_(api, w, w.manager, "select pulse.agent_ai_save(%s,%s)", (agent, Jsonb({"riskPolicy": {"internal": "ask"}})))
    dm_from(api, owner, w, agent, w.editor, "And the brochure? (test)")
    [d] = dispatch_all(api, w, agent)
    assert d["context"]["mode"] == "approve"
    dm_from(api, owner, w, agent, w.lead, "Status? (test)")
    [d] = dispatch_all(api, w, agent)
    assert d["context"]["mode"] == "own", "leadership is always answered"


def test_a_client_conversation_asks_first_until_the_organisation_and_its_policy_allow_it(api, worker, owner, team):  # noqa: F811
    w = team
    agent = world(api, worker, owner, w, autonomy='{"group":"own","direct":"own","mention":"own"}', access="standard")
    group = one(api, w, w.manager, "select pulse.chat_group_create('Client room (test)',%s) id", ([w.editor, w.lead],))["id"]
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (group, agent))
    client = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Ashby Rook (test client)','client')", (client, w.org))
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, group, client))
    as_(api, w, w.editor, "select pulse.chat_send(%s,'Can we offer them 10%% off? (test)',null,'[]',%s,null)", (group, uuid.uuid4()))
    ds = dispatch_all(api, w, agent)
    assert ds and all(d["context"]["mode"] == "approve" and d["context"]["clientFacing"] is True for d in ds)
    # Its own post there is refused by the database.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="only after a person approves"):
        agent_one(api, w, agent, "select pulse.chat_send(%s,'Sure (test)',null,'[]',%s,null) id", (group, uuid.uuid4()))
    # Only leadership or an admin turns the organisation's switch; a manager may not, nor the AI.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_org_policy_set(%s)", (Jsonb({"clientsOn": True}),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.agent_org_policy_set(%s) r", (Jsonb({"clientsOn": True}),))
    as_(api, w, w.lead, "select pulse.agent_org_policy_set(%s)", (Jsonb({"clientsOn": True}),))
    assert one(api, w, w.lead, "select pulse.agent_org_policy_read() p")["p"] == {"clientsOn": True}
    # The switch alone is not enough: its own policy still says ask.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.chat_send(%s,'Sure (test)',null,'[]',%s,null) id", (group, uuid.uuid4()))
    as_(api, w, w.lead, "select pulse.agent_ai_save(%s,%s)", (agent, Jsonb({"riskPolicy": {"clients": "send"}})))
    assert agent_one(api, w, agent, "select pulse.agent_clients_ok(%s) ok", (agent,))["ok"] is True
    assert agent_one(api, w, agent, "select pulse.chat_send(%s,'Sure, Ashby (test)',null,'[]',%s,null) id", (group, uuid.uuid4()))["id"]


def test_who_may_loosen_the_risk_policy_and_what_is_refused(api, worker, owner, team):  # noqa: F811
    w = team
    agent = world(api, worker, owner, w)
    save = lambda who, p: as_(api, w, who, "select pulse.agent_ai_save(%s,%s)", (agent, Jsonb({"riskPolicy": p})))  # noqa: E731
    # The person it reports to (not an admin or a leader) may make it ask first more often, never less.
    owner_sql(owner, w, "update pulse.agent_member set owner_person_id=%s where person_id=%s", (w.editor, agent))
    save(w.editor, {"costLimit": "10000", "legalHr": "ask"})
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Admins and leadership"):
        save(w.editor, {"money": "send"})
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="raise the cost limit"):
        save(w.editor, {"costLimit": "90000"})
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="always waits for a person"):
        save(w.lead, {"delete": "send"})
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        save(w.lead, {"payroll": "send"})
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        save(w.lead, {"costLimit": "-5"})
    save(w.lead, {"money": "send", "costLimit": "50000"})
    pol = agent_one(api, w, agent, "select pulse.agent_policy(%s) p", (agent,))["p"]
    assert pol["money"] == "send" and pol["costLimit"] == 50000 and pol["delete"] == "ask" and pol["clients"] == "ask"
    # An AI never changes its own policy, even through its own session.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.agent_ai_save(%s,%s) r", (agent, Jsonb({"riskPolicy": {"money": "send"}})))
    # Operations access no longer forces "ask first" on everything (0965's blanket rule is gone).
    as_(api, w, w.manager, "select pulse.agent_ai_save(%s,%s)", (agent, Jsonb({"autonomy": {"direct": "own"}})))


def test_policies_stay_inside_their_organisation(api, worker, owner, team):  # noqa: F811
    w = team
    agent = world(api, worker, owner, w)
    as_(api, w, w.lead, "select pulse.agent_org_policy_set(%s)", (Jsonb({"clientsOn": True}),))
    other = build_world(worker, owner, api)
    _staff(worker, other)
    assert one(api, other, other.manager, "select pulse.agent_org_policy_read() p")["p"] == {"clientsOn": False}
    assert one(api, other, other.manager, "select pulse.agent_policy(%s) p", (agent,))["p"] is None, "another organisation's AI is not found"
    assert one(api, other, other.manager, "select count(*)::int n from pulse.agent_org_policy")["n"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, other, other.manager, "select pulse.agent_ai_save(%s,%s)", (agent, Jsonb({"riskPolicy": {"internal": "ask"}})))


def test_every_active_colleague_reaches_an_ai_employee(api, worker, owner, team):  # noqa: F811
    """1352: a staff member who is not a leader opens a DM with an AI employee set to listen to colleagues, and it is
    dispatched; managing it stays with its managers; a client cannot open one."""
    w = team
    agent, _ = make_agent(api, w, "colleague-reach-test")
    owner_sql(owner, w, "update pulse.agent_member set listens_to='leaders', autonomy='{\"direct\":\"own\",\"mention\":\"own\",\"group\":\"off\"}' where person_id=%s", (agent,))
    dm = one(api, w, w.editor, "select pulse.chat_direct(%s) id", (agent,))["id"]
    as_(api, w, w.editor, "select pulse.chat_send(%s,'Can you check the reel? (test)',null,'[]',%s,null)", (dm, uuid.uuid4()))
    [d] = dispatch_all(api, w, agent)
    assert d["status"] == "dispatched" and d["context"]["mode"] == "own"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_ai_save(%s,%s)", (agent, Jsonb({"riskPolicy": {"money": "send"}})))
    client = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Client Reach (test)','client')", (client, w.org))
    with pytest.raises(psycopg.Error):
        as_(api, w, client, "select pulse.chat_direct(%s)", (agent,))
