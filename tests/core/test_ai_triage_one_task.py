"""AI-FIX-5 (2484, BC-127): the daily triage keeps ONE standing task. While the AI employee's last triage task is still
open (EA's sat blocked, one more each day), the next day's triage refreshes that task (today's count and date) and wakes
the AI employee on it; once a day still; a new task only when none is open. Synthetic only."""
from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


def _daytime_zone(owner, w):
    """The organisation's time zone set to one where it is now 10:00-19:59: the triage starts from 9, and the day must
    not turn while the test runs."""
    tz = owner_sql(owner, w, "select name from pg_timezone_names where name like %s and extract(hour from now() at time zone name) between 10 and 19 order by name limit 1",
                   ("Etc/GMT%",))[0]["name"]
    owner_sql(owner, w, "update pulse.org set time_zone=%s where id=%s", (tz, w.org))


def _triage(owner, w, pm):
    return owner_sql(owner, w, "select id, title, status from pulse.task where created_by=%s and title like %s order by created_at", (pm, "Daily triage:%"))


def _yesterday(owner, w, task, status, title):
    """That triage task as if made yesterday, and its AI employee's events dealt with. (task_save locks the fields it set;
    task_manual_wins keeps locked fields on an update with no viewer, so they are unlocked first.)"""
    owner_sql(owner, w, "update pulse.task set locked='{}' where id=%s", (task,))
    owner_sql(owner, w, "update pulse.task set status=%s, title=%s, created_at=now()-interval '1 day', updated_at=now()-interval '1 day' where id=%s", (status, title, task))
    owner_sql(owner, w, "update pulse.agent_event set state='done' where agent_id=(select assignee_person_id from pulse.task where id=%s) and state='queued'", (task,))


def test_the_daily_triage_keeps_one_standing_task(api, worker, owner, team):  # noqa: F811
    w = team
    _daytime_zone(owner, w)
    pm, _ = make_agent(api, w, "pm-standing-test")
    owner_sql(owner, w, "update pulse.agent_member set access='operations', tools=array['chats','tasks','memory'] where person_id=%s", (pm,))
    one(api, w, w.manager, "select pulse.task_save(null,'{\"title\": \"Nobody owns this (test)\"}') id")
    one(api, w, w.manager, "select pulse.agent_daily_triage_set(%s,true) r", (pm,))
    first = agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"]
    assert first and first["taskId"]
    t1 = str(first["taskId"])
    today = _triage(owner, w, pm)[0]["title"].rsplit("(", 1)[1].rstrip(")")  # "20 Nov", in the organisation's own day
    # Yesterday's triage is still open (blocked, as EA's are): today's refreshes it, no second task.
    _yesterday(owner, w, t1, "blocked", "Daily triage: 1 tasks with no owner or due day (yesterday)")
    one(api, w, w.manager, "select pulse.task_save(null,'{\"title\": \"Nobody owns this either (test)\"}') id")
    second = agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"]
    assert str(second["taskId"]) == t1, "the open triage task is refreshed, not a second one made"
    rows = _triage(owner, w, pm)
    assert len(rows) == 1 and rows[0]["title"] == f"Daily triage: {second['tasks']} tasks with no owner or due day ({today})", rows
    woke = owner_sql(owner, w, "select event_type from pulse.agent_event where agent_id=%s and subject_id=%s and state='queued'", (pm, t1))
    assert [x["event_type"] for x in woke] == ["task.mention"], "its AI employee is woken on it"
    assert agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"] is None, "still once a day"
    # Once it is finished, the next day's triage is a task of its own.
    _yesterday(owner, w, t1, "accepted", "Daily triage: 2 tasks with no owner or due day (yesterday)")
    third = agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"]
    assert str(third["taskId"]) != t1
    assert [r["status"] for r in _triage(owner, w, pm)] == ["accepted", "open"]
