"""AI-AGENTS-2 (owner, 17 Nov 2026): an AI employee's daily limit goes up to 5 crore tokens (2231), and its daily triage
reaches more than one person (2232). Synthetic only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


def test_daily_limit_goes_to_five_crore_tokens_and_no_further(api, worker, owner, team):  # noqa: F811
    w = team
    ai, _ = make_agent(api, w, "budget-ceiling-test")
    one(api, w, w.manager, "select pulse.agent_settings_save(%s,%s)", (ai, Jsonb({"dailyTokenBudget": "30000000"})))
    assert owner_sql(owner, w, "select daily_token_budget b from pulse.agent_member where person_id=%s", (ai,))[0]["b"] == 30000000, "3 crore a day is allowed now"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.manager, "select pulse.agent_settings_save(%s,%s)", (ai, Jsonb({"dailyTokenBudget": "60000000"})))
    with pytest.raises(psycopg.errors.CheckViolation):
        owner_sql(owner, w, "update pulse.agent_member set daily_token_budget=50000001 where person_id=%s", (ai,))
    # Add budget near the top stops at the ceiling, and at the ceiling says so.
    owner_sql(owner, w, "update pulse.agent_member set daily_token_budget=49990000 where person_id=%s", (ai,))
    one(api, w, w.manager, "select pulse.agent_budget_add(%s,'day') r", (ai,))
    assert owner_sql(owner, w, "select daily_token_budget b from pulse.agent_member where person_id=%s", (ai,))[0]["b"] == 50000000
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.manager, "select pulse.agent_budget_add(%s,'day') r", (ai,))


def test_the_daily_triage_reaches_the_people_chosen_and_one_person_decides(api, worker, owner, team):  # noqa: F811
    w = team
    pm, _ = make_agent(api, w, "pm-triage-many-test")
    owner_sql(owner, w, "update pulse.agent_member set access='operations', tools=array['chats','tasks','memory'] where person_id=%s", (pm,))
    one(api, w, w.manager, "select pulse.task_save(null,'{\"title\": \"Nobody owns this either (test)\"}') id")
    one(api, w, w.manager, "select pulse.agent_daily_triage_set(%s,true) r", (pm,))
    # Its managers choose; the AI itself and a colleague who is not its manager cannot; nobody outside the company.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, pm, "select pulse.agent_triage_watchers_set(%s,%s::uuid[]) r", (pm, [str(w.editor)]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_triage_watchers_set(%s,%s::uuid[]) r", (pm, [str(w.editor)]))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.manager, "select pulse.agent_triage_watchers_set(%s,%s::uuid[]) r", (pm, [str(w.editor), "00000000-0000-4000-8000-000000000001"]))
    kept = one(api, w, w.manager, "select pulse.agent_triage_watchers_set(%s,%s::uuid[]) r", (pm, [str(w.editor), str(w.lead), str(w.editor)]))["r"]
    assert sorted(map(str, kept)) == sorted([str(w.editor), str(w.lead)]), "each person once"
    hour = owner_sql(owner, w, "select extract(hour from now() at time zone pulse.org_time_zone())::int h")[0]["h"]
    r = agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"]
    if hour < 9:
        assert r is None
        return
    # The day's task may already follow someone of its own (task_save's watchers); the two chosen are added to them.
    assert r["taskId"] and r["watchers"] >= 2
    rows = owner_sql(owner, w, "select person_id from pulse.task_member where task_id=%s and role='watcher' and removed_at is null", (r["taskId"],))
    assert {str(w.editor), str(w.lead)} <= {str(x["person_id"]) for x in rows}
    # The person who decides is still one: the task's reviewer is its approver (or owner), not the watchers.
    t = owner_sql(owner, w, "select review_owner_id from pulse.task where id=%s", (r["taskId"],))[0]
    assert str(t["review_owner_id"]) == str(w.manager)
    # A watcher sees the day's triage task (watchers follow it).
    assert one(api, w, w.editor, "select count(*) n from pulse.task where id=%s", (r["taskId"],))["n"] == 1
    # Cleared, nobody else is added the next time.
    assert one(api, w, w.manager, "select pulse.agent_triage_watchers_set(%s,'{}'::uuid[]) r", (pm,))["r"] == []
