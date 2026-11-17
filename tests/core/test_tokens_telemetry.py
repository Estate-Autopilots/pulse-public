"""TOKENS-TELEMETRY (2270): the daily look stops re-reading tasks where nothing happened, every skipped look is a
decision in the trace, rules can be retired by an admin (audited), the runtime records rule/skill decisions, and the AI
cost report adds model runs and rule decisions up per task type and per AI employee. Synthetic people only.

Production (read-only audit, 21 Oct - 17 Nov 2026): 105 daily looks were 46% of all AI tokens, 104 of them on tasks
with nothing new since the AI's previous look; replaying that history under these rules keeps 27 looks and saves 34%
of all tokens."""
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, owner_sql
from test_ai_tasks import act, ai, finish, look
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)


def daily(api, w, agent):
    return agent_one(api, w, agent, "select pulse.agent_tasks_daily() r")["r"]


def idle(owner, w, tid, hours):
    """The AI's last look and the task's last change were `hours` ago."""
    owner_sql(owner, w, "update pulse.agent_task_work set updated_at=now()-make_interval(hours=>%s) where task_id=%s", (hours, tid))
    owner_sql(owner, w, "update pulse.task set updated_at=now()-make_interval(hours=>%s) where id=%s", (hours, tid))


def age_daily_events(owner, w, agent, tid, days):
    """Everything on the task so far happened `days` earlier (so today's daily key is free), as on a real calendar."""
    owner_sql(owner, w, "update pulse.agent_event set state='done', created_at=created_at-make_interval(days=>%s), "
              "event_key=regexp_replace(event_key, ':daily:.*$', ':daily:2026-01-0' || (1 + (random()*8)::int)::text || '-' || id::text) "
              "where agent_id=%s and subject_id=%s and event_key like %s", (days, agent, tid, "%:daily:%"))
    owner_sql(owner, w, "update pulse.agent_event set created_at=created_at-make_interval(days=>%s) where agent_id=%s and subject_id=%s and event_key not like %s", (days, agent, tid, "%:daily:%"))
    owner_sql(owner, w, "update pulse.task_event set at=at-make_interval(days=>%s) where task_id=%s", (days, tid))
    owner_sql(owner, w, "update pulse.work_comment set created_at=created_at-make_interval(days=>%s) where task_id=%s", (days, tid))


def decisions(owner, w, tid):
    return owner_sql(owner, w, "select task_type, route, rule_key, saved_est > 0 saved from pulse.ai_decision where subject_id=%s order by at", (tid,))


def test_quiet_tasks_are_not_re_read_every_day(api, worker, owner, team):  # noqa: F811
    w = team
    hour = datetime.now(ZoneInfo(owner_sql(owner, w, "select pulse.org_time_zone() z")[0]["z"])).hour
    if hour < 9:
        pytest.skip("the daily look starts at 9 am company time")
    agent = ai(api, owner, w, "tara-test")
    tid = new_task(api, w, w.editor, title="Collect the site photos (test)", assigneeId=str(agent))
    run, ctx = look(api, w, agent)
    act(api, w, agent, run, {"plan": [{"label": "Ask for the photos", "done": True}], "comment": "@editor1 please share the site photos.",
                             "status": "waiting", "waitingOn": "the editor"})
    finish(api, w, agent, run)
    # Day 1 of quiet: the first look still happens (it reminds once).
    idle(owner, w, tid, 30)
    assert daily(api, w, agent) == {"queued": 1}
    run, ctx = look(api, w, agent)
    assert ctx["cause"] == "daily"
    act(api, w, agent, run, {"comment": "A kind reminder about the site photos, @editor1.", "status": "waiting"})
    finish(api, w, agent, run)
    age_daily_events(owner, w, agent, tid, 1)
    # Nothing new, last look 30 h ago: the next quiet look waits 2 days. The skip is one decision a day.
    idle(owner, w, tid, 30)
    assert daily(api, w, agent) == {"queued": 0, "held": 1}
    assert daily(api, w, agent) == {"queued": 0}, "one decision a task a day"
    assert decisions(owner, w, tid) == [{"task_type": "task.daily", "route": "skip", "rule_key": "task.quiet", "saved": True}]
    # 2 days later it looks again (the second reminder) ...
    idle(owner, w, tid, 49)
    assert daily(api, w, agent) == {"queued": 1}
    run, _ = look(api, w, agent)
    finish(api, w, agent, run)
    age_daily_events(owner, w, agent, tid, 2)
    # ... then after 4 more days the third, and after three quiet looks never again until something happens.
    idle(owner, w, tid, 97)
    assert daily(api, w, agent) == {"queued": 1}
    run, _ = look(api, w, agent)
    finish(api, w, agent, run)
    age_daily_events(owner, w, agent, tid, 4)
    idle(owner, w, tid, 24 * 30)
    owner_sql(owner, w, "delete from pulse.ai_decision where subject_id=%s", (tid,))
    assert daily(api, w, agent) == {"queued": 0, "held": 1}, "three quiet looks: stop"
    # Something new (the editor answers on the task): it looks the same day.
    owner_sql(owner, w, "insert into pulse.work_comment(org_id, task_id, author_id, body) values(%s,%s,%s,'Photos are in the shared folder (test)')", (w.org, tid, w.editor))
    owner_sql(owner, w, "delete from pulse.ai_decision where subject_id=%s", (tid,))
    assert "held" not in daily(api, w, agent)
    assert owner_sql(owner, w, "select count(*)::int n from pulse.agent_event where agent_id=%s and subject_id=%s and state='queued'", (agent, tid)) == [{"n": 1}]
    assert decisions(owner, w, tid) == []


def test_with_its_reviewer_no_daily_look_and_admins_can_turn_a_rule_off(api, worker, owner, team):  # noqa: F811
    w = team
    hour = datetime.now(ZoneInfo(owner_sql(owner, w, "select pulse.org_time_zone() z")[0]["z"])).hour
    if hour < 9:
        pytest.skip("the daily look starts at 9 am company time")
    agent = ai(api, owner, w, "ravi-test")
    tid = new_task(api, w, w.editor, title="Draft the brochure copy (test)", assigneeId=str(agent))
    run, _ = look(api, w, agent)
    act(api, w, agent, run, {"comment": "Draft ready for review.", "files": [{"name": "Brochure copy.md", "text": "# Brochure (test)"}], "status": "waiting"})
    finish(api, w, agent, run)
    # Production's case (16 daily looks): the task is still open while the AI's own phase says it is with the reviewer.
    owner_sql(owner, w, "update pulse.agent_task_work set phase='in_review' where task_id=%s", (tid,))
    assert owner_sql(owner, w, "select status in ('open','in_progress','blocked') open from pulse.task where id=%s", (tid,)) == [{"open": True}]
    owner_sql(owner, w, "update pulse.agent_event set state='done' where agent_id=%s and state in ('queued','leased')", (agent,))
    idle(owner, w, tid, 30)
    assert daily(api, w, agent) == {"queued": 0, "held": 1}
    assert decisions(owner, w, tid) == [{"task_type": "task.daily", "route": "skip", "rule_key": "task.with_reviewer", "saved": True}]
    # A member cannot retire a rule; an admin can, it is audited, and the look comes back.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.ai_heuristic_set('task.with_reviewer', false, 'test') r")
    r = one(api, w, w.manager, "select pulse.ai_heuristic_set('task.with_reviewer', false, 'We want daily looks (test)') r")["r"]
    assert r == {"key": "task.with_reviewer", "state": "retired"}
    assert owner_sql(owner, w, "select action from pulse.audit_event where resource='ai_heuristic' and resource_id='task.with_reviewer'") == [{"action": "ai_rule.off"}]
    owner_sql(owner, w, "update pulse.agent_event set state='done' where agent_id=%s and state in ('queued','leased')", (agent,))
    assert daily(api, w, agent) == {"queued": 1}
    one(api, w, w.manager, "select pulse.ai_heuristic_set('task.with_reviewer', true, null) r")

    # The runtime records a decision made without a model (its own session only; checked input; once per dedupe key).
    note = lambda p: agent_one(api, w, agent, "select pulse.ai_decision_note(%s) r", (Jsonb(p),))["r"]  # noqa: E731
    p = {"taskType": "chat.short", "route": "rule", "ruleKey": "chat.screen_direct", "savedEst": 13000, "dedupe": f"t:{uuid.uuid4()}"}
    assert note(p)["recorded"] is True
    assert note(p)["recorded"] is False
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        note({"taskType": "chat.short", "route": "model", "ruleKey": "x"})
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.ai_decision_note(%s) r", (Jsonb(p),))

    # The cost report (leadership, read under row security): model runs and rule decisions per task type, the agent's day.
    rep = one(api, w, w.manager, "select pulse.ai_cost_report(30) r")["r"]
    types = {x["type"] for x in rep["byDay"]}
    assert {"task.assigned", "task.daily", "chat.short"} <= types, types
    daily_row = [x for x in rep["byDay"] if x["type"] == "task.daily"]
    assert sum(x["ruled"] for x in daily_row) >= 1 and sum(x["saved"] for x in daily_row) > 0
    me = [a for a in rep["agents"] if a["id"] == str(agent)][0]
    assert me["runs"] >= 1 and me["tokens"] >= 1200 and me["budget"] == 500000 and me["warn"] is False and me["suggested"] >= 100000
    assert me["inr"] is None and rep["priced"] is False, "no made-up rupees when no price is set"
    keys = {x["key"]: x for x in rep["rules"]}
    assert keys["chat.screen_direct"]["uses"] == 1 and keys["chat.screen_direct"]["saved"] == 13000
    assert keys["task.with_reviewer"]["state"] == "active"
