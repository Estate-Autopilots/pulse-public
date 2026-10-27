"""CHAT-V6: reminders and scheduled messages are delivered however late (the API or the worker catches up), each once,
even with two deliverers at once or one that crashes half way. Synthetic tenants only."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pulse_sdk.db import set_tenant
from pulse_workers.__main__ import _run_chat_due_tick
from test_tasks_rt1 import as_, notes, one, team  # noqa: F401  (team is a fixture)


def _group(api, w, members=None):
    return one(api, w, w.editor2, "select pulse.chat_group_create(%s,%s) id", ("V6 desk", members or [w.editor]))["id"]


def _send(api, w, who, channel, body):
    return one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]'::jsonb,%s,null) id", (channel, body, str(uuid.uuid4())))["id"]


def _overdue(owner, w, table, row, by="2 days"):
    """As if the time came while nothing was running (the functions only take times ahead)."""
    with owner.transaction():
        set_tenant(owner, w.org)
        col = "due_at" if table == "chat_reminder" else "send_at"
        owner.execute(f"update pulse.{table} set {col}=clock_timestamp()-%s::interval where id=%s", (by, row))


def _count(api, w, ch, body):
    return one(api, w, w.editor2, "select count(*)::int n from pulse.chat_message where channel_id=%s and body=%s", (ch, body))["n"]


def test_the_worker_catches_up_on_what_fell_due_while_the_api_was_down(api, owner, worker, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    mid = _send(api, w, w.editor2, ch, "Call the printer about the brochure proofs")
    soon = datetime.now(timezone.utc) + timedelta(hours=1)
    rid = one(api, w, w.editor, "select pulse.chat_remind(%s,%s) id", (mid, soon))["id"]
    sid = one(api, w, w.editor, "select pulse.chat_schedule(%s,%s,'[]'::jsonb,null,null,%s) id", (ch, "Proofs are approved, go ahead", soon))["id"]
    _overdue(owner, w, "chat_reminder", rid)
    _overdue(owner, w, "chat_scheduled", sid)
    # The worker's minute tick (no API involved) delivers both, two days late.
    _run_chat_due_tick(worker)
    assert _count(api, w, ch, "Proofs are approved, go ahead") == 1
    assert [n["title"] for n in notes(worker, w, w.editor, "chat.mention")] == ["Reminder: Call the printer about the brochure proofs"]
    # The API starting afterwards (its catch-up) finds nothing left.
    assert one(api, w, w.editor2, "select pulse.chat_due() n")["n"] == 0
    _run_chat_due_tick(worker)
    assert _count(api, w, ch, "Proofs are approved, go ahead") == 1
    assert len(notes(worker, w, w.editor, "chat.mention")) == 1


def test_two_deliverers_at_once_and_a_crash_half_way_send_once(api, owner, worker, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    sid = one(api, w, w.editor, "select pulse.chat_schedule(%s,%s,'[]'::jsonb,null,null,%s) id",
              (ch, "Site visit moved to 4 pm", datetime.now(timezone.utc) + timedelta(hours=3)))["id"]
    _overdue(owner, w, "chat_scheduled", sid, "5 minutes")

    class Crash(Exception):
        pass

    # The worker claims and sends it, then dies before committing...
    with pytest.raises(Crash), worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.chat_due() n").fetchone()["n"] == 1
        # ...while the API's timer runs at the same moment: the row is claimed, so it skips it.
        assert one(api, w, w.editor2, "select pulse.chat_due() n")["n"] == 0
        raise Crash
    # Nothing went (the crash rolled the send back), and the row is still waiting.
    assert _count(api, w, ch, "Site visit moved to 4 pm") == 0
    assert one(api, w, w.editor, "select sent_at is null and failed_at is null waiting from pulse.chat_scheduled where id=%s", (sid,))["waiting"]
    # The next run sends it, once.
    assert one(api, w, w.editor2, "select pulse.chat_due() n")["n"] == 1
    assert one(api, w, w.editor2, "select pulse.chat_due() n")["n"] == 0
    _run_chat_due_tick(worker)
    assert _count(api, w, ch, "Site visit moved to 4 pm") == 1
    row = one(api, w, w.editor, "select sent_at is not null sent,message_id from pulse.chat_scheduled where id=%s", (sid,))
    assert row["sent"] and row["message_id"]
