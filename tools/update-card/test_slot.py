"""Tests for tools/update-card/slot.py (synthetic ids; times shaped like the 23-24 October 2026 scheduler gap).

  uv run --no-project --with pytest pytest -q tools/update-card/test_slot.py
"""

import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest
import slot

ROUTINE = "routine-1"
PREPARE = {"id": "trigger-prepare", "kind": "schedule", "label": "Prepare", "cronExpression": "40 8,20 * * *",
           "timezone": "Asia/Kolkata", "createdAt": "2026-10-18T17:27:21.240Z"}
PUBLISH = {"id": "trigger-publish", "kind": "schedule", "label": "Publish", "cronExpression": "0 9,21 * * *",
           "timezone": "Asia/Kolkata", "createdAt": "2026-10-20T19:05:16.500Z"}


def routine(*triggers):
    return {"id": ROUTINE, "triggers": list(triggers or (PREPARE, PUBLISH))}


def run(rid, trigger, at, source="schedule"):
    return {"id": rid, "triggerId": trigger["id"], "source": source, "triggeredAt": at}


def issue(rid):
    return {"originKind": "routine_execution", "originId": ROUTINE, "originRunId": rid}


def resolve(rid, runs, resets=(), grace=30, r=None):
    return slot.resolve(issue(rid), r or routine(), runs, list(resets), grace)


def utc(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


GAP_RUNS = [
    run("prep-23am", PREPARE, "2026-10-23T03:10:37.958Z"),
    run("pub-23am", PUBLISH, "2026-10-23T03:30:05.654Z"),
    run("prep-late", PREPARE, "2026-10-24T11:15:58.692Z"),
    run("pub-late", PUBLISH, "2026-10-24T11:15:59.891Z"),
]


def test_late_dispatch_after_an_outage_names_the_claimed_tick_and_every_missed_slot():
    out = resolve("prep-late", GAP_RUNS)
    assert out["nominalTick"] == "2026-10-23T15:10:00.000Z"
    assert out["coveredTicks"] == ["2026-10-23T15:10:00.000Z", "2026-10-24T03:10:00.000Z"]
    assert out["currentTick"] == "2026-10-24T03:10:00.000Z" and out["lateMinutes"] == 485.98
    assert out["onTime"] is False and out["slotKey"] is None
    assert [m["slotKey"] for m in out["missedSlots"]] == ["2026-10-23-pm", "2026-10-24-am"]
    assert out["basis"] == "2026-10-23T03:10:37.958Z" and out["trigger"]["id"] == PREPARE["id"]


def test_publication_trigger_is_resolved_from_its_own_previous_run():
    out = resolve("pub-late", GAP_RUNS)
    assert out["nominalTick"] == "2026-10-23T15:30:00.000Z"
    assert [m["slotKey"] for m in out["missedSlots"]] == ["2026-10-23-pm", "2026-10-24-am"]
    assert out["onTime"] is False


def test_an_on_time_run_names_its_own_slot_and_misses_nothing():
    runs = [run("prep-22am", PREPARE, "2026-10-22T03:10:44.807Z"), run("prep-22pm", PREPARE, "2026-10-22T15:10:17.177Z")]
    out = resolve("prep-22pm", runs)
    assert out["coveredTicks"] == ["2026-10-22T15:10:00.000Z"] and out["nominalTick"] == out["currentTick"]
    assert out["onTime"] is True and out["slotKey"] == "2026-10-22-pm" and out["missedSlots"] == []
    assert out["lateMinutes"] == 0.29


def test_a_resume_shortly_after_a_later_tick_keeps_that_slot_and_records_the_older_ones():
    runs = [run("pub-a", PUBLISH, "2026-10-23T03:30:05.000Z"), run("pub-b", PUBLISH, "2026-10-24T03:40:00.000Z")]
    out = resolve("pub-b", runs)
    assert out["nominalTick"] == "2026-10-23T15:30:00.000Z" and out["currentTick"] == "2026-10-24T03:30:00.000Z"
    assert out["onTime"] is True and out["slotKey"] == "2026-10-24-am"
    assert [m["slotKey"] for m in out["missedSlots"]] == ["2026-10-23-pm"]


def test_a_trigger_edit_after_the_previous_run_moves_the_basis():
    runs = [run("prep-a", PREPARE, "2026-10-23T03:10:37.958Z"), run("prep-b", PREPARE, "2026-10-24T03:10:05.000Z")]
    out = resolve("prep-b", runs, resets=["2026-10-23T16:00:00.000Z"])
    assert out["basis"] == "2026-10-23T16:00:00.000Z"
    assert out["coveredTicks"] == ["2026-10-24T03:10:00.000Z"] and out["missedSlots"] == []
    with pytest.raises(slot.Unresolved):  # an edit after the dispatch may have changed the schedule the run used
        resolve("prep-b", runs, resets=["2026-10-24T09:00:00.000Z"])


def test_a_schedule_change_after_the_dispatch_fails_closed_instead_of_inventing_missed_slots():
    edited = dict(PREPARE, cronExpression="40 9,21 * * *")
    runs = [run("prep-a", PREPARE, "2026-10-23T15:10:05.000Z"), run("prep-b", PREPARE, "2026-10-24T03:10:05.000Z")]
    with pytest.raises(slot.Unresolved):
        resolve("prep-b", runs, resets=["2026-10-24T09:00:00.000Z"], r=routine(edited, PUBLISH))


def test_the_first_run_counts_from_the_trigger_creation():
    out = resolve("first", [run("first", PREPARE, "2026-10-19T03:10:13.823Z")])
    assert out["basis"] == "2026-10-18T17:27:21.240Z" and out["slotKey"] == "2026-10-19-am"


@pytest.mark.parametrize(("dispatch", "on_time"), [("2026-10-22T15:40:00.000Z", True), ("2026-10-22T15:40:30.000Z", False)])
def test_the_grace_window_is_inclusive(dispatch, on_time):
    runs = [run("a", PREPARE, "2026-10-22T03:10:44.807Z"), run("b", PREPARE, dispatch)]
    assert resolve("b", runs)["onTime"] is on_time


def test_runs_that_are_not_scheduled_executions_of_this_routine_are_refused():
    with pytest.raises(slot.Unresolved):
        resolve("manual", [run("manual", PREPARE, "2026-10-22T15:10:17.177Z", source="manual")])
    with pytest.raises(slot.Unresolved):
        resolve("absent", GAP_RUNS)
    with pytest.raises(slot.Unresolved):
        slot.resolve({"originKind": "manual", "originId": ROUTINE, "originRunId": "prep-late"}, routine(), GAP_RUNS, [], 30)


def test_cron_grammar_follows_paperclip():
    minute, hour, dom, month, dow = slot.parse_cron("*/20 1-5/2 * * 0,6")
    assert minute == {0, 20, 40} and hour == {1, 3, 5} and dow == {0, 6}
    with pytest.raises(ValueError):
        slot.parse_cron("0 9 * * 7")
    # Day of month and day of week must both match: the first Monday-the-1st after 1 Jan 2026 is 1 Jun 2026.
    tick = slot.next_tick(slot.parse_cron("0 9 1 * 1"), ZoneInfo("UTC"), utc("2026-01-01T10:00:00Z"))
    assert tick == datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc)
    # A local minute skipped by a clock change never fires that day.
    tick = slot.next_tick(slot.parse_cron("30 1 * * *"), ZoneInfo("Europe/London"), utc("2026-03-28T12:00:00Z"))
    assert tick == utc("2026-03-30T00:30:00Z")


def test_main_prints_the_resolution_and_exits_2_when_unresolved(monkeypatch, capsys):
    monkeypatch.setattr(slot, "fetch", lambda issue_id: (issue("prep-late"), routine(), GAP_RUNS, []))
    assert slot.main(["--issue", "x"]) == 0
    assert json.loads(capsys.readouterr().out)["missedSlots"][0]["slotKey"] == "2026-10-23-pm"
    monkeypatch.setattr(slot, "fetch", lambda issue_id: (issue("absent"), routine(), GAP_RUNS, []))
    assert slot.main(["--issue", "x"]) == 2
    assert "unresolved" in capsys.readouterr().err
