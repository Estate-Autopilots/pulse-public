"""CHAT-GROUPS (owner report EA #4, 28 Oct 2026; "Yes, build it", 22 Nov 2026) on real PostgreSQL (2530).

Team chat groups with categories, a company setting for who may make groups (leadership / managers / everyone, with
requests to an approver for the rest), who may add people and who may post inside a group, admin roles, a "Bugs and
support" group per company that Report a bug posts into (with its screenshot when the reporter chooses), and one group
per project (an existing linked group is reused, never doubled). Existing groups are not rewritten: their category is
read from what Pulse already knows. Every person, group and report here is synthetic."""

import hashlib
import json
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_chats import setup

BUGS_KEY = "custom:bugs-support"


def q(api, w, viewer, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute(sql, args).fetchall()


def one(api, w, viewer, sql, args=()):
    rows = q(api, w, viewer, sql, args)
    return rows[0] if rows else None


def val(api, w, viewer, sql, args=()):
    row = one(api, w, viewer, sql, args)
    return None if row is None else next(iter(row.values()))


def new_group(api, w, viewer, **p):
    body = {"name": "Synthetic crew", "members": [str(w.editor2)], **p}
    return uuid.UUID(val(api, w, viewer, "select pulse.chat_group_new(%s)->>'id'", (json.dumps(body, default=str),)))


def members(api, w, viewer, channel):
    return {r["person_id"]: r["role"] for r in q(api, w, viewer, "select person_id, role from pulse.chat_member where channel_id=%s", (channel,))}


def context(api, w, viewer):
    return val(api, w, viewer, "select pulse.chat_groups_context()")


def category(api, w, viewer, channel):
    return val(api, w, viewer, "select pulse.chat_group_category(%s)", (channel,))


def add_person(worker, w, name, side="staff"):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person (id, org_id, display_name, side) values (%s, %s, %s, %s)", (pid, w.org, name, side))
    return pid


def report(api, w, viewer, words="Synthetic: the Save button did nothing", shot=b"\x89PNG synthetic screenshot"):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        rid = api.execute("""insert into pulse.reported_bug (org_id, number, person_id, command_id, words, route, fingerprint)
            select pulse.current_org(), coalesce(max(number), 0) + 1, %s, %s, %s, '/tasks', %s from pulse.reported_bug returning id""",
                          (viewer, f"cmd-{uuid.uuid4().hex[:12]}", words, hashlib.sha256(words.encode()).hexdigest())).fetchone()["id"]
        if shot:
            api.execute("""insert into pulse.reported_bug_file (report_id, org_id, kind, content_type, bytes, sha256, data)
                values (%s, pulse.current_org(), 'screenshot', 'image/png', %s, %s, %s)""", (rid, len(shot), hashlib.sha256(shot).hexdigest(), shot))
    return rid


# --------------------------------------------------------------------------------------------- creating a group
def test_a_group_has_a_name_description_category_icon_colour_and_members(worker, owner, api):
    w = setup(worker, owner, api)
    g = new_group(api, w, w.editor, name="  Orchid   launch ", description="Shoot plan and edits for Orchid", category="projects",
                  icon="megaphone", colour="violet", members=[str(w.editor2), str(w.lead)])
    row = one(api, w, w.editor, "select name, kind, description, created_by from pulse.chat_channel where id=%s", (g,))
    assert row == {"name": "Orchid launch", "kind": "custom", "description": "Shoot plan and edits for Orchid", "created_by": w.editor}
    assert members(api, w, w.editor, g) == {w.editor: "admin", w.editor2: "member", w.lead: "member"}
    meta = one(api, w, w.editor, "select category, icon, colour, adders, posting from pulse.chat_group_meta where channel_id=%s", (g,))
    assert meta == {"category": "projects", "icon": "megaphone", "colour": "violet", "adders": "admins", "posting": "everyone"}
    assert category(api, w, w.editor, g) == "projects"
    # An unknown icon, colour or category is refused, not stored.
    for bad in ({"icon": "Robert'); drop"}, {"colour": "neon"}, {"category": "c-nothere1"}):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            new_group(api, w, w.editor, **bad)
    # The old call still works (people intake and API v1 use it) and follows the same rules.
    old = val(api, w, w.editor, "select pulse.chat_group_create('Old style crew', %s)", ([w.editor2],))
    assert members(api, w, w.editor, old) == {w.editor: "admin", w.editor2: "member"}


def test_announcements_default_to_admins_posting_and_replies_stay_open(worker, owner, api):
    w = setup(worker, owner, api)
    g = new_group(api, w, w.manager, name="Company news", category="announcements")
    assert val(api, w, w.manager, "select posting from pulse.chat_group_meta where channel_id=%s", (g,)) == "admins"
    root = val(api, w, w.manager, "select pulse.chat_send(%s, 'Office closed on Friday (synthetic)', null, '[]', %s)", (g, uuid.uuid4()))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="admins"):
        q(api, w, w.editor2, "select pulse.chat_send(%s, 'Can I post here?', null, '[]', %s)", (g, uuid.uuid4()))
    # A reply in the announcement's thread is fine: the talk happens under it.
    assert val(api, w, w.editor2, "select pulse.chat_send(%s, 'Noted, thanks', %s, '[]', %s)", (g, root, uuid.uuid4()))
    # The admin opens it up.
    q(api, w, w.manager, "select pulse.chat_group_meta_set(%s, %s)", (g, json.dumps({"posting": "everyone"})))
    assert val(api, w, w.editor2, "select pulse.chat_send(%s, 'Now I can', null, '[]', %s)", (g, uuid.uuid4()))


# -------------------------------------------------------------------------- the company: who may make groups
def test_who_may_make_groups_is_a_company_setting_everyone_by_default(worker, owner, api):
    w = setup(worker, owner, api)          # manager: admin (and a pod's head); lead: PGS (runs a pod's work); editors: staff
    ctx = context(api, w, w.editor)
    assert ctx["creators"] == "everyone" and ctx["canCreate"] is True and ctx["canChange"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.editor, "select pulse.chat_group_policy_set('leaders')")
    assert val(api, w, w.manager, "select pulse.chat_group_policy_set('managers')") == "managers"
    assert context(api, w, w.manager)["canChange"] is True
    # Managers: a person who manages people (a pod head, a PGS, someone with reports), HR, admins and leadership.
    assert new_group(api, w, w.lead)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Ask for one"):
        new_group(api, w, w.editor)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Ask for one"):
        q(api, w, w.editor, "select pulse.chat_group_create('Sneaky crew', %s)", ([w.editor2],))
    assert context(api, w, w.editor)["canCreate"] is False
    # Leadership only: admins and leadership.
    q(api, w, w.manager, "select pulse.chat_group_policy_set('leaders')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        new_group(api, w, w.lead)
    assert new_group(api, w, w.manager)
    with worker.transaction():
        set_tenant(worker, w.org)
        changes = worker.execute("select old_value, new_value from pulse.record_change where entity_type='org' and field='chat_group_creators' order by changed_at").fetchall()
    assert [(c["old_value"], c["new_value"]) for c in changes] == [("everyone", "managers"), ("managers", "leaders")]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        q(api, w, w.manager, "select pulse.chat_group_policy_set('anyone')")


def test_a_person_who_may_not_make_groups_asks_and_an_approver_decides(worker, owner, api):
    w = setup(worker, owner, api)
    q(api, w, w.manager, "select pulse.chat_group_policy_set('leaders')")
    asked = val(api, w, w.editor, "select pulse.chat_group_request_file(%s)", (json.dumps({
        "name": "Edit room", "description": "Editors swap cuts here", "category": "teams", "members": [str(w.editor2)], "note": "For the Orchid edits"}),))
    assert asked["status"] == "pending" and str(w.manager) in asked["approvers"] and str(w.editor) not in asked["approvers"]
    # The approver hears it in Pulse (the bell); the requester sees their own request waiting.
    with worker.transaction():
        set_tenant(worker, w.org)
        bell = worker.execute("select person_id, event_type, href from pulse.notification where subject_type='chat_group_request' and subject_id=%s", (asked["id"],)).fetchall()
    assert [(b["person_id"], b["event_type"]) for b in bell] == [(w.manager, "approval.waiting")] and bell[0]["href"].startswith("/chats")
    mine = context(api, w, w.editor)["requests"]
    assert mine["mine"] == 1 and mine["waiting"] == 0
    assert context(api, w, w.manager)["requests"]["waiting"] == 1
    # Only an approver decides.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.editor2, "select pulse.chat_group_request_decide(%s, true, null)", (asked["id"],))
    done = val(api, w, w.manager, "select pulse.chat_group_request_decide(%s, true, 'Go ahead')", (asked["id"],))
    g = uuid.UUID(done["channelId"])
    assert done["status"] == "approved"
    # The group is the requester's: they are its admin; the approver is not added.
    assert members(api, w, w.editor, g) == {w.editor: "admin", w.editor2: "member"}
    assert one(api, w, w.editor, "select name, description, created_by from pulse.chat_channel where id=%s", (g,)) == {
        "name": "Edit room", "description": "Editors swap cuts here", "created_by": w.editor}
    assert category(api, w, w.editor, g) == "teams"
    with worker.transaction():
        set_tenant(worker, w.org)
        told = worker.execute("select person_id, event_type from pulse.notification where subject_type='chat_group_request' and subject_id=%s and person_id=%s",
                              (asked["id"], w.editor)).fetchall()
    assert [t["event_type"] for t in told] == ["request.decision"]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        q(api, w, w.manager, "select pulse.chat_group_request_decide(%s, false, null)", (asked["id"],))
    # A declined request makes nothing; a person who may make groups is told to make it.
    no = val(api, w, w.editor, "select pulse.chat_group_request_file(%s)", (json.dumps({"name": "Second room", "members": [str(w.editor2)]}),))
    assert val(api, w, w.manager, "select pulse.chat_group_request_decide(%s, false, 'Use Edit room')", (no["id"],))["status"] == "declined"
    assert val(api, w, w.editor, "select count(*) from pulse.chat_channel where name='Second room'") == 0
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="make it"):
        q(api, w, w.manager, "select pulse.chat_group_request_file(%s)", (json.dumps({"name": "Mine", "members": [str(w.editor)]}),))


# ------------------------------------------------------------------------------------ inside a group: who does what
def test_who_may_add_people_and_admin_roles_inside_a_group(worker, owner, api):
    w = setup(worker, owner, api)
    g = new_group(api, w, w.editor, members=[str(w.editor2)])
    # By default only admins add people (as before).
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.editor2, "select pulse.chat_group_members(%s, %s, '{}')", (g, [w.lead]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.editor2, "select pulse.chat_group_meta_set(%s, %s)", (g, json.dumps({"adders": "members"})))
    q(api, w, w.editor, "select pulse.chat_group_meta_set(%s, %s)", (g, json.dumps({"adders": "members"})))
    q(api, w, w.editor2, "select pulse.chat_group_members(%s, %s, '{}')", (g, [w.lead]))
    assert w.lead in members(api, w, w.editor, g)
    # Members add; only admins remove.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="remove"):
        q(api, w, w.editor2, "select pulse.chat_group_members(%s, '{}', %s)", (g, [w.lead]))
    # Admin roles: an admin makes another member an admin, who may then change the group.
    q(api, w, w.editor, "select pulse.chat_group_admin_set(%s, %s, true)", (g, w.editor2))
    assert members(api, w, w.editor, g)[w.editor2] == "admin"
    q(api, w, w.editor2, "select pulse.chat_group_update(%s, 'Renamed by the new admin', '')", (g,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.lead, "select pulse.chat_group_admin_set(%s, %s, true)", (g, w.lead))
    q(api, w, w.editor2, "select pulse.chat_group_admin_set(%s, %s, false)", (g, w.editor))
    # A group always keeps an admin.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="admin"):
        q(api, w, w.editor2, "select pulse.chat_group_admin_set(%s, %s, false)", (g, w.editor2))
    lines = [r["body"] for r in q(api, w, w.editor2, "select body from pulse.chat_message where channel_id=%s and kind='event' order by created_at", (g,))]
    assert "made Editor Two an admin" in lines and "removed Editor One as an admin" in lines


# --------------------------------------------------------------------------------------------- categories
def test_categories_read_existing_groups_without_rewriting_them_and_leaders_add_their_own(worker, owner, api):
    w = setup(worker, owner, api)
    plain = val(api, w, w.editor, "select pulse.chat_group_create('Plain crew', %s)", ([w.editor2],))
    linked = val(api, w, w.editor, "select pulse.chat_group_create('Pilot project room', %s)", ([w.lead],))
    client = val(api, w, w.editor, "select pulse.chat_group_create('Client side room', %s)", ([w.lead],))
    q(api, w, w.editor, "select pulse.chat_group_set(%s, %s)", ([linked], json.dumps({"projectId": str(w.project)})))
    q(api, w, w.editor, "select pulse.chat_group_set(%s, %s)", ([client], json.dumps({"kind": "client"})))
    pod = val(api, w, w.manager, "select id from pulse.chat_channel where org_id=%s and kind in ('pod','team') limit 1", (w.org,))
    assert category(api, w, w.editor, plain) is None            # "Other groups"
    assert category(api, w, w.editor, linked) == "projects"
    assert category(api, w, w.editor, client) == "clients"
    if pod:
        assert category(api, w, w.manager, pod) == "teams"
    # Nothing was written for the groups that already existed.
    assert val(api, w, w.editor, "select count(*) from pulse.chat_group_meta where channel_id = any(%s)", ([plain, linked, client],)) == 0
    # A group admin files their group; leadership and admins also file groups they see.
    q(api, w, w.editor, "select pulse.chat_group_meta_set(%s, %s)", (plain, json.dumps({"category": "teams", "colour": "green"})))
    assert category(api, w, w.editor, plain) == "teams"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.editor2, "select pulse.chat_group_meta_set(%s, %s)", (linked, json.dumps({"category": "teams"})))
    # Company categories: leadership and admins add their own; the five built-in ones always stay.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.editor, "select pulse.chat_category_set(%s)", (json.dumps({"name": "Vendors"}),))
    made = val(api, w, w.manager, "select pulse.chat_category_set(%s)", (json.dumps({"name": " Vendors ", "icon": "truck", "colour": "amber"}),))
    assert made["id"].startswith("c-") and made["name"] == "Vendors"
    keys = [c["id"] for c in context(api, w, w.editor)["categories"]]
    assert keys[:5] == ["announcements", "projects", "teams", "clients", "bugs"] and made["id"] in keys
    q(api, w, w.editor, "select pulse.chat_group_meta_set(%s, %s)", (plain, json.dumps({"category": made["id"]})))
    assert category(api, w, w.editor, plain) == made["id"]
    # A category taken away puts its groups back where Pulse reads them (no group is lost).
    q(api, w, w.manager, "select pulse.chat_category_set(%s)", (json.dumps({"id": made["id"], "archived": True}),))
    assert made["id"] not in [c["id"] for c in context(api, w, w.editor)["categories"]]
    assert category(api, w, w.editor, plain) is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        q(api, w, w.manager, "select pulse.chat_category_set(%s)", (json.dumps({"id": "bugs", "archived": True}),))


# ------------------------------------------------------------------------------------------ Bugs and support
def test_every_company_gets_one_bugs_and_support_group_with_its_team(worker, owner, api):
    w = setup(worker, owner, api)
    first = context(api, w, w.editor)["bugsGroup"]
    again = context(api, w, w.lead)["bugsGroup"]
    assert first and first == again
    assert val(api, w, w.manager, "select count(*) from pulse.chat_channel where key=%s", (BUGS_KEY,)) == 1
    row = one(api, w, w.editor, "select name, kind from pulse.chat_channel where id=%s", (first,))
    assert row == {"name": "Bugs and support", "kind": "custom"}
    team = members(api, w, w.editor, first)
    assert set(team) == {w.editor, w.editor2, w.lead, w.manager}
    assert team[w.manager] == "admin" and team[w.editor] == "member"     # admins and leadership run it
    assert category(api, w, w.editor, first) == "bugs"
    # Someone who leaves it is not put back; someone who joins the company later is added.
    q(api, w, w.editor2, "select pulse.chat_group_leave(%s)", (first,))
    late = add_person(worker, w, "Late Joiner")
    context(api, w, w.editor)
    team = members(api, w, w.editor, first)
    assert w.editor2 not in team and late in team
    # A client-side person and an AI employee are never added.
    client = add_person(worker, w, "Client Contact", side="client")
    context(api, w, w.editor)
    assert client not in members(api, w, w.editor, first)


def test_report_a_bug_posts_into_bugs_and_support_with_the_screenshot_once(worker, owner, api):
    w = setup(worker, owner, api)
    bugs = uuid.UUID(context(api, w, w.editor)["bugsGroup"])
    q(api, w, w.editor2, "select pulse.chat_group_leave(%s)", (bugs,))
    rid = report(api, w, w.editor2)
    posted = val(api, w, w.editor2, "select pulse.chat_bug_post(%s, true)", (rid,))
    assert posted["channelId"] == str(bugs)
    msg = one(api, w, w.editor2, "select author_id, body, attachments, parent_id from pulse.chat_message where id=%s", (posted["messageId"],))
    assert msg["author_id"] == w.editor2 and msg["parent_id"] is None
    assert msg["body"].startswith("Bug #1 on the Tasks page") and "the Save button did nothing" in msg["body"]
    assert len(msg["attachments"]) == 1 and msg["attachments"][0]["name"].endswith(".png")
    # The reporter is back in the group to follow the talk; the same report posts once.
    assert w.editor2 in members(api, w, w.editor, bugs)
    assert val(api, w, w.editor2, "select pulse.chat_bug_post(%s, true)", (rid,))["messageId"] == posted["messageId"]
    # Everyone else in the group hears it, unless they muted the group.
    q(api, w, w.lead, "select pulse.chat_mute(%s, 'infinity')", (bugs,))
    second = val(api, w, w.editor, "select pulse.chat_bug_post(%s, false)", (report(api, w, w.editor, words="Synthetic: the list jumps"),))
    assert one(api, w, w.editor, "select attachments from pulse.chat_message where id=%s", (second["messageId"],))["attachments"] == []
    with worker.transaction():
        set_tenant(worker, w.org)
        heard = {r["person_id"] for r in worker.execute("select person_id from pulse.notification where message_id=%s", (second["messageId"],))}
    assert w.editor not in heard and w.lead not in heard and {w.editor2, w.manager} <= heard
    # Only the reporter posts their own report.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.lead, "select pulse.chat_bug_post(%s, true)", (report(api, w, w.editor, words="Synthetic: third"),))


# ----------------------------------------------------------------------------------------------- projects
def test_a_project_has_one_group_and_an_existing_linked_group_is_reused(worker, owner, api):
    w = setup(worker, owner, api)
    made = val(api, w, w.lead, "select pulse.chat_project_group(%s)", (w.project,))
    assert made["made"] is True
    g = uuid.UUID(made["id"])
    assert one(api, w, w.lead, "select name from pulse.chat_channel where id=%s", (g,))["name"] == "Pilot project"
    assert val(api, w, w.lead, "select project_id from pulse.chat_group_info where channel_id=%s", (g,)) == w.project
    assert category(api, w, w.lead, g) == "projects" and members(api, w, w.lead, g)[w.lead] == "admin"
    again = val(api, w, w.lead, "select pulse.chat_project_group(%s)", (w.project,))
    assert again == {**made, "made": False}
    assert val(api, w, w.lead, "select count(*) from pulse.chat_group_info where project_id=%s", (w.project,)) == 1
    # Only the people who run the project start its group.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w, w.editor, "select pulse.chat_project_group(%s)", (w.project,))
    # The lead leaves the team chat (a colleague keeps it): pressing again names it, and never makes a second one, even
    # though the lead no longer sees the group's hub record.
    q(api, w, w.lead, "select pulse.chat_group_members(%s, %s, '{}')", (g, [w.editor]))
    q(api, w, w.lead, "select pulse.chat_group_leave(%s)", (g,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="ask its admin"):
        q(api, w, w.lead, "select pulse.chat_project_group(%s)", (w.project,))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.chat_channel where name='Pilot project'").fetchone()["n"] == 1


def test_a_project_with_a_linked_team_chat_reuses_it(worker, owner, api):
    w = setup(worker, owner, api)
    room = val(api, w, w.lead, "select pulse.chat_group_create('Pilot crew (synthetic)', %s)", ([w.editor],))
    q(api, w, w.lead, "select pulse.project_chat_link(%s, %s, true)", (w.project, room))
    got = val(api, w, w.lead, "select pulse.chat_project_group(%s)", (w.project,))
    assert got["made"] is False and got["id"] == str(room)
    assert val(api, w, w.lead, "select count(*) from pulse.chat_group_info where project_id=%s", (w.project,)) == 1
