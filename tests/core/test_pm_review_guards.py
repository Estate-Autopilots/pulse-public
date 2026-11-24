"""PM-BUILD-4 (migration 2523; lane C's T4/T11, SPEC 0.5.8): a step with no named reviewer is accepted or returned only
by leadership or the doer's manager (a missing reviewer used to let any colleague through); a person's connected AI app
never accepts, returns or shares with a client. Synthetic tenants only; nothing is sent."""
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)


def as_app(api, w, who, sql, args=()):
    """The same statement from a person's connected AI app (the API sets pulse.actor_account to app:<name>)."""
    with api.transaction():
        set_tenant(api, w.org, who)
        api.execute("select set_config('pulse.actor_account','app:Claude',true)")
        return api.execute(sql, args).fetchall()


def done_without_reviewer(api, owner, w, title):
    """A project step with no named reviewer, which the outsider (another pod) can see because they are on the project."""
    t = new_task(api, w, w.editor, title=title, projectId=str(w.project))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set review_owner_id=null where id=%s", (t,))
        owner.execute("insert into pulse.project_member(org_id,project_id,person_id,role) values(%s,%s,%s,'member')", (w.org, w.project, w.outsider))
    one(api, w, w.editor, "select pulse.task_move(%s,'done',null)", (t,))
    return t


def test_no_named_reviewer_is_not_anyone(api, owner, worker, team):
    w = team
    t = done_without_reviewer(api, owner, w, "Positioning doc")
    assert one(api, w, w.outsider, "select pulse.task_visible(%s) v", (t,))["v"] is True, "the colleague can see the step"
    # A colleague from another pod (not the reviewer, not leadership, not the manager) is refused, to accept and to return.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only the reviewer"):
        as_(api, w, w.outsider, "select pulse.task_accept(%s,null,null)", (t,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only the reviewer"):
        as_(api, w, w.outsider, "select pulse.task_return(%s,'Please redo the intro')", (t,))
    # A connected AI app is refused even for the doer's manager.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="A person reviews work"):
        as_app(api, w, w.editor2, "select pulse.task_accept(%s,null,null)", (t,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="A person reviews work"):
        as_app(api, w, w.editor2, "select pulse.task_return(%s,'Please redo the intro')", (t,))
    # The doer's manager (the pod head) may.
    as_(api, w, w.editor2, "select pulse.task_return(%s,'Please redo the intro')", (t,))
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (t,))["status"] == "in_progress"


def test_a_connected_ai_app_never_shares_with_a_client(api, owner, worker, team):
    w = team
    cid = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Cedar Group')", (cid, w.org))
    row = (w.org, cid, "Site visit reel", w.manager, w.manager)
    sql = "insert into pulse.client_deliverable(org_id,client_id,title,kind,owner_id,shared_by,shared_at,version,state) values(%s,%s,%s,'image',%s,%s,now(),1,'waiting')"
    with owner.transaction():
        set_tenant(owner, w.org, w.manager)
        owner.execute("select set_config('pulse.actor_account','app:Claude',true)")
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person shares"):
            owner.execute(sql, row)
    # The same row from the person's own session is allowed.
    with owner.transaction():
        set_tenant(owner, w.org, w.manager)
        owner.execute(sql, row)
