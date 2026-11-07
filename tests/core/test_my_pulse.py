"""LIFECYCLE part 5: My Pulse reads only the viewer's own records; kudos reach the receiver, their head and HR, never
a stranger; corrections go to HR as a request. Synthetic tenants and names only."""
import json

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_lifecycle_value import finish
from test_tasks_rt1 import as_, notes, one, team  # noqa: F401  (team is a fixture)


def test_my_pulse_is_mine_and_kudos_reach_the_right_people(api, worker, team):
    w = team
    [t] = finish(api, worker, w, w.editor, "Cut the teaser", None, n=1)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.kudos_give(%s,'Thanks to me')", (w.editor,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor2, "select pulse.kudos_give(%s,'ok')", (w.editor,))
    k = one(api, w, w.editor2, "select pulse.kudos_give(%s,'Saved the launch',%s) id", (w.editor, t))["id"]
    assert [n["subject_id"] for n in notes(worker, w, w.editor, "kudos.received")] == [k]
    # The receiver, the giver, HR and the receiver's head see it; a colleague in another pod does not.
    for who, n in ((w.editor, 1), (w.editor2, 1), (w.lead, 1), (w.outsider, 0)):
        assert one(api, w, who, "select count(*) n from pulse.kudos where id=%s", (k,))["n"] == n
    me = one(api, w, w.editor, "select pulse.me_pulse() h")["h"]
    assert me["person"]["id"] == str(w.editor) and me["recognition"]["kudos"][0]["note"] == "Saved the launch"
    assert me["week"]["done"] >= 1 and me["week"]["streak"] >= 1
    assert {"role", "pod", "joined", "stage", "signin", "work"} <= {f["key"] for f in me["knows"]}
    # Nothing about anyone's cost, and only the viewer's own tasks.
    text = json.dumps(me)
    assert "cost" not in text and "Pod Two Outsider" not in text
    other = one(api, w, w.outsider, "select pulse.me_pulse() h")["h"]
    assert other["recognition"]["kudos"] == [] and other["person"]["id"] == str(w.outsider)
    # Only the receiver (or HR) hides a thank-you.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.kudos_hide(%s)", (k,))
    as_(api, w, w.editor, "select pulse.kudos_hide(%s)", (k,))
    assert one(api, w, w.editor, "select pulse.me_pulse() h")["h"]["recognition"]["kudos"] == []
    # "Not right?" becomes an ordinary request to HR.
    tid = one(api, w, w.editor, "select pulse.hr_ticket_open('other','Correction: Your role','What it should be: Senior editor','normal') id")["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select person_id,subject from pulse.hr_ticket where id=%s", (tid,)).fetchone() == {"person_id": w.editor, "subject": "Correction: Your role"}


def test_my_pulse_lists_sent_back_work(api, worker, team):  # noqa: F811
    """RELEASE-5 (0436): with work sent back, My desk still opens and its feedback lists it (the union once belonged to
    the outer select: more than one row, error 21000, for anyone with work sent back in the last 90 days)."""
    from test_tasks_rt1 import new_task
    w = team
    for title in ("Grade the walkthrough", "Trim the interview"):
        back = new_task(api, w, w.editor2, title=title, assigneeId=str(w.editor))
        as_(api, w, w.editor, "select pulse.task_move(%s,'in_progress')", (back,))
        as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (back,))
        as_(api, w, w.editor2, "select pulse.task_return(%s,%s)", (back, f"{title}: the sky still bands"))
    feedback = one(api, w, w.editor, "select pulse.me_pulse() h")["h"]["growth"]["feedback"]
    assert sorted(f["text"] for f in feedback if f["kind"] == "returned") == ["Grade the walkthrough: the sky still bands", "Trim the interview: the sky still bands"]
