"""TOKENS-2 (2280): one price matcher for every reader, rupee budgets (an AI employee's and the company's) with the 80%
warning and the stop at 100%, the model router's trace and per-company override, what the router learned (how often a
class needed a stronger tier), and promotion: work done the same way 5+ times becomes a candidate, an admin approves it,
and the runtime gets it with its engines. Synthetic people and synthetic prices only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, owner_sql
from test_ai_tasks import act, ai, finish, look
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)

NOTE = "tokens-2 test price"


@pytest.fixture
def prices(owner, team):  # noqa: F811
    w = team
    owner_sql(owner, w, "insert into pulse_priv.platform_ai_price(engine,inr_per_m_in,inr_per_m_out,note) values "
              "('sonnet',186.96,934.80,%s),('server:codex',186.96,934.80,%s),('haiku',9.35,46.74,%s) on conflict (engine) do nothing", (NOTE, NOTE, NOTE))
    yield
    owner_sql(owner, w, "delete from pulse_priv.platform_ai_price where note=%s", (NOTE,))


def engine(api, w, agent, run, **p):
    agent_one(api, w, agent, "select pulse.agent_run_engine(%s,%s) r", (run, Jsonb(p)))


def worked(api, w, agent, title, **p):
    """One assigned task, looked at and finished by the AI, with what its runtime records about the run."""
    new_task(api, w, w.editor, title=title, assigneeId=str(agent))
    run, _ = look(api, w, agent)
    act(api, w, agent, run, {"comment": "Sent the reminder (test).", "status": "waiting"})
    engine(api, w, agent, run, **p)
    finish(api, w, agent, run)
    return run


def test_rupee_prices_and_budgets(api, worker, owner, team, prices):  # noqa: F811
    w = team
    price = lambda e: {"a": float(one(api, w, w.manager, "select pulse.ai_price_inr(%s,1000000,0) a", (e,))["a"]),  # noqa: E731
                       "b": float(owner_sql(owner, w, "select pulse.platform_ai_inr(%s,1000000,0) b", (e,))[0]["b"])}
    # The engine name, else its model, else nothing (no "*" in this test): the admin's spend reads the same as the report.
    assert price("server:claude/sonnet") == {"a": 186.96, "b": 186.96}
    assert price(f"connection:{uuid.uuid4()}/sonnet") == {"a": 186.96, "b": 186.96}
    assert price("server:codex") == {"a": 186.96, "b": 186.96}
    assert price("runner:run_0123/haiku")["a"] == 9.35 and price("server:claude/haiku")["b"] == 9.35

    agent = ai(api, owner, w, "rupa-test")
    worked(api, w, agent, "Send the brochure (test)", engine="server:claude/sonnet", tier="fast", tokensIn=100000, tokensOut=10000)
    # 100k in and 10k out on Sonnet: 18.70 + 9.35 = 28.04 rupees this month.
    assert float(owner_sql(owner, w, "select pulse.agent_month_inr(%s) r", (agent,))[0]["r"]) == 28.04

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.ai_rupee_budget_set(%s, 100) r", (agent,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.manager, "select pulse.ai_rupee_budget_set(%s, 0) r", (agent,))
    st = one(api, w, w.manager, "select pulse.ai_rupee_budget_set(%s, 30) r", (agent,))["r"]["budget"]
    assert st["rupees"] == {"used": 28.04, "limit": 30, "share": 93}
    assert (st["level"], st["period"], st["key"][:8]) == ("warn", "rupees", "rupees:2"), st
    assert owner_sql(owner, w, "select count(*)::int n from pulse.audit_event where resource='agent_member' and resource_id=%s", (str(agent),))[0]["n"] >= 1
    # At 100% the claim stops it, as a spent token budget does; cleared, it works again.
    lock = lambda: owner_sql(owner, w, "select (pulse.agent_lock(%s)).daily_token_budget b", (agent,))[0]["b"]  # noqa: E731
    assert lock() == 500000
    st = one(api, w, w.manager, "select pulse.ai_rupee_budget_set(%s, 25) r", (agent,))["r"]["budget"]
    assert (st["level"], st["period"]) == ("out", "rupees")
    assert lock() == 0
    one(api, w, w.manager, "select pulse.ai_rupee_budget_set(%s, null) r", (agent,))
    assert lock() == 500000
    # The company's rupees a month (leaders' engine settings): its meter, and its stop for every AI employee.
    s = one(api, w, w.manager, "select pulse.agent_org_ai_save(%s) r", (Jsonb({"monthlyInr": "20"}),))["r"]
    assert float(s["monthlyInr"]) == 20
    st = one(api, w, w.manager, "select pulse.agent_budget_state(%s) r", (agent,))["r"]
    assert st["orgRupees"]["limit"] == 20 and (st["level"], st["period"]) == ("out", "org_rupees")
    assert lock() == 0
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.manager, "select pulse.agent_org_ai_save(%s) r", (Jsonb({"monthlyInr": "lots"}),))
    one(api, w, w.manager, "select pulse.agent_org_ai_save(%s) r", (Jsonb({"monthlyInr": ""}),))
    assert lock() == 500000
    assert one(api, w, w.manager, "select pulse.agent_budget_state(%s) r", (agent,))["r"]["rupees"] is None


def test_router_trace_override_and_promotion(api, worker, owner, team, prices):  # noqa: F811
    w = team
    agent = ai(api, owner, w, "ruta-test")
    steps = {"tools": ["list_tasks", "add_comment"], "shape": "task:comment+status=done", "routeClass": "action", "tier": "fast",
             "engine": "server:claude/sonnet", "tokensIn": 20000, "tokensOut": 1000}
    runs = [worked(api, w, agent, f"Remind the vendor {i} (test)", routeWhy="asks to do something", **steps) for i in range(5)]
    # What the runtime recorded: the class, the small tier (0988 kept only fast/strong), the tools in order, the shape.
    engine(api, w, agent, runs[0], **{**steps, "tier": "small", "tools": ["list_tasks", "BAD name", "add_comment"], "routeClass": "huge"})
    r = owner_sql(owner, w, "select engine_tier, route_class, tools_used, answer_shape from pulse.agent_run where id=%s", (runs[0],))[0]
    assert r == {"engine_tier": "small", "route_class": None, "tools_used": ["list_tasks", "add_comment"], "answer_shape": "task:comment+status=done"}
    engine(api, w, agent, runs[0], **steps)
    # A sixth like it needed a stronger tier: it is learned, and it is not evidence for a pattern.
    worked(api, w, agent, "Remind the vendor again (test)", escalatedFrom="fast", **{**steps, "tier": "strong"})

    # The company's override: only known classes and tiers are kept.
    s = one(api, w, w.manager, "select pulse.agent_org_ai_save(%s) r", (Jsonb({"router": {"mode": "off", "tiers": {"heavy": "fast", "bogus": "x", "lookup": "huge"}}}),))["r"]
    assert s["router"] == {"mode": "off", "tiers": {"heavy": "fast"}}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_org_ai_save(%s) r", (Jsonb({"router": {"mode": "auto"}}),))
    cfg = agent_one(api, w, agent, "select pulse.agent_engines_read() r")["r"]
    assert cfg["router"]["mode"] == "off" and cfg["router"]["learned"] == {"action": 17} and cfg["patterns"] == []

    # Promotion: the same steps 5 times become one candidate (once; its evidence refreshed on the next scan) ...
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.ai_pattern_scan(14) r")
    assert agent_one(api, w, agent, "select pulse.ai_pattern_scan(14) r")["r"] == {"new": 1, "seen": 0}
    assert one(api, w, w.manager, "select pulse.ai_pattern_scan(14) r")["r"] == {"new": 0, "seen": 1}
    h = owner_sql(owner, w, "select key, task_type, state, title, pattern from pulse.ai_heuristic where pattern is not null")
    assert len(h) == 1 and h[0]["state"] == "candidate" and h[0]["task_type"] == "task.assigned"
    assert h[0]["pattern"]["runs"] == 5 and h[0]["pattern"]["tools"] == ["list_tasks", "add_comment"] and h[0]["pattern"]["tier"] == "fast"
    assert h[0]["title"] == "Same steps for newly assigned tasks: list_tasks → add_comment"
    # ... the runtime does not use a candidate; an admin approves it (audited) and then it does.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.ai_heuristic_set(%s, true, 'test') r", (h[0]["key"],))
    one(api, w, w.manager, "select pulse.ai_heuristic_set(%s, true, 'Looks right (test)') r", (h[0]["key"],))
    assert owner_sql(owner, w, "select action from pulse.audit_event where resource='ai_heuristic' and resource_id=%s", (h[0]["key"],)) == [{"action": "ai_rule.on"}]
    pats = agent_one(api, w, agent, "select pulse.agent_engines_read() r")["r"]["patterns"]
    assert [(p["key"], p["tools"], p["tier"]) for p in pats] == [(h[0]["key"], ["list_tasks", "add_comment"], "fast")]
    # A scan keeps the reviewed state.
    one(api, w, w.manager, "select pulse.ai_pattern_scan(14) r")
    assert owner_sql(owner, w, "select state from pulse.ai_heuristic where key=%s", (h[0]["key"],)) == [{"state": "active"}]

    # The router report (leadership, row security): per class, per week, per kind of work, with rupees; the patterns.
    rep = one(api, w, w.manager, "select pulse.ai_router_report(30) r")["r"]
    cls = {c["class"]: c for c in rep["classes"]}
    assert cls["action"]["runs"] == 6 and cls["action"]["escalated"] == 1 and cls["action"]["strong"] == 1 and cls["action"]["strongest"] == 0
    assert float(cls["action"]["inr"]) == round(6 * round((20000 * 186.96 + 1000 * 934.80) / 1e6, 2), 2), "each run priced to the paisa, then added"
    t = {x["taskType"]: x for x in rep["types"]}
    assert t["task.assigned"]["runs"] == 6 and t["task.assigned"]["words"] == "newly assigned tasks" and t["task.assigned"]["inrPerRun"] is not None
    assert sum(k["runs"] for k in rep["weeks"]) == 6 and rep["priced"] is True
    assert [(p["key"], p["state"]) for p in rep["patterns"]] == [(h[0]["key"], "active")]
    # Off again (the default): the router's settings are the company's own.
    one(api, w, w.manager, "select pulse.agent_org_ai_save(%s) r", (Jsonb({"router": {}}),))
    assert agent_one(api, w, agent, "select pulse.agent_engines_read() r")["r"]["router"]["mode"] == "auto"
