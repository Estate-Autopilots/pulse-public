"""TASK-MERGE (1851): several tasks merge into one task (or a brief) with their lineage kept; the originals close as
"merged" and are never deleted; the merge suggester's proposals are accepted or rejected by a person, and a rejected set
is never proposed again. Synthetic tenants and obviously fake titles only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (fixture)


def test_tasks_merge_into_one_with_their_lineage_and_can_be_undone(api, worker, team):  # noqa: F811
    w = team
    a = new_task(api, w, w.editor2, title="EXAMPLE reel cut for Demo Tower", assigneeId=str(w.editor))
    b = new_task(api, w, w.editor2, title="EXAMPLE reel cut for Demo Tower v2", assigneeId=str(w.editor))
    c = new_task(api, w, w.editor2, title="EXAMPLE reel captions for Demo Tower", assigneeId=str(w.editor))
    waits = new_task(api, w, w.editor2, title="EXAMPLE publish the Demo Tower reel", assigneeId=str(w.editor2))
    sub = new_task(api, w, w.editor2, title="EXAMPLE pick the music", assigneeId=str(w.editor), parentId=str(b))
    as_(api, w, w.editor2, "select pulse.task_block(%s,%s,null)", (waits, a))
    target = new_task(api, w, w.editor, title="EXAMPLE Demo Tower reel brief")
    mid = one(api, w, w.editor, "select pulse.work_merge_tasks(%s,%s,%s,'brief',true,null) id", (target, [a, b, c, a], "Three cuts of one reel"))["id"]
    rows = as_(api, w, w.editor, "select id,status,closed_as from pulse.task where id = any(%s)", ([a, b, c],))
    assert {(r["status"], r["closed_as"]) for r in rows} == {("cancelled", "merged")}, "originals close as merged, never deleted"
    m = one(api, w, w.editor, "select kind,target_id,made_new,shape,reason,method from pulse.work_merge where id=%s", (mid,))
    assert m == {"kind": "task", "target_id": target, "made_new": True, "shape": "brief", "reason": "Three cuts of one reel", "method": "by_hand"}
    src = as_(api, w, w.editor, "select source_id,position,status_before,moved from pulse.work_merge_source where merge_id=%s order by position", (mid,))
    assert len(src) == 3 and {s["source_id"] for s in src} == {a, b, c}
    assert {s["status_before"] for s in src} == {"open"}
    assert one(api, w, w.editor2, "select blocker_id from pulse.task_link where task_id=%s and cleared_at is null", (waits,))["blocker_id"] == target
    assert one(api, w, w.editor, "select parent_id from pulse.task where id=%s", (sub,))["parent_id"] == target, "subtasks move"
    assert one(api, w, w.editor, "select count(*)::int n from pulse.task_event where task_id=%s and kind='merged'", (a,))["n"] == 1
    # Someone outside the work sees neither the merge nor its originals' rows.
    assert as_(api, w, w.outsider, "select id from pulse.work_merge where id=%s", (mid,)) == []
    # Merged work is not merged again.
    other = new_task(api, w, w.editor, title="EXAMPLE another brief")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.work_merge_tasks(%s,%s,null,'task',false,null)", (other, [a]))
    # Undo: the originals open again in the status they had; a target the merge made is cancelled.
    assert one(api, w, w.editor, "select pulse.work_merge_undo(%s) n", (mid,))["n"] == 3
    assert {r["status"] for r in as_(api, w, w.editor, "select status from pulse.task where id = any(%s)", ([a, b, c],))} == {"open"}
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (target,))["status"] == "cancelled"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.work_merge_undo(%s)", (mid,))


def test_only_people_who_may_change_every_task_merge_them(api, worker, team):  # noqa: F811
    w = team
    mine = new_task(api, w, w.editor, title="EXAMPLE approve the notice draft")
    theirs = new_task(api, w, w.editor2, title="EXAMPLE approve the notice draft again", assigneeId=str(w.editor2))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_merge_tasks(%s,%s,null,'task',false,null)", (mine, [theirs]))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.work_merge_tasks(%s,%s,null,'task',false,null)", (mine, [mine]))


def test_suggestions_are_decided_by_a_person_and_a_rejected_set_stays_rejected(api, worker, team):  # noqa: F811
    w = team
    x = new_task(api, w, w.editor2, title="EXAMPLE post for Demo Heights", assigneeId=str(w.editor))
    y = new_task(api, w, w.editor2, title="EXAMPLE post for Demo Heights again", assigneeId=str(w.editor))
    z = new_task(api, w, w.editor2, title="EXAMPLE story for Demo Heights", assigneeId=str(w.editor))
    rows = Jsonb([{"kind": "duplicate", "taskIds": [str(x), str(y)], "score": 0.91, "method": "words", "title": "EXAMPLE post for Demo Heights", "reason": "Same words"},
                  {"kind": "cluster", "taskIds": [str(x), str(y), str(z)], "score": 0.7, "method": "words", "title": "EXAMPLE Demo Heights brief", "shape": "brief"}])
    assert one(api, w, w.editor, "select pulse.merge_suggestion_save(%s,%s) n", (w.editor, rows))["n"] == 2
    # Someone who does not look after the person's work can neither propose nor read.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.merge_suggestion_save(%s,%s)", (w.editor, rows))
    assert as_(api, w, w.outsider, "select id from pulse.merge_suggestion") == []
    dup = one(api, w, w.editor, "select id from pulse.merge_suggestion where kind='duplicate'")["id"]
    assert one(api, w, w.editor, "select pulse.merge_suggestion_reject(%s) ok", (dup,))["ok"] is True
    assert one(api, w, w.editor, "select state from pulse.task_same where task_a=least(%s::uuid,%s::uuid)", (x, y))["state"] == "dismissed"
    # Scanning again does not reopen it; the cluster stays open.
    assert one(api, w, w.editor, "select pulse.merge_suggestion_save(%s,%s) n", (w.editor, rows))["n"] == 1
    assert one(api, w, w.editor, "select status from pulse.merge_suggestion where id=%s", (dup,))["status"] == "rejected"
    # Accepting is merging: the cluster becomes one brief and the proposal points at the merge.
    sid = one(api, w, w.editor, "select id from pulse.merge_suggestion where kind='cluster'")["id"]
    target = new_task(api, w, w.editor, title="EXAMPLE Demo Heights brief")
    mid = one(api, w, w.editor, "select pulse.work_merge_tasks(%s,%s,null,'brief',true,%s) id", (target, [x, y, z], sid))["id"]
    assert one(api, w, w.editor, "select status,merge_id from pulse.merge_suggestion where id=%s", (sid,)) == {"status": "accepted", "merge_id": mid}
    assert one(api, w, w.editor, "select method from pulse.work_merge where id=%s", (mid,))["method"] == "suggested"
    # A scan with nothing left marks what is no longer found as stale.
    assert one(api, w, w.editor, "select pulse.merge_suggestion_save(%s,'[]'::jsonb) n", (w.editor,))["n"] == 0
