"""POLISH-1: a group's members are the people the roster still counts. Anyone it marks as gone (status, a lifecycle stage
of left, a past end date or last working day) leaves pods, teams and Google groups as a former member, and member counts
and lists skip them in every conversation. Synthetic tenants only."""
import uuid
from datetime import date, timedelta

import pytest
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

PAST = (date.today() - timedelta(days=2)).isoformat()
NEXT_WEEK = (date.today() + timedelta(days=7)).isoformat()


def _group_everyone(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.workspace_group(org_id,address,name,members,source_kind)
                          values(%s,%s,'Synthetic team','[]','all')""", (w.org, f"team@{w.domain}"))


def _channel(api, w):
    as_(api, w, w.editor2, "select pulse.chat_refresh()")
    return one(api, w, w.editor2, "select id from pulse.chat_channel where key=%s", (f"group:team@{w.domain}",))["id"]


def _members(api, w, channel):
    return {r["person_id"] for r in as_(api, w, w.editor2, "select person_id from pulse.chat_member where channel_id=%s", (channel,))}


MARKS = {
    "last_working_day": "insert into pulse.hr_employment(org_id,person_id,last_working_day,updated_by) values(%(org)s,%(who)s,%(day)s,%(by)s)",
    "active_to": "update pulse.person set active_to=%(day)s where id=%(who)s",
    "stage_left": "insert into pulse.person_lifecycle(org_id,person_id,stage,since,left_on,left_type) values(%(org)s,%(who)s,'left',%(day)s,%(day)s,'resigned')",
}


@pytest.mark.parametrize("mark", list(MARKS))
def test_someone_the_roster_marks_as_gone_leaves_groups_and_member_counts(api, worker, owner, team, mark):
    w = team
    _group_everyone(worker, w)
    channel = _channel(api, w)
    assert w.editor in _members(api, w, channel)
    custom = one(api, w, w.editor2, "select pulse.chat_group_create('Edit desk',%s) id", ([w.editor],))["id"]
    # HR's records are written by the owner here (the worker role has no hr_employment grant).
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(MARKS[mark], {"org": w.org, "who": w.editor, "day": PAST, "by": w.lead})
        assert owner.execute("select status from pulse.person where id=%s", (w.editor,)).fetchone()["status"] == "active"
    assert one(api, w, w.editor2, "select pulse.chat_current(%s) ok", (w.editor,))["ok"] is False
    channel = _channel(api, w)
    assert w.editor not in _members(api, w, channel)
    assert w.editor2 in _members(api, w, channel)
    former = as_(api, w, w.editor2, "select reason from pulse.chat_former_member where channel_id=%s and person_id=%s", (channel, w.editor))
    assert [r["reason"] for r in former] == ["left_company"]
    # A custom group keeps the row (its creator chose the members), but nobody counts or lists the leaver.
    assert w.editor in _members(api, w, custom)
    counted = one(api, w, w.editor2, """select count(*)::int n from pulse.chat_member cm where cm.channel_id=%s and pulse.chat_current(cm.person_id)""", (custom,))
    assert counted["n"] == 1


def test_a_future_last_day_or_notice_keeps_someone_in_their_groups(api, worker, owner, team):
    w = team
    _group_everyone(worker, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(MARKS["last_working_day"], {"org": w.org, "who": w.editor, "day": NEXT_WEEK, "by": w.lead})
        owner.execute("update pulse.person set active_to=%s where id=%s", (NEXT_WEEK, w.editor))
    assert one(api, w, w.editor2, "select pulse.chat_current(%s) ok", (w.editor,))["ok"] is True
    assert w.editor in _members(api, w, _channel(api, w))


def test_chat_current_reveals_nothing_about_another_organisation(api, worker, team):
    w = team
    stranger = uuid.uuid4()
    assert one(api, w, w.editor2, "select pulse.chat_current(%s) ok", (stranger,))["ok"] is False
