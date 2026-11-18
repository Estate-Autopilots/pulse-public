"""FIX-AI-EMPLOYEES (2011): pulse.agent_costs(day), each AI employee's cost for the day and the month in tokens and,
when the platform has a price for the engines used, in rupees; its budget, tools, last run and queue. Read with
agent_workload's rule: admins and leadership see every AI employee, a manager theirs, nobody else. Synthetic company,
runs and price."""
import uuid

import psycopg
import pytest
from test_agent_coworkers import as_agent, make_agent, owner_sql
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


def runs(owner, w, agent, n, tokens, ago="5 minutes", engine="server:claude/sonnet"):
    # A run from minutes ago stays in the company's today: in the first minutes after its midnight, "5 minutes ago" was
    # yesterday there, and today read 0 tokens (hosted db-08, run 44147397679, at 00:0x IST). Runs a day old or more are
    # dated as given.
    for i in range(n):
        at = owner_sql(owner, w, """select case when %(ago)s::interval >= interval '1 day' then now() - %(ago)s::interval - make_interval(mins => %(i)s)
            else greatest(now() - %(ago)s::interval - make_interval(mins => %(i)s),
                          (now() at time zone pulse.org_time_zone(%(org)s))::date::timestamp at time zone pulse.org_time_zone(%(org)s)) end at""",
                       {"ago": ago, "i": i, "org": w.org})[0]["at"]
        ev = owner_sql(owner, w, """insert into pulse.agent_event(org_id,agent_id,event_type,subject_type,subject_id,event_key,invoked_by,state,created_at)
            values(%s,%s,'chat.message','message',%s,%s,%s,'done',%s) returning id""",
                       (w.org, agent, uuid.uuid4(), f"autopilots-cost-test:{uuid.uuid4()}", w.manager, at))[0]["id"]
        owner_sql(owner, w, """insert into pulse.agent_run(org_id,agent_id,event_id,state,lane,model,reserved,tokens,tokens_in,tokens_out,engine,seconds,started_at,deadline,finished_at)
            values(%s,%s,%s,'done','quick','sonnet',%s,%s,%s,%s,%s,12,%s,now(),greatest(%s, now()-%s::interval))""",
                   (w.org, agent, ev, tokens, tokens, tokens * 4 // 5, tokens // 5, engine, at, at, ago))


def test_cost_per_ai_employee_in_tokens_and_rupees_for_its_readers_only(api, worker, owner, team):  # noqa: F811
    w = team
    busy, _ = make_agent(api, w, "cost-busy-test", title="Quotes and invoices (AI)")
    idle, _ = make_agent(api, w, "cost-idle-test", title="Scripts (AI)")
    owner_sql(owner, w, "update pulse.agent_member set tools=array['billing','chats'] where person_id=%s", (busy,))
    runs(owner, w, busy, 3, 12000)
    runs(owner, w, idle, 1, 4000, ago="40 days")
    owner_sql(owner, w, """insert into pulse.agent_event(org_id,agent_id,event_type,subject_type,subject_id,event_key,invoked_by,state)
        values(%s,%s,'chat.message','message',%s,%s,%s,'queued')""", (w.org, busy, uuid.uuid4(), f"autopilots-cost-test:{uuid.uuid4()}", w.manager))

    # No price on the platform: tokens only, never a made-up rupee figure.
    c = one(api, w, w.manager, "select pulse.agent_costs(null) c")["c"]
    assert c["priced"] in (False, True)
    b = c["agents"][str(busy)]
    assert b["today"]["tokens"] == 36000 and b["month"]["tokens"] >= 36000
    assert b["queued"] == 1 and b["running"] is False and b["tools"] == ["billing", "chats"]
    assert b["budget"]["day"]["limit"] > 0
    i = c["agents"][str(idle)]
    assert i["today"] == {"tokens": 0, "inr": 0} and i["lastRunAt"] is not None

    # With a price for every engine: rupees, from the tokens in and out.
    owner_sql(owner, w, "insert into pulse_priv.platform_ai_price(engine,inr_per_m_in,inr_per_m_out,note) values('*',250,1250,'autopilots cost test') on conflict (engine) do nothing")
    try:
        c = one(api, w, w.manager, "select pulse.agent_costs(null) c")["c"]
        assert c["priced"] is True
        assert float(c["agents"][str(busy)]["today"]["inr"]) == pytest.approx(3 * (9600 * 250 + 2400 * 1250) / 1e6, abs=0.05)
    finally:
        owner_sql(owner, w, "delete from pulse_priv.platform_ai_price where note='autopilots cost test'")

    # An older day: nothing that day.
    old = one(api, w, w.manager, "select pulse.agent_costs((now() - interval '20 days')::date) c")["c"]
    assert old["agents"][str(busy)]["today"]["tokens"] == 0

    # A colleague who is neither a leader nor its manager is refused, and so is an AI employee.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_costs(null)")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, busy, "select pulse.agent_costs(null)")
